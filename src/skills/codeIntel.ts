import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { SkillContext } from '../types.js';
import { resolveSafePath } from './filesystem.js';

const CODE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const LSP_SYMBOL_KINDS: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter'
};
const LSP_DIAG_SEVERITY: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint'
};

interface OpenFileState {
  version: number;
  mtimeMs: number;
  content: string;
}

class TSLspClient {
  rootDir: string;
  proc: ChildProcessWithoutNullStreams | null = null;
  initPromise: Promise<void> | null = null;
  nextId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  buffer = Buffer.alloc(0);
  openFiles = new Map<string, OpenFileState>();
  diagnosticsByUri = new Map<string, any[]>();
  idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private bumpIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), 60000);
    this.idleTimer.unref?.();
  }

  private async resolveTscCommand(): Promise<{ cmd: string; args: string[] } | null> {
    try {
      const req = createRequire(path.join(this.rootDir, 'package.json'));
      const tsPkgPath = req.resolve('typescript/package.json');
      const getExe = path.join(path.dirname(tsPkgPath), 'lib', 'getExePath.js');
      if (fs.existsSync(getExe)) {
        const mod = await import(pathToFileURL(getExe).href);
        const exe = typeof mod.default === 'function' ? mod.default() : null;
        if (exe && fs.existsSync(exe)) {
          return { cmd: exe, args: ['--lsp', '--stdio'] };
        }
      }
    } catch (_) {
      // Try OMega's own node_modules
    }

    try {
      const selfReq = createRequire(import.meta.url);
      const tsPkgPath = selfReq.resolve('typescript/package.json');
      const getExe = path.join(path.dirname(tsPkgPath), 'lib', 'getExePath.js');
      if (fs.existsSync(getExe)) {
        const mod = await import(pathToFileURL(getExe).href);
        const exe = typeof mod.default === 'function' ? mod.default() : null;
        if (exe && fs.existsSync(exe)) {
          return { cmd: exe, args: ['--lsp', '--stdio'] };
        }
      }
    } catch (_) {
      // Not available
    }

    return null;
  }

  async ensureStarted(): Promise<void> {
    this.bumpIdleTimer();
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const resolved = await this.resolveTscCommand();
      if (!resolved) {
        this.initPromise = null;
        throw new Error('TypeScript LSP server is not available in this environment.');
      }

      const proc = spawn(resolved.cmd, resolved.args, {
        cwd: this.rootDir,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.proc = proc;
      this.setStreamsRef(false);

      proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
      proc.on('exit', () => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('TypeScript LSP process exited'));
        }
        this.pending.clear();
        this.proc = null;
        this.initPromise = null;
        this.openFiles.clear();
      });

      await this.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(this.rootDir).href,
        capabilities: {
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            diagnostic: { dynamicRegistration: false },
            publishDiagnostics: {}
          }
        }
      });
      this.notify('initialized', {});
    })();

    return this.initPromise;
  }

  private onStdout(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const msgStart = headerEnd + 4;
      if (this.buffer.length < msgStart + len) break;

      const bodyStr = this.buffer.slice(msgStart, msgStart + len).toString('utf8');
      this.buffer = this.buffer.slice(msgStart + len);

      try {
        const msg = JSON.parse(bodyStr);
        if (msg.method && msg.id !== undefined) {
          // Reply to server-initiated LSP requests (e.g. client/registerCapability, workspace/configuration)
          this.send({
            id: msg.id,
            result: msg.method === 'workspace/configuration' ? [] : null
          });
        } else if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (this.pending.size === 0) this.setStreamsRef(false);
          if (msg.error) entry.reject(new Error(msg.error.message || 'LSP error'));
          else entry.resolve(msg.result);
        } else if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
          this.diagnosticsByUri.set(msg.params.uri, msg.params.diagnostics || []);
        }
      } catch (_) {
        // Ignore malformed frame
      }
    }
  }

  private setStreamsRef(active: boolean) {
    if (!this.proc) return;
    const fn = active ? 'ref' : 'unref';
    (this.proc as any)[fn]?.();
    (this.proc.stdin as any)?.[fn]?.();
    (this.proc.stdout as any)?.[fn]?.();
    (this.proc.stderr as any)?.[fn]?.();
  }

  private send(payload: Record<string, any>) {
    if (!this.proc?.stdin.writable) return;
    const body = JSON.stringify({ jsonrpc: '2.0', ...payload });
    const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    this.proc.stdin.write(frame);
  }

  notify(method: string, params: any) {
    this.send({ method, params });
  }

  request(method: string, params: any, timeoutMs = 15000): Promise<any> {
    this.bumpIdleTimer();
    const id = this.nextId++;
    this.setStreamsRef(true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pending.size === 0) this.setStreamsRef(false);
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  syncFile(filePath: string): { uri: string; content: string } | null {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    const uri = pathToFileURL(path.resolve(filePath)).href;
    const cached = this.openFiles.get(uri);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { uri, content: cached.content };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();
    const languageId = ext === '.tsx' ? 'typescriptreact' : ext === '.jsx' ? 'javascriptreact' : ext.includes('js') ? 'javascript' : 'typescript';

    if (!cached) {
      const state: OpenFileState = { version: 1, mtimeMs: stat.mtimeMs, content };
      this.openFiles.set(uri, state);
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content }
      });
    } else {
      const nextVersion = cached.version + 1;
      this.openFiles.set(uri, { version: nextVersion, mtimeMs: stat.mtimeMs, content });
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text: content }]
      });
    }

    return { uri, content };
  }

  dispose() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (_) {}
      this.proc = null;
    }
    this.initPromise = null;
    this.openFiles.clear();
  }
}

const clientCache = new Map<string, TSLspClient>();

function getLspClient(workspaceDir: string): TSLspClient {
  const key = path.resolve(workspaceDir || process.cwd());
  let client = clientCache.get(key);
  if (!client) {
    client = new TSLspClient(key);
    clientCache.set(key, client);
  }
  return client;
}

function resolveLineCol(content: string, line?: number, column?: number, symbol?: string): { line: number; character: number; error?: string } {
  const lines = content.split(/\r?\n/);

  if (typeof line === 'number' && line >= 1) {
    if (line > lines.length) {
      return { line: 0, character: 0, error: `Line ${line} is out of range (file has ${lines.length} lines).` };
    }
    const lineText = lines[line - 1] || '';
    if (symbol && typeof symbol === 'string') {
      const idx = lineText.indexOf(symbol);
      if (idx >= 0) return { line: line - 1, character: idx };
    }
    const charIdx = typeof column === 'number' && column >= 1 ? column - 1 : 0;
    return { line: line - 1, character: charIdx };
  }

  if (symbol && typeof symbol === 'string') {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m && typeof m.index === 'number') {
        return { line: i, character: m.index };
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf(symbol);
      if (idx >= 0) return { line: i, character: idx };
    }
    return { line: 0, character: 0, error: `Symbol '${symbol}' not found in file.` };
  }

  return { line: 0, character: 0, error: 'Either line (1-based) or symbol is required.' };
}

function mapDocumentSymbols(items: any[]): any[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const range = item.range || item.location?.range;
    const entry: Record<string, any> = {
      name: item.name,
      kind: LSP_SYMBOL_KINDS[item.kind] || String(item.kind),
      startLine: (range?.start?.line ?? 0) + 1,
      endLine: (range?.end?.line ?? 0) + 1
    };
    if (Array.isArray(item.children) && item.children.length > 0) {
      entry.children = mapDocumentSymbols(item.children);
    }
    return entry;
  });
}

function getLinePreview(filePath: string, zeroBasedLine: number): string {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    return (lines[zeroBasedLine] || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Run fast TypeScript LSP diagnostics on a single file (used by auto-diagnostics after edits).
 */
export async function getFileDiagnostics(filePath: string, workspaceDir: string, maxDiagnostics = 20) {
  if (!CODE_EXT_RE.test(filePath)) return [];
  const client = getLspClient(workspaceDir);
  try {
    await client.ensureStarted();
  } catch (_) {
    return [];
  }

  const synced = client.syncFile(filePath);
  if (!synced) return [];

  let items: any[] = [];
  try {
    const res = await client.request('textDocument/diagnostic', {
      textDocument: { uri: synced.uri }
    });
    if (Array.isArray(res?.items)) {
      items = res.items;
    }
  } catch (_) {
    items = client.diagnosticsByUri.get(synced.uri) || [];
  }

  return items.slice(0, maxDiagnostics).map((d) => ({
    file: path.relative(client.rootDir, filePath),
    line: (d.range?.start?.line ?? 0) + 1,
    column: (d.range?.start?.character ?? 0) + 1,
    category: LSP_DIAG_SEVERITY[d.severity] || 'error',
    code: d.code,
    message: String(d.message || '')
  }));
}

export const codeIntelSkills = [
  {
    name: 'file_outline',
    description: 'Return a structural outline of classes, functions, methods, interfaces, and line ranges in a TS/JS file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the TypeScript or JavaScript file' }
      },
      required: ['path']
    },
    execute: async ({ path: filePath }: Record<string, any>, context: SkillContext = {}) => {
      const workspaceDir = context.config?.workspaceDir || process.cwd();
      let target: string;
      try {
        target = resolveSafePath(filePath, workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(target)) return { success: false, error: `File not found: ${filePath}` };

      const client = getLspClient(workspaceDir);
      try {
        await client.ensureStarted();
      } catch (err: any) {
        return { success: false, error: err.message };
      }

      const synced = client.syncFile(target);
      if (!synced) return { success: false, error: `Unable to read file: ${filePath}` };

      const raw = await client.request('textDocument/documentSymbol', {
        textDocument: { uri: synced.uri }
      });
      const outline = mapDocumentSymbols(raw);
      return {
        success: true,
        path: path.relative(client.rootDir, target),
        symbolCount: outline.length,
        outline
      };
    }
  },

  {
    name: 'go_to_definition',
    description: 'Resolve the exact definition location (file, line, column) of a symbol in a TS/JS file using LSP.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file containing the symbol usage' },
        line: { type: 'number', description: 'Optional 1-based line number' },
        column: { type: 'number', description: 'Optional 1-based column number' },
        symbol: { type: 'string', description: 'Optional symbol name to locate in the file or on the given line' }
      },
      required: ['path']
    },
    execute: async ({ path: filePath, line, column, symbol }: Record<string, any>, context: SkillContext = {}) => {
      const workspaceDir = context.config?.workspaceDir || process.cwd();
      let target: string;
      try {
        target = resolveSafePath(filePath, workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(target)) return { success: false, error: `File not found: ${filePath}` };

      const client = getLspClient(workspaceDir);
      try {
        await client.ensureStarted();
      } catch (err: any) {
        return { success: false, error: err.message };
      }

      const synced = client.syncFile(target);
      if (!synced) return { success: false, error: `Unable to read file: ${filePath}` };

      const pos = resolveLineCol(synced.content, line, column, symbol);
      if (pos.error) return { success: false, error: pos.error };

      const raw = await client.request('textDocument/definition', {
        textDocument: { uri: synced.uri },
        position: { line: pos.line, character: pos.character }
      });
      const locs = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const definitions = locs.map((loc: any) => {
        const uri = loc.uri || loc.targetUri;
        const range = loc.range || loc.targetSelectionRange || loc.targetRange;
        const defPath = uri ? fileURLToPath(uri) : target;
        const zeroLine = range?.start?.line ?? 0;
        return {
          file: path.relative(client.rootDir, defPath),
          line: zeroLine + 1,
          column: (range?.start?.character ?? 0) + 1,
          preview: getLinePreview(defPath, zeroLine)
        };
      });

      return {
        success: true,
        count: definitions.length,
        definitions
      };
    }
  },

  {
    name: 'find_references',
    description: 'Find all semantic references across the project for a symbol in a TS/JS file using LSP.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file containing the symbol' },
        line: { type: 'number', description: 'Optional 1-based line number' },
        column: { type: 'number', description: 'Optional 1-based column number' },
        symbol: { type: 'string', description: 'Optional symbol name to locate in the file or on the given line' },
        maxResults: { type: 'number', description: 'Maximum references to return (default: 50)' }
      },
      required: ['path']
    },
    execute: async ({ path: filePath, line, column, symbol, maxResults = 50 }: Record<string, any>, context: SkillContext = {}) => {
      const workspaceDir = context.config?.workspaceDir || process.cwd();
      let target: string;
      try {
        target = resolveSafePath(filePath, workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(target)) return { success: false, error: `File not found: ${filePath}` };

      const client = getLspClient(workspaceDir);
      try {
        await client.ensureStarted();
      } catch (err: any) {
        return { success: false, error: err.message };
      }

      const synced = client.syncFile(target);
      if (!synced) return { success: false, error: `Unable to read file: ${filePath}` };

      const pos = resolveLineCol(synced.content, line, column, symbol);
      if (pos.error) return { success: false, error: pos.error };

      const raw = await client.request('textDocument/references', {
        textDocument: { uri: synced.uri },
        position: { line: pos.line, character: pos.character },
        context: { includeDeclaration: true }
      });
      const locs = Array.isArray(raw) ? raw.slice(0, maxResults) : [];
      const references = locs.map((loc: any) => {
        const refPath = loc.uri ? fileURLToPath(loc.uri) : target;
        const zeroLine = loc.range?.start?.line ?? 0;
        return {
          file: path.relative(client.rootDir, refPath),
          line: zeroLine + 1,
          column: (loc.range?.start?.character ?? 0) + 1,
          lineText: getLinePreview(refPath, zeroLine)
        };
      });

      return {
        success: true,
        count: references.length,
        references
      };
    }
  },

  {
    name: 'get_diagnostics',
    description: 'Run fast TypeScript syntactic and semantic diagnostics on a file without spawning a full build.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to check' },
        maxDiagnostics: { type: 'number', description: 'Maximum diagnostics to return (default: 30)' }
      },
      required: ['path']
    },
    execute: async ({ path: filePath, maxDiagnostics = 30 }: Record<string, any>, context: SkillContext = {}) => {
      const workspaceDir = context.config?.workspaceDir || process.cwd();
      let target: string;
      try {
        target = resolveSafePath(filePath, workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!fs.existsSync(target)) return { success: false, error: `File not found: ${filePath}` };

      const diagnostics = await getFileDiagnostics(target, workspaceDir, maxDiagnostics);
      return {
        success: true,
        file: path.relative(path.resolve(workspaceDir), target),
        errorCount: diagnostics.filter((d) => d.category === 'error').length,
        diagnostics
      };
    }
  }
];
