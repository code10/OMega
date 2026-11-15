import { execFile } from 'node:child_process';
import { resolveSafePath } from '../dist/skills/filesystem.js';

/**
 * Custom Skill Plugin: Git Inspector (Read-Only)
 * Safely inspect repository status, recent commits, branches, and diffs without a shell.
 */
export const skill = {
  name: 'git_inspect',
  description: 'Safely inspect a Git repository (status, diff, log, branch) in read-only mode without invoking a shell.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'diff', 'log', 'branch'],
        description: 'Git inspection action to run'
      },
      target: {
        type: 'string',
        description: 'Optional file path (for diff) or commit count (for log, default 10)'
      },
      cwd: {
        type: 'string',
        description: 'Repository directory (defaults to workspaceDir)'
      }
    },
    required: ['action']
  },
  execute: async ({ action, target, cwd }, context = {}) => {
    const baseWorkspace = context.config?.workspaceDir || process.cwd();
    let workingDir;
    try {
      workingDir = resolveSafePath(cwd || '.', baseWorkspace, context);
    } catch (err) {
      return { success: false, error: err.message };
    }

    let args;
    if (action === 'status') {
      args = ['status', '--short', '--branch'];
    } else if (action === 'branch') {
      args = ['branch', '--list'];
    } else if (action === 'log') {
      const count = Math.min(Math.max(1, Number(target) || 10), 50);
      args = ['log', `-n`, String(count), '--oneline'];
    } else if (action === 'diff') {
      args = target ? ['diff', '--', String(target)] : ['diff', '--stat'];
    } else {
      return { success: false, error: `Unsupported action: ${action}` };
    }

    return new Promise((resolve) => {
      execFile('git', args, { cwd: workingDir, timeout: 10000, shell: false, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          return resolve({
            success: false,
            error: (stderr || err.message || 'Git inspection failed').trim()
          });
        }
        resolve({
          success: true,
          action,
          output: (stdout || '').trim() || '(clean / no output)'
        });
      });
    });
  }
};
