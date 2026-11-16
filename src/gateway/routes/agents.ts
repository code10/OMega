import type http from 'node:http';
import { readJsonBody, sendJson } from '../httpUtils.js';
import type { AgentManager } from '../agentManager.js';
import { DetachedSwarmManager } from '../../agent/detachedSwarm.js';

export interface AgentsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  agentManager: AgentManager;
}

export async function handleAgentsRoutes(ctx: AgentsRouteContext): Promise<boolean> {
  const { req, res, pathname, agentManager } = ctx;

  if (pathname === '/api/agents' && req.method === 'GET') {
    sendJson(res, 200, { success: true, ...agentManager.getState() });
    return true;
  }

  if (pathname === '/api/agents/reset' && req.method === 'POST') {
    agentManager.resetAll();
    sendJson(res, 200, { success: true, ...agentManager.getState() });
    return true;
  }

  if (pathname === '/api/agents/run' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const run = agentManager.startOneOffRun({
        name: data.name,
        prompt: data.prompt,
        systemPrompt: data.systemPrompt,
        provider: data.provider,
        model: data.model,
        maxSteps: data.maxSteps
      });
      sendJson(res, 202, { success: true, run });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const abortMatch = pathname.match(/^\/api\/agents\/runs\/([^/]+)\/abort$/);
  if (abortMatch && req.method === 'POST') {
    const runId = decodeURIComponent(abortMatch[1]);
    const aborted = agentManager.abortRun(runId);
    if (!aborted) {
      sendJson(res, 404, { success: false, error: `Active run '${runId}' not found` });
      return true;
    }
    sendJson(res, 200, { success: true, aborted: true, runId });
    return true;
  }

  const diffMatch = pathname.match(/^\/api\/agents\/runs\/([^/]+)\/diff$/);
  if (diffMatch && req.method === 'GET') {
    const runId = decodeURIComponent(diffMatch[1]);
    try {
      const diff = agentManager.getRunDiff(runId);
      sendJson(res, 200, { success: true, ...diff });
    } catch (err: any) {
      sendJson(res, 404, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const rollbackMatch = pathname.match(/^\/api\/agents\/runs\/([^/]+)\/rollback$/);
  if (rollbackMatch && req.method === 'POST') {
    const runId = decodeURIComponent(rollbackMatch[1]);
    try {
      const result = agentManager.rollbackRun(runId);
      sendJson(res, 200, { ...result });
    } catch (err: any) {
      sendJson(res, 404, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  if (pathname === '/api/agents/persistent' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const agent = agentManager.createPersistentAgent({
        name: data.name,
        description: data.description,
        systemPrompt: data.systemPrompt,
        taskPrompt: data.taskPrompt,
        mode: data.mode,
        intervalMs: data.intervalMs,
        cron: data.cron,
        watchPath: data.watchPath,
        provider: data.provider,
        model: data.model,
        maxSteps: data.maxSteps,
        keepHistory: data.keepHistory,
        workspaceMode: data.workspaceMode,
        maxConsecutiveFailures: data.maxConsecutiveFailures,
        dailyTokenBudget: data.dailyTokenBudget,
        dailyCostBudgetUsd: data.dailyCostBudgetUsd,
        autoStart: data.autoStart
      });
      sendJson(res, 201, { success: true, agent });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const pUpdateMatch = pathname.match(/^\/api\/agents\/persistent\/([^/]+)$/);
  if (pUpdateMatch && req.method === 'PATCH') {
    const id = decodeURIComponent(pUpdateMatch[1]);
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const agent = agentManager.updatePersistentAgent(id, data);
      sendJson(res, 200, { success: true, agent });
    } catch (err: any) {
      const status = String(err?.message || '').includes('not found') ? 404 : 400;
      sendJson(res, status, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const pRunMatch = pathname.match(/^\/api\/agents\/persistent\/([^/]+)\/run$/);
  if (pRunMatch && req.method === 'POST') {
    const id = decodeURIComponent(pRunMatch[1]);
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const run = await agentManager.runPersistentAgent(id, data.prompt);
      sendJson(res, 202, { success: true, run });
    } catch (err: any) {
      const status = String(err?.message || '').includes('not found') ? 404 : 400;
      sendJson(res, status, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const pWebhookMatch = pathname.match(/^\/api\/agents\/persistent\/([^/]+)\/webhook$/);
  if (pWebhookMatch && req.method === 'POST') {
    const id = decodeURIComponent(pWebhookMatch[1]);
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const existing = agentManager.persistentAgents.get(id);
      if (!existing) {
        sendJson(res, 404, { success: false, error: `Persistent agent '${id}' not found` });
        return true;
      }
      const basePrompt = data.prompt || existing.taskPrompt || 'Handle incoming webhook event';
      const payloadStr = Object.keys(data).length > 0 ? `\n[Webhook Payload]: ${JSON.stringify(data)}` : '';
      const run = await agentManager.runPersistentAgent(id, `${basePrompt}${payloadStr}`);
      sendJson(res, 202, { success: true, run });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const pStartMatch = pathname.match(/^\/api\/agents\/persistent\/([^/]+)\/start$/);
  if (pStartMatch && req.method === 'POST') {
    const id = decodeURIComponent(pStartMatch[1]);
    try {
      const agent = agentManager.startPersistentAgent(id);
      sendJson(res, 200, { success: true, agent });
    } catch (err: any) {
      sendJson(res, 404, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const pStopMatch = pathname.match(/^\/api\/agents\/persistent\/([^/]+)\/stop$/);
  if (pStopMatch && req.method === 'POST') {
    const id = decodeURIComponent(pStopMatch[1]);
    try {
      const agent = agentManager.stopPersistentAgent(id);
      sendJson(res, 200, { success: true, agent });
    } catch (err: any) {
      sendJson(res, 404, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const pDeleteMatch = pathname.match(/^\/api\/agents\/persistent\/([^/]+)$/);
  if (pDeleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(pDeleteMatch[1]);
    const deleted = agentManager.deletePersistentAgent(id);
    if (!deleted) {
      sendJson(res, 404, { success: false, error: `Persistent agent '${id}' not found` });
      return true;
    }
    sendJson(res, 200, { success: true, deleted: true, id });
    return true;
  }

  const getDetachedManager = () => new DetachedSwarmManager({
    memoryDir: agentManager.memoryDir,
    workspaceDir: agentManager.parentAgent?.config?.workspaceDir,
    skillsDir: agentManager.parentAgent?.config?.skillsDir,
    provider: agentManager.parentAgent?.config?.provider,
    model: agentManager.parentAgent?.config?.model
  });

  if (pathname === '/api/agents/detached' && req.method === 'GET') {
    const sessions = getDetachedManager().listSessions();
    sendJson(res, 200, { success: true, sessions }, true);
    return true;
  }

  if (pathname === '/api/agents/detached/spawn' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const handle = getDetachedManager().spawnDetached({
        prompt: data.prompt,
        sessionId: data.sessionId,
        provider: data.provider,
        model: data.model,
        systemPrompt: data.systemPrompt,
        maxSteps: data.maxSteps
      });
      sendJson(res, 202, { success: true, ...handle });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const dInspectMatch = pathname.match(/^\/api\/agents\/detached\/([^/]+)$/);
  if (dInspectMatch && req.method === 'GET') {
    const sessionId = decodeURIComponent(dInspectMatch[1]);
    try {
      const session = getDetachedManager().inspectSession(sessionId);
      sendJson(res, 200, { success: true, session }, true);
    } catch (err: any) {
      sendJson(res, 404, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const dResumeMatch = pathname.match(/^\/api\/agents\/detached\/([^/]+)\/resume$/);
  if (dResumeMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(dResumeMatch[1]);
    const data: Record<string, any> = (await readJsonBody(req, res)) || {};
    try {
      const handle = getDetachedManager().resumeSession(sessionId, {
        maxSteps: data.maxSteps,
        prompt: data.prompt
      });
      sendJson(res, 202, { success: true, ...handle });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const dForkMatch = pathname.match(/^\/api\/agents\/detached\/([^/]+)\/fork$/);
  if (dForkMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(dForkMatch[1]);
    const data: Record<string, any> = (await readJsonBody(req, res)) || {};
    try {
      const result = getDetachedManager().forkSession(sessionId, {
        step: data.step,
        newSessionId: data.newSessionId,
        prompt: data.prompt,
        autoStart: Boolean(data.autoStart)
      });
      sendJson(res, 201, { success: true, ...result }, true);
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const dStopMatch = pathname.match(/^\/api\/agents\/detached\/([^/]+)\/stop$/);
  if (dStopMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(dStopMatch[1]);
    try {
      const result = getDetachedManager().stopSession(sessionId);
      sendJson(res, 200, { success: true, ...result });
    } catch (err: any) {
      sendJson(res, 404, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
