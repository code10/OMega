import fs from 'node:fs';
import path from 'node:path';
import { OMAgent } from '../agent.js';
import { SessionManager } from './sessionManager.js';
import { AgentManager } from './agentManager.js';

export interface TenantContext {
  userId: string;
  agent: OMAgent;
  sessionManager: SessionManager;
  agentManager: AgentManager;
  memoryDir: string;
  workspaceDir: string;
  lastAccessAt: number;
}

export function sanitizeTenantId(userId: string): string {
  return String(userId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Manages per-tenant isolated OMAgent, SessionManager, and AgentManager instances
 * with configurable idle-eviction TTL to bound RAM usage.
 */
export class TenantManager {
  baseConfig: Record<string, any>;
  tenantsRoot: string;
  idleTtlMs: number;
  tenants: Map<string, TenantContext>;
  onActivity?: (userId: string, entry: any) => void;
  onAgentUpdate?: (userId: string, payload: any) => void;
  confirmCommand?: (info: Record<string, any>) => Promise<boolean>;
  _evictTimer: ReturnType<typeof setInterval> | null;

  constructor(options: {
    baseConfig: Record<string, any>;
    tenantsRoot?: string;
    idleTtlMs?: number;
    onActivity?: (userId: string, entry: any) => void;
    onAgentUpdate?: (userId: string, payload: any) => void;
    confirmCommand?: (info: Record<string, any>) => Promise<boolean>;
  }) {
    this.baseConfig = options.baseConfig;
    const baseRoot = path.resolve(options.baseConfig.workspaceDir || process.cwd());
    this.tenantsRoot = path.resolve(options.tenantsRoot || path.join(baseRoot, 'tenants'));
    this.idleTtlMs = Math.max(1000, Number(options.idleTtlMs ?? 15 * 60 * 1000));
    this.tenants = new Map();
    this.onActivity = options.onActivity;
    this.onAgentUpdate = options.onAgentUpdate;
    this.confirmCommand = options.confirmCommand;

    const sweepInterval = Math.min(this.idleTtlMs, 60_000);
    this._evictTimer = setInterval(() => {
      void this.evictIdle();
    }, sweepInterval);
    this._evictTimer.unref?.();
  }

  async getTenant(userId: string): Promise<TenantContext> {
    const safeId = sanitizeTenantId(userId);
    const existing = this.tenants.get(safeId);
    if (existing) {
      existing.lastAccessAt = Date.now();
      return existing;
    }

    const tenantBase = path.join(this.tenantsRoot, safeId);
    const memoryDir = path.join(tenantBase, 'memory');
    const workspaceDir = path.join(tenantBase, 'workspace');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const tenantConfig = {
      ...this.baseConfig,
      memoryDir,
      workspaceDir
    };
    const agent = new OMAgent(tenantConfig);
    await agent.init();
    if (this.confirmCommand) {
      agent.confirmCommand = this.confirmCommand;
      agent.options.confirmCommand = this.confirmCommand;
    }
    if (this.onActivity) {
      agent.on('activity', (entry) => this.onActivity?.(safeId, entry));
    }

    const sessionManager = new SessionManager(agent);
    const agentManager = new AgentManager(agent, {
      onUpdate: (payload) => this.onAgentUpdate?.(safeId, payload)
    });

    const ctx: TenantContext = {
      userId: safeId,
      agent,
      sessionManager,
      agentManager,
      memoryDir,
      workspaceDir,
      lastAccessAt: Date.now()
    };
    this.tenants.set(safeId, ctx);
    return ctx;
  }

  async evictIdle(now = Date.now()): Promise<string[]> {
    const evicted: string[] = [];
    for (const [id, ctx] of this.tenants.entries()) {
      if (now - ctx.lastAccessAt >= this.idleTtlMs) {
        this.tenants.delete(id);
        evicted.push(id);
        try {
          await ctx.agent.close();
        } catch {
          // ignore close errors during eviction
        }
      }
    }
    return evicted;
  }

  async closeAll(): Promise<void> {
    if (this._evictTimer) {
      clearInterval(this._evictTimer);
      this._evictTimer = null;
    }
    for (const [, ctx] of this.tenants.entries()) {
      try {
        await ctx.agent.close();
      } catch {
        // ignore
      }
    }
    this.tenants.clear();
  }
}
