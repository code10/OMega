import type http from 'node:http';
import { OMSelfImprover } from '../../selfImprove.js';
import { OMTrainingPipeline } from '../../training.js';
import { readDistillState } from '../../memory/distiller.js';
import { readJsonBody, sendJson } from '../httpUtils.js';

export interface MemoryRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  url: URL;
  agent: any;
}

export async function handleMemoryRoutes(ctx: MemoryRouteContext): Promise<boolean> {
  const { req, res, pathname, url, agent } = ctx;

  if (pathname === '/api/memory' && req.method === 'GET') {
    const longTerm = agent.memory.readLongTermMemory();
    const daily = agent.memory.readDailyJournal();
    const vectorStats = agent.memory.getVectorStats();
    sendJson(res, 200, { longTerm, daily, vectorStats }, true);
    return true;
  }

  if (pathname === '/api/memory/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
    const mode = (url.searchParams.get('mode') || 'hybrid').toLowerCase();
    const topK = Number(url.searchParams.get('topK') || 10);
    const sourceFilter = url.searchParams.get('source') || undefined;

    const results = mode === 'semantic'
      ? agent.memory.semanticSearch(q, { topK, sourceFilter })
      : agent.memory.search(q, { topK, sourceFilter, semantic: mode !== 'exact' });

    sendJson(res, 200, {
      success: true,
      query: q,
      mode,
      count: results.length,
      results,
      vectorStats: agent.memory.getVectorStats()
    }, true);
    return true;
  }

  if (pathname === '/api/memory/reindex' && req.method === 'POST') {
    const stats = agent.memory.rebuildVectorIndex();
    sendJson(res, 200, {
      success: true,
      message: 'Vector index rebuilt successfully',
      vectorStats: stats
    });
    return true;
  }

  if (pathname === '/api/memory/distill/status' && req.method === 'GET') {
    const state = readDistillState(agent.config.memoryDir);
    sendJson(res, 200, { success: true, ...state }, true);
    return true;
  }

  if (pathname === '/api/memory/distill' && req.method === 'POST') {
    const data = await readJsonBody(req, res);
    if (!data) return true;
    const distilled = await OMSelfImprover.distill(agent, data);
    sendJson(res, 200, distilled, true);
    return true;
  }

  if (pathname === '/api/training/export' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    const exported = OMTrainingPipeline.exportDataset(agent.config.memoryDir, data.outputDir);
    sendJson(res, 200, exported, true);
    return true;
  }

  if (pathname === '/api/memory' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    if (data.content !== undefined) {
      agent.memory.writeLongTermMemory(data.content);
      sendJson(res, 200, { success: true, message: 'Memory updated' });
    } else {
      sendJson(res, 400, { error: 'content field is required' });
    }
    return true;
  }

  return false;
}
