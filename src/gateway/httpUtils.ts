import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp'
};

export const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB payload ceiling

/**
 * Send a JSON response with status code.
 */
export function sendJson(res: http.ServerResponse, status: number, data: unknown, pretty = false): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

/**
 * Safely parse incoming JSON request body using Buffer concatenation (UTF-8 chunk-safe)
 * with max payload size limit.
 */
export function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes = MAX_BODY_BYTES
): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;

    const finish = (val: Record<string, any> | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      receivedBytes += buf.length;
      if (receivedBytes > maxBytes) {
        if (!res.headersSent) {
          sendJson(res, 413, { error: `Payload Too Large: request body exceeds ${maxBytes} bytes` });
        }
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = raw ? JSON.parse(raw) : {};
        finish(parsed);
      } catch (err: any) {
        if (!res.headersSent) {
          sendJson(res, 400, { error: `Malformed JSON: ${err.message}` });
        }
        finish(null);
      }
    });

    req.on('error', (err: Error) => {
      if (!res.headersSent) {
        sendJson(res, 400, { error: err.message });
      }
      finish(null);
    });
  });
}

/**
 * Resolve `<!-- @include partials/... -->` directives in HTML files across publicDirs
 * with directory traversal protection.
 */
export function resolveHtmlIncludes(html: string, publicDirOrDirs: string | string[]): string {
  const publicDirs = Array.isArray(publicDirOrDirs) ? publicDirOrDirs : [publicDirOrDirs];
  return html.replace(/<!--\s*@include\s+([^\s]+)\s*-->/g, (_match, relInclude: string) => {
    for (const publicDir of publicDirs) {
      const resolved = path.resolve(publicDir, relInclude);
      const rel = path.relative(publicDir, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return fs.readFileSync(resolved, 'utf8');
      }
    }
    return '';
  });
}

/**
 * Serve static dashboard files from one or more publicDirs with directory traversal protection.
 */
export function serveStatic(
  res: http.ServerResponse,
  pathname: string,
  publicDirOrDirs: string | string[]
): boolean {
  const publicDirs = Array.isArray(publicDirOrDirs) ? publicDirOrDirs : [publicDirOrDirs];
  const sanitizedRelPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  for (const publicDir of publicDirs) {
    const resolvedFilePath = path.resolve(publicDir, sanitizedRelPath);
    const relToPublic = path.relative(publicDir, resolvedFilePath);

    if (relToPublic.startsWith('..') || path.isAbsolute(relToPublic)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Access Denied');
      return true;
    }

    if (fs.existsSync(resolvedFilePath) && fs.statSync(resolvedFilePath).isFile()) {
      const ext = path.extname(resolvedFilePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const headers: Record<string, string> = { 'Content-Type': mime };
      if (ext === '.html') {
        const rendered = resolveHtmlIncludes(fs.readFileSync(resolvedFilePath, 'utf8'), publicDirs);
        res.writeHead(200, headers);
        res.end(rendered);
        return true;
      }
      if (['.css', '.js'].includes(ext)) {
        headers['Cache-Control'] = 'no-cache, must-revalidate';
      } else if (['.png', '.ico', '.svg', '.jpeg', '.jpg', '.webp'].includes(ext)) {
        headers['Cache-Control'] = 'public, max-age=3600';
      }
      res.writeHead(200, headers);
      fs.createReadStream(resolvedFilePath).pipe(res);
      return true;
    }
  }

  return false;
}
