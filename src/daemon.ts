import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { OMAgent } from './agent.js';
import { OMSelfImprover } from './selfImprove.js';
import { createLogger } from './utils/logger.js';

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
  running: boolean;

  constructor(agentOrOptions: any = {}) {
    super();
    this.agent = agentOrOptions instanceof OMAgent ? agentOrOptions : null;
    this.agentOptions = agentOrOptions instanceof OMAgent ? agentOrOptions.options : agentOrOptions;
    this.triggers = new Map();
    this.timers = [];
    this.watchers = [];
    this.history = [];
    this.running = false;
  }

  async _ensureAgent() {
    if (!this.agent) {
      this.agent = new OMAgent(this.agentOptions);
      await this.agent.init();
    }
    return this.agent;
  }

  addTrigger(trigger: Record<string, any>) {
    if (!trigger || !trigger.id) throw new Error('Trigger requires an id');
    const normalized = {
      id: trigger.id,
      type: trigger.type || (trigger.cron ? 'cron' : trigger.everyMs ? 'interval' : trigger.watchPath ? 'watch' : 'webhook'),
      cron: trigger.cron || null,
      everyMs: trigger.everyMs || null,
      watchPath: trigger.watchPath || null,
      prompt: trigger.prompt || '',
      skill: trigger.skill || null,
      handler: typeof trigger.handler === 'function' ? trigger.handler : null,
      runOnStart: Boolean(trigger.runOnStart),
      enabled: trigger.enabled !== false,
      lastRunAt: null,
      runCount: 0
    };
    this.triggers.set(normalized.id, normalized);
    return normalized;
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

  async fireTrigger(triggerId: string, payload: Record<string, any> = {}) {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) throw new Error(`Trigger '${triggerId}' not found`);
    if (!trigger.enabled) return { skipped: true, reason: 'disabled' };

    const agent = await this._ensureAgent();
    const promptText = trigger.skill
      ? `/${trigger.skill} ${trigger.prompt || ''} ${Object.keys(payload).length ? `\nTrigger Payload: ${JSON.stringify(payload)}` : ''}`.trim()
      : `${trigger.prompt}${Object.keys(payload).length ? `\nTrigger Payload: ${JSON.stringify(payload)}` : ''}`.trim();

    trigger.lastRunAt = new Date().toISOString();
    trigger.runCount += 1;

    const record: Record<string, any> = {
      triggerId,
      type: trigger.type,
      startedAt: trigger.lastRunAt,
      success: false
    };

    try {
      if (trigger.handler) {
        const res = await trigger.handler(payload, agent);
        record.success = res?.success !== false;
        record.result = res;
        record.zeroToken = true;
      } else {
        const res = await agent.run(promptText);
        record.success = Boolean(res.success);
        record.answer = res.content;
      }
      record.finishedAt = new Date().toISOString();
      this.emit('trigger_run', record);
      return record;
    } catch (err: any) {
      record.error = err.message;
      record.finishedAt = new Date().toISOString();
      this.emit('trigger_error', record);
      return record;
    } finally {
      this.history.push(record);
      if (this.history.length > 100) this.history.shift();
    }
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

