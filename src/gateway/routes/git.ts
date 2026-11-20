import type http from 'node:http';
import { OMGitManager } from '../../git.js';
import { readJsonBody, sendJson } from '../httpUtils.js';

export interface GitRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  url: URL;
  agent: any;
}

export async function handleGitRoutes(ctx: GitRouteContext): Promise<boolean> {
  const { req, res, pathname, url, agent } = ctx;
  const git = agent.git || new OMGitManager(agent.config.workspaceDir);

  if (pathname === '/api/git/status' && req.method === 'GET') {
    if (!git.isGitRepo()) {
      sendJson(res, 200, { success: true, isGitRepo: false });
      return true;
    }
    sendJson(res, 200, { success: true, isGitRepo: true, ...git.getStatus() });
    return true;
  }

  if (pathname === '/api/git/diff' && req.method === 'GET') {
    if (!git.isGitRepo()) {
      sendJson(res, 400, { success: false, error: 'Workspace is not a git repository' });
      return true;
    }
    const baseRef = url.searchParams.get('base') || undefined;
    const diff = git.getDiff(baseRef);
    sendJson(res, 200, { success: true, diff, empty: diff.length === 0 });
    return true;
  }

  if (pathname === '/api/git/worktree/diff' && req.method === 'GET') {
    const wtPath = url.searchParams.get('worktreePath');
    if (!wtPath) {
      sendJson(res, 400, { success: false, error: 'worktreePath is required' });
      return true;
    }
    try {
      const summary = git.getWorktreeSummary(wtPath);
      sendJson(res, 200, { success: true, ...summary });
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  if (pathname === '/api/git/worktree/merge' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    if (!data.worktreePath || !data.branch) {
      sendJson(res, 400, { success: false, error: 'worktreePath and branch are required' });
      return true;
    }
    try {
      const result = git.mergeWorktree(String(data.worktreePath), String(data.branch), data.commitMessage ? String(data.commitMessage) : undefined);
      sendJson(res, 200, { success: true, ...result });
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  if (pathname === '/api/git/worktree/discard' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    if (!data.worktreePath) {
      sendJson(res, 400, { success: false, error: 'worktreePath is required' });
      return true;
    }
    try {
      const result = git.discardWorktree(String(data.worktreePath), data.branch ? String(data.branch) : undefined);
      sendJson(res, 200, { success: true, ...result });
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  return false;
}
