import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { OMAgent } from './agent.js';
import { OMGitManager } from './git.js';
import { OMSelfImprover } from './selfImprove.js';
import { createLogger } from './utils/logger.js';
import { buildSafeChildEnv } from './utils/redact.js';

const execAsync = promisify(exec);
const log = createLogger('OMDaemon');

/**
 * Match a simple 5-field cron expression (minute hour day-of-month month day-of-week) against a Date.
 */
export function matchesCron(expr: string, date = new Date()) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay()
  ];

  return parts.every((field, idx) => {
    if (field === '*') return true;
    const val = values[idx];
    for (const seg of field.split(',')) {
      if (seg.startsWith('*/')) {
        const step = Number(seg.slice(2));
        if (step > 0 && val % step === 0) return true;
      } else if (seg.includes('-')) {
        const [a, b] = seg.split('-').map(Number);
        if (val >= a && val <= b) return true;
      } else if (Number(seg) === val) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Always-On Local Daemon Mode:
 * Runs scheduled (cron / interval), file-watch, and webhook triggers against OMAgent.
 */
export class OMDaemon extends EventEmitter {
  agent: any;
  agentOptions: Record<string, any>;
  triggers: Map<string, any>;
  timers: any[];
  watchers: any[];
  history: any[];
  historyFile: string | null;
  running: boolean;

  constructor(agentOrOptions: any = {}) {
    super();
    this.agent = agentOrOptions instanceof OMAgent ? agentOrOptions : null;
    this.agentOptions = agentOrOptions instanceof OMAgent ? agentOrOptions.options : agentOrOptions;
    this.triggers = new Map();
    this.timers = [];
    this.watchers = [];
    this.history = [];
    this.historyFile = this._resolveHistoryFile();
    this.running = false;
    this._loadHistory();
  }

  _resolveWorkspaceDir(): string {
    return this.agent?.config?.workspaceDir || this.agentOptions?.workspaceDir || process.cwd();
  }

  _resolveHistoryFile(): string | null {
    const explicit = this.agentOptions?.daemonHistoryFile;
    if (explicit) return path.resolve(explicit);
    const memDir = this.agent?.config?.memoryDir || this.agentOptions?.memoryDir;
    if (memDir) return path.join(path.resolve(memDir), 'daemon-runs.json');
    return path.join(this._resolveWorkspaceDir(), 'memory', 'daemon-runs.json');
  }

  _loadHistory() {
    if (!this.historyFile || !fs.existsSync(this.historyFile)) return;
    try {
      const raw = fs.readFileSync(this.historyFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.history = parsed.slice(-100);
      }
    } catch (err: any) {
      log.warn(`Failed to load daemon run history: ${err.message}`);
    }
  }

  _saveHistory() {
    if (!this.historyFile) return;
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history.slice(-100), null, 2), 'utf8');
    } catch (err: any) {
      log.warn(`Failed to persist daemon run history: ${err.message}`);
    }
  }

  async _ensureAgent() {
    if (!this.agent) {
      this.agent = new OMAgent(this.agentOptions);
      await this.agent.init();
      this.historyFile = this._resolveHistoryFile();
    }
    return this.agent;
  }

  addTrigger(trigger: Record<string, any>) {
    if (!trigger || !trigger.id) throw new Error('Trigger requires an id');
    const existing = this.triggers.get(trigger.id);
    const normalized = {
      id: trigger.id,
      name: trigger.name || trigger.id,
      type: trigger.type || (trigger.cron ? 'cron' : trigger.everyMs ? 'interval' : trigger.watchPath ? 'watch' : 'webhook'),
      cron: trigger.cron || null,
      everyMs: trigger.everyMs ? Number(trigger.everyMs) : null,
      watchPath: trigger.watchPath || null,
      prompt: trigger.prompt || '',
      skill: trigger.skill || null,
      checkCommand: trigger.checkCommand ? String(trigger.checkCommand).trim() : null,
      checkTimeoutMs: trigger.checkTimeoutMs ? Number(trigger.checkTimeoutMs) : 120_000,
      isolatedWorktree: Boolean(trigger.isolatedWorktree),
      maxSteps: trigger.maxSteps !== undefined ? Number(trigger.maxSteps) : 25,
      maxTokens: trigger.maxTokens !== undefined ? Number(trigger.maxTokens) : 0,
      maxDurationMs: trigger.maxDurationMs !== undefined ? Number(trigger.maxDurationMs) : 0,
      handler: typeof trigger.handler === 'function' ? trigger.handler : null,
      runOnStart: Boolean(trigger.runOnStart),
      enabled: trigger.enabled !== false,
      lastRunAt: existing?.lastRunAt ?? null,
      runCount: existing?.runCount ?? 0
    };
    this.triggers.set(normalized.id, normalized);
    return normalized;
  }

  removeTrigger(triggerId: string): boolean {
    return this.triggers.delete(triggerId);
  }

  toggleTrigger(triggerId: string, enabled?: boolean) {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) throw new Error(`Trigger '${triggerId}' not found`);
    trigger.enabled = enabled !== undefined ? Boolean(enabled) : !trigger.enabled;
    return trigger;
  }

  getRun(runId: string) {
    return this.history.find((r) => r.runId === runId) || null;
  }

  loadFromConfig(config: Record<string, any> = {}) {
    const list = Array.isArray(config.daemon?.triggers) ? config.daemon.triggers : [];
    for (const t of list) {
      this.addTrigger(t);
    }
    if (config.daemon?.distillation?.enabled) {
      this.enableAutonomousDistillation(config.daemon.distillation);
    }
    return this;
  }

  /**
   * Enable zero-token autonomous background memory distillation.
   * Compresses daily logs and prunes redundant session turns on a schedule without LLM calls.
   */
  enableAutonomousDistillation(options: {
    id?: string;
    intervalMs?: number;
    cron?: string;
    runOnStart?: boolean;
    prune?: boolean;
    retainDailyDays?: number;
    maxRetainedTurns?: number;
    maxVectorDocs?: number;
  } = {}) {
    const id = options.id || 'autonomous_memory_distillation';
    const useCron = Boolean(options.cron && !options.intervalMs);
    return this.addTrigger({
      id,
      type: useCron ? 'cron' : 'interval',
      cron: useCron ? options.cron : null,
      everyMs: useCron ? null : (options.intervalMs ?? 3600_000),
      runOnStart: Boolean(options.runOnStart),
      enabled: true,
      handler: async (_payload: Record<string, any>, activeAgent: any) => {
        const result = await OMSelfImprover.distill(activeAgent, {
          useLLM: false,
          prune: options.prune ?? true,
          retainDailyDays: options.retainDailyDays,
          maxRetainedTurns: options.maxRetainedTurns,
          maxVectorDocs: options.maxVectorDocs
        });
        this.emit('distillation', result);
        return result;
      }
    });
  }

  async _runDeterministicCheck(command: string, cwd: string, timeoutMs = 120_000) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: buildSafeChildEnv()
      });
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      return {
        passed: true,
        exitCode: 0,
        output: combined.slice(0, 8000)
      };
    } catch (err: any) {
      const combined = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim();
      return {
        passed: false,
        exitCode: typeof err?.code === 'number' ? err.code : 1,
        output: combined.slice(0, 8000)
      };
    }
  }

  async fireTrigger(triggerId: string, payload: Record<string, any> = {}) {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) throw new Error(`Trigger '${triggerId}' not found`);
    if (!trigger.enabled) return { skipped: true, reason: 'disabled' };

    const agent = await this._ensureAgent();
    const workspaceDir = this._resolveWorkspaceDir();
    const runId = `drun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    trigger.lastRunAt = new Date().toISOString();
    trigger.runCount += 1;

    const record: Record<string, any> = {
      runId,
      triggerId,
      triggerName: trigger.name || triggerId,
      type: trigger.type,
      startedAt: trigger.lastRunAt,
      success: false,
      zeroToken: false,
      isolatedWorktree: Boolean(trigger.isolatedWorktree),
      budgets: {
        maxSteps: trigger.maxSteps,
        maxTokens: trigger.maxTokens || 0,
        maxDurationMs: trigger.maxDurationMs || 0
      }
    };

    let wt: { worktreePath: string; branch: string } | null = null;
    let gitMgr: OMGitManager | null = null;
    let scopedAgent: any = null;

    try {
      let execDir = workspaceDir;
      if (trigger.isolatedWorktree) {
        gitMgr = new OMGitManager(workspaceDir);
        const safeId = String(triggerId).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'task';
        const branchName = `om-daemon-${safeId}-${Date.now().toString(36)}`;
        const relWtPath = path.join('.om-worktrees', runId);
        wt = gitMgr.createWorktree(relWtPath, branchName);
        execDir = wt.worktreePath;
      }

      // 1. Deterministic-first check (0 LLM tokens unless it fails)
      let checkFailureContext = '';
      if (trigger.checkCommand) {
        record.checkCommand = trigger.checkCommand;
        const checkRes = await this._runDeterministicCheck(trigger.checkCommand, execDir, trigger.checkTimeoutMs || 120_000);
        record.checkPassed = checkRes.passed;
        record.checkExitCode = checkRes.exitCode;
        record.checkOutput = checkRes.output;

        if (checkRes.passed) {
          record.success = true;
          record.zeroToken = true;
          record.answer = `Deterministic check passed (0 tokens): ${trigger.checkCommand}`;
          if (wt && gitMgr) {
            const summary = gitMgr.getWorktreeSummary(wt.worktreePath);
            if (summary.clean) {
              gitMgr.discardWorktree(wt.worktreePath, wt.branch);
            } else {
              record.worktree = { ...summary, status: 'pending' };
            }
          }
          return this._finalizeRun(record, 'trigger_run');
        }

        checkFailureContext = `\nDeterministic check FAILED:\nCommand: ${trigger.checkCommand}\nExit code: ${checkRes.exitCode}\nOutput:\n${checkRes.output}`;
        if (!trigger.handler && !trigger.prompt && !trigger.skill) {
          record.success = false;
          record.zeroToken = true;
          record.error = `Check failed (exit ${checkRes.exitCode}): ${trigger.checkCommand}`;
          return this._finalizeRun(record, 'trigger_error');
        }
      }

      // 2. Custom zero-token handler or guardrailed LLM agent execution
      if (trigger.handler) {
        const res = await trigger.handler({ ...payload, checkOutput: record.checkOutput, workspaceDir: execDir }, agent);
        record.success = res?.success !== false;
        record.result = res;
        record.zeroToken = true;
      } else {
        const basePrompt = trigger.skill
          ? `/${trigger.skill} ${trigger.prompt || ''}`.trim()
          : `${trigger.prompt || 'Diagnose and fix the failing check.'}`.trim();
        const payloadPart = Object.keys(payload).length ? `\nTrigger Payload: ${JSON.stringify(payload)}` : '';
        const promptText = `${basePrompt}${checkFailureContext}${payloadPart}`.trim();

        let activeAgent = agent;
        if (trigger.isolatedWorktree && execDir !== workspaceDir) {
          scopedAgent = new OMAgent({
            ...agent.options,
            workspaceDir: execDir,
            memoryDir: agent.config?.memoryDir
          });
          await scopedAgent.init();
          activeAgent = scopedAgent;
        }

        const runOpts: Record<string, any> = {
          maxSteps: trigger.maxSteps ?? 25
        };
        if ((trigger.maxTokens && trigger.maxTokens > 0) || (trigger.maxDurationMs && trigger.maxDurationMs > 0)) {
          runOpts.budgets = {
            ...(trigger.maxTokens > 0 ? { maxTokens: trigger.maxTokens } : {}),
            ...(trigger.maxDurationMs > 0 ? { maxDurationMs: trigger.maxDurationMs } : {})
          };
        }

        const res = await activeAgent.run(promptText, runOpts);
        record.success = Boolean(res.success);
        record.answer = res.content;
        if (res.usage) record.usage = res.usage;
        if (res.stopReason) record.stopReason = res.stopReason;
      }

      if (wt && gitMgr) {
        const summary = gitMgr.getWorktreeSummary(wt.worktreePath);
        if (summary.clean) {
          gitMgr.discardWorktree(wt.worktreePath, wt.branch);
        } else {
          record.worktree = { ...summary, status: 'pending' };
        }
      }

      return this._finalizeRun(record, 'trigger_run');
    } catch (err: any) {
      record.error = err.message;
      if (wt && gitMgr) {
        try {
          const summary = gitMgr.getWorktreeSummary(wt.worktreePath);
          if (summary.clean) {
            gitMgr.discardWorktree(wt.worktreePath, wt.branch);
          } else {
            record.worktree = { ...summary, status: 'pending' };
          }
        } catch (_: any) {}
      }
      return this._finalizeRun(record, 'trigger_error');
    } finally {
      if (scopedAgent) {
        try { await scopedAgent.close?.(); } catch (_: any) {}
      }
    }
  }

  _finalizeRun(record: Record<string, any>, eventName: 'trigger_run' | 'trigger_error') {
    if (!record.finishedAt) record.finishedAt = new Date().toISOString();
    this.history.push(record);
    if (this.history.length > 100) this.history.shift();
    this._saveHistory();
    this.emit(eventName, record);
    return record;
  }

  mergeRunWorktree(runId: string, commitMessage?: string) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Daemon run '${runId}' not found`);
    if (!run.worktree || run.worktree.status !== 'pending') {
      throw new Error(`Daemon run '${runId}' has no pending worktree changes`);
    }
    const gitMgr = new OMGitManager(this._resolveWorkspaceDir());
    const msg = commitMessage || `OMega daemon fix (${run.triggerId}: ${runId})`;
    const result = gitMgr.mergeWorktree(run.worktree.worktreePath, run.worktree.branch, msg);
    run.worktree.status = 'merged';
    run.worktree.mergedAt = new Date().toISOString();
    this._saveHistory();
    this.emit('trigger_merged', { runId, triggerId: run.triggerId, branch: run.worktree.branch });
    return result;
  }

  discardRunWorktree(runId: string) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Daemon run '${runId}' not found`);
    if (!run.worktree || run.worktree.status !== 'pending') {
      throw new Error(`Daemon run '${runId}' has no pending worktree changes`);
    }
    const gitMgr = new OMGitManager(this._resolveWorkspaceDir());
    const result = gitMgr.discardWorktree(run.worktree.worktreePath, run.worktree.branch);
    run.worktree.status = 'discarded';
    run.worktree.discardedAt = new Date().toISOString();
    this._saveHistory();
    this.emit('trigger_discarded', { runId, triggerId: run.triggerId, branch: run.worktree.branch });
    return result;
  }

  async start() {
    if (this.running) return this;
    await this._ensureAgent();
    this.running = true;

    let lastCronMinute = -1;
    const hasCron = Array.from(this.triggers.values()).some((t) => t.type === 'cron' && t.cron);
    if (hasCron) {
      const cronTimer = setInterval(() => {
        const now = new Date();
        const minKey = Math.floor(now.getTime() / 60000);
        if (minKey === lastCronMinute) return;
        lastCronMinute = minKey;
        for (const t of this.triggers.values()) {
          if (t.enabled && t.type === 'cron' && t.cron && matchesCron(t.cron, now)) {
            this.fireTrigger(t.id, { scheduledAt: now.toISOString() }).catch((e) => log.warn(e.message));
          }
        }
      }, 10000);
      cronTimer.unref?.();
      this.timers.push(cronTimer);
    }

    for (const t of this.triggers.values()) {
      if (!t.enabled) continue;
      if (t.runOnStart) {
        this.fireTrigger(t.id, { runOnStart: true }).catch((e) => log.warn(e.message));
      }
      if (t.type === 'interval' && t.everyMs > 0) {
        const timer = setInterval(() => {
          this.fireTrigger(t.id, { intervalMs: t.everyMs }).catch((e) => log.warn(e.message));
        }, t.everyMs);
        timer.unref?.();
        this.timers.push(timer);
      } else if (t.type === 'watch' && t.watchPath) {
        const resolved = path.resolve(this.agent.config.workspaceDir || process.cwd(), t.watchPath);
        if (fs.existsSync(resolved)) {
          let debounce: NodeJS.Timeout | null = null;
          const watcher = fs.watch(resolved, { recursive: true }, (eventType, filename) => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
              this.fireTrigger(t.id, { eventType, filename }).catch((e) => log.warn(e.message));
            }, 250);
          });
          watcher.unref?.();
          this.watchers.push(watcher);
        }
      }
    }

    this.emit('started', { triggerCount: this.triggers.size });
    return this;
  }

  stop() {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const w of this.watchers) {
      try { w.close(); } catch (_: any) {}
    }
    this.watchers = [];
    this.emit('stopped');
  }

  getStatus() {
    return {
      running: this.running,
      triggers: Array.from(this.triggers.values()),
      recentRuns: this.history.slice(-20)
    };
  }
}

