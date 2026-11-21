import fs from 'node:fs';
import path from 'node:path';
import { defaultLocalExecutionBackend } from './execution/backend.js';
import type { ExecutionBackend, ExecutionDirEntry, ExecutionFileStat } from './types.js';

/**
 * Lightweight Zero-Dependency Workspace Snapshot & Rollback Manager ("Undo Agent Run").
 * Tracks original file contents before agent mutations so any run can be inspected or reverted.
 */
export class WorkspaceSnapshotManager {
  workspaceDir: string;
  snapshotRoot: string;
  execution: ExecutionBackend;
  runs: Map<string, any>;

  constructor(
    workspaceDir = process.cwd(),
    snapshotRoot: string | null = null,
    execution: ExecutionBackend = defaultLocalExecutionBackend
  ) {
    this.workspaceDir = path.resolve(workspaceDir || process.cwd());
    this.snapshotRoot = snapshotRoot || path.join(this.workspaceDir, '.om_snapshots');
    this.execution = execution;
    this.runs = new Map();
  }

  private _existsSync(p: string): boolean {
    const res = this.execution.exists(p);
    return typeof res === 'boolean' ? res : fs.existsSync(p);
  }

  private _statSync(p: string): ExecutionFileStat {
    const res = this.execution.stat(p);
    if (res && !(res instanceof Promise)) return res;
    const s = fs.statSync(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
  }

  private _readFileSync(p: string): string {
    const res = this.execution.readFile(p, 'utf8');
    return typeof res === 'string' ? res : fs.readFileSync(p, 'utf8');
  }

  private _writeFileSync(p: string, content: string): void {
    const res = this.execution.writeFile(p, content, 'utf8');
    if (res instanceof Promise) {
      fs.writeFileSync(p, content, 'utf8');
    }
  }

  private _mkdirSync(p: string): void {
    const res = this.execution.mkdir(p, { recursive: true });
    if (res instanceof Promise) {
      fs.mkdirSync(p, { recursive: true });
    }
  }

  private _readdirSync(p: string): ExecutionDirEntry[] {
    const res = this.execution.readdir(p);
    if (Array.isArray(res)) return res;
    return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDirectory: d.isDirectory()
    }));
  }

  private _copyFileSync(src: string, dest: string): void {
    if (typeof this.execution.copyFile === 'function') {
      const res = this.execution.copyFile(src, dest);
      if (!(res instanceof Promise)) return;
    }
    this._writeFileSync(dest, this._readFileSync(src));
  }

  private _rmSync(p: string): void {
    if (typeof this.execution.rm === 'function') {
      const res = this.execution.rm(p, { force: true });
      if (!(res instanceof Promise)) return;
    }
    fs.rmSync(p, { force: true });
  }

  _runDir(runId: string) {
    return path.join(this.snapshotRoot, runId);
  }

  _manifestPath(runId: string) {
    return path.join(this._runDir(runId), 'manifest.json');
  }

  startRun(runId = `run_${Date.now().toString(36)}`, meta = {}) {
    const existing = this.loadManifest(runId);
    if (existing) {
      return existing;
    }
    const entry = {
      runId,
      createdAt: new Date().toISOString(),
      workspaceDir: this.workspaceDir,
      meta,
      files: {} // relPath -> { existed: boolean, backupFile: string|null, postExisted?: boolean }
    };
    this.runs.set(runId, entry);
    return entry;
  }

  /**
   * Capture the original state of a file right before a tool mutates it.
   */
  captureBeforeMutation(runId: string, targetPath: string) {
    if (!runId || !targetPath) return;
    let entry = this.runs.get(runId);
    if (!entry) entry = this.startRun(runId);

    const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(this.workspaceDir, targetPath);
    const rel = path.relative(this.workspaceDir, abs);
    // Ignore files outside workspace or inside .om_snapshots
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith('.om_snapshots')) return;

    // Only capture the first pre-run state per file within this run
    if (entry.files[rel]) return;

    const existed = this._existsSync(abs);
    let backupFile: string | null = null;
    if (existed && this._statSync(abs).isFile) {
      const backupDir = path.join(this._runDir(runId), 'files');
      backupFile = path.join(backupDir, rel);
      this._mkdirSync(path.dirname(backupFile));
      this._copyFileSync(abs, backupFile);
    }

    entry.files[rel] = { existed, backupFile };
    this._persistManifest(entry);
  }

  _persistManifest(entry: Record<string, any>) {
    try {
      this._mkdirSync(this._runDir(entry.runId));
      this._writeFileSync(this._manifestPath(entry.runId), JSON.stringify(entry, null, 2));
    } catch (_) {
      // non-fatal
    }
  }

  loadManifest(runId: string) {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const p = this._manifestPath(runId);
    if (!this._existsSync(p)) return null;
    try {
      const parsed = JSON.parse(this._readFileSync(p));
      this.runs.set(runId, parsed);
      return parsed;
    } catch (_) {
      return null;
    }
  }

  listRuns() {
    if (!this._existsSync(this.snapshotRoot)) return [];
    const dirs = this._readdirSync(this.snapshotRoot).filter((d) => d.isDirectory);
    const list = [];
    for (const d of dirs) {
      const m = this.loadManifest(d.name);
      if (m) {
        list.push({
          runId: m.runId,
          createdAt: m.createdAt,
          fileCount: Object.keys(m.files || {}).length,
          files: Object.keys(m.files || {}),
          meta: m.meta || {}
        });
      }
    }
    return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  diff(runId: string) {
    const entry = this.loadManifest(runId);
    if (!entry) return null;
    const changes = [];
    for (const [rel, info] of Object.entries(entry.files || {}) as Array<[string, any]>) {
      const abs = path.join(this.workspaceDir, rel);
      const currentExists = this._existsSync(abs);
      const before = info.existed && info.backupFile && this._existsSync(info.backupFile)
        ? this._readFileSync(info.backupFile)
        : null;
      const after = currentExists && this._statSync(abs).isFile ? this._readFileSync(abs) : null;
      changes.push({
        path: rel,
        status: !info.existed && currentExists ? 'created' : info.existed && !currentExists ? 'deleted' : 'modified',
        beforePreview: before !== null ? before.slice(0, 1000) : null,
        afterPreview: after !== null ? after.slice(0, 1000) : null
      });
    }
    return { runId, createdAt: entry.createdAt, changes };
  }

  rollback(runId: string) {
    const entry = this.loadManifest(runId);
    if (!entry) {
      return { success: false, error: `Snapshot '${runId}' not found` };
    }
    const restored = [];
    const deleted = [];
    for (const [rel, info] of Object.entries(entry.files || {}) as Array<[string, any]>) {
      const abs = path.join(this.workspaceDir, rel);
      if (info.existed && info.backupFile && this._existsSync(info.backupFile)) {
        this._mkdirSync(path.dirname(abs));
        this._copyFileSync(info.backupFile, abs);
        restored.push(rel);
      } else if (!info.existed && this._existsSync(abs)) {
        this._rmSync(abs);
        deleted.push(rel);
      }
    }
    return { success: true, runId, restored, deleted };
  }
}

