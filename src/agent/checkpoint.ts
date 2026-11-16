import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AgentCheckpoint');

export type CheckpointStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'paused';

export interface CheckpointRecord {
  sessionId: string;
  runId: string;
  pid: number | null;
  detached: boolean;
  status: CheckpointStatus;
  prompt: string;
  systemPrompt?: string;
  provider: string;
  model: string;
  workspaceDir: string;
  currentStep: number;
  maxSteps: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  history: Array<Record<string, any>>;
  steps: Array<Record<string, any>>;
  answers: Array<Record<string, any>>;
  logFile?: string | null;
  error?: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  pidAlive?: boolean;
  recoverable?: boolean;
}

export function getCheckpointsDir(memoryDir: string): string {
  return path.join(path.resolve(memoryDir), 'checkpoints');
}

export function sanitizeSessionId(sessionId: string): string {
  return String(sessionId || 'session').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function getCheckpointPath(memoryDir: string, sessionId: string): string {
  return path.join(getCheckpointsDir(memoryDir), `${sanitizeSessionId(sessionId)}.json`);
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but we lack permission; ESRCH means it does not exist
    return err?.code === 'EPERM';
  }
}

export function saveCheckpoint(memoryDir: string, record: CheckpointRecord): string {
  const dir = getCheckpointsDir(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getCheckpointPath(memoryDir, record.sessionId);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const payload = {
    ...record,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

export function loadCheckpoint(memoryDir: string, sessionId: string): CheckpointRecord | null {
  const filePath = getCheckpointPath(memoryDir, sessionId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CheckpointRecord;
    const alive = raw.status === 'running' ? isPidAlive(raw.pid) : false;
    return {
      ...raw,
      pidAlive: alive,
      recoverable: raw.status !== 'completed' && !alive
    };
  } catch (err: any) {
    log.warn(`Failed to load checkpoint ${sessionId}: ${err.message}`);
    return null;
  }
}

export function listCheckpoints(memoryDir: string): CheckpointRecord[] {
  const dir = getCheckpointsDir(memoryDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.job.json'));
  const records: CheckpointRecord[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CheckpointRecord;
      const alive = raw.status === 'running' ? isPidAlive(raw.pid) : false;
      const effectiveStatus: CheckpointStatus =
        raw.status === 'running' && !alive ? 'paused' : raw.status;
      records.push({
        ...raw,
        status: effectiveStatus,
        pidAlive: alive,
        recoverable: effectiveStatus !== 'completed' && !alive
      });
    } catch (_) {
      // skip corrupt checkpoint
    }
  }
  return records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function deleteCheckpoint(memoryDir: string, sessionId: string): boolean {
  const filePath = getCheckpointPath(memoryDir, sessionId);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Fork a checkpointed session (optionally at a specific ReAct step) into a new independent session checkpoint.
 */
export function forkCheckpoint(
  memoryDir: string,
  sourceSessionId: string,
  options: { step?: number; newSessionId?: string; prompt?: string } = {}
): CheckpointRecord {
  const source = loadCheckpoint(memoryDir, sourceSessionId);
  if (!source) {
    throw new Error(`Checkpoint '${sourceSessionId}' not found`);
  }

  const targetStep = typeof options.step === 'number' && options.step >= 0
    ? Math.min(options.step, source.steps.length)
    : source.steps.length;

  const forkedSteps = source.steps.slice(0, targetStep).map((s) => ({ ...s }));
  const newSessionId = options.newSessionId || `${source.sessionId}_fork_${Date.now().toString(36)}`;

  // Reconstruct history cleanly up to targetStep without leaving orphaned tool messages
  let forkedHistory = Array.isArray(source.history) ? [...source.history] : [];
  if (targetStep < source.steps.length && forkedSteps.length > 0) {
    // Count assistant turns corresponding to targetStep
    let assistantCount = 0;
    let cutIdx = forkedHistory.length;
    for (let i = 0; i < forkedHistory.length; i++) {
      if (forkedHistory[i]?.role === 'assistant') {
        assistantCount++;
        if (assistantCount > targetStep) {
          cutIdx = i;
          break;
        }
      }
    }
    forkedHistory = forkedHistory.slice(0, cutIdx);
  }
  while (forkedHistory.length > 0 && forkedHistory[forkedHistory.length - 1]?.role === 'tool') {
    forkedHistory.pop();
  }

  const forked: CheckpointRecord = {
    ...source,
    sessionId: newSessionId,
    runId: `run_${Date.now().toString(36)}_fork`,
    pid: null,
    status: 'paused',
    prompt: options.prompt || source.prompt,
    currentStep: targetStep,
    history: forkedHistory,
    steps: forkedSteps,
    answers: Array.isArray(source.answers) ? [...source.answers] : [],
    error: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    pidAlive: false,
    recoverable: true
  };

  saveCheckpoint(memoryDir, forked);
  return forked;
}
