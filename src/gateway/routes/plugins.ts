import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '../httpUtils.js';
import type { PluginManager } from '../../plugins.js';

export interface PluginRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  agent: any;
  pluginManager: PluginManager;
}

export async function handlePluginRoutes(ctx: PluginRouteContext): Promise<boolean> {
  const { req, res, pathname, agent, pluginManager } = ctx;

  // GET /api/plugins
  if (pathname === '/api/plugins' && req.method === 'GET') {
    const data = pluginManager.list(agent);
    sendJson(res, 200, {
      success: true,
      ...data,
      skillsCount: Array.isArray(agent?.skills?.list?.()) ? agent.skills.list().length : undefined,
      contextUsage: typeof agent?.getContextUsage === 'function' ? agent.getContextUsage() : undefined
    });
    return true;
  }

  // POST /api/plugins/connect
  if (pathname === '/api/plugins/connect' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    try {
      const result = await pluginManager.connect(agent, body);
      sendJson(res, 200, {
        ...result,
        ...pluginManager.list(agent),
        skillsCount: Array.isArray(agent?.skills?.list?.()) ? agent.skills.list().length : undefined,
        contextUsage: typeof agent?.getContextUsage === 'function' ? agent.getContextUsage() : undefined
      });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  // POST /api/plugins/toggle
  if (pathname === '/api/plugins/toggle' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const id = String(body.id || '').trim();
    if (!id) {
      sendJson(res, 400, { success: false, error: 'Plugin id is required' });
      return true;
    }
    try {
      const result = await pluginManager.toggle(agent, id, Boolean(body.enabled));
      sendJson(res, 200, {
        ...result,
        ...pluginManager.list(agent),
        skillsCount: Array.isArray(agent?.skills?.list?.()) ? agent.skills.list().length : undefined,
        contextUsage: typeof agent?.getContextUsage === 'function' ? agent.getContextUsage() : undefined
      });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  // POST /api/plugins/disconnect
  if (pathname === '/api/plugins/disconnect' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const id = String(body.id || '').trim();
    if (!id) {
      sendJson(res, 400, { success: false, error: 'Plugin id is required' });
      return true;
    }
    try {
      const result = pluginManager.disconnect(agent, id);
      sendJson(res, 200, {
        ...result,
        ...pluginManager.list(agent),
        skillsCount: Array.isArray(agent?.skills?.list?.()) ? agent.skills.list().length : undefined,
        contextUsage: typeof agent?.getContextUsage === 'function' ? agent.getContextUsage() : undefined
      });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
