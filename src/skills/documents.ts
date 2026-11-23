import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveSafePath } from './filesystem.js';
import type { SkillContext, SkillDefinition } from '../types.js';

function getErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function decodePdfLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

function extractTextFromPdfContent(content: string): string[] {
  const chunks: string[] = [];
  // Match simple Tj strings: (Hello World) Tj
  for (const m of content.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)) {
    const decoded = decodePdfLiteral(m[1]).trim();
    if (decoded) chunks.push(decoded);
  }
  // Match TJ arrays: [(Hello) -20 (World)] TJ
  for (const m of content.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    const parts: string[] = [];
    for (const sm of m[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)) {
      parts.push(decodePdfLiteral(sm[1]));
    }
    const joined = parts.join('').trim();
    if (joined) chunks.push(joined);
  }
  return chunks;
}

/**
 * Extract readable text from a PDF buffer (supports plain and FlateDecode streams, zero external deps).
 */
export function extractTextFromPdfBuffer(buf: Buffer): { text: string; streamCount: number } {
  const latin = buf.toString('latin1');
  const extracted: string[] = [];
  let streamCount = 0;

  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(latin)) !== null) {
    streamCount += 1;
    const rawStream = Buffer.from(match[1], 'latin1');
    let content = '';
    try {
      content = zlib.inflateSync(rawStream).toString('latin1');
    } catch (_err: unknown) {
      content = rawStream.toString('latin1');
    }
    extracted.push(...extractTextFromPdfContent(content));
  }

  if (extracted.length === 0) {
    extracted.push(...extractTextFromPdfContent(latin));
  }

  return {
    text: extracted.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    streamCount
  };
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function simpleMarkdownToHtml(md: string, title = 'Document'): string {
  const lines = String(md || '').split(/\r?\n/);
  const body: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      body.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      body.push(escapeHtml(line));
      continue;
    }
    if (/^###\s+/.test(line)) body.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ''))}</h3>`);
    else if (/^##\s+/.test(line)) body.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`);
    else if (/^#\s+/.test(line)) body.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`);
    else if (/^[-*]\s+/.test(line)) body.push(`<li>${escapeHtml(line.replace(/^[-*]\s+/, ''))}</li>`);
    else if (line.trim() === '') body.push('<br/>');
    else body.push(`<p>${escapeHtml(line)}</p>`);
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; line-height: 1.6; color: #1a1a1a; font-size: 14px; }
  h1, h2, h3 { font-family: system-ui, -apple-system, sans-serif; color: #111; margin-top: 1.4em; }
  pre { background: #f4f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>${body.join('\n')}</body>
</html>`;
}

export const documentSkills: SkillDefinition[] = [
  {
    name: 'pdf_read',
    description: 'Extract readable text from a local PDF file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the PDF file' },
        maxChars: { type: 'number', description: 'Optional max characters to return (default: 24000)' }
      },
      required: ['path']
    },
    execute: async (args: Record<string, unknown>, context: SkillContext = {}) => {
      const filePath = String(args.path || '');
      const maxChars = Math.max(500, Number(args.maxChars || 24_000));
      let target: string;
      try {
        target = resolveSafePath(filePath, context.config?.workspaceDir, context);
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
      if (!fs.existsSync(target)) {
        return { success: false, error: `PDF not found: ${filePath}` };
      }
      try {
        const buf = fs.readFileSync(target);
        const { text, streamCount } = extractTextFromPdfBuffer(buf);
        const truncated = text.length > maxChars;
        return {
          success: true,
          path: target,
          streamCount,
          charCount: text.length,
          truncated,
          text: truncated ? text.slice(0, maxChars) : text,
          summary: text.length
            ? `Extracted ${text.length} char(s) from ${path.basename(target)}.`
            : `No selectable text found in ${path.basename(target)} (may be a scanned image PDF).`
        };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  },
  {
    name: 'markdown_to_pdf',
    description: 'Render Markdown content into a formatted PDF file using headless Chromium (Playwright).',
    parameters: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'Markdown content to convert' },
        outputPath: { type: 'string', description: 'Destination PDF file path (e.g. report.pdf)' },
        title: { type: 'string', description: 'Optional document title' }
      },
      required: ['markdown', 'outputPath']
    },
    execute: async (args: Record<string, unknown>, context: SkillContext = {}) => {
      const markdown = String(args.markdown || '');
      const outputPath = String(args.outputPath || '');
      const title = String(args.title || path.basename(outputPath, '.pdf') || 'Document');

      let target: string;
      try {
        target = resolveSafePath(outputPath, context.config?.workspaceDir, context);
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }

      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const html = simpleMarkdownToHtml(markdown, title);
        const pw = await import('playwright');
        const browser = await pw.chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.setContent(html, { waitUntil: 'load' });
          await page.pdf({
            path: target,
            format: 'A4',
            margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
            printBackground: true
          });
        } finally {
          await browser.close();
        }
        const stat = fs.statSync(target);
        return {
          success: true,
          path: target,
          sizeBytes: stat.size,
          summary: `Created PDF ${path.basename(target)} (${Math.round(stat.size / 1024)} KB).`
        };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  }
];
