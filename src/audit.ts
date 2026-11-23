import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './utils/redact.js';

export type AuditEventType =
  | 'tool_call'
  | 'approval_decision'
  | 'llm_usage'
  | 'daemon_run'
  | 'security_event';

export interface ModelPricing {
  inputUsd: number;
  outputUsd: number;
}

export interface AuditEntry {
  seq: number;
  timestamp: string;
  type: AuditEventType;
  ownerId: string;
  sessionId?: string;
  runId?: string;
  daemonId?: string;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditQueryFilter {
  ownerId?: string;
  sessionId?: string;
  daemonId?: string;
  type?: AuditEventType;
  since?: string;
  limit?: number;
}

export interface AuditChainVerification {
  valid: boolean;
  entriesChecked: number;
  brokenAtSeq?: number;
  reason?: string;
}

export interface CostBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface CostSummary extends CostBucket {
  byModel: Record<string, CostBucket & { provider: string; model: string }>;
  bySession: Record<string, CostBucket>;
  byOwner: Record<string, CostBucket>;
}

/**
 * Reference USD pricing per 1,000,000 tokens (input / output).
 * Local and mock providers default to $0.
 */
export const DEFAULT_MODEL_PRICING_PER_1M: Record<string, ModelPricing> = {
  // Google Gemini
  'gemini-3-flash-preview': { inputUsd: 0.15, outputUsd: 0.60 },
  'gemini-3.1-flash-lite': { inputUsd: 0.075, outputUsd: 0.30 },
  'gemini-2.5-pro': { inputUsd: 1.25, outputUsd: 10.0 },
  'gemini-2.5-flash': { inputUsd: 0.15, outputUsd: 0.60 },
  'gemini-2.0-flash': { inputUsd: 0.10, outputUsd: 0.40 },
  // OpenAI
  'gpt-4o': { inputUsd: 2.50, outputUsd: 10.0 },
  'gpt-4o-mini': { inputUsd: 0.15, outputUsd: 0.60 },
  'gpt-4.1': { inputUsd: 2.00, outputUsd: 8.00 },
  'gpt-4.1-mini': { inputUsd: 0.40, outputUsd: 1.60 },
  'o3-mini': { inputUsd: 1.10, outputUsd: 4.40 },
  // Anthropic
  'claude-3-5-sonnet-20241022': { inputUsd: 3.00, outputUsd: 15.0 },
  'claude-3-7-sonnet-20250219': { inputUsd: 3.00, outputUsd: 15.0 },
  'claude-sonnet-4': { inputUsd: 3.00, outputUsd: 15.0 },
  'claude-3-5-haiku-20241022': { inputUsd: 0.80, outputUsd: 4.00 },
  // DeepSeek / Kimi / Qwen / GLM
  'deepseek-chat': { inputUsd: 0.27, outputUsd: 1.10 },
  'deepseek-reasoner': { inputUsd: 0.55, outputUsd: 2.19 },
  'kimi-k2-0711-preview': { inputUsd: 0.60, outputUsd: 2.50 },
  'qwen-plus': { inputUsd: 0.40, outputUsd: 1.20 },
  'glm-4.5-flash': { inputUsd: 0.10, outputUsd: 0.30 }
};

const PROVIDER_FALLBACK_PRICING: Record<string, ModelPricing> = {
  om: { inputUsd: 0, outputUsd: 0 },
  mock: { inputUsd: 0, outputUsd: 0 },
  replay: { inputUsd: 0, outputUsd: 0 },
  lmstudio: { inputUsd: 0, outputUsd: 0 },
  vllm: { inputUsd: 0, outputUsd: 0 },
  gemini: { inputUsd: 0.15, outputUsd: 0.60 },
  openai: { inputUsd: 2.50, outputUsd: 10.0 },
  anthropic: { inputUsd: 3.00, outputUsd: 15.0 },
  deepseek: { inputUsd: 0.27, outputUsd: 1.10 },
  kimi: { inputUsd: 0.60, outputUsd: 2.50 },
  qwen: { inputUsd: 0.40, outputUsd: 1.20 },
  glm: { inputUsd: 0.10, outputUsd: 0.30 }
};

function roundUsd(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

/**
 * Estimate USD cost for a model call given token usage.
 */
export function estimateCostUsd(
  provider: string,
  model: string,
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  pricingOverrides?: Record<string, ModelPricing>
): number {
  if (!usage) return 0;
  const promptTokens = Math.max(0, Number(usage.promptTokens || 0));
  const completionTokens = Math.max(0, Number(usage.completionTokens || 0));
  if (promptTokens === 0 && completionTokens === 0) return 0;

  const pKey = String(provider || 'om').toLowerCase().trim();
  const mKey = String(model || '').toLowerCase().trim();

  const exactOverride = pricingOverrides?.[mKey];
  const exactDefault = DEFAULT_MODEL_PRICING_PER_1M[mKey];
  let pricing = exactOverride || exactDefault;

  if (!pricing && mKey) {
    const matchedKey = Object.keys(DEFAULT_MODEL_PRICING_PER_1M).find((k) => mKey.startsWith(k) || k.startsWith(mKey));
    if (matchedKey) pricing = DEFAULT_MODEL_PRICING_PER_1M[matchedKey];
  }
  if (!pricing) {
    pricing = PROVIDER_FALLBACK_PRICING[pKey] || { inputUsd: 0, outputUsd: 0 };
  }

  const cost = (promptTokens / 1_000_000) * pricing.inputUsd + (completionTokens / 1_000_000) * pricing.outputUsd;
  return roundUsd(cost);
}

function sanitizeValue(val: unknown, depth = 0): unknown {
  if (depth > 4) return '[Truncated]';
  if (typeof val === 'string') {
    const redacted = redactSecrets(val);
    return redacted.length > 500 ? `${redacted.slice(0, 500)}...[truncated]` : redacted;
  }
  if (val === null || val === undefined || typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>).slice(0, 30)) {
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return String(val);
}

function computeEntryHash(payload: Omit<AuditEntry, 'hash'>): string {
  const canonical = JSON.stringify({
    seq: payload.seq,
    timestamp: payload.timestamp,
    type: payload.type,
    ownerId: payload.ownerId,
    sessionId: payload.sessionId ?? null,
    runId: payload.runId ?? null,
    daemonId: payload.daemonId ?? null,
    data: payload.data,
    prevHash: payload.prevHash
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Append-only, SHA-256 hash-chained audit log and cost ledger.
 */
export class OMAuditLedger {
  readonly filePath: string;
  readonly defaultOwnerId: string;
  readonly pricingOverrides: Record<string, ModelPricing>;

  constructor(
    ledgerPathOrMemoryDir: string,
    options: { ownerId?: string; pricingOverrides?: Record<string, ModelPricing> } = {}
  ) {
    this.filePath = ledgerPathOrMemoryDir.endsWith('.jsonl')
      ? path.resolve(ledgerPathOrMemoryDir)
      : path.join(path.resolve(ledgerPathOrMemoryDir), 'audit-ledger.jsonl');
    this.defaultOwnerId = options.ownerId || 'local';
    this.pricingOverrides = options.pricingOverrides || {};
  }

  private _readTailState(): { seq: number; hash: string } {
    if (!fs.existsSync(this.filePath)) {
      return { seq: 0, hash: 'GENESIS' };
    }
    try {
      const content = fs.readFileSync(this.filePath, 'utf8').trim();
      if (!content) return { seq: 0, hash: 'GENESIS' };
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const parsed = JSON.parse(line) as AuditEntry;
        return { seq: Number(parsed.seq || lines.length), hash: String(parsed.hash || 'GENESIS') };
      }
    } catch {
      // Fall through to genesis if unreadable
    }
    return { seq: 0, hash: 'GENESIS' };
  }

  append(
    type: AuditEventType,
    data: Record<string, unknown>,
    meta: { ownerId?: string; sessionId?: string; runId?: string; daemonId?: string } = {}
  ): AuditEntry {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tail = this._readTailState();
    const base: Omit<AuditEntry, 'hash'> = {
      seq: tail.seq + 1,
      timestamp: new Date().toISOString(),
      type,
      ownerId: meta.ownerId || this.defaultOwnerId,
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.runId ? { runId: meta.runId } : {}),
      ...(meta.daemonId ? { daemonId: meta.daemonId } : {}),
      data: sanitizeValue(data) as Record<string, unknown>,
      prevHash: tail.hash
    };
    const entry: AuditEntry = {
      ...base,
      hash: computeEntryHash(base)
    };
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  recordToolCall(params: {
    toolName: string;
    args?: unknown;
    success: boolean;
    durationMs: number;
    error?: string;
    step?: number;
    ownerId?: string;
    sessionId?: string;
    runId?: string;
  }): AuditEntry {
    return this.append(
      'tool_call',
      {
        toolName: params.toolName,
        args: params.args ?? {},
        success: params.success,
        durationMs: params.durationMs,
        ...(params.step !== undefined ? { step: params.step } : {}),
        ...(params.error ? { error: params.error } : {})
      },
      { ownerId: params.ownerId, sessionId: params.sessionId, runId: params.runId }
    );
  }

  recordApproval(params: {
    requestId: string;
    toolName: string;
    command?: string | null;
    approved: boolean;
    scope?: string;
    commandPrefix?: string;
    reason?: string;
    ownerId?: string;
    sessionId?: string;
  }): AuditEntry {
    return this.append(
      'approval_decision',
      {
        requestId: params.requestId,
        toolName: params.toolName,
        ...(params.command ? { command: params.command } : {}),
        approved: params.approved,
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.commandPrefix ? { commandPrefix: params.commandPrefix } : {}),
        ...(params.reason ? { reason: params.reason } : {})
      },
      { ownerId: params.ownerId, sessionId: params.sessionId }
    );
  }

  recordLlmUsage(params: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    step?: number;
    ownerId?: string;
    sessionId?: string;
    runId?: string;
    daemonId?: string;
  }): AuditEntry {
    const estimatedCostUsd = estimateCostUsd(
      params.provider,
      params.model,
      {
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        totalTokens: params.totalTokens
      },
      this.pricingOverrides
    );
    return this.append(
      'llm_usage',
      {
        provider: params.provider,
        model: params.model,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        totalTokens: params.totalTokens,
        estimatedCostUsd,
        ...(params.step !== undefined ? { step: params.step } : {})
      },
      {
        ownerId: params.ownerId,
        sessionId: params.sessionId,
        runId: params.runId,
        daemonId: params.daemonId
      }
    );
  }

  recordDaemonRun(params: {
    daemonId: string;
    daemonName?: string;
    status: string;
    triggerType?: string;
    steps?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    worktreeBranch?: string;
    error?: string;
    ownerId?: string;
    runId?: string;
  }): AuditEntry {
    return this.append(
      'daemon_run',
      {
        daemonName: params.daemonName || params.daemonId,
        status: params.status,
        ...(params.triggerType ? { triggerType: params.triggerType } : {}),
        ...(params.steps !== undefined ? { steps: params.steps } : {}),
        ...(params.totalTokens !== undefined ? { totalTokens: params.totalTokens } : {}),
        ...(params.estimatedCostUsd !== undefined ? { estimatedCostUsd: params.estimatedCostUsd } : {}),
        ...(params.worktreeBranch ? { worktreeBranch: params.worktreeBranch } : {}),
        ...(params.error ? { error: params.error } : {})
      },
      { ownerId: params.ownerId, daemonId: params.daemonId, runId: params.runId }
    );
  }

  recordSecurityEvent(params: {
    category: string;
    detail: string;
    ownerId?: string;
    sessionId?: string;
    extra?: Record<string, unknown>;
  }): AuditEntry {
    return this.append(
      'security_event',
      {
        category: params.category,
        detail: params.detail,
        ...params.extra
      },
      { ownerId: params.ownerId, sessionId: params.sessionId }
    );
  }

  readAll(): AuditEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf8');
    const entries: AuditEntry[] = [];
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Malformed lines are caught by verifyChain()
      }
    }
    return entries;
  }

  /**
   * Reset the audit ledger file back to an empty genesis state.
   */
  clear(): { cleared: boolean } {
    if (fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', 'utf8');
    }
    return { cleared: true };
  }

  verifyChain(): AuditChainVerification {
    if (!fs.existsSync(this.filePath)) {
      return { valid: true, entriesChecked: 0 };
    }
    const content = fs.readFileSync(this.filePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    let expectedPrevHash = 'GENESIS';

    for (let i = 0; i < lines.length; i++) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(lines[i]) as AuditEntry;
      } catch {
        return {
          valid: false,
          entriesChecked: i,
          brokenAtSeq: i + 1,
          reason: `Malformed JSON at line ${i + 1}`
        };
      }
      if (entry.seq !== i + 1) {
        return {
          valid: false,
          entriesChecked: i,
          brokenAtSeq: i + 1,
          reason: `Sequence mismatch at line ${i + 1}: expected ${i + 1}, got ${entry.seq}`
        };
      }
      if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          entriesChecked: i,
          brokenAtSeq: entry.seq,
          reason: `Previous hash mismatch at seq ${entry.seq}`
        };
      }
      const { hash, ...withoutHash } = entry;
      const expectedHash = computeEntryHash(withoutHash);
      if (hash !== expectedHash) {
        return {
          valid: false,
          entriesChecked: i,
          brokenAtSeq: entry.seq,
          reason: `Hash mismatch (tampered entry) at seq ${entry.seq}`
        };
      }
      expectedPrevHash = hash;
    }

    return { valid: true, entriesChecked: lines.length };
  }

  query(filter: AuditQueryFilter = {}): AuditEntry[] {
    const all = this.readAll();
    const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
    const matched = all.filter((entry) => {
      if (filter.ownerId && entry.ownerId !== filter.ownerId) return false;
      if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
      if (filter.daemonId && entry.daemonId !== filter.daemonId) return false;
      if (filter.type && entry.type !== filter.type) return false;
      if (!Number.isNaN(sinceMs) && Date.parse(entry.timestamp) < sinceMs) return false;
      return true;
    });
    const limit = typeof filter.limit === 'number' && filter.limit > 0 ? filter.limit : 200;
    return matched.slice(-limit);
  }

  getCostSummary(filter: Omit<AuditQueryFilter, 'type' | 'limit'> = {}): CostSummary {
    const entries = this.query({ ...filter, type: 'llm_usage', limit: Number.MAX_SAFE_INTEGER });
    const summary: CostSummary = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      calls: 0,
      byModel: {},
      bySession: {},
      byOwner: {}
    };

    const addToBucket = (bucket: CostBucket, pt: number, ct: number, tt: number, cost: number) => {
      bucket.promptTokens += pt;
      bucket.completionTokens += ct;
      bucket.totalTokens += tt;
      bucket.costUsd = roundUsd(bucket.costUsd + cost);
      bucket.calls += 1;
    };

    for (const entry of entries) {
      const pt = Number(entry.data.promptTokens || 0);
      const ct = Number(entry.data.completionTokens || 0);
      const tt = Number(entry.data.totalTokens || pt + ct);
      const cost = Number(entry.data.estimatedCostUsd || 0);
      const provider = String(entry.data.provider || 'unknown');
      const model = String(entry.data.model || 'unknown');
      const modelKey = `${provider}/${model}`;
      const sessionKey = entry.sessionId || 'unknown';
      const ownerKey = entry.ownerId || 'local';

      addToBucket(summary, pt, ct, tt, cost);

      if (!summary.byModel[modelKey]) {
        summary.byModel[modelKey] = { provider, model, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
      }
      addToBucket(summary.byModel[modelKey], pt, ct, tt, cost);

      if (!summary.bySession[sessionKey]) {
        summary.bySession[sessionKey] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
      }
      addToBucket(summary.bySession[sessionKey], pt, ct, tt, cost);

      if (!summary.byOwner[ownerKey]) {
        summary.byOwner[ownerKey] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
      }
      addToBucket(summary.byOwner[ownerKey], pt, ct, tt, cost);
    }

    return summary;
  }
}
