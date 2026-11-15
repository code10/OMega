import type http from 'node:http';
import path from 'node:path';
import { SessionReplay } from '../../replay.js';
import { readJsonBody, sendJson } from '../httpUtils.js';

export interface SessionRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  agent: any;
}

export async function handleSessionRoutes(ctx: SessionRouteContext): Promise<boolean> {
  const { req, res, pathname, agent } = ctx;

  // POST /api/sessions/:id/fork
  const forkMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/);
  if (forkMatch && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const sourceId = decodeURIComponent(forkMatch[1]);
      const forked = SessionReplay.forkFromStep(agent.memory, sourceId, data.step || 1, {
        overrideToolResult: data.overrideToolResult
      });
      sendJson(res, 200, { success: true, forkedSession: forked }, true);
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return true;
  }

  // POST /api/sessions/:id/replay
  const replayMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/replay$/);
  if (replayMatch && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const sourceId = decodeURIComponent(replayMatch[1]);
      const replayRes = await SessionReplay.deterministicReplay(agent, sourceId, {
        mockTools: data.mockTools !== false
      });
      sendJson(res, 200, { success: true, ...replayRes }, true);
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return true;
  }

  // POST /api/compare
  if (pathname === '/api/compare' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    if (!data.prompt || !Array.isArray(data.targets) || data.targets.length === 0) {
      sendJson(res, 400, { success: false, error: 'prompt and targets[] are required' });
      return true;
    }
    try {
      const comparison = await SessionReplay.compareModels(agent.options, data.prompt, data.targets);
      sendJson(res, 200, { success: true, ...comparison }, true);
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // POST /api/reset
  if (pathname === '/api/reset' && req.method === 'POST') {
    agent.reset();
    sendJson(res, 200, { success: true, sessionId: agent.sessionId });
    return true;
  }

  // POST /api/clear or POST /api/sessions/clear
  if ((pathname === '/api/clear' || pathname === '/api/sessions/clear') && req.method === 'POST') {
    sendJson(res, 200, agent.clearCurrentSession());
    return true;
  }

  // GET /api/sessions
  if (pathname === '/api/sessions' && req.method === 'GET') {
    try {
      /** @type {Array<Record<string, any>>} */
      const sessions = agent.memory.listSessions();
      const hasCurrent = sessions.some((s: any) => s.sessionId === agent.sessionId);
      if (!hasCurrent && agent.sessionId) {
        const match = agent.sessionId.match(/^session_(\d+)$/);
        const num = match ? parseInt(match[1], 10) : Infinity;
        sessions.push({
          file: `${agent.sessionId}.json`,
          sessionId: agent.sessionId,
          sessionNumber: num,
          timestamp: new Date().toISOString(),
          provider: agent.config.provider,
          model: agent.config.model,
          target: agent._getTarget(),
          historyLength: agent.history?.length || 0,
          answersCount: agent.answers?.length || 0,
          firstTask: agent.history?.[0]?.content || '(New conversation)',
          latestAnswer: agent.answers?.slice(-1)[0]?.answer || '',
          isCurrent: true,
          isNew: (agent.history?.length || 0) === 0
        });
        sessions.sort((a: any, b: any) => a.sessionNumber - b.sessionNumber);
      }
      sendJson(res, 200, { success: true, currentSessionId: agent.sessionId, sessions });
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // POST /api/sessions/switch
  if (pathname === '/api/sessions/switch' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    const { sessionId } = data;
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      sendJson(res, 400, { error: 'Valid sessionId is required' });
      return true;
    }
    try {
      const sessionData = agent.resumeSession(sessionId);
      sendJson(res, 200, { success: true, sessionId: agent.sessionId, session: sessionData });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  // POST /api/sessions/reset-counter or /api/sessions/clear-all
  if ((pathname === '/api/sessions/reset-counter' || pathname === '/api/sessions/clear-all') && req.method === 'POST') {
    try {
      sendJson(res, 200, agent.resetSessionCounter());
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // GET /api/sessions/:sessionId/export
  if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/export') && req.method === 'GET') {
    try {
      const segments = pathname.replace('/api/sessions/', '').split('/');
      const sessionId = path.basename(segments[0]);
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        sendJson(res, 400, { error: 'Invalid session ID' });
        return true;
      }

      const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const format = (urlObj.searchParams.get('format') || 'markdown').toLowerCase();

      const sessionData = sessionId === agent.sessionId
        ? {
            sessionId: agent.sessionId,
            history: agent.history,
            answers: agent.answers || [],
            provider: agent.config.provider,
            model: agent.config.model,
            target: agent._getTarget(),
            timestamp: new Date().toISOString()
          }
        : agent.memory.loadSession(sessionId);

      if (!sessionData) {
        sendJson(res, 404, { error: `Session '${sessionId}' not found` });
        return true;
      }

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${sessionId}_transcript.json"`);
        res.writeHead(200);
        res.end(JSON.stringify(sessionData, null, 2));
        return true;
      }

      const history = sessionData.history || [];
      let md = `# OMega Session Transcript: ${sessionId}\n\n`;
      md += `**Date:** ${sessionData.timestamp || new Date().toISOString()}\n`;
      md += `**Provider:** ${sessionData.provider || agent.config.provider} [${sessionData.model || agent.config.model}]\n`;
      if (sessionData.target) md += `**Target:** ${sessionData.target}\n`;
      if (Array.isArray(sessionData.answers)) md += `**Model Answers Logged:** ${sessionData.answers.length}\n`;
      md += `**Total Messages:** ${history.length}\n\n---\n\n`;

      for (const msg of history) {
        let roleTitle = msg.role === 'user' ? 'User' : (msg.role === 'assistant' ? 'Agent' : msg.role);
        if (msg.role === 'assistant' && (msg.model || msg.provider)) {
          roleTitle += ` (${msg.provider || sessionData.provider || ''}: ${msg.model || sessionData.model || ''})`;
        }
        md += `### ${roleTitle}\n\n${msg.content || ''}\n\n`;
      }

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${sessionId}_transcript.md"`);
      res.writeHead(200);
      res.end(md);
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  return false;
}
