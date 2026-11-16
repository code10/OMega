import fs from 'node:fs';
import path from 'node:path';
import { OMAgent } from '../agent.js';
import { matchesCron } from '../daemon.js';
import { OMGitManager } from '../git.js';
import { WorkspaceSnapshotManager } from '../snapshot.js';
import { ModelRouter } from '../providers/router.js';

export type PersistentAgentMode = 'manual' | 'interval' | 'cron' | 'continuous' | 'watch';
export type PersistentAgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type WorkspaceMode = 'shared' | 'worktree';

export interface PersistentAgentRecord {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  systemPrompt: string;
  taskPrompt: string;
  mode: PersistentAgentMode;
  intervalMs: number | null;
  cron: string | null;
  watchPath: string | null;
  provider: string | null;
  model: string | null;
  maxSteps: number;
  keepHistory: boolean;
  workspaceMode: WorkspaceMode;
  worktreePath: string | null;
  worktreeBranch: string | null;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  dailyTokenBudget: number | null;
  dailyCostBudgetUsd: number | null;
  dailyUsageDate: string;
  dailyTokensUsed: number;
  dailyCostUsd: number;
  enabled: boolean;
  status: PersistentAgentStatus;
  runCount: number;
  createdAt: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastAnswer: string | null;
  lastError: string | null;
}

export interface AgentRunRecord {
  runId: string;
  snapshotRunId: string | null;
  workspaceDir: string;
  agentId: string | null;
  name: string;
  prompt: string;
  provider: string;
  model: string;
  status: AgentRunStatus;
  liveStatus: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stepsCount: number;
  tokensUsed: number;
  estimatedCostUsd: number;
  steps: Array<{ step: number; thought?: string; toolCalls: Array<{ name: string; success: boolean }> }>;
  answer: string | null;
  error: string | null;
}

export interface RunAgentOptions {
  name?: string;
  prompt: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  maxSteps?: number;
  agentId?: string | null;
}

export interface CreatePersistentAgentOptions {
  name: string;
  description?: string;
  systemPrompt?: string;
  taskPrompt?: string;
  mode?: PersistentAgentMode;
  intervalMs?: number | null;
  cron?: string | null;
  watchPath?: string | null;
  provider?: string | null;
  model?: string | null;
  maxSteps?: number;
  keepHistory?: boolean;
  workspaceMode?: WorkspaceMode;
  maxConsecutiveFailures?: number;
  dailyTokenBudget?: number | null;
  dailyCostBudgetUsd?: number | null;
  autoStart?: boolean;
}

export type UpdatePersistentAgentOptions = Partial<Omit<CreatePersistentAgentOptions, 'autoStart'>>;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export class AgentManager {
  parentAgent: any;
  memoryDir: string;
  storagePath: string;
  runsStoragePath: string;
  persistentAgents: Map<string, PersistentAgentRecord>;
  liveAgents: Map<string, OMAgent>;
  timers: Map<string, NodeJS.Timeout>;
  watchers: Map<string, fs.FSWatcher>;
  runs: AgentRunRecord[];
  activeControllers: Map<string, AbortController>;
  onUpdate: (payload: any) => void;
  disposed: boolean;

  constructor(parentAgent: any, options: { onUpdate?: (payload: any) => void } = {}) {
    this.parentAgent = parentAgent;
    this.memoryDir = parentAgent?.config?.memoryDir || path.join(process.cwd(), 'memory');
    this.storagePath = path.join(this.memoryDir, 'agents.json');
    this.runsStoragePath = path.join(this.memoryDir, 'agent_runs.json');
    this.persistentAgents = new Map();
    this.liveAgents = new Map();
    this.timers = new Map();
    this.watchers = new Map();
    this.runs = [];
    this.activeControllers = new Map();
    this.onUpdate = options.onUpdate || (() => {});
    this.disposed = false;

    this._load();
    this._armEnabledAgents();
  }

  _getNextPrefixedSessionId(prefix: 'one-off' | 'persistent'): string {
    const sessionsDir = path.join(this.memoryDir, 'sessions');
    let max = 0;
    const re = new RegExp(`^${prefix}_(\\d+)(?:\\.json)?$`);

    if (prefix === 'persistent') {
      for (const ag of this.persistentAgents.values()) {
        const m = String(ag.sessionId || '').match(re);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }

    try {
      if (fs.existsSync(sessionsDir)) {
        for (const f of fs.readdirSync(sessionsDir)) {
          const m = f.match(re);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
      }
    } catch (_) {}

    return `${prefix}_${max + 1}`;
  }

  _normalizeRecord(item: any): PersistentAgentRecord {
    const mode: PersistentAgentMode = ['manual', 'interval', 'cron', 'continuous', 'watch'].includes(item.mode)
      ? item.mode
      : 'manual';
    return {
      id: item.id,
      sessionId: item.sessionId || this._getNextPrefixedSessionId('persistent'),
      name: String(item.name || 'Agent'),
      description: String(item.description || ''),
      systemPrompt: String(item.systemPrompt || ''),
      taskPrompt: String(item.taskPrompt || ''),
      mode,
      intervalMs: item.intervalMs != null ? Number(item.intervalMs) : null,
      cron: item.cron || null,
      watchPath: item.watchPath || null,
      provider: item.provider || null,
      model: item.model || null,
      maxSteps: Math.max(1, Math.min(100, Number(item.maxSteps) || 15)),
      keepHistory: item.keepHistory !== false,
      workspaceMode: item.workspaceMode === 'worktree' ? 'worktree' : 'shared',
      worktreePath: item.worktreePath || null,
      worktreeBranch: item.worktreeBranch || null,
      maxConsecutiveFailures: Math.max(1, Number(item.maxConsecutiveFailures) || 3),
      consecutiveFailures: Number(item.consecutiveFailures) || 0,
      dailyTokenBudget: item.dailyTokenBudget != null && Number(item.dailyTokenBudget) > 0 ? Number(item.dailyTokenBudget) : null,
      dailyCostBudgetUsd: item.dailyCostBudgetUsd != null && Number(item.dailyCostBudgetUsd) > 0 ? Number(item.dailyCostBudgetUsd) : null,
      dailyUsageDate: item.dailyUsageDate || todayUtc(),
      dailyTokensUsed: Number(item.dailyTokensUsed) || 0,
      dailyCostUsd: Number(item.dailyCostUsd) || 0,
      enabled: item.enabled !== false,
      status: item.enabled !== false ? 'idle' : 'paused',
      runCount: Number(item.runCount) || 0,
      createdAt: item.createdAt || new Date().toISOString(),
      lastRunAt: item.lastRunAt || null,
      lastDurationMs: item.lastDurationMs != null ? Number(item.lastDurationMs) : null,
      lastAnswer: item.lastAnswer || null,
      lastError: item.lastError || null
    };
  }

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
        const list = Array.isArray(raw?.agents) ? raw.agents : [];
        for (const item of list) {
          if (!item?.id) continue;
          this.persistentAgents.set(item.id, this._normalizeRecord(item));
        }
      }
    } catch (_) {
      // ignore corrupt agents file
    }

    try {
      if (fs.existsSync(this.runsStoragePath)) {
        const rawRuns = JSON.parse(fs.readFileSync(this.runsStoragePath, 'utf8'));
        if (Array.isArray(rawRuns?.runs)) {
          this.runs = rawRuns.runs.slice(0, 50).map((r: any) => ({
            ...r,
            status: r.status === 'running' ? 'aborted' : r.status
          }));
        }
      }
    } catch (_) {
      // ignore corrupt runs file
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(
        this.storagePath,
        JSON.stringify({ updatedAt: new Date().toISOString(), agents: Array.from(this.persistentAgents.values()) }, null, 2),
        'utf8'
      );
    } catch (_) {
      // non-fatal
    }
  }

  _saveRuns() {
    try {
      fs.mkdirSync(path.dirname(this.runsStoragePath), { recursive: true });
      fs.writeFileSync(
        this.runsStoragePath,
        JSON.stringify({ updatedAt: new Date().toISOString(), runs: this.runs.slice(0, 50) }, null, 2),
        'utf8'
      );
    } catch (_) {
      // non-fatal
    }
  }

  _emitUpdate(type: string, extra: Record<string, any> = {}) {
    if (this.disposed) return;
    try {
      this.onUpdate({ type, ...extra, state: this.getState() });
    } catch (_) {
      // non-fatal
    }
  }

  _armEnabledAgents() {
    for (const agent of this.persistentAgents.values()) {
      if (agent.enabled && agent.mode !== 'manual') {
        this._armSchedule(agent);
      }
    }
  }

  _clearSchedule(agentId: string) {
    const existing = this.timers.get(agentId);
    if (existing) {
      clearInterval(existing);
      clearTimeout(existing);
      this.timers.delete(agentId);
    }
    const watcher = this.watchers.get(agentId);
    if (watcher) {
      try { watcher.close(); } catch (_) {}
      this.watchers.delete(agentId);
    }
  }

  _armSchedule(record: PersistentAgentRecord) {
    this._clearSchedule(record.id);
    if (!record.enabled || this.disposed) return;

    if (record.mode === 'interval') {
      const ms = Math.max(5000, Number(record.intervalMs) || 60000);
      const timer = setInterval(() => {
        if (!record.enabled || record.status === 'running' || this.disposed) return;
        this.runPersistentAgent(record.id).catch(() => {});
      }, ms);
      timer.unref?.();
      this.timers.set(record.id, timer);
    } else if (record.mode === 'cron' && record.cron) {
      let lastMinute = -1;
      const timer = setInterval(() => {
        if (!record.enabled || record.status === 'running' || this.disposed) return;
        const now = new Date();
        const minKey = Math.floor(now.getTime() / 60000);
        if (minKey === lastMinute) return;
        lastMinute = minKey;
        if (matchesCron(record.cron!, now)) {
          this.runPersistentAgent(record.id).catch(() => {});
        }
      }, 10000);
      timer.unref?.();
      this.timers.set(record.id, timer);
    } else if (record.mode === 'continuous') {
      const cooldown = Math.max(2000, Number(record.intervalMs) || 15000);
      const timer = setTimeout(() => {
        if (!record.enabled || record.status === 'running' || this.disposed) return;
        this.runPersistentAgent(record.id).catch(() => {});
      }, cooldown);
      timer.unref?.();
      this.timers.set(record.id, timer);
    } else if (record.mode === 'watch' && record.watchPath) {
      const baseDir = this.parentAgent?.config?.workspaceDir || process.cwd();
      const targetPath = path.resolve(baseDir, record.watchPath);
      if (fs.existsSync(targetPath)) {
        let debounce: NodeJS.Timeout | null = null;
        try {
          const watcher = fs.watch(targetPath, { recursive: true }, (eventType, filename) => {
            if (!record.enabled || this.disposed) return;
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
              if (!record.enabled || record.status === 'running' || this.disposed) return;
              const note = filename ? `\n[File Watch Trigger: ${eventType} on ${filename}]` : '';
              this.runPersistentAgent(record.id, `${record.taskPrompt}${note}`.trim()).catch(() => {});
            }, 400);
          });
          watcher.unref?.();
          this.watchers.set(record.id, watcher);
        } catch (_) {
          // ignore watch error on unsupported paths
        }
      }
    }
  }

  _ensureAgentWorkspace(record: PersistentAgentRecord): string {
    const baseDir = this.parentAgent?.config?.workspaceDir || process.cwd();
    if (record.workspaceMode !== 'worktree') {
      return baseDir;
    }

    if (record.worktreePath && fs.existsSync(record.worktreePath)) {
      return record.worktreePath;
    }

    const git = new OMGitManager(baseDir);
    if (!git.isGitRepo()) {
      return baseDir;
    }

    const relWorktree = path.join('.om_worktrees', record.id);
    const branch = record.worktreeBranch || `om-agent-${record.id}`;
    try {
      const created = git.createWorktree(relWorktree, branch);
      record.worktreePath = created.worktreePath;
      record.worktreeBranch = created.branch;
      this._save();
      return created.worktreePath;
    } catch (_) {
      return baseDir;
    }
  }

  _buildOMAgentOptions(overrides: {
    systemPrompt?: string;
    provider?: string | null;
    model?: string | null;
    maxSteps?: number;
    workspaceDir?: string;
    sessionId?: string;
  } = {}) {
    const baseCfg = this.parentAgent?.config || {};
    const effectiveProvider = overrides.provider || baseCfg.provider;
    const providerChanged = Boolean(overrides.provider && overrides.provider !== baseCfg.provider);
    const effectiveModel = overrides.model || (providerChanged ? undefined : baseCfg.model);

    const cfg: Record<string, any> = {
      ...baseCfg,
      provider: effectiveProvider,
      model: effectiveModel,
      maxSteps: overrides.maxSteps || baseCfg.maxSteps || 15,
      workspaceDir: overrides.workspaceDir || baseCfg.workspaceDir,
      confirmCommand: this.parentAgent?.confirmCommand
    };
    if (overrides.sessionId) {
      cfg.sessionId = overrides.sessionId;
    }
    if (overrides.systemPrompt) {
      cfg.systemPrompt = overrides.systemPrompt;
    }
    return cfg;
  }

  async _createChildAgent(overrides: {
    systemPrompt?: string;
    provider?: string | null;
    model?: string | null;
    maxSteps?: number;
    workspaceDir?: string;
    sessionId?: string;
    restoreHistory?: boolean;
  } = {}) {
    const child = new OMAgent(this._buildOMAgentOptions(overrides));
    await child.init();

    if (overrides.sessionId) {
      child.sessionId = overrides.sessionId;
      if (overrides.restoreHistory) {
        try {
          const saved = child.memory.loadSession(overrides.sessionId);
          if (saved && Array.isArray(saved.history)) {
            child.history = saved.history;
          }
        } catch (_) {
          // start with fresh history if none saved
        }
      }
    }

    if (this.parentAgent?.skills) {
      for (const skill of this.parentAgent.skills.list()) {
        if (!child.skills.has(skill.name)) {
          child.skills.register(skill, skill.source || 'runtime');
        }
      }
    }
    return child;
  }

  _recordRun(run: AgentRunRecord) {
    this.runs.unshift(run);
    if (this.runs.length > 50) {
      this.runs.length = 50;
    }
    this._saveRuns();
  }

  _rollDailyCountersIfNeeded(record: PersistentAgentRecord) {
    const today = todayUtc();
    if (record.dailyUsageDate !== today) {
      record.dailyUsageDate = today;
      record.dailyTokensUsed = 0;
      record.dailyCostUsd = 0;
    }
  }

  _checkBudgets(record: PersistentAgentRecord): string | null {
    this._rollDailyCountersIfNeeded(record);
    if (record.dailyTokenBudget && record.dailyTokensUsed >= record.dailyTokenBudget) {
      return `Daily token budget exceeded (${record.dailyTokensUsed}/${record.dailyTokenBudget})`;
    }
    if (record.dailyCostBudgetUsd && record.dailyCostUsd >= record.dailyCostBudgetUsd) {
      return `Daily cost budget exceeded ($${record.dailyCostUsd.toFixed(4)}/$${record.dailyCostBudgetUsd})`;
    }
    return null;
  }

  getState() {
    return {
      persistentAgents: Array.from(this.persistentAgents.values()),
      runs: this.runs
    };
  }

  createPersistentAgent(opts: CreatePersistentAgentOptions): PersistentAgentRecord {
    const name = String(opts.name || '').trim();
    if (!name) throw new Error('Agent name is required');

    const mode: PersistentAgentMode = ['manual', 'interval', 'cron', 'continuous', 'watch'].includes(String(opts.mode))
      ? (opts.mode as PersistentAgentMode)
      : 'manual';

    const intervalMs =
      mode === 'interval'
        ? Math.max(5000, Number(opts.intervalMs) || 60000)
        : mode === 'continuous'
          ? Math.max(2000, Number(opts.intervalMs) || 15000)
          : null;
    const cron = mode === 'cron' ? String(opts.cron || '*/5 * * * *').trim() : null;
    const watchPath = mode === 'watch' ? String(opts.watchPath || '.').trim() : null;
    const enabled = opts.autoStart !== false;

    const record = this._normalizeRecord({
      id: `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      description: String(opts.description || '').trim(),
      systemPrompt: String(opts.systemPrompt || '').trim(),
      taskPrompt: String(opts.taskPrompt || '').trim(),
      mode,
      intervalMs,
      cron,
      watchPath,
      provider: opts.provider ? String(opts.provider).trim() : null,
      model: opts.model ? String(opts.model).trim() : null,
      maxSteps: Math.max(1, Math.min(100, Number(opts.maxSteps) || 15)),
      keepHistory: opts.keepHistory !== false,
      workspaceMode: opts.workspaceMode === 'worktree' ? 'worktree' : 'shared',
      maxConsecutiveFailures: Math.max(1, Number(opts.maxConsecutiveFailures) || 3),
      dailyTokenBudget: opts.dailyTokenBudget && Number(opts.dailyTokenBudget) > 0 ? Number(opts.dailyTokenBudget) : null,
      dailyCostBudgetUsd: opts.dailyCostBudgetUsd && Number(opts.dailyCostBudgetUsd) > 0 ? Number(opts.dailyCostBudgetUsd) : null,
      enabled,
      status: enabled ? 'idle' : 'paused',
      runCount: 0,
      createdAt: new Date().toISOString()
    });

    this.persistentAgents.set(record.id, record);
    if (enabled && mode !== 'manual') {
      this._armSchedule(record);
    }
    this._save();
    this._emitUpdate('persistent_created', { agentId: record.id });
    return record;
  }

  updatePersistentAgent(agentId: string, patch: UpdatePersistentAgentOptions): PersistentAgentRecord {
    const record = this.persistentAgents.get(agentId);
    if (!record) throw new Error(`Persistent agent '${agentId}' not found`);

    if (patch.name !== undefined) {
      const nextName = String(patch.name).trim();
      if (!nextName) throw new Error('Agent name cannot be empty');
      record.name = nextName;
    }
    if (patch.description !== undefined) record.description = String(patch.description).trim();
    if (patch.systemPrompt !== undefined) record.systemPrompt = String(patch.systemPrompt).trim();
    if (patch.taskPrompt !== undefined) record.taskPrompt = String(patch.taskPrompt).trim();
    if (patch.mode !== undefined && ['manual', 'interval', 'cron', 'continuous', 'watch'].includes(patch.mode)) {
      record.mode = patch.mode;
    }
    if (patch.intervalMs !== undefined) {
      record.intervalMs = patch.intervalMs != null ? Math.max(2000, Number(patch.intervalMs)) : null;
    }
    if (patch.cron !== undefined) record.cron = patch.cron ? String(patch.cron).trim() : null;
    if (patch.watchPath !== undefined) record.watchPath = patch.watchPath ? String(patch.watchPath).trim() : null;
    if (patch.provider !== undefined) record.provider = patch.provider ? String(patch.provider).trim() : null;
    if (patch.model !== undefined) record.model = patch.model ? String(patch.model).trim() : null;
    if (patch.maxSteps !== undefined) record.maxSteps = Math.max(1, Math.min(100, Number(patch.maxSteps) || 15));
    if (patch.keepHistory !== undefined) record.keepHistory = Boolean(patch.keepHistory);
    if (patch.workspaceMode !== undefined) {
      record.workspaceMode = patch.workspaceMode === 'worktree' ? 'worktree' : 'shared';
    }
    if (patch.maxConsecutiveFailures !== undefined) {
      record.maxConsecutiveFailures = Math.max(1, Number(patch.maxConsecutiveFailures) || 3);
    }
    if (patch.dailyTokenBudget !== undefined) {
      record.dailyTokenBudget = patch.dailyTokenBudget && Number(patch.dailyTokenBudget) > 0 ? Number(patch.dailyTokenBudget) : null;
    }
    if (patch.dailyCostBudgetUsd !== undefined) {
      record.dailyCostBudgetUsd = patch.dailyCostBudgetUsd && Number(patch.dailyCostBudgetUsd) > 0 ? Number(patch.dailyCostBudgetUsd) : null;
    }

    // Reset live instance so next run uses updated prompt/model/workspace
    const prevLive = this.liveAgents.get(agentId);
    if (prevLive) {
      prevLive.close?.().catch(() => {});
      this.liveAgents.delete(agentId);
    }
    if (record.enabled) {
      this._armSchedule(record);
    } else {
      this._clearSchedule(agentId);
    }

    this._save();
    this._emitUpdate('persistent_updated', { agentId });
    return record;
  }

  startPersistentAgent(agentId: string): PersistentAgentRecord {
    const record = this.persistentAgents.get(agentId);
    if (!record) throw new Error(`Persistent agent '${agentId}' not found`);
    record.enabled = true;
    record.consecutiveFailures = 0;
    record.lastError = null;
    if (record.status !== 'running') record.status = 'idle';
    this._armSchedule(record);
    this._save();
    this._emitUpdate('persistent_started', { agentId });
    return record;
  }

  stopPersistentAgent(agentId: string): PersistentAgentRecord {
    const record = this.persistentAgents.get(agentId);
    if (!record) throw new Error(`Persistent agent '${agentId}' not found`);
    record.enabled = false;
    this._clearSchedule(agentId);
    if (record.status !== 'running') record.status = 'paused';
    this._save();
    this._emitUpdate('persistent_stopped', { agentId });
    return record;
  }

  deletePersistentAgent(agentId: string): boolean {
    const record = this.persistentAgents.get(agentId);
    if (!record) return false;
    this.persistentAgents.delete(agentId);
    this._clearSchedule(agentId);
    const live = this.liveAgents.get(agentId);
    if (live) {
      live.close?.().catch(() => {});
      this.liveAgents.delete(agentId);
    }

    if (record.worktreePath && fs.existsSync(record.worktreePath)) {
      try {
        const git = new OMGitManager(this.parentAgent?.config?.workspaceDir || process.cwd());
        if (git.isGitRepo()) git.removeWorktree(record.worktreePath, true);
      } catch (_) {}
    }

    try {
      const sessFile = path.join(this.memoryDir, 'sessions', `${record.sessionId}.json`);
      if (fs.existsSync(sessFile)) fs.rmSync(sessFile, { force: true });
      const legacyFile = path.join(this.memoryDir, 'sessions', `persistent_${agentId}.json`);
      if (fs.existsSync(legacyFile)) fs.rmSync(legacyFile, { force: true });
    } catch (_) {}

    this._save();
    this._emitUpdate('persistent_deleted', { agentId });
    return true;
  }

  _attachProgressListener(child: OMAgent, run: AgentRunRecord) {
    let lastEmit = 0;
    const handler = (entry: any) => {
      if (!entry) return;
      if (entry.type === 'tool_call') {
        run.liveStatus = `Step ${entry.step || run.stepsCount + 1}: running ${entry.name}`;
      } else if (entry.type === 'step') {
        run.stepsCount = Math.max(run.stepsCount, Number(entry.step) || 0);
        run.liveStatus = `Step ${run.stepsCount} completed`;
      } else if (entry.type === 'thinking' || entry.type === 'model_call') {
        run.liveStatus = `Step ${entry.step || run.stepsCount + 1}: reasoning...`;
      }
      const now = Date.now();
      if (now - lastEmit > 350) {
        lastEmit = now;
        this._emitUpdate('run_progress', { runId: run.runId, agentId: run.agentId });
      }
    };
    child.on('activity', handler);
    return () => child.off('activity', handler);
  }

  startOneOffRun(opts: RunAgentOptions): AgentRunRecord {
    const prompt = String(opts.prompt || '').trim();
    if (!prompt) throw new Error('Prompt is required to run an agent');

    const baseCfg = this.parentAgent?.config || {};
    const workspaceDir = baseCfg.workspaceDir || process.cwd();
    const runId = `arun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const run: AgentRunRecord = {
      runId,
      snapshotRunId: null,
      workspaceDir,
      agentId: opts.agentId || null,
      name: String(opts.name || 'One-Off Agent').trim() || 'One-Off Agent',
      prompt,
      provider: opts.provider || baseCfg.provider || 'mock',
      model: opts.model || baseCfg.model || 'default',
      status: 'running',
      liveStatus: 'Initializing...',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      stepsCount: 0,
      tokensUsed: 0,
      estimatedCostUsd: 0,
      steps: [],
      answer: null,
      error: null
    };

    const controller = new AbortController();
    this.activeControllers.set(runId, controller);
    this._recordRun(run);
    this._emitUpdate('run_started', { runId });

    (async () => {
      const startMs = Date.now();
      let detach: (() => void) | null = null;
      try {
        const child = await this._createChildAgent({
          systemPrompt: opts.systemPrompt,
          provider: opts.provider,
          model: opts.model,
          maxSteps: opts.maxSteps,
          workspaceDir,
          sessionId: this._getNextPrefixedSessionId('one-off')
        });
        run.provider = child.config.provider;
        run.model = child.config.model;
        detach = this._attachProgressListener(child, run);

        const res = await child.run(prompt, {
          maxSteps: opts.maxSteps || child.config.maxSteps,
          signal: controller.signal
        });

        run.finishedAt = new Date().toISOString();
        run.durationMs = Date.now() - startMs;
        run.snapshotRunId = res.runId || child.lastRunId || null;
        run.stepsCount = Array.isArray(res.steps) ? res.steps.length : 0;
        run.tokensUsed = Number(res.usage?.totalTokens) || 0;
        run.estimatedCostUsd = ModelRouter.estimateCost(run.provider, run.model, {
          prompt_tokens: res.usage?.promptTokens || 0,
          completion_tokens: res.usage?.completionTokens || 0
        });
        run.steps = (res.steps || []).map((s: any) => ({
          step: s.step,
          thought: s.thought ? String(s.thought).slice(0, 200) : undefined,
          toolCalls: (s.toolCalls || []).map((tc: any) => ({
            name: tc.name,
            success: tc.result?.success !== false
          }))
        }));
        run.answer = res.content || res.answer || '';
        run.liveStatus = null;
        run.status = res.aborted ? 'aborted' : res.success ? 'completed' : 'failed';
      } catch (err: any) {
        run.finishedAt = new Date().toISOString();
        run.durationMs = Date.now() - startMs;
        run.liveStatus = null;
        run.status = controller.signal.aborted ? 'aborted' : 'failed';
        run.error = err?.message || String(err);
      } finally {
        if (detach) detach();
        this.activeControllers.delete(runId);
        this._saveRuns();
        this._emitUpdate('run_finished', { runId, status: run.status });
      }
    })();

    return run;
  }

  async runPersistentAgent(agentId: string, promptOverride?: string): Promise<AgentRunRecord> {
    const record = this.persistentAgents.get(agentId);
    if (!record) throw new Error(`Persistent agent '${agentId}' not found`);
    if (record.status === 'running') {
      throw new Error(`Persistent agent '${record.name}' is already running`);
    }

    const budgetErr = this._checkBudgets(record);
    if (budgetErr) {
      record.enabled = false;
      record.status = 'paused';
      record.lastError = budgetErr;
      this._clearSchedule(record.id);
      this._save();
      this._emitUpdate('persistent_budget_paused', { agentId: record.id, error: budgetErr });
      throw new Error(budgetErr);
    }

    const prompt = String(promptOverride || record.taskPrompt || '').trim();
    if (!prompt) {
      throw new Error(`Persistent agent '${record.name}' has no task prompt configured`);
    }

    const workspaceDir = this._ensureAgentWorkspace(record);
    const baseCfg = this.parentAgent?.config || {};
    const runId = `arun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const run: AgentRunRecord = {
      runId,
      snapshotRunId: null,
      workspaceDir,
      agentId: record.id,
      name: record.name,
      prompt,
      provider: record.provider || baseCfg.provider || 'mock',
      model: record.model || baseCfg.model || 'default',
      status: 'running',
      liveStatus: 'Initializing...',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      stepsCount: 0,
      tokensUsed: 0,
      estimatedCostUsd: 0,
      steps: [],
      answer: null,
      error: null
    };

    record.status = 'running';
    record.lastError = null;
    const controller = new AbortController();
    this.activeControllers.set(runId, controller);
    this._recordRun(run);
    this._save();
    this._emitUpdate('run_started', { runId, agentId: record.id });

    (async () => {
      const startMs = Date.now();
      let detach: (() => void) | null = null;
      const agentSessionId = record.sessionId || this._getNextPrefixedSessionId('persistent');
      if (!record.sessionId) {
        record.sessionId = agentSessionId;
        this._save();
      }
      try {
        let child = record.keepHistory ? this.liveAgents.get(record.id) : undefined;
        if (!child) {
          child = await this._createChildAgent({
            systemPrompt: record.systemPrompt || undefined,
            provider: record.provider,
            model: record.model,
            maxSteps: record.maxSteps,
            workspaceDir,
            sessionId: agentSessionId,
            restoreHistory: record.keepHistory
          });
          if (record.keepHistory) {
            this.liveAgents.set(record.id, child);
          }
        }

        run.provider = child.config.provider;
        run.model = child.config.model;
        detach = this._attachProgressListener(child, run);

        const res = await child.run(prompt, {
          maxSteps: record.maxSteps || child.config.maxSteps,
          signal: controller.signal
        });

        const durationMs = Date.now() - startMs;
        run.finishedAt = new Date().toISOString();
        run.durationMs = durationMs;
        run.snapshotRunId = res.runId || child.lastRunId || null;
        run.stepsCount = Array.isArray(res.steps) ? res.steps.length : 0;
        run.tokensUsed = Number(res.usage?.totalTokens) || 0;
        run.estimatedCostUsd = ModelRouter.estimateCost(run.provider, run.model, {
          prompt_tokens: res.usage?.promptTokens || 0,
          completion_tokens: res.usage?.completionTokens || 0
        });
        run.steps = (res.steps || []).map((s: any) => ({
          step: s.step,
          thought: s.thought ? String(s.thought).slice(0, 200) : undefined,
          toolCalls: (s.toolCalls || []).map((tc: any) => ({
            name: tc.name,
            success: tc.result?.success !== false
          }))
        }));
        run.answer = res.content || res.answer || '';
        run.liveStatus = null;
        run.status = res.aborted ? 'aborted' : res.success ? 'completed' : 'failed';

        this._rollDailyCountersIfNeeded(record);
        record.dailyTokensUsed += run.tokensUsed;
        record.dailyCostUsd += run.estimatedCostUsd;
        record.runCount += 1;
        record.lastRunAt = run.finishedAt;
        record.lastDurationMs = durationMs;
        record.lastAnswer = run.answer;

        if (run.status === 'failed') {
          record.consecutiveFailures += 1;
          record.lastError = 'Run ended unsuccessfully';
        } else {
          record.consecutiveFailures = 0;
        }

        if (record.keepHistory) {
          try {
            child.memory.saveSession(agentSessionId, {
              sessionId: agentSessionId,
              agentId: record.id,
              updatedAt: run.finishedAt,
              history: child.history.slice(-80)
            });
          } catch (_) {}
        }

        if (record.consecutiveFailures >= record.maxConsecutiveFailures) {
          record.enabled = false;
          record.status = 'error';
          record.lastError = `Circuit breaker: paused after ${record.consecutiveFailures} consecutive failures`;
          this._clearSchedule(record.id);
        } else {
          record.status = record.enabled ? 'idle' : 'paused';
        }
      } catch (err: any) {
        const durationMs = Date.now() - startMs;
        run.finishedAt = new Date().toISOString();
        run.durationMs = durationMs;
        run.liveStatus = null;
        run.status = controller.signal.aborted ? 'aborted' : 'failed';
        run.error = err?.message || String(err);

        record.lastRunAt = run.finishedAt;
        record.lastDurationMs = durationMs;
        record.lastError = run.error;
        record.consecutiveFailures += 1;

        if (record.consecutiveFailures >= record.maxConsecutiveFailures) {
          record.enabled = false;
          record.status = 'error';
          record.lastError = `Circuit breaker (${record.consecutiveFailures} failures): ${run.error}`;
          this._clearSchedule(record.id);
        } else {
          record.status = record.enabled ? 'idle' : 'paused';
        }
      } finally {
        if (detach) detach();
        this.activeControllers.delete(runId);
        this._save();
        this._saveRuns();
        this._emitUpdate('run_finished', { runId, agentId: record.id, status: run.status });

        // Re-arm continuous loop after run completes
        if (!this.disposed && record.enabled && record.mode === 'continuous') {
          this._armSchedule(record);
        }
      }
    })();

    return run;
  }

  getRunDiff(runId: string) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) throw new Error(`Run '${runId}' not found`);
    if (!run.snapshotRunId) {
      return { runId, changes: [], note: 'No file mutations recorded for this run' };
    }
    const mgr = new WorkspaceSnapshotManager(run.workspaceDir);
    return mgr.diff(run.snapshotRunId) || { runId, changes: [] };
  }

  rollbackRun(runId: string) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) throw new Error(`Run '${runId}' not found`);
    if (!run.snapshotRunId) {
      throw new Error(`No snapshot recorded for run '${runId}'`);
    }
    const mgr = new WorkspaceSnapshotManager(run.workspaceDir);
    return mgr.rollback(run.snapshotRunId);
  }

  abortRun(runId: string): boolean {
    const controller = this.activeControllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  resetAll() {
    for (const ac of this.activeControllers.values()) {
      ac.abort();
    }
    this.activeControllers.clear();

    for (const id of Array.from(this.persistentAgents.keys())) {
      this._clearSchedule(id);
      const record = this.persistentAgents.get(id);
      if (record?.worktreePath && fs.existsSync(record.worktreePath)) {
        try {
          const git = new OMGitManager(this.parentAgent?.config?.workspaceDir || process.cwd());
          if (git.isGitRepo()) git.removeWorktree(record.worktreePath, true);
        } catch (_) {}
      }
      try {
        if (record?.sessionId) {
          const namedSessFile = path.join(this.memoryDir, 'sessions', `${record.sessionId}.json`);
          if (fs.existsSync(namedSessFile)) fs.rmSync(namedSessFile, { force: true });
        }
        const sessFile = path.join(this.memoryDir, 'sessions', `persistent_${id}.json`);
        if (fs.existsSync(sessFile)) fs.rmSync(sessFile, { force: true });
      } catch (_) {}
    }

    this.persistentAgents.clear();
    for (const live of this.liveAgents.values()) {
      live.close?.().catch(() => {});
    }
    this.liveAgents.clear();
    this.runs = [];
    this._save();
    this._saveRuns();
    this._emitUpdate('reset');
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const w of this.watchers.values()) {
      try { w.close(); } catch (_) {}
    }
    this.watchers.clear();
    for (const ac of this.activeControllers.values()) {
      ac.abort();
    }
    this.activeControllers.clear();
    for (const live of this.liveAgents.values()) {
      live.close?.().catch(() => {});
    }
    this.liveAgents.clear();
  }
}
