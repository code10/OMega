import { OMGitManager } from '../git.js';
import type { SkillContext, SkillDefinition } from '../types.js';

/**
 * Built-in Git skills backed by OMGitManager (status, diff, branch).
 */
export const gitSkills: SkillDefinition[] = [
  {
    name: 'git_status',
    description: 'Inspect git repository branch and modified/untracked files in the workspace.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async (_args = {}, context: SkillContext = {}) => {
      const ws = context.config?.workspaceDir || context.agent?.config?.workspaceDir || process.cwd();
      const git = context.agent?.git || new OMGitManager(ws);
      if (!git.isGitRepo()) {
        return { success: false, error: 'Workspace is not a git repository' };
      }
      return { success: true, ...git.getStatus() };
    }
  },
  {
    name: 'git_diff',
    description: 'Get unified git diff for the current working tree or against an optional base ref.',
    parameters: {
      type: 'object',
      properties: {
        baseRef: { type: 'string', description: 'Optional base branch/commit ref to diff against' }
      }
    },
    execute: async ({ baseRef } = {}, context: SkillContext = {}) => {
      const ws = context.config?.workspaceDir || context.agent?.config?.workspaceDir || process.cwd();
      const git = context.agent?.git || new OMGitManager(ws);
      if (!git.isGitRepo()) {
        return { success: false, error: 'Workspace is not a git repository' };
      }
      const diff = git.getDiff(baseRef);
      return { success: true, diff, empty: diff.length === 0 };
    }
  },
  {
    name: 'git_branch',
    description: 'Create or switch to a git branch for isolating multi-file refactors.',
    parameters: {
      type: 'object',
      properties: {
        branchName: { type: 'string', description: 'Branch name to create or switch to' }
      },
      required: ['branchName']
    },
    execute: async ({ branchName }, context: SkillContext = {}) => {
      const ws = context.config?.workspaceDir || context.agent?.config?.workspaceDir || process.cwd();
      const git = context.agent?.git || new OMGitManager(ws);
      if (!git.isGitRepo()) {
        return { success: false, error: 'Workspace is not a git repository' };
      }
      const res = git.createBranch(branchName);
      return { success: true, ...res };
    }
  }
];
