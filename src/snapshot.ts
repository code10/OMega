import fs from 'node:fs';
import path from 'node:path';

/**
 * Lightweight Zero-Dependency Workspace Snapshot & Rollback Manager ("Undo Agent Run").
 * Tracks original file contents before agent mutations so any run can be inspected or reverted.
 */
export class WorkspaceSnapshotManager {
  workspaceDir: string;
  snapshotRoot: string;
  runs: Map<string, any>;

  constructor(workspaceDir = process.cwd(), snapshotRoot: string | null = null) {
    this.workspaceDir = path.resolve(workspaceDir || process.cwd());
    this.snapshotRoot = snapshotRoot || path.join(this.workspaceDir, '.om_snapshots');
    this.runs = new Map();
  }

  _runDir(runId: string) {
    return path.join(this.snapshotRoot, runId);
  }

  _manifestPath(runId: string) {
    return path.join(this._runDir(runId), 'manifest.json');
  }

  startRun(runId = `run_${Date.now().toString(36)}`, meta = {}) {
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

    const existed = fs.existsSync(abs);
    let backupFile: string | null = null;
    if (existed && fs.statSync(abs).isFile()) {
      const backupDir = path.join(this._runDir(runId), 'files');
      backupFile = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.copyFileSync(abs, backupFile);
    }

    entry.files[rel] = { existed, backupFile };
    this._persistManifest(entry);
  }

  _persistManifest(entry: Record<string, any>) {
    try {
      fs.mkdirSync(this._runDir(entry.runId), { recursive: true });
      fs.writeFileSync(this._manifestPath(entry.runId), JSON.stringify(entry, null, 2), 'utf8');
    } catch (_) {
      // non-fatal
    }
  }

  loadManifest(runId: string) {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const p = this._manifestPath(runId);
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    this.runs.set(runId, parsed);
    return parsed;
  }

  listRuns() {
    if (!fs.existsSync(this.snapshotRoot)) return [];
    const dirs = fs.readdirSync(this.snapshotRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
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
      const currentExists = fs.existsSync(abs);
      const before = info.existed && info.backupFile && fs.existsSync(info.backupFile)
        ? fs.readFileSync(info.backupFile, 'utf8')
        : null;
      const after = currentExists && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null;
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
      if (info.existed && info.backupFile && fs.existsSync(info.backupFile)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(info.backupFile, abs);
        restored.push(rel);
      } else if (!info.existed && fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true });
        deleted.push(rel);
      }
    }
    return { success: true, runId, restored, deleted };
  }
}

