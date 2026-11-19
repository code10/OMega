import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  captureWorkspaceState,
  deleteCheckpoint,
  forkCheckpoint,
  getCheckpointsDir,
  isPidAlive,
  listCheckpoints,
  loadCheckpoint,
  sanitizeSessionId,
  saveCheckpoint,
  type CheckpointBudgets,
  type CheckpointRecord
} from './checkpoint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SpawnDetachedOptions {
  prompt: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  maxSteps?: number;
  workspaceDir?: string;
  workspaceMode?: 'shared' | 'worktree';
  swarmId?: string | null;
  parentSessionId?: string | null;
  budgets?: CheckpointBudgets;
  memoryDir?: string;
  skillsDir?: string;
  resume?: boolean;
}

export interface DetachedSessionHandle {
  sessionId: string;
  runId: string;
  pid: number | null;
  logFile: string;
  status: string;
  swarmId?: string | null;
  workspaceDir?: string;
  workspaceMode?: 'shared' | 'worktree';
}

/**
 * Manages process-detached background agent workers with step-level ReAct checkpointing,
 * inspection, crash recovery (resume), and historical session forking.
 */
export class DetachedSwarmManager {
  memoryDir: string;
  workspaceDir: string;
  skillsDir?: string;
  defaultProvider?: string;
  defaultModel?: string;

  constructor(options: {
    memoryDir: string;
    workspaceDir?: string;
    skillsDir?: string;
    provider?: string;
    model?: string;
  }) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    this.skillsDir = options.skillsDir ? path.resolve(options.skillsDir) : undefined;
    this.defaultProvider = options.provider;
    this.defaultModel = options.model;
  }

  _workerScriptPath(): string {
    // Always resolve to compiled JS in dist/agent/detachedWorker.js
    const candidate = path.join(__dirname, 'detachedWorker.js');
    if (fs.existsSync(candidate)) return candidate;
    return path.resolve(this.workspaceDir, 'dist/agent/detachedWorker.js');
  }

  _prepareWorkspace(
    baseWorkspace: string,
    sessionId: string,
    requestedMode: 'shared' | 'worktree' = 'shared'
  ): { workspaceDir: string; workspaceMode: 'shared' | 'worktree' } {
    const resolvedBase = path.resolve(baseWorkspace || this.workspaceDir);
    if (requestedMode !== 'worktree') {
      return { workspaceDir: resolvedBase, workspaceMode: 'shared' };
    }
    const worktreeDir = path.join(resolvedBase, '.om_worktrees', sanitizeSessionId(sessionId));
    if (fs.existsSync(worktreeDir)) {
      return { workspaceDir: worktreeDir, workspaceMode: 'worktree' };
    }
    try {
      fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
      const branchName = `om-swarm-${sanitizeSessionId(sessionId)}`;
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreeDir, 'HEAD'], {
        cwd: resolvedBase,
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'ignore']
      });
      return { workspaceDir: worktreeDir, workspaceMode: 'worktree' };
    } catch {
      // Fallback gracefully if not a git repo or HEAD cannot be branched
      return { workspaceDir: resolvedBase, workspaceMode: 'shared' };
    }
  }

  /**
   * Spawn a new process-detached background agent daemon (survives parent/UI/CLI exit).
   */
  spawnDetached(options: SpawnDetachedOptions): DetachedSessionHandle {
    const prompt = String(options.prompt || '').trim();
    if (!prompt && !options.resume) {
      throw new Error('spawnDetached requires a non-empty prompt');
    }

    const memDir = path.resolve(options.memoryDir || this.memoryDir);
    const cpDir = getCheckpointsDir(memDir);
    fs.mkdirSync(cpDir, { recursive: true });

    const sessionId = sanitizeSessionId(
      options.sessionId || `detached_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    );
    const existing = options.resume ? loadCheckpoint(memDir, sessionId) : null;
    const effectivePrompt = prompt || existing?.prompt || '';
    if (!effectivePrompt) {
      throw new Error(`Cannot resume session '${sessionId}': missing prompt`);
    }

    const logFile = path.join(cpDir, `${sessionId}.log`);
    const jobFile = path.join(cpDir, `${sessionId}.job.json`);
    const runId = existing?.runId || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

    const requestedMode = options.workspaceMode || existing?.workspaceMode || 'shared';
    const baseWorkspace = path.resolve(options.workspaceDir || existing?.workspaceDir || this.workspaceDir);
    const preparedWs = existing?.workspaceDir && options.resume
      ? { workspaceDir: existing.workspaceDir, workspaceMode: existing.workspaceMode || requestedMode }
      : this._prepareWorkspace(baseWorkspace, sessionId, requestedMode);

    const effectiveBudgets = options.budgets || existing?.budgets;
    const effectiveSwarmId = options.swarmId !== undefined ? options.swarmId : existing?.swarmId ?? null;
    const effectiveParentId = options.parentSessionId !== undefined ? options.parentSessionId : existing?.parentSessionId ?? null;
    const wsState = captureWorkspaceState(preparedWs.workspaceDir);

    const jobPayload = {
      sessionId,
      prompt: effectivePrompt,
      provider: options.provider || existing?.provider || this.defaultProvider,
      model: options.model || existing?.model || this.defaultModel,
      systemPrompt: options.systemPrompt || existing?.systemPrompt,
      maxSteps: options.maxSteps || existing?.maxSteps || 15,
      workspaceDir: preparedWs.workspaceDir,
      workspaceMode: preparedWs.workspaceMode,
      swarmId: effectiveSwarmId,
      parentSessionId: effectiveParentId,
      budgets: effectiveBudgets,
      memoryDir: memDir,
      skillsDir: options.skillsDir || this.skillsDir,
      logFile,
      resume: Boolean(options.resume && existing)
    };
    fs.writeFileSync(jobFile, JSON.stringify(jobPayload, null, 2), 'utf8');

    // Write/update initial checkpoint before spawning so UI sees it immediately
    const now = new Date().toISOString();
    saveCheckpoint(memDir, {
      sessionId,
      runId,
      pid: null,
      detached: true,
      status: 'running',
      prompt: effectivePrompt,
      systemPrompt: jobPayload.systemPrompt,
      provider: String(jobPayload.provider || 'om'),
      model: String(jobPayload.model || 'om-turbo'),
      workspaceDir: jobPayload.workspaceDir,
      workspaceMode: jobPayload.workspaceMode,
      swarmId: effectiveSwarmId,
      parentSessionId: effectiveParentId,
      currentStep: existing?.currentStep ?? 0,
      maxSteps: jobPayload.maxSteps,
      pendingStep: existing?.pendingStep ?? null,
      snapshotRunId: existing?.snapshotRunId ?? runId,
      workspaceHead: existing?.workspaceHead ?? wsState.head,
      workspaceDirtyHash: existing?.workspaceDirtyHash ?? wsState.dirtyHash,
      pauseReason: null,
      budgets: effectiveBudgets,
      usage: existing?.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      history: existing?.history || [],
      steps: existing?.steps || [],
      answers: existing?.answers || [],
      logFile,
      startedAt: existing?.startedAt || now,
      updatedAt: now
    });

    const outFd = fs.openSync(logFile, 'a');
    let childPid: number | null = null;
    try {
      const child = spawn(process.execPath, [this._workerScriptPath(), jobFile], {
        cwd: jobPayload.workspaceDir,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        windowsHide: true
      });
      child.unref();
      childPid = child.pid ?? null;
    } finally {
      fs.closeSync(outFd);
    }

    const updated = loadCheckpoint(memDir, sessionId);
    if (updated && childPid) {
      saveCheckpoint(memDir, { ...updated, pid: childPid, status: 'running' });
    }

    return {
      sessionId,
      runId,
      pid: childPid,
      logFile,
      status: 'running',
      swarmId: effectiveSwarmId,
      workspaceDir: jobPayload.workspaceDir,
      workspaceMode: jobPayload.workspaceMode
    };
  }

  /**
   * Spawn a coordinated multi-worker detached swarm under a shared swarmId.
   */
  spawnSwarm(
    tasks: Array<Pick<SpawnDetachedOptions, 'prompt' | 'sessionId' | 'provider' | 'model' | 'systemPrompt' | 'maxSteps' | 'budgets'>>,
    sharedOptions: Omit<SpawnDetachedOptions, 'prompt' | 'sessionId'> = {}
  ): { swarmId: string; workers: DetachedSessionHandle[] } {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('spawnSwarm requires at least one task');
    }
    const swarmId = sharedOptions.swarmId || `swarm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const defaultMode = sharedOptions.workspaceMode || (tasks.length > 1 ? 'worktree' : 'shared');
    const workers = tasks.map((task, idx) =>
      this.spawnDetached({
        ...sharedOptions,
        ...task,
        swarmId,
        workspaceMode: defaultMode,
        sessionId: task.sessionId || `${swarmId}_w${idx + 1}`
      })
    );
    return { swarmId, workers };
  }

  /**
   * List all checkpointed/detached sessions with live PID liveness detection.
   */
  listSessions(): CheckpointRecord[] {
    return listCheckpoints(this.memoryDir);
  }

  /**
   * Inspect a checkpointed/detached session including its recent log output.
   */
  inspectSession(sessionId: string, options: { logLines?: number } = {}) {
    const checkpoint = loadCheckpoint(this.memoryDir, sessionId);
    if (!checkpoint) {
      throw new Error(`Session checkpoint '${sessionId}' not found`);
    }

    let logTail = '';
    if (checkpoint.logFile && fs.existsSync(checkpoint.logFile)) {
      const raw = fs.readFileSync(checkpoint.logFile, 'utf8');
      const lines = raw.split(/\r?\n/);
      const maxLines = options.logLines ?? 80;
      logTail = lines.slice(-maxLines).join('\n');
    }

    return {
      ...checkpoint,
      logTail
    };
  }

  /**
   * Resume an interrupted, paused, failed, or crashed session from its exact last ReAct step.
   */
  resumeSession(sessionId: string, options: { maxSteps?: number; prompt?: string } = {}): DetachedSessionHandle {
    const existing = loadCheckpoint(this.memoryDir, sessionId);
    if (!existing) {
      throw new Error(`Session checkpoint '${sessionId}' not found`);
    }
    if (existing.status === 'running' && isPidAlive(existing.pid)) {
      throw new Error(`Session '${sessionId}' is already running (pid=${existing.pid})`);
    }
    return this.spawnDetached({
      sessionId,
      prompt: options.prompt || existing.prompt,
      maxSteps: options.maxSteps || existing.maxSteps,
      resume: true
    });
  }

  /**
   * Fork any historical or mid-flight checkpointed session (optionally at a specific step)
   * into a new independent session and optionally launch it as a detached worker.
   */
  forkSession(
    sourceSessionId: string,
    options: { step?: number; newSessionId?: string; prompt?: string; autoStart?: boolean } = {}
  ) {
    const forked = forkCheckpoint(this.memoryDir, sourceSessionId, options);
    if (options.autoStart) {
      const handle = this.spawnDetached({
        sessionId: forked.sessionId,
        prompt: forked.prompt,
        maxSteps: forked.maxSteps,
        resume: true
      });
      return { forked, handle };
    }
    return { forked, handle: null };
  }

  /**
   * Stop a running detached background worker process.
   */
  stopSession(sessionId: string): { stopped: boolean; pid: number | null } {
    const cp = loadCheckpoint(this.memoryDir, sessionId);
    if (!cp) {
      throw new Error(`Session checkpoint '${sessionId}' not found`);
    }
    let stopped = false;
    if (cp.pid && isPidAlive(cp.pid)) {
      try {
        process.kill(cp.pid, 'SIGTERM');
        stopped = true;
      } catch (_) {
        stopped = false;
      }
    }
    saveCheckpoint(this.memoryDir, {
      ...cp,
      status: 'aborted',
      pid: null,
      finishedAt: new Date().toISOString()
    });
    return { stopped, pid: cp.pid };
  }

  /**
   * Delete a stopped/completed checkpoint and its job/log files.
   */
  deleteSession(sessionId: string): boolean {
    const cp = loadCheckpoint(this.memoryDir, sessionId);
    if (cp && cp.status === 'running' && isPidAlive(cp.pid)) {
      this.stopSession(sessionId);
    }
    const deleted = deleteCheckpoint(this.memoryDir, sessionId);
    const cpDir = getCheckpointsDir(this.memoryDir);
    const safeId = sanitizeSessionId(sessionId);
    for (const ext of ['.log', '.job.json']) {
      const p = path.join(cpDir, `${safeId}${ext}`);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (_) {
          // ignore
        }
      }
    }
    return deleted;
  }
}
