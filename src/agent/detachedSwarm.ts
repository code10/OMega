import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  forkCheckpoint,
  getCheckpointsDir,
  isPidAlive,
  listCheckpoints,
  loadCheckpoint,
  sanitizeSessionId,
  saveCheckpoint,
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

    const jobPayload = {
      sessionId,
      prompt: effectivePrompt,
      provider: options.provider || existing?.provider || this.defaultProvider,
      model: options.model || existing?.model || this.defaultModel,
      systemPrompt: options.systemPrompt || existing?.systemPrompt,
      maxSteps: options.maxSteps || existing?.maxSteps || 15,
      workspaceDir: path.resolve(options.workspaceDir || existing?.workspaceDir || this.workspaceDir),
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
      currentStep: existing?.currentStep ?? 0,
      maxSteps: jobPayload.maxSteps,
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
      status: 'running'
    };
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
}
