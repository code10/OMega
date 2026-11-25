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

  // GET /api/mcp/resources (List MCP resources across all connected MCP servers)
  if (pathname === '/api/mcp/resources' && req.method === 'GET') {
    const resources: Array<Record<string, unknown>> = [];
    const clients: Map<string, any> = agent?.mcpManager?.clients instanceof Map ? agent.mcpManager.clients : new Map();
    for (const [serverName, client] of clients.entries()) {
      try {
        const list = await client.listResources();
        for (const r of list || []) {
          resources.push({ server: serverName, uri: r.uri, name: r.name || r.uri, description: r.description || '', mimeType: r.mimeType });
        }
      } catch {
        // Server may not implement resources/list
      }
    }
    sendJson(res, 200, { success: true, count: resources.length, resources });
    return true;
  }

  // POST /api/mcp/resources/read (Read a specific MCP resource URI for @-mention attachment)
  if (pathname === '/api/mcp/resources/read' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const serverName = String(body.server || '').trim();
    const uri = String(body.uri || '').trim();
    if (!serverName || !uri) {
      sendJson(res, 400, { success: false, error: 'server and uri are required' });
      return true;
    }
    const client = agent?.mcpManager?.clients?.get?.(serverName);
    if (!client) {
      sendJson(res, 404, { success: false, error: `MCP server '${serverName}' is not connected` });
      return true;
    }
    try {
      const result = await client.readResource(uri);
      sendJson(res, 200, { success: true, server: serverName, uri, result });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  // GET /api/mcp/prompts (List MCP prompts across all connected MCP servers for / slash commands)
  if (pathname === '/api/mcp/prompts' && req.method === 'GET') {
    const prompts: Array<Record<string, unknown>> = [];
    const clients: Map<string, any> = agent?.mcpManager?.clients instanceof Map ? agent.mcpManager.clients : new Map();
    for (const [serverName, client] of clients.entries()) {
      try {
        const list = await client.listPrompts();
        for (const p of list || []) {
          prompts.push({ server: serverName, name: p.name, description: p.description || '', arguments: p.arguments || [] });
        }
      } catch {
        // Server may not implement prompts/list
      }
    }
    sendJson(res, 200, { success: true, count: prompts.length, prompts });
    return true;
  }

  // POST /api/mcp/prompts/get (Expand an MCP prompt)
  if (pathname === '/api/mcp/prompts/get' && req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const serverName = String(body.server || '').trim();
    const name = String(body.name || '').trim();
    if (!serverName || !name) {
      sendJson(res, 400, { success: false, error: 'server and name are required' });
      return true;
    }
    const client = agent?.mcpManager?.clients?.get?.(serverName);
    if (!client) {
      sendJson(res, 404, { success: false, error: `MCP server '${serverName}' is not connected` });
      return true;
    }
    try {
      const result = await client.getPrompt(name, body.args || {});
      sendJson(res, 200, { success: true, server: serverName, name, result });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
