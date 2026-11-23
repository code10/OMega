import { OMAgent } from '../agent.js';

/**
 * Manages isolated per-session OMAgent instances and serializes concurrent
 * turns within the same session to prevent history corruption.
 */
export class SessionManager {
  defaultAgent: any;
  sessions: Map<string, any>;
  locks: Map<string, Promise<any>>;

  constructor(baseAgent: any) {
    this.defaultAgent = baseAgent;
    this.sessions = new Map();
    this.locks = new Map();
    if (baseAgent?.sessionId) {
      this.sessions.set(baseAgent.sessionId, baseAgent);
    }
  }

  private _syncRuntimeConfig(targetAgent: any) {
    if (!targetAgent || targetAgent === this.defaultAgent) return;
    const base = this.defaultAgent.config;
    targetAgent.config.maxSteps = base.maxSteps;
    targetAgent.config.temperature = base.temperature;
    targetAgent.config.effort = base.effort;
    targetAgent.config.systemPrompt = base.systemPrompt;
    targetAgent.config.security = base.security;
  }

  getAgent(sessionId?: string) {
    if (!sessionId || sessionId === this.defaultAgent.sessionId) {
      return this.defaultAgent;
    }
    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      this._syncRuntimeConfig(existing);
      return existing;
    }

    const isolated = new OMAgent({
      ...this.defaultAgent.options,
      provider: this.defaultAgent.config.provider,
      model: this.defaultAgent.config.model,
      maxSteps: this.defaultAgent.config.maxSteps,
      temperature: this.defaultAgent.config.temperature,
      effort: this.defaultAgent.config.effort,
      systemPrompt: this.defaultAgent.config.systemPrompt,
      memoryDir: this.defaultAgent.config.memoryDir,
      skillsDir: this.defaultAgent.config.skillsDir,
      workspaceDir: this.defaultAgent.config.workspaceDir,
      sessionId
    });
    // Share loaded skills, router (live stats + cooldowns), security config & memory vector store
    isolated.skills = this.defaultAgent.skills;
    isolated.router = this.defaultAgent.router;
    isolated.config.security = this.defaultAgent.config.security;
    try {
      isolated.resumeSession(sessionId);
    } catch (_) {
      // Fresh session if not yet on disk
    }
    this.sessions.set(sessionId, isolated);
    return isolated;
  }

  setProvider(provider: string, model?: string) {
    this.defaultAgent.setProvider(provider, model);
    for (const sessionAgent of this.sessions.values()) {
      if (sessionAgent !== this.defaultAgent) {
        sessionAgent.setProvider(provider, model);
      }
    }
  }

  /**
   * Abort an active in-process run for a specific session (or all active sessions if omitted).
   */
  abortSession(sessionId?: string, reason = 'Stopped by user'): string[] {
    const aborted: string[] = [];
    if (sessionId) {
      const target =
        sessionId === this.defaultAgent.sessionId
          ? this.defaultAgent
          : this.sessions.get(sessionId);
      if (target?.abort?.(reason)) {
        aborted.push(sessionId);
      }
      return aborted;
    }
    const seen = new Set<any>();
    for (const [id, agent] of this.sessions.entries()) {
      seen.add(agent);
      if (agent?.abort?.(reason)) aborted.push(id);
    }
    if (this.defaultAgent && !seen.has(this.defaultAgent) && this.defaultAgent.abort?.(reason)) {
      aborted.push(this.defaultAgent.sessionId || 'default');
    }
    return aborted;
  }

  async runExclusive<T>(sessionId: string | undefined, taskFn: (sessionAgent: any) => Promise<T>): Promise<T> {
    const key = sessionId || this.defaultAgent.sessionId || 'default';
    const prev = this.locks.get(key) || Promise.resolve();
    let release: (value?: any) => void = () => {};
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => next);
    this.locks.set(key, tail);

    await prev;
    try {
      return await taskFn(this.getAgent(sessionId));
    } finally {
      release();
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }
}

