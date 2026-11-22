import type http from 'node:http';
import type { OMDaemon } from '../../daemon.js';
import { saveConfigPatch } from '../../config.js';
import { readJsonBody, sendJson } from '../httpUtils.js';

export interface DaemonRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  url: URL;
  daemon: OMDaemon;
  agent: any;
  persistConfig: boolean;
}

function serializeTriggersForConfig(daemon: OMDaemon) {
  return Array.from(daemon.triggers.values())
    .filter((t) => !t.handler && t.id !== 'autonomous_memory_distillation')
    .map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      ...(t.cron ? { cron: t.cron } : {}),
      ...(t.everyMs ? { everyMs: t.everyMs } : {}),
      ...(t.watchPath ? { watchPath: t.watchPath } : {}),
      ...(t.checkCommand ? { checkCommand: t.checkCommand } : {}),
      ...(t.checkTimeoutMs ? { checkTimeoutMs: t.checkTimeoutMs } : {}),
      ...(t.isolatedWorktree ? { isolatedWorktree: true } : {}),
      maxSteps: t.maxSteps,
      ...(t.maxTokens ? { maxTokens: t.maxTokens } : {}),
      ...(t.maxDurationMs ? { maxDurationMs: t.maxDurationMs } : {}),
      ...(t.skill ? { skill: t.skill } : {}),
      prompt: t.prompt || '',
      ...(t.runOnStart ? { runOnStart: true } : {}),
      enabled: t.enabled !== false
    }));
}

function persistDaemonTriggers(daemon: OMDaemon, agent: any, persistConfig: boolean) {
  if (!persistConfig) return;
  const triggers = serializeTriggersForConfig(daemon);
  const nextDaemonCfg = { ...(agent.config?.daemon || {}), triggers };
  agent.config.daemon = nextDaemonCfg;
  saveConfigPatch({ daemon: nextDaemonCfg }, agent.config.rootDir);
}

async function restartIfRunning(daemon: OMDaemon) {
  if (!daemon.running) return;
  daemon.stop();
  await daemon.start();
}

export async function handleDaemonRoutes(ctx: DaemonRouteContext): Promise<boolean> {
  const { req, res, pathname, url, daemon, agent, persistConfig } = ctx;

  if (pathname === '/api/daemon/status' && req.method === 'GET') {
    sendJson(res, 200, { success: true, ...daemon.getStatus() });
    return true;
  }

  if (pathname === '/api/daemon/start' && req.method === 'POST') {
    await daemon.start();
    sendJson(res, 200, { success: true, ...daemon.getStatus() });
    return true;
  }

  if (pathname === '/api/daemon/stop' && req.method === 'POST') {
    daemon.stop();
    sendJson(res, 200, { success: true, ...daemon.getStatus() });
    return true;
  }

  if (pathname === '/api/daemon/triggers' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    try {
      const trigger = daemon.addTrigger(data);
      persistDaemonTriggers(daemon, agent, persistConfig);
      await restartIfRunning(daemon);
      sendJson(res, 200, { success: true, trigger, ...daemon.getStatus() });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const triggerMatch = pathname.match(/^\/api\/daemon\/triggers\/([^/]+)$/);
  if (triggerMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(triggerMatch[1]);
    const removed = daemon.removeTrigger(id);
    if (!removed) {
      sendJson(res, 404, { success: false, error: `Trigger '${id}' not found` });
      return true;
    }
    persistDaemonTriggers(daemon, agent, persistConfig);
    await restartIfRunning(daemon);
    sendJson(res, 200, { success: true, removed: id, ...daemon.getStatus() });
    return true;
  }

  const toggleMatch = pathname.match(/^\/api\/daemon\/triggers\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    const id = decodeURIComponent(toggleMatch[1]);
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (data === null) return true;
    try {
      const trigger = daemon.toggleTrigger(id, data.enabled);
      persistDaemonTriggers(daemon, agent, persistConfig);
      await restartIfRunning(daemon);
      sendJson(res, 200, { success: true, trigger, ...daemon.getStatus() });
    } catch (err: any) {
      sendJson(res, 404, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const runTriggerMatch = pathname.match(/^\/api\/daemon\/triggers\/([^/]+)\/run$/);
  if (runTriggerMatch && req.method === 'POST') {
    const id = decodeURIComponent(runTriggerMatch[1]);
    if (!daemon.triggers.has(id)) {
      sendJson(res, 404, { success: false, error: `Trigger '${id}' not found` });
      return true;
    }
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (data === null) return true;

    const isAsync = url.searchParams.get('async') === '1' || url.searchParams.get('async') === 'true';
    if (isAsync) {
      daemon.fireTrigger(id, data).catch(() => {});
      sendJson(res, 202, { success: true, started: true, triggerId: id });
      return true;
    }
    try {
      const record = await daemon.fireTrigger(id, data);
      sendJson(res, 200, { success: true, record });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const diffMatch = pathname.match(/^\/api\/daemon\/runs\/([^/]+)\/diff$/);
  if (diffMatch && req.method === 'GET') {
    const runId = decodeURIComponent(diffMatch[1]);
    const run = daemon.getRun(runId);
    if (!run) {
      sendJson(res, 404, { success: false, error: `Daemon run '${runId}' not found` });
      return true;
    }
    sendJson(res, 200, {
      success: true,
      runId,
      worktree: run.worktree || null
    });
    return true;
  }

  const mergeMatch = pathname.match(/^\/api\/daemon\/runs\/([^/]+)\/merge$/);
  if (mergeMatch && req.method === 'POST') {
    const runId = decodeURIComponent(mergeMatch[1]);
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (data === null) return true;
    try {
      const result = daemon.mergeRunWorktree(runId, data.commitMessage);
      sendJson(res, 200, { success: true, runId, ...result, ...daemon.getStatus() });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  const discardMatch = pathname.match(/^\/api\/daemon\/runs\/([^/]+)\/discard$/);
  if (discardMatch && req.method === 'POST') {
    const runId = decodeURIComponent(discardMatch[1]);
    try {
      const result = daemon.discardRunWorktree(runId);
      sendJson(res, 200, { success: true, runId, ...result, ...daemon.getStatus() });
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: err?.message || String(err) });
    }
    return true;
  }

  return false;
}
