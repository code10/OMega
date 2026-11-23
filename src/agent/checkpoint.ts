import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AgentCheckpoint');

export type CheckpointStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'paused';

export interface CheckpointBudgets {
  maxTokens?: number;
  maxDurationMs?: number;
  maxConsecutiveErrors?: number;
}

export interface WorkspaceStateSnapshot {
  head: string | null;
  dirtyHash: string | null;
  isGitRepo: boolean;
}

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
  workspaceMode?: 'shared' | 'worktree';
  swarmId?: string | null;
  parentSessionId?: string | null;
  currentStep: number;
  maxSteps: number;
  pendingStep?: number | null;
  snapshotRunId?: string | null;
  workspaceHead?: string | null;
  workspaceDirtyHash?: string | null;
  pauseReason?: string | null;
  budgets?: CheckpointBudgets;
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

/**
 * Capture a lightweight git HEAD + working-tree digest for stale-world detection on resume.
 */
export function captureWorkspaceState(workspaceDir: string): WorkspaceStateSnapshot {
  const cwd = path.resolve(workspaceDir || process.cwd());
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const dirtyHash = crypto.createHash('sha256').update(porcelain).digest('hex').slice(0, 12);
    return { head: head || null, dirtyHash, isGitRepo: true };
  } catch {
    return { head: null, dirtyHash: null, isGitRepo: false };
  }
}

/**
 * Compare current workspace git state against a previously checkpointed state.
 */
export function detectWorkspaceDrift(
  workspaceDir: string,
  prevHead?: string | null,
  prevDirtyHash?: string | null
): { drifted: boolean; summary: string; current: WorkspaceStateSnapshot } {
  const current = captureWorkspaceState(workspaceDir);
  if (!current.isGitRepo || (!prevHead && !prevDirtyHash)) {
    return { drifted: false, summary: '', current };
  }
  const reasons: string[] = [];
  if (prevHead && current.head && prevHead !== current.head) {
    reasons.push(`HEAD changed (${prevHead.slice(0, 7)} -> ${current.head.slice(0, 7)})`);
  }
  if (prevDirtyHash && current.dirtyHash && prevDirtyHash !== current.dirtyHash) {
    reasons.push('working tree files modified');
  }
  return {
    drifted: reasons.length > 0,
    summary: reasons.join('; '),
    current
  };
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
  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  let renamed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      renamed = true;
      break;
    } catch (err: any) {
      if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'EACCES') {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
      }
      // Brief busy-wait fallback for Windows file lock contention with concurrent readers
      const waitUntil = Date.now() + 15 * (attempt + 1);
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
  if (!renamed) {
    fs.writeFileSync(filePath, serialized, 'utf8');
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
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
