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

  getAgent(sessionId?: string) {
    if (!sessionId || sessionId === this.defaultAgent.sessionId) {
      return this.defaultAgent;
    }
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    const isolated = new OMAgent({
      ...this.defaultAgent.options,
      provider: this.defaultAgent.config.provider,
      model: this.defaultAgent.config.model,
      memoryDir: this.defaultAgent.config.memoryDir,
      skillsDir: this.defaultAgent.config.skillsDir,
      workspaceDir: this.defaultAgent.config.workspaceDir,
      sessionId
    });
    // Share loaded skills & memory vector store
    isolated.skills = this.defaultAgent.skills;
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

