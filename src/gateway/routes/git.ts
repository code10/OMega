import type http from 'node:http';
import { OMGitManager } from '../../git.js';
import { sendJson } from '../httpUtils.js';

export interface GitRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  url: URL;
  agent: any;
}

export function handleGitRoutes(ctx: GitRouteContext): boolean {
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

  return false;
}
