/**
 * Web inspection and network skills (SSRF-safe, multi-modal, SSE-capable)
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { HttpFileInput, HttpImageInput, SkillContext, SkillDefinition, SSEParsedEvent } from '../types.js';
import { consumeSSEStream, extractSSEToken } from '../utils/http.js';
import { resolveSafePath } from './filesystem.js';

function normalizeIpv4Mapped(ip: string): string {
  const low = ip.trim().toLowerCase();
  // Dotted form: ::ffff:127.0.0.1
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(low)) {
    return low.slice(7);
  }
  // Hex form produced by WHATWG URL parser: ::ffff:7f00:1 -> 127.0.0.1
  const hexMatch = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return low;
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return false;
  const normalized = normalizeIpv4Mapped(ip);
  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(normalized)) {
    const low = normalized.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // Unique local
    if (low.startsWith('fe80:')) return true; // Link-local
    return false;
  }
  return false;
}

export async function validateExternalUrl(rawUrl: string, context: SkillContext = {}): Promise<URL> {
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS protocols are supported');
  }

  if (context?.config?.security?.allowPrivateNetwork === true) {
    return parsedUrl;
  }

  // URL.hostname keeps brackets around IPv6 literals ([::1]); strip before net.isIP
  const host = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`SSRF protection: Access to local hostname '${host}' is blocked`);
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`SSRF protection: Access to private/loopback IP '${host}' is blocked`);
    }
    return parsedUrl;
  }

  try {
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) {
      throw new Error(`SSRF protection: DNS lookup returned no addresses for '${host}'`);
    }
    for (const rec of records) {
      if (isPrivateIp(rec.address)) {
        throw new Error(`SSRF protection: Host '${host}' resolves to private IP '${rec.address}'`);
      }
    }
  } catch (err: any) {
    if (String(err?.message || '').startsWith('SSRF protection:')) throw err;
    // Fail closed on DNS lookup failures to prevent unverified SSRF targets
    throw new Error(`SSRF protection: DNS resolution failed for '${host}': ${err?.message || err}`);
  }

  return parsedUrl;
}

/**
 * Perform fetch() with redirect:'manual' and SSRF re-validation on every redirect hop.
 */
export async function safeExternalFetch(
  rawUrl: string,
  init: RequestInit = {},
  context: SkillContext = {},
  maxRedirects = 5
): Promise<Response> {
  let currentUrl = (await validateExternalUrl(rawUrl, context)).href;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(currentUrl, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      if (hop === maxRedirects) {
        throw new Error(`Too many redirects (>${maxRedirects}) while fetching ${rawUrl}`);
      }
      const nextUrl = new URL(loc, currentUrl).href;
      currentUrl = (await validateExternalUrl(nextUrl, context)).href;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects while fetching ${rawUrl}`);
}

// Simple HTML to readable text / markdown stripper with safe regex patterns
function htmlToMarkdown(html: string) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();

  return text;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain'
};

function inferMimeType(filePath?: string, explicit?: string): string {
  if (explicit) return explicit;
  if (!filePath) return 'application/octet-stream';
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export const webSkills: SkillDefinition[] = [
  {
    name: 'search_web',
    description: 'Search the web for real-time information, documentation, news, or answers to general knowledge questions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { type: 'number', description: 'Maximum number of search results to return (default: 5)' }
      },
      required: ['query']
    },
    execute: async ({ query, maxResults = 5 }) => {
      try {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(ddgUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OM-Agent/1.0'
          },
          signal: AbortSignal.timeout(12000)
        });

        if (res.ok) {
          const html = await res.text();
          const results = [];
          const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
          let match;
          while ((match = regex.exec(html)) !== null && results.length < maxResults) {
            let link = match[1];
            const uddgMatch = link.match(/[?&]uddg=([^&]+)/);
            if (uddgMatch) {
              link = decodeURIComponent(uddgMatch[1]);
            }
            const title = match[2].replace(/<[^>]+>/g, '').trim();
            const snippet = match[3].replace(/<[^>]+>/g, '').trim();
            if (title && link) {
              results.push({ title, url: link, snippet });
            }
          }

          if (results.length > 0) {
            return {
              success: true,
              query,
              count: results.length,
              results
            };
          }
        }

        // Fallback to Wikipedia OpenSearch API
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${maxResults}&namespace=0&format=json`;
        const wikiRes = await fetch(wikiUrl, {
          headers: { 'User-Agent': 'OM-Agent/1.0' },
          signal: AbortSignal.timeout(10000)
        });
        if (wikiRes.ok) {
          const wikiData = await wikiRes.json();
          const titles = wikiData[1] || [];
          const snippets = wikiData[2] || [];
          const urls = wikiData[3] || [];
          const results = titles.map((t: string, i: number) => ({
            title: t,
            snippet: snippets[i] || '',
            url: urls[i] || ''
          }));
          return {
            success: true,
            query,
            count: results.length,
            results
          };
        }

        return { success: false, query, error: 'No results returned from search provider.' };
      } catch (err: any) {
        return { success: false, query, error: err.message };
      }
    }
  },

  {
    name: 'fetch_page',
    description: 'Fetch a web page by URL and extract its text/markdown content.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The HTTP or HTTPS URL to fetch' },
        maxChars: { type: 'number', description: 'Max characters to return (default: 8000)' }
      },
      required: ['url']
    },
    execute: async ({ url, maxChars = 8000 }, context = {}) => {
      try {
        if (!url) return { success: false, error: 'URL is required' };
        const res = await safeExternalFetch(url, {
          headers: {
            'User-Agent': 'OM-Agent/1.0 (Agent Harness)'
          },
          signal: AbortSignal.timeout(15000)
        }, context);

        if (!res.ok) {
          return { success: false, status: res.status, error: `HTTP ${res.status}: ${res.statusText}` };
        }

        const raw = await res.text();
        const cleaned = htmlToMarkdown(raw);
        const truncated = cleaned.slice(0, maxChars);

        return {
          success: true,
          url,
          status: res.status,
          totalChars: cleaned.length,
          content: truncated + (cleaned.length > maxChars ? '\n\n...[Truncated]' : '')
        };
      } catch (err: any) {
        return { success: false, url, error: err.message };
      }
    }
  },

  {
    name: 'http_request',
    description: 'Perform an HTTP request (GET, POST, PUT, DELETE) with optional multi-modal files/images and SSE token streaming.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Optional key-value object of headers' },
        body: { type: 'string', description: 'Optional JSON or string payload for POST/PUT' },
        files: {
          type: 'array',
          description: 'Optional workspace files to upload via multipart/form-data',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              path: { type: 'string' },
              filename: { type: 'string' },
              mimeType: { type: 'string' }
            }
          }
        },
        images: {
          type: 'array',
          description: 'Optional images (workspace path, base64, or url) for multi-modal requests',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              path: { type: 'string' },
              base64: { type: 'string' },
              url: { type: 'string' },
              filename: { type: 'string' },
              mimeType: { type: 'string' }
            }
          }
        },
        multipart: { type: 'boolean', description: 'Force multipart/form-data encoding (auto-enabled for files/images)' },
        stream: { type: 'boolean', description: 'Stream SSE/token responses when true or when server returns text/event-stream' }
      },
      required: ['url']
    },
    execute: async (
      {
        url,
        method = 'GET',
        headers = {},
        body,
        files,
        images,
        multipart,
        stream = false
      }: {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: any;
        files?: HttpFileInput[];
        images?: HttpImageInput[];
        multipart?: boolean;
        stream?: boolean;
      },
      context: SkillContext = {}
    ) => {
      try {
        if (!url) return { success: false, error: 'URL is required' };
        await validateExternalUrl(url, context);

        const upperMethod = method.toUpperCase();
        const hasAttachments = (Array.isArray(files) && files.length > 0) || (Array.isArray(images) && images.length > 0);
        const useMultipart = multipart ?? hasAttachments;
        const reqHeaders: Record<string, string> = {
          'User-Agent': 'OM-Agent/1.0',
          ...(useMultipart ? {} : { 'Content-Type': 'application/json' }),
          ...(stream ? { Accept: 'text/event-stream, application/json' } : {}),
          ...headers
        };

        const options: RequestInit = {
          method: upperMethod,
          headers: reqHeaders,
          signal: context.signal
            ? AbortSignal.any([context.signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000)
        };

        if (['POST', 'PUT', 'PATCH'].includes(upperMethod)) {
          if (useMultipart) {
            const form = new FormData();
            if (body !== undefined && body !== null) {
              if (typeof body === 'object') {
                for (const [k, v] of Object.entries(body)) {
                  form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
                }
              } else {
                form.append('body', String(body));
              }
            }
            const baseDir = context.config?.workspaceDir || process.cwd();
            for (const f of files || []) {
              const safePath = resolveSafePath(f.path, baseDir, context);
              const bytes = fs.readFileSync(safePath);
              const mime = inferMimeType(safePath, f.mimeType);
              form.append(f.field || 'file', new Blob([bytes], { type: mime }), f.filename || path.basename(safePath));
            }
            for (const img of images || []) {
              if (img.path) {
                const safePath = resolveSafePath(img.path, baseDir, context);
                const bytes = fs.readFileSync(safePath);
                const mime = inferMimeType(safePath, img.mimeType);
                form.append(img.field || 'image', new Blob([bytes], { type: mime }), img.filename || path.basename(safePath));
              } else if (img.base64) {
                const cleanB64 = img.base64.replace(/^data:[^;]+;base64,/, '');
                const bytes = Buffer.from(cleanB64, 'base64');
                const mime = img.mimeType || 'image/png';
                form.append(img.field || 'image', new Blob([bytes], { type: mime }), img.filename || 'image.png');
              } else if (img.url) {
                form.append(img.field || 'image_url', img.url);
              }
            }
            options.body = form;
          } else if (body !== undefined) {
            options.body = typeof body === 'object' ? JSON.stringify(body) : String(body);
          }
        }

        const res = await safeExternalFetch(url, options as RequestInit, context);
        const contentType = res.headers.get('content-type') || '';

        if (stream || contentType.includes('text/event-stream')) {
          const events: SSEParsedEvent[] = [];
          let text = '';
          await consumeSSEStream(res, (dataStr, eventName, id) => {
            const { token, json } = extractSSEToken(dataStr);
            if (token) text += token;
            const ev: SSEParsedEvent = {
              event: eventName,
              ...(id ? { id } : {}),
              data: dataStr,
              ...(json !== undefined ? { json } : {}),
              ...(token ? { token } : {})
            };
            events.push(ev);
            context.onStreamEvent?.(ev);
            context.agent?.emit?.('http_stream', { url, ...ev });
          });
          return {
            success: res.ok,
            status: res.status,
            statusText: res.statusText,
            contentType,
            streamed: true,
            events,
            text
          };
        }

        if (/^(image|audio|video)\/|application\/(octet-stream|pdf)/i.test(contentType)) {
          const buf = Buffer.from(await res.arrayBuffer());
          return {
            success: res.ok,
            status: res.status,
            statusText: res.statusText,
            contentType,
            isBinary: true,
            sizeBytes: buf.length,
            base64: buf.toString('base64')
          };
        }

        const data = contentType.includes('application/json')
          ? await res.json()
          : await res.text();

        return {
          success: res.ok,
          status: res.status,
          statusText: res.statusText,
          contentType,
          data
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  }
];
