import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OMAgent } from '../agent.js';
import { loadConfig } from '../config.js';
import { SessionManager } from './sessionManager.js';
import { OMDaemon } from '../daemon.js';
import { readJsonBody, serveStatic } from './httpUtils.js';
import { ApprovalManager } from './approvals.js';
import { handleMemoryRoutes } from './routes/memory.js';
import { handleSessionRoutes } from './routes/sessions.js';
import { handleGitRoutes } from './routes/git.js';
import { handleConfigRoutes } from './routes/config.js';
import { AgentManager } from './agentManager.js';
import { handleAgentsRoutes } from './routes/agents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIRS = [
  path.join(__dirname, 'public'),
  path.resolve(__dirname, '../../src/gateway/public')
];

/**
 * Start the OMega HTTP and SSE Server
 */
export async function startGateway(options: Record<string, any> = {}) {
  const config = loadConfig(options);
  const agent = new OMAgent(config);
  await agent.init();
  agent.startWatching();

  const port = options.port ?? config.gateway?.port ?? 3000;
  const host = options.host || config.gateway?.host || '127.0.0.1';
  const sessionManager = new SessionManager(agent);
  const sseClients = new Set<any>();
  const daemon = new OMDaemon(agent).loadFromConfig(config);

  const isLocalHostBind = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const persistConfig = options.persistConfig ?? (path.resolve(config.workspaceDir) === path.resolve(config.rootDir));
  const explicitToken = options.authToken || config.gateway?.authToken || process.env.OM_GATEWAY_TOKEN || '';
  const isEphemeralToken = !explicitToken;
  const authToken = explicitToken || crypto.randomBytes(24).toString('hex');
  const allowSkillCreation = Boolean(options.allowSkillCreation ?? config.gateway?.allowSkillCreation ?? false);

  const getAllowedOrigins = (): string[] => {
    if (Array.isArray(config.gateway?.corsOrigins)) {
      return config.gateway.corsOrigins;
    }
    const addr = server?.address();
    const activePort = typeof addr === 'object' && addr ? addr.port : port;
    return [`http://127.0.0.1:${activePort}`, `http://localhost:${activePort}`];
  };

  const broadcastSSE = (eventName: string, dataObj: any) => {
    const payload = JSON.stringify(dataObj);
    for (const client of sseClients) {
      try {
        client.write(`event: ${eventName}\ndata: ${payload}\n\n`);
      } catch (_: any) {
        sseClients.delete(client);
      }
    }
  };

  agent.on('activity', (entry) => {
    broadcastSSE('activity', entry);
  });

  const agentManager = new AgentManager(agent, {
    onUpdate: (payload) => broadcastSSE('agent_update', payload)
  });

  // Bridge interactive tool/shell confirmation into SSE + POST /api/approvals/:id
  const approvals = new ApprovalManager(broadcastSSE);
  const gatewayConfirmHandler = approvals.createConfirmHandler() as (info: Record<string, any>) => Promise<boolean>;
  agent.confirmCommand = gatewayConfirmHandler;
  agent.options.confirmCommand = gatewayConfirmHandler;

  agent.on('config_updated', (data) => {
    const payloadObj = {
      name: 'OMega',
      version: agent.config.version || '1.0.0',
      provider: data.provider,
      model: data.model,
      target: agent._getTarget(data.provider),
      skillsCount: data.skillsCount,
      skills: data.skills.map((s: any) => ({
        name: s.name,
        description: s.description,
        parameters: s.parameters,
        type: s.type || 'function',
        references: s.references || [],
        triggers: s.triggers || []
      })),
      sessionId: agent.sessionId,
      memoryDir: agent.config.memoryDir,
      workspaceDir: agent.config.workspaceDir,
      timestamp: new Date().toISOString()
    };
    broadcastSSE('config_updated', payloadObj);
  });

  const server = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin;
    const allowedOrigins = getAllowedOrigins();
    const isOriginAllowed = !reqOrigin || allowedOrigins.includes('*') || allowedOrigins.includes(reqOrigin);

    if (reqOrigin && !isOriginAllowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: Origin not allowed' }));
      return;
    }

    if (reqOrigin) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Enforce Bearer token authentication on /api/*
    if (pathname.startsWith('/api/')) {
      const authHeader = req.headers.authorization || '';
      const tokenQuery = url.searchParams.get('token');
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : tokenQuery;
      if (provided !== authToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Valid Bearer token required' }));
        return;
      }
    }

    // --- API Endpoints ---

    // 1. GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      const skills = agent.skills.list();
      const status = {
        name: 'OMega',
        version: agent.config.version || '1.0.0',
        provider: agent.config.provider,
        model: agent.config.model,
        target: agent._getTarget(),
        skillsCount: skills.length,
        sessionId: agent.sessionId,
        activeSessions: sessionManager.sessions.size,
        memoryDir: agent.config.memoryDir,
        workspaceDir: agent.config.workspaceDir,
        vectorStats: agent.memory.getVectorStats(),
        routingStats: agent.router?.getStats(),
        usageStats: agent.usageStats,
        timestamp: new Date().toISOString()
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // 1b. GET /api/events (Real-time SSE stream for live provider & skills updates)
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('\n');
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // 2. GET /api/skills
    if (pathname === '/api/skills' && req.method === 'GET') {
      const skills = agent.skills.list().map((s) => ({
        name: s.name,
        description: s.description,
        parameters: s.parameters,
        type: s.type || 'function',
        references: s.references || [],
        triggers: s.triggers || []
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ skills }, null, 2));
      return;
    }

    // 3. Memory & Training Routes (/api/memory*, /api/training/export)
    if (await handleMemoryRoutes({ req, res, pathname, url, agent })) return;

    // 3b. Git Routes (/api/git/status, /api/git/diff)
    if (handleGitRoutes({ req, res, pathname, url, agent })) return;

    // 3c. Agents Routes (/api/agents*)
    if (await handleAgentsRoutes({ req, res, pathname, agentManager })) return;

    // 3d. GET /api/activity (Live activity trace history & router stats)
    if (pathname === '/api/activity' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        activities: agent.activityLog || [],
        routingStats: agent.router?.getStats() || {}
      }));
      return;
    }

    // 5. POST /api/chat/stream (Server-Sent Events)
    if (pathname === '/api/chat/stream' && req.method === 'POST') {
      const data: Record<string, any> | null = await readJsonBody(req, res);
      if (!data) return;
      const { prompt, attachments, responseFormat } = data;
      const targetSessionId = data.sessionId || req.headers['x-session-id'];
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'prompt is required' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      const sendEvent = (event: string, eventData: any) => {
        if (!res.writableEnded) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(eventData)}\n\n`);
        }
      };

      await sessionManager.runExclusive(targetSessionId, async (sessionAgent: any) => {
        const onStepStart = (d: any) => sendEvent('step_start', d);
        const onThought = (d: any) => sendEvent('thought', d);
        const onToken = (d: any) => sendEvent('token', d);
        const onToolStart = (d: any) => sendEvent('tool_start', d);
        const onToolEnd = (d: any) => sendEvent('tool_end', d);
        const onRetry = (d: any) => sendEvent('retry', d);
        const onFallback = (d: any) => sendEvent('fallback', d);

        sessionAgent.on('step_start', onStepStart);
        sessionAgent.on('thought', onThought);
        sessionAgent.on('token', onToken);
        sessionAgent.on('tool_start', onToolStart);
        sessionAgent.on('tool_end', onToolEnd);
        sessionAgent.on('retry', onRetry);
        sessionAgent.on('fallback', onFallback);

        const cleanup = () => {
          sessionAgent.off('step_start', onStepStart);
          sessionAgent.off('thought', onThought);
          sessionAgent.off('token', onToken);
          sessionAgent.off('tool_start', onToolStart);
          sessionAgent.off('tool_end', onToolEnd);
          sessionAgent.off('retry', onRetry);
          sessionAgent.off('fallback', onFallback);
        };

        req.on('close', cleanup);

        try {
          const result = await sessionAgent.run(prompt, { attachments, responseFormat, stream: true });
          sendEvent('done', result);
        } catch (err: any) {
          sendEvent('error', { error: err.message });
        } finally {
          cleanup();
          res.end();
        }
      });
      return;
    }

    // 6. POST /api/chat (Standard JSON)
    if (pathname === '/api/chat' && req.method === 'POST') {
      const data: Record<string, any> | null = await readJsonBody(req, res);
      if (!data) return;
      const { prompt, attachments, responseFormat } = data;
      const targetSessionId = data.sessionId || req.headers['x-session-id'];
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'prompt is required' }));
        return;
      }
      try {
        const result = await sessionManager.runExclusive(targetSessionId, (sessionAgent: any) =>
          sessionAgent.run(prompt, { attachments, responseFormat })
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 6b. POST /api/chat/abort (Abort active agent run)
    if (pathname === '/api/chat/abort' && req.method === 'POST') {
      const data: Record<string, any> | null = await readJsonBody(req, res);
      if (!data) return;
      const targetSessionId = data.sessionId || req.headers['x-session-id'];
      const targetAgent = sessionManager.getAgent(targetSessionId);
      const aborted = targetAgent.abort(data.reason || 'Aborted via Gateway');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, aborted }));
      return;
    }

    // 6c. POST /api/chat/steer (Inject live mid-run steering directive)
    if (pathname === '/api/chat/steer' && req.method === 'POST') {
      const data: Record<string, any> | null = await readJsonBody(req, res);
      if (!data) return;
      const targetSessionId = data.sessionId || req.headers['x-session-id'];
      const targetAgent = sessionManager.getAgent(targetSessionId);
      const queued = targetAgent.steer(data.instruction || data.message || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: queued, queued }));
      return;
    }

    // 6d. POST /api/approvals/:id (Resolve pending HITL tool/shell confirmation)
    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && req.method === 'POST') {
      await approvals.handleResolve(req, res, decodeURIComponent(approvalMatch[1]));
      return;
    }

    // 6e-6g & 7 & 7b: Session, Replay, Compare, Reset, Clear routes
    if (await handleSessionRoutes({ req, res, pathname, agent, agentManager })) return;

    // 6h. Workspace Snapshots & Rollback (/api/snapshots)
    if (pathname === '/api/snapshots' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, snapshots: agent.snapshots.listRuns() }, null, 2));
      return;
    }

    const snapDiffMatch = pathname.match(/^\/api\/snapshots\/([^/]+)\/diff$/);
    if (snapDiffMatch && req.method === 'GET') {
      const runId = decodeURIComponent(snapDiffMatch[1]);
      const diff = agent.snapshots.diff(runId);
      res.writeHead(diff ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(diff ? { success: true, ...diff } : { success: false, error: 'Snapshot not found' }, null, 2));
      return;
    }

    const snapRollbackMatch = pathname.match(/^\/api\/snapshots\/([^/]+)\/rollback$/);
    if (snapRollbackMatch && req.method === 'POST') {
      const runId = decodeURIComponent(snapRollbackMatch[1]);
      const rb = agent.snapshots.rollback(runId);
      res.writeHead(rb.success ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rb, null, 2));
      return;
    }

    // 6i. Daemon Status & Webhook Triggers
    if (pathname === '/api/daemon/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...daemon.getStatus() }, null, 2));
      return;
    }

    const webhookMatch = pathname.match(/^\/api\/webhooks\/([^/]+)$/);
    if (webhookMatch && req.method === 'POST') {
      const data: Record<string, any> | null = await readJsonBody(req, res);
      if (!data) return;
      const triggerId = decodeURIComponent(webhookMatch[1]);
      try {
        const record = await daemon.fireTrigger(triggerId, data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, record }, null, 2));
      } catch (err: any) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // 8-13. Provider, Model, and System Prompt / Temperature routes
    if (await handleConfigRoutes({ req, res, pathname, url, agent, sessionManager, persistConfig })) {
      return;
    }

    // 14. GET /api/skills/:skillName/references/:refName (Read workflow runbook reference)
    if (pathname.startsWith('/api/skills/') && pathname.includes('/references/') && req.method === 'GET') {
      try {
        const parts = pathname.replace('/api/skills/', '').split('/references/');
        const skillName = path.basename(parts[0]);
        const refName = path.basename(parts[1]);

        if (!/^[a-zA-Z0-9_.-]+$/.test(skillName) || !/^[a-zA-Z0-9_.-]+$/.test(refName)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid skill or reference filename' }));
          return;
        }

        const refPath = path.resolve(agent.config.skillsDir, skillName, 'references', refName);
        const rel = path.relative(agent.config.skillsDir, refPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Access Denied' }));
          return;
        }

        if (fs.existsSync(refPath) && fs.statSync(refPath).isFile()) {
          const content = fs.readFileSync(refPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            skill: skillName,
            reference: refName,
            content
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: `Reference '${refName}' not found for skill '${skillName}'` }));
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // 15. POST /api/skills/create (Interactively scaffold and register new skill - disabled by default)
    if (pathname === '/api/skills/create' && req.method === 'POST') {
      if (!allowSkillCreation) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'Skill creation via API is disabled by default. Enable gateway.allowSkillCreation in om.config.json to allow it.'
        }));
        return;
      }
      const data: Record<string, any> | null = await readJsonBody(req, res);
      if (!data) return;
      try {
        const { type, name, description, prompt, triggers, code } = data;
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Valid skill name (letters, numbers, hyphens) is required' }));
          return;
        }

        const cleanName = name.trim().toLowerCase();
        const cleanDesc = (description || `Custom ${type || 'workflow'} skill ${cleanName}`).trim();
        const skillsDir = agent.config.skillsDir;
        if (!fs.existsSync(skillsDir)) {
          fs.mkdirSync(skillsDir, { recursive: true });
        }

        let createdPath = '';
        if (type === 'tool') {
          // JavaScript executable tool
          const toolFile = path.join(skillsDir, `${cleanName}.js`);
          const toolCode = code && code.trim() ? code.trim() : `export const skill = {
  name: '${cleanName}',
  description: ${JSON.stringify(cleanDesc)},
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Task input parameter' }
    }
  },
  async execute(args, context) {
    return {
      success: true,
      message: 'Executed ${cleanName} successfully',
      args
    };
  }
};
`;
          fs.writeFileSync(toolFile, toolCode, 'utf8');
          createdPath = toolFile;
        } else {
          // Workflow directive (SKILL.md)
          const skillFolder = path.join(skillsDir, cleanName);
          if (!fs.existsSync(skillFolder)) {
            fs.mkdirSync(skillFolder, { recursive: true });
          }
          const cleanTriggers = Array.isArray(triggers) && triggers.length > 0 ? triggers : ['user', 'model'];
          const skillMdFile = path.join(skillFolder, 'SKILL.md');
          const mdContent = `---
name: ${cleanName}
description: ${cleanDesc}
disable-model-invocation: true
triggers: [${cleanTriggers.join(', ')}]
---

${prompt && prompt.trim() ? prompt.trim() : `Execute procedure for ${cleanName}. Be concise, practical, and clear.`}
`;
          fs.writeFileSync(skillMdFile, mdContent, 'utf8');
          createdPath = skillMdFile;
        }

        // Reload skills registry immediately
        await agent.skills.loadFromDirectory(skillsDir);
        agent._emitConfigUpdate();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          name: cleanName,
          type: type || 'workflow',
          path: createdPath,
          message: `Skill '${cleanName}' created and registered successfully`
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // --- Static Web Dashboard Files ---
    if ((pathname === '/' || pathname === '/index.html') && isEphemeralToken && isLocalHostBind && !reqOrigin) {
      for (const dir of PUBLIC_DIRS) {
        const indexPath = path.join(dir, 'index.html');
        if (fs.existsSync(indexPath)) {
          const html = fs.readFileSync(indexPath, 'utf8').replace(
            '<head>',
            `<head>\n  <meta name="om-gateway-token" content="${authToken}">`
          );
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
          return;
        }
      }
    }
    if (serveStatic(res, pathname, PUBLIC_DIRS)) return;

    // Default 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.on('close', () => {
    agentManager.dispose();
    daemon.stop();
    agent.close?.().catch(() => {});
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      console.log(`\n[OMega] Running live at: \x1b[36m${url}\x1b[0m`);
      if (isEphemeralToken) {
        console.log(`[OMega Security] Gateway token: \x1b[33m${authToken}\x1b[0m\n`);
      } else {
        console.log('');
      }
      resolve({ server, agent, agentManager, url, port: actualPort, host, authToken });
    });
  });
}
