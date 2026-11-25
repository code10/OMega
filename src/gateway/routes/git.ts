import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { OMAgent } from '../../agent.js';
import { OMGitManager } from '../../git.js';
import { resolveSafePath } from '../../skills/filesystem.js';
import { readJsonBody, sendJson } from '../httpUtils.js';

export interface GitRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  url: URL;
  agent: OMAgent;
}

function getErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    const file = url.searchParams.get('file') || undefined;
    const diff = file
      ? git._exec(['diff', ...(baseRef ? [baseRef] : []), '--', file])
      : git.getDiff(baseRef);
    sendJson(res, 200, { success: true, file: file || null, diff, empty: diff.length === 0 });
    return true;
  }

  if (pathname === '/api/git/revert-file' && req.method === 'POST') {
    if (!git.isGitRepo()) {
      sendJson(res, 400, { success: false, error: 'Workspace is not a git repository' });
      return true;
    }
    const data: Record<string, unknown> | null = await readJsonBody(req, res);
    if (!data) return true;
    const rawFile = String(data.file || '').trim();
    if (!rawFile) {
      sendJson(res, 400, { success: false, error: 'file is required' });
      return true;
    }
    try {
      const wsDir = agent.config.workspaceDir || process.cwd();
      const safeAbs = resolveSafePath(rawFile, wsDir, { config: agent.config });
      const rel = path.relative(path.resolve(wsDir), safeAbs).replace(/\\/g, '/');
      try {
        git._exec(['checkout', '--', rel]);
      } catch {
        // Untracked file: remove it safely if it exists
        if (fs.existsSync(safeAbs) && fs.statSync(safeAbs).isFile()) {
          fs.unlinkSync(safeAbs);
        } else {
          throw new Error(`Unable to revert '${rel}'`);
        }
      }
      sendJson(res, 200, { success: true, file: rel, status: git.getStatus() });
    } catch (err: unknown) {
      sendJson(res, 400, { success: false, error: getErrMsg(err) });
    }
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
    } catch (err: unknown) {
      sendJson(res, 500, { success: false, error: getErrMsg(err) });
    }
    return true;
  }

  if (pathname === '/api/git/worktree/merge' && req.method === 'POST') {
    const data: Record<string, unknown> | null = await readJsonBody(req, res);
    if (!data) return true;
    if (!data.worktreePath || !data.branch) {
      sendJson(res, 400, { success: false, error: 'worktreePath and branch are required' });
      return true;
    }
    try {
      const result = git.mergeWorktree(String(data.worktreePath), String(data.branch), data.commitMessage ? String(data.commitMessage) : undefined);
      sendJson(res, 200, { success: true, ...result });
    } catch (err: unknown) {
      sendJson(res, 500, { success: false, error: getErrMsg(err) });
    }
    return true;
  }

  if (pathname === '/api/git/worktree/discard' && req.method === 'POST') {
    const data: Record<string, unknown> | null = await readJsonBody(req, res);
    if (!data) return true;
    if (!data.worktreePath) {
      sendJson(res, 400, { success: false, error: 'worktreePath is required' });
      return true;
    }
    try {
      const result = git.discardWorktree(String(data.worktreePath), data.branch ? String(data.branch) : undefined);
      sendJson(res, 200, { success: true, ...result });
    } catch (err: unknown) {
      sendJson(res, 500, { success: false, error: getErrMsg(err) });
    }
    return true;
  }

  return false;
}
