import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ExecutionBackend, SkillContext } from '../types.js';
import { defaultLocalExecutionBackend, getExecutionBackend } from '../execution/backend.js';
import { resolveSafePath } from './filesystem.js';

const CODE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|c|h|cc|cpp|cxx|hpp|hh)$/i;

export interface LspServerSpec {
  language: string;
  extensions: string[];
  candidates: Array<{ cmd: string; args: string[] }>;
}

const BUILTIN_LSP_SERVERS: LspServerSpec[] = [
  {
    language: 'typescript',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    candidates: [] // resolved via resolveTscExecutable
  },
  {
    language: 'python',
    extensions: ['.py', '.pyi'],
    candidates: [
      { cmd: 'pyright-langserver', args: ['--stdio'] },
      { cmd: 'pylsp', args: [] }
    ]
  },
  {
    language: 'go',
    extensions: ['.go'],
    candidates: [{ cmd: 'gopls', args: [] }]
  },
  {
    language: 'rust',
    extensions: ['.rs'],
    candidates: [{ cmd: 'rust-analyzer', args: [] }]
  },
  {
    language: 'cpp',
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
    candidates: [{ cmd: 'clangd', args: [] }]
  }
];

const binaryProbeCache = new Map<string, boolean>();

function isBinaryOnPath(cmd: string): boolean {
  if (binaryProbeCache.has(cmd)) return binaryProbeCache.get(cmd)!;
  if (path.isAbsolute(cmd)) {
    const exists = fs.existsSync(cmd);
    binaryProbeCache.set(cmd, exists);
    return exists;
  }
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(checker, [cmd], { stdio: 'ignore', timeout: 2000, windowsHide: true });
    const ok = res.status === 0;
    binaryProbeCache.set(cmd, ok);
    return ok;
  } catch {
    binaryProbeCache.set(cmd, false);
    return false;
  }
}

export function detectLspLanguage(filePath: string, customServers?: Record<string, { extensions?: string[]; command: string; args?: string[] }>): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return null;
  if (customServers) {
    for (const [lang, cfg] of Object.entries(customServers)) {
      if (Array.isArray(cfg?.extensions) && cfg.extensions.some((e) => e.toLowerCase() === ext)) {
        return lang;
      }
    }
  }
  for (const spec of BUILTIN_LSP_SERVERS) {
    if (spec.extensions.includes(ext)) return spec.language;
  }
  return null;
}

function getLspLanguageId(filePath: string, language: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.jsx') return 'javascriptreact';
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (['.ts', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (ext === '.c' || ext === '.h') return 'c';
  return language;
}
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

async function resolveTscExecutable(rootDir: string): Promise<string | null> {
  for (const reqBase of [path.join(rootDir, 'package.json'), import.meta.url]) {
    try {
      const req = createRequire(reqBase);
      const tsPkgPath = req.resolve('typescript/package.json');
      const getExe = path.join(path.dirname(tsPkgPath), 'lib', 'getExePath.js');
      if (fs.existsSync(getExe)) {
        const mod = await import(pathToFileURL(getExe).href);
        const exe = typeof mod.default === 'function' ? mod.default() : null;
        if (exe && fs.existsSync(exe)) {
          return exe;
        }
      }
    } catch {
      // Try next resolution root
    }
  }
  return null;
}

interface OpenFileState {
  version: number;
  mtimeMs: number;
  content: string;
}

class GenericLspClient {
  rootDir: string;
  language: string;
  customServer?: { command: string; args?: string[] };
  execution: ExecutionBackend;
  proc: ChildProcessWithoutNullStreams | null = null;
  initPromise: Promise<void> | null = null;
  nextId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  buffer = Buffer.alloc(0);
  openFiles = new Map<string, OpenFileState>();
  diagnosticsByUri = new Map<string, any[]>();
  idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    rootDir: string,
    language = 'typescript',
    execution: ExecutionBackend = defaultLocalExecutionBackend,
    customServer?: { command: string; args?: string[] }
  ) {
    this.rootDir = path.resolve(rootDir);
    this.language = language;
    this.execution = execution;
    this.customServer = customServer;
  }

  private bumpIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), 60000);
    this.idleTimer.unref?.();
  }

  private async resolveServerCommand(): Promise<{ cmd: string; args: string[] } | null> {
    if (this.customServer?.command) {
      if (isBinaryOnPath(this.customServer.command)) {
        return { cmd: this.customServer.command, args: this.customServer.args || [] };
      }
      return null;
    }
    if (this.language === 'typescript') {
      const exe = await resolveTscExecutable(this.rootDir);
      return exe ? { cmd: exe, args: ['--lsp', '--stdio'] } : null;
    }
    const spec = BUILTIN_LSP_SERVERS.find((s) => s.language === this.language);
    if (!spec) return null;
    for (const cand of spec.candidates) {
      if (isBinaryOnPath(cand.cmd)) {
        return cand;
      }
    }
    return null;
  }

  async ensureStarted(): Promise<void> {
    this.bumpIdleTimer();
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const resolved = await this.resolveServerCommand();
      if (!resolved) {
        this.initPromise = null;
        throw new Error(`LSP server for '${this.language}' is not installed in this environment.`);
      }

      const proc = this.execution.spawnInteractive
        ? this.execution.spawnInteractive(resolved.cmd, resolved.args, { cwd: this.rootDir, env: process.env })
        : spawn(resolved.cmd, resolved.args, {
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

  async syncFile(filePath: string): Promise<{ uri: string; content: string } | null> {
    if (!(await this.execution.exists(filePath))) return null;
    const stat = await this.execution.stat(filePath);
    if (!stat.isFile) return null;

    const uri = pathToFileURL(path.resolve(filePath)).href;
    const cached = this.openFiles.get(uri);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { uri, content: cached.content };
    }

    const content = await this.execution.readFile(filePath, 'utf8');
    const languageId = getLspLanguageId(filePath, this.language);

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
        this.proc.stdin?.destroy();
        this.proc.stdout?.destroy();
        this.proc.stderr?.destroy();
        this.proc.kill();
      } catch (_) {}
      this.proc = null;
    }
    this.initPromise = null;
    this.openFiles.clear();
  }
}

const clientCache = new Map<string, GenericLspClient>();

export function disposeAllLspClients() {
  for (const client of clientCache.values()) {
    client.dispose();
  }
  clientCache.clear();
}

function getLspClient(
  workspaceDir: string,
  execution: ExecutionBackend = defaultLocalExecutionBackend,
  language = 'typescript',
  customServer?: { command: string; args?: string[] }
): GenericLspClient {
  const key = `${execution.name}:${language}:${path.resolve(workspaceDir || process.cwd())}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new GenericLspClient(workspaceDir, language, execution, customServer);
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
 * Run fast multi-language LSP diagnostics on a single file (used by auto-diagnostics after edits).
 * Supports TypeScript/JS, Python (pyright/pylsp), Go (gopls), Rust (rust-analyzer), C/C++ (clangd),
 * and any custom servers configured in `config.lsp.servers`.
 */
export async function getFileDiagnostics(
  filePath: string,
  workspaceDir: string,
  maxDiagnostics = 20,
  execution: ExecutionBackend = defaultLocalExecutionBackend,
  customServers?: Record<string, { extensions?: string[]; command: string; args?: string[] }>
) {
  const language = detectLspLanguage(filePath, customServers);
  if (!language && !CODE_EXT_RE.test(filePath)) return [];
  const resolvedLang = language || 'typescript';
  const client = getLspClient(workspaceDir, execution, resolvedLang, customServers?.[resolvedLang]);
  try {
    await client.ensureStarted();
  } catch (_) {
    return [];
  }

  const synced = await client.syncFile(filePath);
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

      const customServers = (context.config as Record<string, any>)?.lsp?.servers;
      const lang = detectLspLanguage(target, customServers) || 'typescript';
      const client = getLspClient(workspaceDir, getExecutionBackend(context), lang, customServers?.[lang]);
      try {
        await client.ensureStarted();
      } catch (err: any) {
        return { success: false, error: err.message };
      }

      const synced = await client.syncFile(target);
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

      const customServers = (context.config as Record<string, any>)?.lsp?.servers;
      const lang = detectLspLanguage(target, customServers) || 'typescript';
      const client = getLspClient(workspaceDir, getExecutionBackend(context), lang, customServers?.[lang]);
      try {
        await client.ensureStarted();
      } catch (err: any) {
        return { success: false, error: err.message };
      }

      const synced = await client.syncFile(target);
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

      const customServers = (context.config as Record<string, any>)?.lsp?.servers;
      const lang = detectLspLanguage(target, customServers) || 'typescript';
      const client = getLspClient(workspaceDir, getExecutionBackend(context), lang, customServers?.[lang]);
      try {
        await client.ensureStarted();
      } catch (err: any) {
        return { success: false, error: err.message };
      }

      const synced = await client.syncFile(target);
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

      const customServers = (context.config as Record<string, any>)?.lsp?.servers;
      const diagnostics = await getFileDiagnostics(target, workspaceDir, maxDiagnostics, getExecutionBackend(context), customServers);
      return {
        success: true,
        file: path.relative(path.resolve(workspaceDir), target),
        errorCount: diagnostics.filter((d) => d.category === 'error').length,
        diagnostics
      };
    }
  },

  {
    name: 'get_workspace_diagnostics',
    description: 'Run project-wide TypeScript typechecking diagnostics across the workspace using the execution backend.',
    parameters: {
      type: 'object',
      properties: {
        tsconfigPath: { type: 'string', description: 'Optional path to tsconfig.json (defaults to workspace tsconfig.json)' },
        maxDiagnostics: { type: 'number', description: 'Maximum diagnostics to return (default: 50)' }
      }
    },
    execute: async ({ tsconfigPath, maxDiagnostics = 50 }: { tsconfigPath?: string; maxDiagnostics?: number }, context: SkillContext = {}) => {
      const workspaceDir = path.resolve(context.config?.workspaceDir || process.cwd());
      const backend = getExecutionBackend(context);

      const tscExe = await resolveTscExecutable(workspaceDir);

      if (!tscExe) {
        return { success: false, error: 'TypeScript compiler (tsc) is not available in this environment.' };
      }

      const args = ['--noEmit', '--pretty', 'false'];
      if (tsconfigPath) {
        try {
          const safeTsConfig = resolveSafePath(tsconfigPath, workspaceDir, context);
          args.push('-p', safeTsConfig);
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }

      const res = await backend.spawn(tscExe, args, {
        cwd: workspaceDir,
        env: process.env,
        timeoutMs: 60000
      });

      const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
      const diagRegex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message)\s+(TS\d+):\s+(.+)$/;
      const diagnostics: Array<{ file: string; line: number; column: number; category: string; code: string; message: string }> = [];

      for (const line of combined.split(/\r?\n/)) {
        const m = diagRegex.exec(line.trim());
        if (m) {
          diagnostics.push({
            file: path.relative(workspaceDir, path.resolve(workspaceDir, m[1])),
            line: Number(m[2]),
            column: Number(m[3]),
            category: m[4],
            code: m[5],
            message: m[6]
          });
          if (diagnostics.length >= maxDiagnostics) break;
        }
      }

      return {
        success: true,
        exitCode: res.exitCode,
        errorCount: diagnostics.filter((d) => d.category === 'error').length,
        diagnostics
      };
    }
  },

  {
    name: 'repo_map',
    description: 'Build a dependency-ranked structural map of the repository (key files, exported symbols, and inbound import rank) so you can understand the architecture in one turn.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Optional subdirectory to map (defaults to workspace root)' },
        maxFiles: { type: 'number', description: 'Maximum ranked files to include (default: 40)' },
        maxSymbolsPerFile: { type: 'number', description: 'Maximum symbols to list per file (default: 12)' },
        focusFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative file paths to boost to the top of the map'
        }
      }
    },
    execute: async (
      { dir = '.', maxFiles = 40, maxSymbolsPerFile = 12, focusFiles = [] }: {
        dir?: string;
        maxFiles?: number;
        maxSymbolsPerFile?: number;
        focusFiles?: string[];
      },
      context: SkillContext = {}
    ) => {
      const workspaceDir = context.config?.workspaceDir || process.cwd();
      const backend = getExecutionBackend(context);
      let targetDir: string;
      try {
        targetDir = resolveSafePath(dir, workspaceDir, context);
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!(await backend.exists(targetDir))) {
        return { success: false, error: `Directory not found: ${dir}` };
      }

      const IGNORED = new Set([
        'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache',
        '.om_snapshots', '.om-worktrees', '.om_worktrees', 'coverage', '__pycache__', '.venv', 'target'
      ]);
      const MAP_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|c|h|cc|cpp|hpp)$/i;
      const MAX_SCAN_FILES = 600;
      const MAX_FILE_BYTES = 512 * 1024;

      const scannedFiles: string[] = [];
      async function walk(cur: string) {
        if (scannedFiles.length >= MAX_SCAN_FILES) return;
        let entries;
        try {
          entries = await backend.readdir(cur);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (scannedFiles.length >= MAX_SCAN_FILES) break;
          if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
          const full = path.join(cur, entry.name);
          if (entry.isDirectory) {
            await walk(full);
          } else if (entry.isFile && MAP_EXT_RE.test(entry.name)) {
            scannedFiles.push(full);
          }
        }
      }

      await walk(targetDir);

      interface FileMapNode {
        relPath: string;
        symbols: string[];
        imports: string[];
        inboundRefs: number;
      }

      const nodes = new Map<string, FileMapNode>();
      const stemIndex = new Map<string, string[]>();

      const extractSymbolsAndImports = (text: string, ext: string): { symbols: string[]; imports: string[] } => {
        const symbols: string[] = [];
        const imports: string[] = [];
        const addSym = (s: string) => {
          if (s && !symbols.includes(s)) symbols.push(s);
        };

        if (ext === '.py') {
          for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
            if (!m[1].startsWith('_')) addSym(m[1]);
          }
          for (const m of text.matchAll(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
            imports.push((m[1] || m[2] || '').replace(/\./g, '/'));
          }
        } else if (ext === '.go') {
          for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)|^type\s+([A-Z][A-Za-z0-9_]*)/gm)) {
            addSym(m[1] || m[2]);
          }
          for (const m of text.matchAll(/"([^"]+)"/g)) {
            if (m[1].includes('/')) imports.push(m[1]);
          }
        } else if (ext === '.rs') {
          for (const m of text.matchAll(/^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
            addSym(m[1]);
          }
          for (const m of text.matchAll(/^(?:use|mod)\s+([\w:]+)/gm)) {
            imports.push(m[1].replace(/::/g, '/'));
          }
        } else {
          // TS / JS / C++
          for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
            addSym(m[1]);
          }
          for (const m of text.matchAll(/(?:import\s+[\s\S]*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
            imports.push(m[1]);
          }
        }
        return { symbols, imports };
      };

      for (const full of scannedFiles) {
        try {
          const stat = await backend.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          const text = await backend.readFile(full, 'utf8');
          const relPath = path.relative(targetDir, full).replace(/\\/g, '/');
          const ext = path.extname(full).toLowerCase();
          const { symbols, imports } = extractSymbolsAndImports(text, ext);
          nodes.set(relPath, { relPath, symbols, imports, inboundRefs: 0 });

          const noExt = relPath.replace(/\.[^.]+$/, '');
          const base = path.basename(noExt);
          for (const key of [noExt, base]) {
            const arr = stemIndex.get(key) || [];
            arr.push(relPath);
            stemIndex.set(key, arr);
          }
        } catch {
          // skip unreadable file
        }
      }

      // Compute inbound dependency counts across local relative/module imports
      for (const node of nodes.values()) {
        const fromDir = path.posix.dirname(node.relPath);
        for (const imp of node.imports) {
          if (imp.startsWith('.')) {
            const normalized = path.posix.normalize(path.posix.join(fromDir, imp)).replace(/\.(js|ts|mjs|cjs)$/, '');
            const targets = stemIndex.get(normalized) || stemIndex.get(`${normalized}/index`) || [];
            for (const t of targets) {
              const targetNode = nodes.get(t);
              if (targetNode && t !== node.relPath) targetNode.inboundRefs++;
            }
          } else {
            const tail = imp.split('/').pop() || '';
            const targets = stemIndex.get(tail) || [];
            if (targets.length === 1 && targets[0] !== node.relPath) {
              const targetNode = nodes.get(targets[0]);
              if (targetNode) targetNode.inboundRefs++;
            }
          }
        }
      }

      const focusSet = new Set(focusFiles.map((f) => String(f).replace(/\\/g, '/')));
      const ranked = Array.from(nodes.values())
        .sort((a, b) => {
          const aFocus = focusSet.has(a.relPath) ? 1 : 0;
          const bFocus = focusSet.has(b.relPath) ? 1 : 0;
          if (aFocus !== bFocus) return bFocus - aFocus;
          if (b.inboundRefs !== a.inboundRefs) return b.inboundRefs - a.inboundRefs;
          return b.symbols.length - a.symbols.length;
        })
        .slice(0, Math.max(1, maxFiles));

      const mapText = ranked
        .map((n) => {
          const syms = n.symbols.slice(0, maxSymbolsPerFile).join(', ');
          const rankTag = n.inboundRefs > 0 ? ` [refs:${n.inboundRefs}]` : '';
          return `${n.relPath}${rankTag}${syms ? `: ${syms}` : ''}`;
        })
        .join('\n');

      return {
        success: true,
        totalScanned: nodes.size,
        returnedFiles: ranked.length,
        files: ranked.map((n) => ({
          file: n.relPath,
          inboundRefs: n.inboundRefs,
          symbols: n.symbols.slice(0, maxSymbolsPerFile)
        })),
        map: mapText
      };
    }
  }
];
