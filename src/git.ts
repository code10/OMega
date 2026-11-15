import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Zero-dependency Git integration for repository inspection, diffing,
 * branching, and isolated worktrees.
 */
export class OMGitManager {
  workspaceDir: string;

  constructor(workspaceDir = process.cwd()) {
    this.workspaceDir = path.resolve(workspaceDir || process.cwd());
  }

  /**
   * Run a git command synchronously inside a directory.
   * @param {string[]} args
   * @param {string} [cwd=this.workspaceDir]
   * @returns {string}
   */
  _exec(args: string[], cwd = this.workspaceDir) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
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
    const args = baseRef ? ['diff', baseRef] : ['diff'];
    return this._exec(args);
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
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    this._exec(['worktree', 'add', '-b', branchName, absPath]);
    return { worktreePath: absPath, branch: branchName };
  }

  /**
   * Remove an isolated git worktree.
   * @param {string} worktreePath
   * @param {boolean} [force=true]
   */
  removeWorktree(worktreePath: string, force = true) {
    const absPath = path.resolve(this.workspaceDir, worktreePath);
    const args = force ? ['worktree', 'remove', '--force', absPath] : ['worktree', 'remove', absPath];
    this._exec(args);
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
