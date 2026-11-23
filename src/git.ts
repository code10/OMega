import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { defaultLocalExecutionBackend } from './execution/backend.js';
import type { ExecutionBackend } from './types.js';

/**
 * Zero-dependency Git integration for repository inspection, diffing,
 * branching, and isolated worktrees.
 */
export class OMGitManager {
  workspaceDir: string;
  execution: ExecutionBackend;

  constructor(workspaceDir = process.cwd(), execution: ExecutionBackend = defaultLocalExecutionBackend) {
    this.workspaceDir = path.resolve(workspaceDir || process.cwd());
    this.execution = execution;
  }

  /**
   * Run a git command synchronously inside a directory.
   * @param {string[]} args
   * @param {string} [cwd=this.workspaceDir]
   * @returns {string}
   */
  _exec(args: string[], cwd = this.workspaceDir) {
    try {
      if (typeof this.execution.execSync === 'function') {
        return this.execution.execSync('git', args, { cwd });
      }
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    } catch (err: any) {
      const stderr = String(err?.stderr || '').trim();
      const detail = stderr || err?.message || 'Unknown git error';
      const wrapped: Error & { status?: number; code?: string; stderr?: string } = new Error(
        `git ${args[0] || ''} failed: ${detail}`.trim()
      );
      if (typeof err?.status === 'number') wrapped.status = err.status;
      if (err?.code) wrapped.code = err.code;
      if (stderr) wrapped.stderr = stderr;
      throw wrapped;
    }
  }

  /**
   * Check whether workspaceDir is inside a git repository.
   * @returns {boolean}
   */
  isGitRepo() {
    try {
      return this._exec(['rev-parse', '--is-inside-work-tree']) === 'true';
    } catch (_) {
      return false;
    }
  }

  /**
   * Get the current branch name (works even on an unborn branch, or HEAD if detached).
   * @returns {string}
   */
  getCurrentBranch() {
    try {
      return this._exec(['symbolic-ref', '--short', 'HEAD']);
    } catch (_) {
      try {
        return this._exec(['rev-parse', '--abbrev-ref', 'HEAD']);
      } catch (_) {
        return 'HEAD';
      }
    }
  }

  /**
   * Return porcelain status entries and modified file paths.
   * @returns {{ branch: string, clean: boolean, files: Array<{ status: string, path: string }> }}
   */
  getStatus() {
    const branch = this.getCurrentBranch();
    const raw = this._exec(['status', '--porcelain']);
    const files = raw
      ? raw.split(/\r?\n/).filter(Boolean).map((line) => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3).trim()
        }))
      : [];
    return { branch, clean: files.length === 0, files };
  }

  /**
   * Get unified diff for working tree or against a base ref.
   * @param {string} [baseRef]
   * @returns {string}
   */
  getDiff(baseRef?: string) {
    if (baseRef !== undefined && baseRef !== '') {
      const cleaned = String(baseRef).trim();
      if (!cleaned || cleaned.startsWith('-') || /[\r\n\0]/.test(cleaned)) {
        throw new Error(`Invalid git ref '${baseRef}': refs must not start with '-' or contain control characters.`);
      }
      // Verify the revision resolves cleanly before passing to git diff
      this._exec(['rev-parse', '--verify', `${cleaned}^{commit}`]);
      return this._exec(['diff', cleaned, '--']);
    }
    return this._exec(['diff', '--']);
  }

  /**
   * Create and switch to a new branch (or switch if it already exists).
   * @param {string} branchName
   * @returns {{ branch: string, created: boolean }}
   */
  createBranch(branchName: string) {
    try {
      this._exec(['checkout', '-b', branchName]);
      return { branch: branchName, created: true };
    } catch (_) {
      this._exec(['checkout', branchName]);
      return { branch: branchName, created: false };
    }
  }

  /**
   * Create an isolated git worktree on a new branch for parallel or risky refactors.
   * @param {string} worktreePath
   * @param {string} [branchName]
   * @returns {{ worktreePath: string, branch: string }}
   */
  createWorktree(worktreePath: string, branchName = `om-wt-${Date.now().toString(36)}`) {
    const absPath = path.resolve(this.workspaceDir, worktreePath);
    this.execution.mkdir(path.dirname(absPath), { recursive: true });
    this._exec(['worktree', 'add', '-b', branchName, absPath]);
    this._linkWorktreeDependencies(absPath);
    return { worktreePath: absPath, branch: branchName };
  }

  /**
   * Link untracked node_modules from the main workspace into an isolated worktree
   * so builds and tests (tsc, npm test) run without a fresh install.
   */
  _linkWorktreeDependencies(absWorktreePath: string) {
    const mainNodeModules = path.join(this.workspaceDir, 'node_modules');
    const wtNodeModules = path.join(absWorktreePath, 'node_modules');
    if (this.execution.exists(mainNodeModules) && !this.execution.exists(wtNodeModules)) {
      try {
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        this.execution.symlink?.(mainNodeModules, wtNodeModules, linkType);
      } catch (_) {
        // Best-effort; worktree still functions if symlink/junction is unsupported
      }
    }
  }

  /**
   * Unlink any junction/symlinked node_modules before removing a worktree.
   */
  _unlinkWorktreeDependencies(absWorktreePath: string) {
    const wtNodeModules = path.join(absWorktreePath, 'node_modules');
    try {
      if (this.execution.isSymlink?.(wtNodeModules)) {
        this.execution.unlink?.(wtNodeModules);
      }
    } catch (_) {
      // Ignore if not present
    }
  }

  /**
   * Remove an isolated git worktree.
   * @param {string} worktreePath
   * @param {boolean} [force=true]
   */
  removeWorktree(worktreePath: string, force = true) {
    const absPath = path.resolve(this.workspaceDir, worktreePath);
    this._unlinkWorktreeDependencies(absPath);
    const args = force ? ['worktree', 'remove', '--force', absPath] : ['worktree', 'remove', absPath];
    try {
      this._exec(args);
    } catch (err: any) {
      if (!force) throw err;
      // On Windows, NTFS/AV can briefly hold a handle during `git worktree remove --force`.
      // Fall back to retryable directory removal + `git worktree prune`.
      try {
        if (this.execution.exists(absPath)) {
          this.execution.rm?.(absPath, { recursive: true, force: true });
        }
      } catch (_) {
        // Best-effort cleanup; prune still detaches the worktree metadata
      }
      try {
        this._exec(['worktree', 'prune']);
      } catch (_) {
        throw err;
      }
    }
  }

  /**
   * Summarize uncommitted changes inside a worktree, including untracked new files.
   */
  getWorktreeSummary(worktreePath: string) {
    const absPath = path.resolve(this.workspaceDir, worktreePath);
    const wtGit = new OMGitManager(absPath);
    const status = wtGit.getStatus();
    let diff = '';
    try {
      diff = wtGit._exec(['diff', 'HEAD']);
    } catch (_) {
      diff = wtGit.getDiff();
    }

    // Include untracked new files as synthetic unified diff blocks for UI preview
    const untrackedFiles = (status.files || []).filter((f: any) => f.status === '??' && f.path && !f.path.startsWith('node_modules'));
    for (const f of untrackedFiles) {
      const fullPath = path.join(absPath, f.path);
      try {
        const stat = this.execution.stat(fullPath);
        if (stat instanceof Promise || !stat.isFile || stat.size > 32768) continue;
        const content = this.execution.readFile(fullPath, 'utf8');
        if (typeof content !== 'string' || content.includes('\u0000')) continue; // skip binary
        const lines = content.split(/\r?\n/);
        const hunkBody = lines.map((l: string) => `+${l}`).join('\n');
        const synthetic = `diff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n${hunkBody}\n`;
        diff = diff ? `${diff}\n${synthetic}` : synthetic;
      } catch (_) {
        // Ignore unreadable untracked files
      }
    }

    const MAX_DIFF_CHARS = 200000;
    const diffTruncated = diff.length > MAX_DIFF_CHARS;
    if (diffTruncated) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + '\n... [diff truncated]';
    }

    return {
      worktreePath: absPath,
      branch: status.branch,
      clean: status.clean,
      files: status.files,
      diff,
      diffTruncated
    };
  }

  /**
   * Commit any pending worktree edits, merge the worktree branch into the main workspace,
   * and remove the temporary worktree and branch.
   */
  mergeWorktree(worktreePath: string, branchName: string, commitMessage = `OMega task merge (${branchName})`) {
    const absPath = path.resolve(this.workspaceDir, worktreePath);
    const wtGit = new OMGitManager(absPath, this.execution);
    const wtStatus = wtGit.getStatus();
    if (!wtStatus.clean) {
      wtGit.commit(commitMessage);
    }
    this._exec(['merge', '--no-ff', branchName, '-m', commitMessage]);
    this.discardWorktree(absPath, branchName);
    return { merged: true, branch: branchName };
  }

  /**
   * Remove an isolated worktree and optionally delete its temporary branch.
   */
  discardWorktree(worktreePath: string, branchName?: string) {
    const absPath = path.resolve(this.workspaceDir, worktreePath);
    if (this.execution.exists(absPath)) {
      this.removeWorktree(absPath, true);
    }
    if (branchName && branchName !== 'HEAD') {
      try {
        this._exec(['branch', '-D', branchName]);
      } catch (_) {
        // Ignore if branch was already deleted or doesn't exist
      }
    }
    return { discarded: true, branch: branchName || null };
  }

  /**
   * Stage all changes and create a commit.
   * @param {string} message
   * @returns {{ committed: boolean, hash?: string }}
   */
  commit(message: string) {
    this._exec(['add', '-A']);
    const status = this.getStatus();
    if (status.clean) return { committed: false };
    this._exec(['commit', '-m', message]);
    const hash = this._exec(['rev-parse', '--short', 'HEAD']);
    return { committed: true, hash };
  }
}
