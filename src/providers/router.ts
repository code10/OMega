import { createProvider } from './index.js';
import { estimateMessagesTokens, getModelContextLimit } from '../tokenizer.js';
import { collectDeviceSpecs, type DeviceSpecsSnapshot } from '../deviceSpecs.js';

export interface ProviderHealthMetrics {
  calls: number;
  successes: number;
  failures: number;
  inFlight: number;
  rpm60s: number;
  ewmaTtftMs: number | null;
  ewmaLatencyMs: number | null;
  lastTtftMs: number | null;
  lastLatencyMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  halfOpen: boolean;
  openCount: number;
}

/**
 * Multi-Model Router & Automatic Failover Engine for OMega.
 *
 * Provides:
 * - Graceful failover between local models (LM Studio, vLLM, OM)
 *   and cloud providers (Gemini, OpenAI, Anthropic).
 * - Automatic retry with exponential backoff + jitter on transient failures.
 * - EWMA TTFT & latency tracking, load balancing ('priority' | 'latency' | 'round_robin'),
 *   half-open circuit breaker with exponential cooldown backoff, and optional hedged requests.
 * - Context window overflow / token limit detection with seamless handoff
 *   to larger-context cloud models.
 * - Full telemetry and event emission ('retry', 'fallback', 'hedge_won', 'stream_reset') for UI & CLI visibility.
 */
export class ModelRouter {
  config: Record<string, any>;
  routingConfig: Record<string, any>;
  onEvent: (event: string, payload: any) => void;
  providerFactory: (cfg: Record<string, any>) => any;
  systemOne: any;
  hardwareSampler: (() => Promise<DeviceSpecsSnapshot>) | null;
  _cachedHardware: { at: number; specs: DeviceSpecsSnapshot } | null;
  _providerCache: Map<string, any>;
  cooldowns: Map<string, number>;
  consecutiveFailures: Map<string, number>;
  providerMetrics: Map<string, ProviderHealthMetrics>;
  _inFlight: Map<string, number>;
  _requestTimestamps: Map<string, number[]>;
  _rrCursor: number;
  stats: Record<string, any>;

  constructor(options: Record<string, any> = {}) {
    this.config = options.config || {};
    const defaultHedging = { enabled: false, delayMs: 3500 };
    const defaultRpmGuard = { enabled: false, softRpmPerModel: 25, maxInFlightPerModel: 4 };
    this.routingConfig = {
      enabled: true,
      strategy: 'priority',
      balancePrimary: false,
      adaptiveEffort: false,
      maxRetries: 1,
      retryDelayMs: 75,
      rateLimitCooldownMs: 15000,
      overloadCooldownMs: 8000,
      maxRateLimitWaitMs: 65000,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30000,
      maxCircuitBreakerCooldownMs: 120000,
      ewmaAlpha: 0.3,
      autoHandoffOnContextLimit: true,
      fallbackChain: [
        { provider: 'gemini', model: 'gemini-3.5-flash' },
        { provider: 'gemini', model: 'gemini-3.8-flash' },
        { provider: 'openai', model: 'gpt-5-mini-2025-08-07' },
        { provider: 'anthropic', model: 'claude-fable-5-2' },
        { provider: 'om', model: 'om-reasoning' }
      ],
      ...this.config.routing,
      ...options.routing,
      hedging: {
        ...defaultHedging,
        ...this.config.routing?.hedging,
        ...options.routing?.hedging
      },
      rpmGuard: {
        ...defaultRpmGuard,
        ...this.config.routing?.rpmGuard,
        ...options.routing?.rpmGuard
      }
    };
    this.onEvent = options.onEvent || (() => { });
    this.providerFactory = options.providerFactory || createProvider;
    this.systemOne = options.systemOne || null;
    this.hardwareSampler = typeof options.hardwareSampler === 'function' ? options.hardwareSampler : null;
    this._cachedHardware = null;
    this._providerCache = new Map();
    this.cooldowns = new Map();
    this.consecutiveFailures = new Map();
    this.providerMetrics = new Map();
    this._inFlight = new Map();
    this._requestTimestamps = new Map();
    this._rrCursor = 0;
    this.stats = {
      totalCalls: 0,
      retries: 0,
      fallbacks: 0,
      hedgesWon: 0,
      rpmSpillovers: 0,
      contextHandoffs: 0,
      rateLimitFallbacks: 0,
      complexityRoutes: 0,
      hardwareRoutes: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      history: []
    };
  }

  async _getHardwareSnapshot(options: Record<string, any> = {}, ttlMs = 5000): Promise<DeviceSpecsSnapshot> {
    if (options.hardwareSpecs) return options.hardwareSpecs;
    const now = Date.now();
    if (this._cachedHardware && now - this._cachedHardware.at < ttlMs) {
      return this._cachedHardware.specs;
    }
    const specs = this.hardwareSampler ? await this.hardwareSampler() : await collectDeviceSpecs();
    this._cachedHardware = { at: now, specs };
    return specs;
  }

  _findUsableCloudFallback(): Record<string, any> | null {
    const chain = this.routingConfig.fallbackChain || [];
    for (const item of chain) {
      const cand = typeof item === 'string' ? { provider: item } : { ...item };
      const pName = (cand.provider || '').toLowerCase();
      if (ModelRouter.isLocalProvider(pName)) continue;
      const model = cand.model || this.getDefaultModelForProvider(pName);
      if (!this.isInCooldown(pName, model) && this.canUseCandidate({ ...cand, provider: pName, model })) {
        return { provider: pName, model, providerInstance: cand.providerInstance || null };
      }
    }
    return null;
  }

  static estimateCost(providerName: string, modelName: string, usage: Record<string, any> = {}) {
    if (ModelRouter.isLocalProvider(providerName)) return 0;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? 0) || 0;
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0) || 0;
    const m = (modelName || '').toLowerCase();
    // Approximate USD per 1M tokens -> per token
    let inPerM = 0.5;
    let outPerM = 1.5;
    if (m.includes('opus')) { inPerM = 15; outPerM = 75; }
    else if (m.includes('sonnet') || m.includes('fable') || (m.includes('gpt-4o') && !m.includes('mini'))) { inPerM = 3; outPerM = 15; }
    else if (m.includes('pro')) { inPerM = 1.25; outPerM = 5; }
    else if (m.includes('deepseek-reasoner') || m.includes('deepseek-r1')) { inPerM = 0.55; outPerM = 2.19; }
    else if (m.includes('deepseek')) { inPerM = 0.27; outPerM = 1.1; }
    else if (m.includes('flash-lite') || m.includes('mini') || m.includes('glm-4.5-flash')) { inPerM = 0.1; outPerM = 0.4; }
    else if (m.includes('flash')) { inPerM = 0.15; outPerM = 0.6; }
    return (prompt * inPerM + completion * outPerM) / 1_000_000;
  }

  /**
   * Weighted multi-signal complexity classifier ('simple' | 'moderate' | 'complex').
   * Evaluates token density, code/stack-trace presence, tool-error recovery, conversation depth, and intent.
   */
  static classifyComplexity(chatParams: Record<string, any> = {}) {
    const messages = chatParams.messages || [];
    const last = messages[messages.length - 1];
    const userMsg = [...messages].reverse().find((m) => m.role === 'user');
    const text = String(userMsg?.content || '');

    let score = 0;
    const { estimatedTokens } = estimateMessagesTokens(messages, chatParams.systemPrompt);
    if (estimatedTokens > 1500) score += 2;
    else if (estimatedTokens > 400) score += 1;

    // Code blocks, stack traces, or multi-file references
    if (/```|Error:|at\s+\S+\s*\(|function\s+\w+|class\s+\w+/.test(text)) score += 2;
    // Multi-step or architectural reasoning intent
    if (/\b(architect|refactor|debug|security|audit|plan|analyze|compare|multi-step|implement|migrate)\b/i.test(text)) score += 2;
    // Prior tool failure requires stronger reasoning to recover
    const lastContent = String(last?.content || '');
    if (last?.role === 'tool' && (lastContent.includes('"success":false') || lastContent.includes('Error'))) {
      score += 3;
    } else if (last?.role === 'tool' && lastContent.length < 1800 && score < 2) {
      return 'simple';
    }

    if (messages.length > 8) score += 1;
    if (Array.isArray(chatParams.tools) && chatParams.tools.length > 12) score += 1;

    if (score >= 3) return 'complex';
    if (score <= 0 && messages.length <= 2 && text.length < 180) return 'simple';
    return 'moderate';
  }

  _getOrCreateProvider(target: Record<string, any>) {
    if (target.providerInstance) return target.providerInstance;
    const key = this._cooldownKey(target.provider || '', target.model || '');
    if (this.providerFactory === createProvider && this._providerCache.has(key)) {
      return this._providerCache.get(key);
    }
    const inst = this.providerFactory({ ...this.config, ...target });
    if (this.providerFactory === createProvider) {
      this._providerCache.set(key, inst);
    }
    return inst;
  }

  _isNonTransientHttpError(err: any): boolean {
    const status = Number(err?.status ?? err?.statusCode ?? 0);
    return status === 400 || status === 401 || status === 403 || status === 404;
  }

  _cooldownKey(provider: string, model?: string) {
    return `${(provider || '').toLowerCase()}/${model || 'default'}`;
  }

  _getOrInitMetrics(provider: string, model?: string): ProviderHealthMetrics {
    const key = this._cooldownKey(provider, model);
    let m = this.providerMetrics.get(key);
    if (!m) {
      m = {
        calls: 0,
        successes: 0,
        failures: 0,
        inFlight: 0,
        rpm60s: 0,
        ewmaTtftMs: null,
        ewmaLatencyMs: null,
        lastTtftMs: null,
        lastLatencyMs: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        halfOpen: false,
        openCount: 0
      };
      this.providerMetrics.set(key, m);
    }
    return m;
  }

  _getRecentRpm(provider: string, model?: string): number {
    const key = this._cooldownKey(provider, model);
    const list = this._requestTimestamps.get(key);
    if (!list || list.length === 0) return 0;
    const cutoff = Date.now() - 60_000;
    let pruneIdx = 0;
    while (pruneIdx < list.length && list[pruneIdx] < cutoff) pruneIdx++;
    if (pruneIdx > 0) list.splice(0, pruneIdx);
    if (list.length === 0) {
      this._requestTimestamps.delete(key);
      return 0;
    }
    return list.length;
  }

  _getInFlight(provider: string, model?: string): number {
    return this._inFlight.get(this._cooldownKey(provider, model)) || 0;
  }

  _beginRequestLoad(provider: string, model?: string) {
    const key = this._cooldownKey(provider, model);
    const now = Date.now();
    const list = this._requestTimestamps.get(key) || [];
    list.push(now);
    this._requestTimestamps.set(key, list);
    const nextInFlight = (this._inFlight.get(key) || 0) + 1;
    this._inFlight.set(key, nextInFlight);
    const m = this._getOrInitMetrics(provider, model);
    m.inFlight = nextInFlight;
    m.rpm60s = this._getRecentRpm(provider, model);
  }

  _endRequestLoad(provider: string, model?: string) {
    const key = this._cooldownKey(provider, model);
    const nextInFlight = Math.max(0, (this._inFlight.get(key) || 1) - 1);
    if (nextInFlight === 0) this._inFlight.delete(key);
    else this._inFlight.set(key, nextInFlight);
    const m = this._getOrInitMetrics(provider, model);
    m.inFlight = nextInFlight;
    m.rpm60s = this._getRecentRpm(provider, model);
  }

  _isAtSoftCap(provider: string, model?: string): boolean {
    const guard = this.routingConfig.rpmGuard;
    if (!guard?.enabled) return false;
    const maxInFlight = Number(guard.maxInFlightPerModel ?? 4);
    if (maxInFlight > 0 && this._getInFlight(provider, model) >= maxInFlight) {
      return true;
    }
    const pName = (provider || '').toLowerCase();
    const key = this._cooldownKey(provider, model);
    const softRpm = Number(
      guard.providerRpmLimits?.[key] ??
      guard.providerRpmLimits?.[pName] ??
      guard.softRpmPerModel ??
      25
    );
    if (softRpm > 0 && this._getRecentRpm(provider, model) >= softRpm) {
      return true;
    }
    return false;
  }

  _recordTelemetry(provider: string, model: string | undefined, latencyMs: number, ttftMs: number | null) {
    const alpha = Math.min(0.9, Math.max(0.05, Number(this.routingConfig.ewmaAlpha ?? 0.3)));
    const m = this._getOrInitMetrics(provider, model);
    m.calls++;
    m.successes++;
    m.lastLatencyMs = latencyMs;
    m.ewmaLatencyMs = m.ewmaLatencyMs === null ? latencyMs : Math.round(alpha * latencyMs + (1 - alpha) * m.ewmaLatencyMs);
    if (ttftMs !== null) {
      m.lastTtftMs = ttftMs;
      m.ewmaTtftMs = m.ewmaTtftMs === null ? ttftMs : Math.round(alpha * ttftMs + (1 - alpha) * m.ewmaTtftMs);
    }
    m.lastSuccessAt = Date.now();
  }

  async _invokeWithTelemetry(providerInstance: any, providerName: string, modelName: string, chatParams: Record<string, any>) {
    const startMs = Date.now();
    let ttftMs: number | null = null;
    let emittedTokens = 0;
    const origOnToken = typeof chatParams.onToken === 'function' ? chatParams.onToken : undefined;
    const wrappedParams = origOnToken
      ? {
        ...chatParams,
        onToken: (token: string) => {
          if (ttftMs === null) ttftMs = Date.now() - startMs;
          emittedTokens++;
          origOnToken(token);
        }
      }
      : chatParams;
    this._beginRequestLoad(providerName, modelName);
    try {
      const response = await providerInstance.chat(wrappedParams);
      const latencyMs = Date.now() - startMs;
      this._recordTelemetry(providerName, modelName, latencyMs, ttftMs);
      return { response, ttftMs, latencyMs, emittedTokens };
    } catch (err: any) {
      if (err && typeof err === 'object') {
        err._emittedTokens = emittedTokens;
      }
      throw err;
    } finally {
      this._endRequestLoad(providerName, modelName);
    }
  }

  isInCooldown(provider: string, model?: string) {
    const key = this._cooldownKey(provider, model);
    const until = this.cooldowns.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldowns.delete(key);
      // Enter half-open probe state so a failed probe re-opens immediately with backoff
      const m = this._getOrInitMetrics(provider, model);
      m.halfOpen = true;
      return false;
    }
    return true;
  }

  markCooldown(provider: string, model?: string, retryAfterMs?: number) {
    const duration = retryAfterMs || this.routingConfig.rateLimitCooldownMs || 60000;
    if (duration <= 0) return;
    this.cooldowns.set(this._cooldownKey(provider, model), Date.now() + duration);
  }

  /**
   * Reset consecutive failure count, half-open state, and any active cooldown after a successful call.
   */
  recordSuccess(provider: string, model?: string) {
    const key = this._cooldownKey(provider, model);
    this.consecutiveFailures.delete(key);
    this.cooldowns.delete(key);
    const m = this._getOrInitMetrics(provider, model);
    m.halfOpen = false;
    m.openCount = 0;
  }

  /**
   * Track consecutive non-429 failures and open a circuit-breaker cooldown once the threshold is reached.
   * Uses half-open probe detection and exponential cooldown backoff to avoid hammering recovering backends.
   */
  recordFailure(provider: string, model?: string) {
    const m = this._getOrInitMetrics(provider, model);
    m.calls++;
    m.failures++;
    m.lastFailureAt = Date.now();

    const threshold = Number(this.routingConfig.circuitBreakerThreshold ?? 3);
    if (threshold <= 0) return;
    const key = this._cooldownKey(provider, model);
    const baseCooldownMs = Number(this.routingConfig.circuitBreakerCooldownMs ?? 30000);
    const maxCooldownMs = Number(this.routingConfig.maxCircuitBreakerCooldownMs ?? 120000);

    // If a half-open probe fails, re-open immediately with exponential backoff
    if (m.halfOpen) {
      m.halfOpen = false;
      m.openCount = Math.min(m.openCount + 1, 5);
      this.consecutiveFailures.delete(key);
      const backoffMs = Math.min(baseCooldownMs * Math.pow(2, m.openCount - 1), maxCooldownMs);
      this.markCooldown(provider, model, backoffMs);
      return;
    }

    const nextCount = (this.consecutiveFailures.get(key) || 0) + 1;
    if (nextCount >= threshold) {
      this.consecutiveFailures.delete(key);
      m.openCount = Math.min(m.openCount + 1, 5);
      const backoffMs = Math.min(baseCooldownMs * Math.pow(2, m.openCount - 1), maxCooldownMs);
      this.markCooldown(provider, model, backoffMs);
    } else {
      this.consecutiveFailures.set(key, nextCount);
    }
  }

  /**
   * Determine if an error indicates transient upstream overload (HTTP 502/503/504/529)
   */
  static isOverloadError(err: any) {
    if (!err) return false;
    const status = Number(err.status ?? err.statusCode ?? 0);
    const msg = (err.message || String(err)).toLowerCase();
    return (
      status === 502 ||
      status === 503 ||
      status === 504 ||
      status === 529 ||
      msg.includes('overloaded') ||
      msg.includes('high demand') ||
      msg.includes('service unavailable')
    );
  }

  /**
   * Determine if an error indicates rate-limit / quota exhaustion (HTTP 429)
   */
  static isRateLimitError(err: any) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    return (
      err.status === 429 ||
      err.code === 'RATE_LIMIT_EXCEEDED' ||
      /\b429\b/.test(msg) ||
      msg.includes('rate limit') ||
      msg.includes('quota') ||
      msg.includes('resource_exhausted') ||
      msg.includes('too many requests')
    );
  }

  /**
   * Determine if a provider is considered a local runtime
   */
  static isLocalProvider(providerName?: string) {
    const p = (providerName || '').toLowerCase();
    return ['local', 'lmstudio', 'vllm', 'om', 'omega', 'mock'].includes(p);
  }

  /**
   * Determine if an error indicates context window / token limit exhaustion
   */
  static isContextLimitError(err: any) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    return (
      msg.includes('context_length_exceeded') ||
      msg.includes('context length') ||
      msg.includes('context window') ||
      msg.includes('maximum context') ||
      msg.includes('token limit') ||
      msg.includes('too many tokens') ||
      msg.includes('prompt is too long') ||
      msg.includes('max_tokens') ||
      err.code === 'CONTEXT_LIMIT_EXCEEDED' ||
      err.status === 413
    );
  }

  /**
   * Estimate total character/token count across messages and systemPrompt using model-aware tokenization
   */
  static estimateContextUsage(messages = [], systemPrompt = '', model = '') {
    return estimateMessagesTokens(messages, systemPrompt, model);
  }

  /**
   * Check whether a candidate fallback provider is usable (has credentials or is a custom/mock instance)
   */
  canUseCandidate(candidate: Record<string, any>) {
    if (candidate.providerInstance) return true;
    const pName = (candidate.provider || '').toLowerCase();
    if (pName === 'om' || pName === 'omega' || pName === 'mock') return true;
    if (pName === 'gemini' || pName === 'google') {
      return Boolean(
        candidate.apiKey ||
        this.config.providers?.gemini?.apiKey ||
        process.env.GEMINI_API_KEY
      );
    }
    if (pName === 'openai' || pName === 'gpt') {
      return Boolean(
        candidate.apiKey ||
        this.config.providers?.openai?.apiKey ||
        process.env.OPENAI_API_KEY
      );
    }
    if (pName === 'anthropic' || pName === 'claude') {
      return Boolean(
        candidate.apiKey ||
        this.config.providers?.anthropic?.apiKey ||
        process.env.ANTHROPIC_API_KEY
      );
    }
    const compatKeyMap: Record<string, { canonical: string; envs: string[] }> = {
      deepseek: { canonical: 'deepseek', envs: ['DEEPSEEK_API_KEY'] },
      kimi: { canonical: 'kimi', envs: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
      moonshot: { canonical: 'kimi', envs: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
      qwen: { canonical: 'qwen', envs: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'] },
      dashscope: { canonical: 'qwen', envs: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'] },
      glm: { canonical: 'glm', envs: ['GLM_API_KEY', 'ZHIPU_API_KEY'] },
      zhipu: { canonical: 'glm', envs: ['GLM_API_KEY', 'ZHIPU_API_KEY'] }
    };
    if (compatKeyMap[pName]) {
      const { canonical, envs } = compatKeyMap[pName];
      return Boolean(
        candidate.apiKey ||
        this.config.providers?.[canonical]?.apiKey ||
        envs.some((envKey) => Boolean(process.env[envKey]))
      );
    }
    if (['lmstudio', 'vllm'].includes(pName)) {
      return Boolean(candidate.allowLocalFallback);
    }
    return false;
  }

  /**
   * Build the ordered list of fallback candidates for a given primary provider
   */
  getFallbackCandidates(primaryProviderName: string, primaryModel: string, opts: { advanceCursor?: boolean } = {}) {
    const primaryIsLocal = ModelRouter.isLocalProvider(primaryProviderName);
    const chain = this.routingConfig.fallbackChain || [];
    const usable = [];
    const seen = new Set<string>();

    for (const item of chain) {
      const cand = typeof item === 'string' ? { provider: item } : { ...item };
      const candProv = (cand.provider || '').toLowerCase();
      const candModel = cand.model || this.getDefaultModelForProvider(candProv);

      // Enforce strict target isolation: cloud -> cloud only, local -> local only
      if (ModelRouter.isLocalProvider(candProv) !== primaryIsLocal) {
        continue;
      }

      // Skip if identical to primary or currently in rate-limit cooldown
      if (candProv === (primaryProviderName || '').toLowerCase() && candModel === primaryModel && !cand.providerInstance) {
        continue;
      }
      if (!cand.providerInstance && this.isInCooldown(candProv, candModel)) {
        continue;
      }

      const dedupKey = this._cooldownKey(candProv, candModel);
      if (!cand.providerInstance && seen.has(dedupKey)) {
        continue;
      }

      if (this.canUseCandidate(cand)) {
        seen.add(dedupKey);
        usable.push({
          provider: candProv,
          model: candModel,
          providerInstance: cand.providerInstance || null,
          reason: cand.reason || null
        });
      }
    }

    const strategy = String(this.routingConfig.strategy || 'priority').toLowerCase();
    if (strategy === 'latency' && usable.length > 1) {
      const scoreOf = (c: { provider: string; model: string }) => {
        const m = this.providerMetrics.get(this._cooldownKey(c.provider, c.model));
        if (!m || (m.ewmaTtftMs === null && m.ewmaLatencyMs === null)) return Number.POSITIVE_INFINITY;
        const base = m.ewmaTtftMs ?? m.ewmaLatencyMs ?? Number.POSITIVE_INFINITY;
        const errRate = m.calls > 0 ? m.failures / m.calls : 0;
        // Penalize error-prone candidates while keeping latency primary
        return base * (1 + errRate * 2);
      };
      // Stable sort: measured candidates sorted by lowest effective latency, unmeasured keep configured order
      usable.sort((a, b) => {
        const sa = scoreOf(a);
        const sb = scoreOf(b);
        if (sa === sb) return 0;
        return sa - sb;
      });
    } else if (strategy === 'round_robin' && usable.length > 1 && opts.advanceCursor !== false) {
      const offset = this._rrCursor % usable.length;
      this._rrCursor = (this._rrCursor + 1) % 1_000_000;
      if (offset > 0) {
        return [...usable.slice(offset), ...usable.slice(0, offset)];
      }
    }

    return usable;
  }

  /**
   * Select the best starting target from [primary, ...healthyFallbacks] when load balancing or RPM spillover is enabled.
   */
  _selectBalancedTarget(primaryProvider: any, primaryName: string, primaryModel: string) {
    // Never silently load-balance a user-selected local model onto another model or the built-in OM simulator
    if (ModelRouter.isLocalProvider(primaryName)) return null;

    const strategy = String(this.routingConfig.strategy || 'priority').toLowerCase();
    const rpmGuardEnabled = Boolean(this.routingConfig.rpmGuard?.enabled);
    const shouldBalance =
      strategy === 'round_robin' ||
      rpmGuardEnabled ||
      (strategy === 'latency' && this.routingConfig.balancePrimary === true);
    if (!shouldBalance || !this.routingConfig.enabled) return null;

    const fallbacks = this.getFallbackCandidates(primaryName, primaryModel, { advanceCursor: false });
    if (fallbacks.length === 0) return null;

    const pool: Array<{ provider: string; model: string; providerInstance: any; isPrimary: boolean }> = [];
    if (!this.isInCooldown(primaryName, primaryModel)) {
      pool.push({ provider: primaryName, model: primaryModel, providerInstance: primaryProvider, isPrimary: true });
    }
    for (const fb of fallbacks) {
      pool.push({ ...fb, isPrimary: false });
    }
    if (pool.length <= 1) return null;

    // 1. Proactive RPM / concurrency spillover: if primary is at soft capacity, spill onto an under-capacity target
    if (rpmGuardEnabled && this._isAtSoftCap(primaryName, primaryModel)) {
      const underCap = pool.filter((t) => !this._isAtSoftCap(t.provider, t.model));
      const candidates = underCap.length > 0 ? underCap : pool;
      // Pick the least-loaded candidate (lowest inFlight, then lowest rpm60s, then lowest EWMA latency)
      candidates.sort((a, b) => {
        const infDiff = this._getInFlight(a.provider, a.model) - this._getInFlight(b.provider, b.model);
        if (infDiff !== 0) return infDiff;
        const rpmDiff = this._getRecentRpm(a.provider, a.model) - this._getRecentRpm(b.provider, b.model);
        if (rpmDiff !== 0) return rpmDiff;
        const ma = this.providerMetrics.get(this._cooldownKey(a.provider, a.model));
        const mb = this.providerMetrics.get(this._cooldownKey(b.provider, b.model));
        const la = ma ? (ma.ewmaTtftMs ?? ma.ewmaLatencyMs ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        const lb = mb ? (mb.ewmaTtftMs ?? mb.ewmaLatencyMs ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        return la - lb;
      });
      const chosen = candidates[0];
      if (!chosen.isPrimary) {
        this.stats.rpmSpillovers++;
        return { ...chosen, reason: 'rpm_spillover' };
      }
    }

    if (strategy === 'round_robin') {
      const underCap = rpmGuardEnabled ? pool.filter((t) => !this._isAtSoftCap(t.provider, t.model)) : pool;
      const activePool = underCap.length > 0 ? underCap : pool;
      const idx = this._rrCursor % activePool.length;
      this._rrCursor = (this._rrCursor + 1) % 1_000_000;
      return activePool[idx];
    }

    if (strategy === 'latency' && this.routingConfig.balancePrimary === true) {
      // Only switch away from primary if we have latency data for both primary and at least one fallback
      const primaryMetric = this.providerMetrics.get(this._cooldownKey(primaryName, primaryModel));
      const primaryScore = primaryMetric ? (primaryMetric.ewmaTtftMs ?? primaryMetric.ewmaLatencyMs) : null;
      if (primaryScore === null) return null;

      let best = pool[0];
      let bestScore = primaryScore;
      for (let i = 1; i < pool.length; i++) {
        if (rpmGuardEnabled && this._isAtSoftCap(pool[i].provider, pool[i].model)) continue;
        const m = this.providerMetrics.get(this._cooldownKey(pool[i].provider, pool[i].model));
        const s = m ? (m.ewmaTtftMs ?? m.ewmaLatencyMs) : null;
        if (s !== null && s < bestScore * 0.85) {
          // Require 15% faster EWMA to prevent flapping
          best = pool[i];
          bestScore = s;
        }
      }
      return best.isPrimary ? null : best;
    }

    return null;
  }

  /**
   * Speculative hedged request: if primary doesn't emit a first token or resolve within `delayMs`,
   * launch the top healthy fallback in parallel and cancel the loser as soon as a winner emerges.
   */
  async _executeHedgedChat(
    primaryProvider: any,
    primaryName: string,
    primaryModel: string,
    hedgeCandidate: Record<string, any>,
    chatParams: Record<string, any>,
    delayMs: number,
    options: Record<string, any> = {}
  ): Promise<Record<string, any>> {
    const externalSignal: AbortSignal | undefined = chatParams.signal;
    const origOnToken = typeof chatParams.onToken === 'function' ? chatParams.onToken : undefined;

    const makeLinkedController = () => {
      const ctrl = new AbortController();
      const onExt = () => ctrl.abort(externalSignal?.reason);
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
        else externalSignal.addEventListener('abort', onExt, { once: true });
      }
      return {
        controller: ctrl,
        cleanup: () => {
          if (externalSignal) externalSignal.removeEventListener('abort', onExt);
        }
      };
    };

    const primaryLink = makeLinkedController();
    let hedgeController: AbortController | null = null;
    const cleanups: Array<() => void> = [primaryLink.cleanup];
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
    let winner: 'primary' | 'hedge' | null = null;
    let primaryFirstTokenAt: number | null = null;
    let hedgeFirstTokenAt: number | null = null;
    const primaryStart = Date.now();
    let hedgeStart = 0;

    const primaryBuf: string[] = [];
    const hedgeBuf: string[] = [];

    const claimWinner = (who: 'primary' | 'hedge') => {
      if (winner) return winner === who;
      winner = who;
      if (hedgeTimer) {
        clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
      if (who === 'primary') {
        hedgeController?.abort(new Error('Hedge cancelled: primary won'));
        if (origOnToken) {
          for (const tok of primaryBuf) origOnToken(tok);
          primaryBuf.length = 0;
        }
      } else {
        primaryLink.controller.abort(new Error('Primary cancelled: hedge won'));
        if (origOnToken) {
          for (const tok of hedgeBuf) origOnToken(tok);
          hedgeBuf.length = 0;
        }
      }
      return true;
    };

    const runPrimary = async () => {
      const params = {
        ...chatParams,
        signal: primaryLink.controller.signal,
        ...(origOnToken
          ? {
            onToken: (tok: string) => {
              if (primaryFirstTokenAt === null) primaryFirstTokenAt = Date.now() - primaryStart;
              if (winner === 'primary') {
                origOnToken(tok);
              } else if (!winner) {
                primaryBuf.push(tok);
                claimWinner('primary');
              }
            }
          }
          : {})
      };
      this._beginRequestLoad(primaryName, primaryModel);
      try {
        const res = await primaryProvider.chat(params);
        const latencyMs = Date.now() - primaryStart;
        this._recordTelemetry(primaryName, primaryModel, latencyMs, primaryFirstTokenAt);
        this.recordSuccess(primaryName, primaryModel);
        claimWinner('primary');
        return { who: 'primary' as const, response: res, latencyMs, ttftMs: primaryFirstTokenAt };
      } finally {
        this._endRequestLoad(primaryName, primaryModel);
      }
    };

    const runHedge = async () => {
      const hLink = makeLinkedController();
      hedgeController = hLink.controller;
      cleanups.push(hLink.cleanup);
      hedgeStart = Date.now();
      const targetProvider = this._getOrCreateProvider(hedgeCandidate);
      const hedgeModel = targetProvider.model || hedgeCandidate.model;
      let adaptedTools = chatParams.tools;
      if (options.getToolsForProvider && typeof options.getToolsForProvider === 'function') {
        adaptedTools = options.getToolsForProvider(hedgeCandidate.provider);
      }
      const params = {
        ...chatParams,
        tools: adaptedTools,
        signal: hLink.controller.signal,
        ...(origOnToken
          ? {
            onToken: (tok: string) => {
              if (hedgeFirstTokenAt === null) hedgeFirstTokenAt = Date.now() - hedgeStart;
              if (winner === 'hedge') {
                origOnToken(tok);
              } else if (!winner) {
                hedgeBuf.push(tok);
                claimWinner('hedge');
              }
            }
          }
          : {})
      };
      this._beginRequestLoad(hedgeCandidate.provider, hedgeModel);
      try {
        const res = await targetProvider.chat(params);
        const latencyMs = Date.now() - hedgeStart;
        this._recordTelemetry(hedgeCandidate.provider, hedgeModel, latencyMs, hedgeFirstTokenAt);
        this.recordSuccess(hedgeCandidate.provider, hedgeModel);
        claimWinner('hedge');
        return { who: 'hedge' as const, response: res, latencyMs, ttftMs: hedgeFirstTokenAt, modelName: hedgeModel };
      } finally {
        this._endRequestLoad(hedgeCandidate.provider, hedgeModel);
      }
    };

    try {
      const result = await new Promise<any>((resolve, reject) => {
        let settled = false;
        let primaryErr: any = null;
        let hedgeStarted = false;
        let hedgeErr: any = null;
        let pendingCount = 1;

        const finishReject = () => {
          if (settled) return;
          settled = true;
          reject(primaryErr || hedgeErr || new Error('Hedged request failed'));
        };

        const launchHedge = () => {
          if (settled || winner || hedgeStarted || externalSignal?.aborted) return;
          hedgeStarted = true;
          pendingCount++;
          runHedge().then(
            (r) => {
              if (!settled && winner === 'hedge') {
                settled = true;
                resolve(r);
              }
            },
            (err) => {
              hedgeErr = err;
              pendingCount--;
              if (pendingCount === 0) finishReject();
            }
          );
        };

        hedgeTimer = setTimeout(launchHedge, Math.max(50, delayMs));

        runPrimary().then(
          (r) => {
            if (!settled && winner === 'primary') {
              settled = true;
              resolve(r);
            }
          },
          (err) => {
            primaryErr = err;
            pendingCount--;
            if (externalSignal?.aborted || err?.name === 'AbortError') {
              if (!winner) finishReject();
              return;
            }
            if (!hedgeStarted && !winner) {
              // Primary failed before hedge timer fired: cancel timer and let standard retry/failover loop handle it
              if (hedgeTimer) {
                clearTimeout(hedgeTimer);
                hedgeTimer = null;
              }
              finishReject();
            } else if (pendingCount === 0) {
              finishReject();
            }
          }
        );
      });

      const tok = Number(result.response.usage?.total_tokens ?? result.response.usage?.totalTokenCount ?? 0) || 0;
      this.stats.totalTokens += tok;

      if (result.who === 'hedge') {
        this.stats.hedgesWon++;
        this.stats.fallbacks++;
        this.stats.estimatedCostUsd += ModelRouter.estimateCost(hedgeCandidate.provider, result.modelName, result.response.usage);
        const hedgeEvent = {
          fromProvider: primaryName,
          fromModel: primaryModel,
          toProvider: hedgeCandidate.provider,
          toModel: result.modelName,
          reasonType: 'hedged_failover',
          reason: `Hedged fallback won (delay ${delayMs}ms)`,
          hedgeDelayMs: delayMs,
          ttftMs: result.ttftMs,
          latencyMs: result.latencyMs,
          timestamp: new Date().toISOString()
        };
        this.onEvent('hedge_won', hedgeEvent);
        return {
          ...result.response,
          routedProvider: hedgeCandidate.provider,
          routedModel: result.modelName,
          fallbackUsed: true,
          fallbackInfo: hedgeEvent,
          hedged: true,
          ttftMs: result.ttftMs,
          latencyMs: result.latencyMs
        };
      }

      this.stats.estimatedCostUsd += ModelRouter.estimateCost(primaryName, primaryModel, result.response.usage);
      return {
        ...result.response,
        routedProvider: primaryProvider.name || primaryName,
        routedModel: primaryProvider.model || primaryModel,
        fallbackUsed: false,
        hedged: false,
        ttftMs: result.ttftMs,
        latencyMs: result.latencyMs
      };
    } finally {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      for (const fn of cleanups) fn();
    }
  }

  getDefaultModelForProvider(providerName: string) {
    const p = (providerName || 'om').toLowerCase();
    const defaults: Record<string, string> = {
      gemini: this.config.providers?.gemini?.model || 'gemini-3.5-flash',
      openai: this.config.providers?.openai?.model || 'gpt-5-mini-2025-08-07',
      anthropic: this.config.providers?.anthropic?.model || 'claude-fable-5-2',
      deepseek: this.config.providers?.deepseek?.model || 'deepseek-chat',
      kimi: this.config.providers?.kimi?.model || 'kimi-k2-0711-preview',
      moonshot: this.config.providers?.kimi?.model || 'kimi-k2-0711-preview',
      qwen: this.config.providers?.qwen?.model || 'qwen-plus',
      dashscope: this.config.providers?.qwen?.model || 'qwen-plus',
      glm: this.config.providers?.glm?.model || 'glm-4.5-flash',
      zhipu: this.config.providers?.glm?.model || 'glm-4.5-flash',
      local: this.config.providers?.local?.model || 'auto',
      lmstudio: this.config.providers?.lmstudio?.model || 'local-model',
      vllm: this.config.providers?.vllm?.model || 'default',
      om: this.config.providers?.om?.model || this.config.providers?.mock?.model || 'om-reasoning',
      mock: this.config.providers?.om?.model || this.config.providers?.mock?.model || 'om-reasoning'
    };
    return defaults[p] || 'om-reasoning';
  }

  /**
   * Execute chat with intelligent routing, retry, context-overflow detection, and fallback
   */
  async chat(primaryProvider: any, chatParams: Record<string, any>, options: Record<string, any> = {}): Promise<Record<string, any>> {
    this.stats.totalCalls++;
    const primaryName = primaryProvider.name || this.config.provider || 'om';
    const primaryModel = primaryProvider.model || this.config.model || 'default';
    const isLocal = ModelRouter.isLocalProvider(primaryName);

    if (chatParams.signal?.aborted) {
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    // 0. Budget guardrails (token & cost ceiling)
    const budget = options.budget || this.routingConfig.budget;
    if (budget) {
      const overTokens = budget.maxSessionTokens > 0 && this.stats.totalTokens >= budget.maxSessionTokens;
      const overCost = budget.maxSessionCostUsd > 0 && this.stats.estimatedCostUsd >= budget.maxSessionCostUsd;
      if (overTokens || overCost) {
        if (budget.fallbackToLocal && !isLocal) {
          const localTarget = budget.localTarget || { provider: 'om', model: 'om-turbo' };
          const localProv = this.providerFactory({ ...this.config, ...localTarget });
          this.onEvent('route_decision', {
            reason: 'budget_exceeded_local_fallback',
            fromProvider: primaryName,
            toProvider: localTarget.provider,
            toModel: localTarget.model
          });
          const res = await localProv.chat(chatParams);
          return { ...res, routedProvider: localTarget.provider, routedModel: localTarget.model, fallbackUsed: true };
        }
        const budgetErr: Error & { code?: string } = new Error(
          overCost
            ? `Session cost budget exceeded ($${this.stats.estimatedCostUsd.toFixed(4)} >= $${budget.maxSessionCostUsd})`
            : `Session token budget exceeded (${this.stats.totalTokens} >= ${budget.maxSessionTokens})`
        );
        budgetErr.code = 'BUDGET_EXCEEDED';
        throw budgetErr;
      }
    }

    // 0b. Complexity-aware hybrid routing (optional; supports custom classifier callback)
    const complexityCfg = options.complexityRouting || this.routingConfig.complexityRouting;
    if (complexityCfg?.enabled) {
      const complexity = typeof complexityCfg.classifier === 'function'
        ? await complexityCfg.classifier(chatParams)
        : (await this.systemOne?.classifyComplexity?.(chatParams)) || ModelRouter.classifyComplexity(chatParams);
      if (complexity === 'simple' && !isLocal && complexityCfg.simpleToLocal) {
        const target = complexityCfg.localTarget || { provider: 'om', model: 'om-turbo' };
        const localProv = this.providerFactory({ ...this.config, ...target });
        this.stats.complexityRoutes++;
        this.onEvent('route_decision', { complexity, fromProvider: primaryName, toProvider: target.provider, toModel: target.model });
        const res = await localProv.chat(chatParams);
        return { ...res, routedProvider: target.provider, routedModel: target.model, fallbackUsed: false, complexityRouted: true };
      }
      if (complexity === 'complex' && isLocal && complexityCfg.complexToCloud && complexityCfg.cloudTarget && this.canUseCandidate(complexityCfg.cloudTarget)) {
        const target = complexityCfg.cloudTarget;
        const cloudProv = this.providerFactory({ ...this.config, ...target });
        let adaptedTools = chatParams.tools;
        if (options.getToolsForProvider) adaptedTools = options.getToolsForProvider(target.provider);
        this.stats.complexityRoutes++;
        this.onEvent('route_decision', { complexity, fromProvider: primaryName, toProvider: target.provider, toModel: target.model });
        const res = await cloudProv.chat({ ...chatParams, tools: adaptedTools });
        const tok = Number(res.usage?.total_tokens ?? res.usage?.totalTokenCount ?? 0) || 0;
        this.stats.totalTokens += tok;
        this.stats.estimatedCostUsd += ModelRouter.estimateCost(target.provider, target.model, res.usage);
        return { ...res, routedProvider: target.provider, routedModel: target.model, fallbackUsed: false, complexityRouted: true };
      }
    }

    // 0c. Hardware-aware VRAM / RAM / Thermal routing for local inference
    const hwCfg = options.hardwareRouting || this.routingConfig.hardwareRouting;
    if (hwCfg?.enabled && isLocal) {
      const ttlMs = Number(hwCfg.cacheTtlMs ?? 5000);
      const specs = await this._getHardwareSnapshot(options, ttlMs);
      const gpus = Array.isArray(specs?.gpus) ? specs.gpus : [];
      const freeVramList = gpus
        .map((g) => (typeof g.vramFreeMb === 'number' ? g.vramFreeMb : g.vramTotalMb > 0 && typeof g.vramUsedMb === 'number' ? Math.max(0, g.vramTotalMb - g.vramUsedMb) : null))
        .filter((v): v is number => typeof v === 'number');
      const freeVramMb = freeVramList.length > 0 ? Math.max(...freeVramList) : null;
      const freeRamMb = Math.round(Number(specs?.ram?.freeGb ?? 0) * 1024);
      const maxTempC = gpus.length > 0 ? Math.max(...gpus.map((g) => Number(g.temperatureC ?? 0))) : 0;

      const minFreeVramMb = Number(hwCfg.minFreeVramMb ?? 1536);
      const minFreeRamMb = Number(hwCfg.minFreeRamMb ?? 1024);
      const maxTempLimit = Number(hwCfg.maxTempC ?? 88);

      let hardwareReason: string | null = null;
      if (minFreeVramMb > 0 && freeVramMb !== null && freeVramMb < minFreeVramMb) {
        hardwareReason = `hardware_vram_pressure (${freeVramMb}MB < ${minFreeVramMb}MB)`;
      } else if (minFreeRamMb > 0 && freeRamMb > 0 && freeRamMb < minFreeRamMb) {
        hardwareReason = `hardware_ram_pressure (${freeRamMb}MB < ${minFreeRamMb}MB)`;
      } else if (maxTempLimit > 0 && maxTempC >= maxTempLimit) {
        hardwareReason = `hardware_thermal_pressure (${maxTempC}C >= ${maxTempLimit}C)`;
      }

      if (hardwareReason) {
        const cloudTarget =
          hwCfg.cloudTarget && this.canUseCandidate(hwCfg.cloudTarget)
            ? hwCfg.cloudTarget
            : hwCfg.autoCloudFallback !== false
              ? this._findUsableCloudFallback()
              : null;
        const target = cloudTarget || hwCfg.localFallbackTarget || null;

        if (target) {
          const targetProv = target.providerInstance || this.providerFactory({ ...this.config, ...target });
          let adaptedTools = chatParams.tools;
          if (options.getToolsForProvider && target.provider) {
            adaptedTools = options.getToolsForProvider(target.provider);
          }
          this.stats.hardwareRoutes++;
          this.onEvent('route_decision', {
            reason: hardwareReason,
            fromProvider: primaryName,
            fromModel: primaryModel,
            toProvider: target.provider,
            toModel: target.model,
            freeVramMb,
            freeRamMb,
            maxTempC
          });
          const res = await targetProv.chat({ ...chatParams, tools: adaptedTools });
          const tok = Number(res.usage?.total_tokens ?? res.usage?.totalTokenCount ?? 0) || 0;
          this.stats.totalTokens += tok;
          if (!ModelRouter.isLocalProvider(target.provider)) {
            this.stats.estimatedCostUsd += ModelRouter.estimateCost(target.provider, target.model, res.usage);
          }
          return {
            ...res,
            routedProvider: target.provider,
            routedModel: target.model,
            fallbackUsed: true,
            hardwareRouted: true,
            hardwareReason
          };
        }
      }
    }

    // 1. Proactive Context Limit Handoff: only tokenize when local auto-handoff is active
    if (
      this.routingConfig.enabled &&
      this.routingConfig.autoHandoffOnContextLimit &&
      isLocal
    ) {
      const contextLimitTokens =
        options.contextLimitTokens ||
        this.routingConfig.contextLimitTokens ||
        (this.routingConfig.autoDetectContextLimit ? getModelContextLimit(primaryName, primaryModel) : 0);
      if (contextLimitTokens > 0) {
        const usage = ModelRouter.estimateContextUsage(chatParams.messages, chatParams.systemPrompt, primaryModel);
        if (usage.estimatedTokens > contextLimitTokens) {
          const contextErr: Error & { code?: string } = new Error(
            `Local model '${primaryModel}' (${primaryName}) context limit exceeded (${usage.estimatedTokens} estimated tokens > ${contextLimitTokens} limit)`
          );
          contextErr.code = 'CONTEXT_LIMIT_EXCEEDED';
          return this._executeFailover(primaryProvider, chatParams, contextErr, 'context_limit_exceeded', options);
        }
      }
    }

    // 1b. Rate-Limit Cooldown Circuit Breaker: skip primary if it recently hit 429
    if (
      this.routingConfig.enabled &&
      !options.disableFailover &&
      this.isInCooldown(primaryName, primaryModel)
    ) {
      const cooldownErr: Error & { status?: number } = new Error(
        `Model '${primaryModel}' (${primaryName}) is in rate-limit cooldown; routing directly to fallback.`
      );
      cooldownErr.status = 429;
      return this._executeFailover(primaryProvider, chatParams, cooldownErr, 'rate_limit_cooldown', options);
    }

    // 1c. Adaptive effort tuning for simple turns (cuts thinking-token TTFT)
    let effectiveChatParams = chatParams;
    if (this.routingConfig.adaptiveEffort && (!chatParams.effort || chatParams.effort === 'medium')) {
      const turnComplexity = ModelRouter.classifyComplexity(chatParams);
      if (turnComplexity === 'simple') {
        effectiveChatParams = { ...chatParams, effort: 'low' };
      }
    }

    // 1d. Optional load-balanced primary selection (round_robin or latency-based)
    let activePrimary = primaryProvider;
    let activePrimaryName = primaryName;
    let activePrimaryModel = primaryModel;
    if (!options.disableFailover) {
      const balanced = this._selectBalancedTarget(primaryProvider, primaryName, primaryModel);
      if (balanced) {
        activePrimary = this._getOrCreateProvider(balanced);
        activePrimaryName = balanced.provider;
        activePrimaryModel = activePrimary.model || balanced.model;
        if (options.getToolsForProvider && typeof options.getToolsForProvider === 'function') {
          effectiveChatParams = { ...effectiveChatParams, tools: options.getToolsForProvider(activePrimaryName) };
        }
        this.onEvent('route_decision', {
          reason: (balanced as any).reason || `load_balance_${this.routingConfig.strategy}`,
          fromProvider: primaryName,
          fromModel: primaryModel,
          toProvider: activePrimaryName,
          toModel: activePrimaryModel
        });
      }
    }

    // 1e. Optional speculative hedging for cloud tail-latency / TTFT protection
    // (Disabled for local providers unless hedging.allowLocal is true to avoid GPU/CPU contention)
    let initialHedgeError: any = null;
    const hedgeCfg = options.hedging || this.routingConfig.hedging;
    const activeIsLocal = ModelRouter.isLocalProvider(activePrimaryName);
    if (hedgeCfg?.enabled && this.routingConfig.enabled && !options.disableFailover && (!activeIsLocal || hedgeCfg.allowLocal)) {
      const hedgeCandidates = this.getFallbackCandidates(activePrimaryName, activePrimaryModel, { advanceCursor: false });
      if (hedgeCandidates.length > 0) {
        try {
          return await this._executeHedgedChat(
            activePrimary,
            activePrimaryName,
            activePrimaryModel,
            hedgeCandidates[0],
            effectiveChatParams,
            Number(hedgeCfg.delayMs ?? 3500),
            options
          );
        } catch (hedgeErr: any) {
          if (hedgeErr?.name === 'AbortError' || effectiveChatParams.signal?.aborted) {
            throw hedgeErr;
          }
          // Immediate non-retryable errors skip retry loop and fail over directly
          if (ModelRouter.isContextLimitError(hedgeErr)) {
            return this._executeFailover(activePrimary, effectiveChatParams, hedgeErr, 'context_limit', options);
          }
          if (ModelRouter.isRateLimitError(hedgeErr)) {
            this.markCooldown(activePrimaryName, activePrimaryModel, hedgeErr.retryAfterMs);
            return this._executeFailover(activePrimary, effectiveChatParams, hedgeErr, 'rate_limit', options);
          }
          if (hedgeErr.status === 408 || hedgeErr.status === 529 || /overloaded_error/i.test(String(hedgeErr.message || ''))) {
            this.markCooldown(activePrimaryName, activePrimaryModel, hedgeErr.retryAfterMs || this.routingConfig.overloadCooldownMs || 8000);
            return this._executeFailover(activePrimary, effectiveChatParams, hedgeErr, 'provider_overload', options);
          }
          if (this._isNonTransientHttpError(hedgeErr)) {
            if (hedgeErr.status === 401 || hedgeErr.status === 403 || hedgeErr.status === 404) {
              this.markCooldown(activePrimaryName, activePrimaryModel);
            }
            return this._executeFailover(activePrimary, effectiveChatParams, hedgeErr, 'provider_error', options);
          }
          // Transient error already consumed attempt 0 — resume at retry attempt 1 so we don't double-attempt primary
          initialHedgeError = hedgeErr;
        }
      }
    }

    // 2. Attempt primary provider with automatic retries for transient errors
    const maxRetries = options.maxRetries ?? this.routingConfig.maxRetries ?? 1;
    let lastError = initialHedgeError;
    const startAttempt = initialHedgeError ? 1 : 0;

    for (let attempt = startAttempt; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.stats.retries++;
          const retryEvent = {
            attempt,
            maxRetries,
            provider: activePrimaryName,
            model: activePrimaryModel,
            reason: lastError?.message || 'Transient error',
            timestamp: new Date().toISOString()
          };
          this.onEvent('retry', retryEvent);
          const baseDelay = this.routingConfig.retryDelayMs ?? 100;
          if (baseDelay > 0) {
            const expDelay = baseDelay * Math.pow(2, attempt - 1);
            const jitter = Math.floor(Math.random() * Math.max(10, Math.round(expDelay * 0.35)));
            await this._sleepWithSignal(expDelay + jitter, effectiveChatParams.signal);
          }
        }

        const { response, ttftMs, latencyMs } = await this._invokeWithTelemetry(
          activePrimary,
          activePrimaryName,
          activePrimaryModel,
          effectiveChatParams
        );
        this.recordSuccess(activePrimaryName, activePrimaryModel);
        const tok = Number(response.usage?.total_tokens ?? response.usage?.totalTokenCount ?? 0) || 0;
        this.stats.totalTokens += tok;
        this.stats.estimatedCostUsd += ModelRouter.estimateCost(activePrimaryName, activePrimaryModel, response.usage);
        return {
          ...response,
          routedProvider: activePrimary.name || activePrimaryName,
          routedModel: activePrimary.model || activePrimaryModel,
          fallbackUsed: false,
          attempts: attempt + 1,
          ttftMs,
          latencyMs
        };
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError' || effectiveChatParams.signal?.aborted) {
          throw err;
        }
        if (err._emittedTokens > 0) {
          this.onEvent('stream_reset', {
            provider: activePrimaryName,
            model: activePrimaryModel,
            emittedTokens: err._emittedTokens,
            reason: err.message
          });
        }
        // Never waste retries on context limit, 429 rate-limit, 529 overloaded, or non-transient 400/401/403/404 errors — fail over immediately
        if (ModelRouter.isContextLimitError(err)) {
          break;
        }
        if (ModelRouter.isRateLimitError(err)) {
          this.markCooldown(activePrimaryName, activePrimaryModel, err.retryAfterMs);
          break;
        }
        if (err.status === 529 || /overloaded_error/i.test(String(err.message || ''))) {
          this.markCooldown(activePrimaryName, activePrimaryModel, err.retryAfterMs || this.routingConfig.overloadCooldownMs || 8000);
          break;
        }
        if (this._isNonTransientHttpError(err)) {
          if (err.status === 401 || err.status === 403 || err.status === 404) {
            this.markCooldown(activePrimaryName, activePrimaryModel);
          }
          break;
        }
        // fetchWithTimeout / consumeSSEStream timeout — cool down and fail over immediately
        if (err.status === 408) {
          this.markCooldown(activePrimaryName, activePrimaryModel);
          break;
        }
      }
    }

    if (lastError && ModelRouter.isOverloadError(lastError)) {
      this.markCooldown(activePrimaryName, activePrimaryModel, lastError.retryAfterMs || this.routingConfig.overloadCooldownMs || 8000);
    } else if (lastError && !ModelRouter.isContextLimitError(lastError) && !ModelRouter.isRateLimitError(lastError)) {
      this.recordFailure(activePrimaryName, activePrimaryModel);
    }

    // 3. If routing/failover is disabled, rethrow primary error
    if (this.routingConfig.enabled === false || options.disableFailover) {
      throw lastError;
    }

    // 4. Execute seamless failover to fallback chain
    const isQuotaZero = /quota limit:\s*0|limit:\s*0/i.test(String(lastError?.message || ''));
    const reasonType = ModelRouter.isContextLimitError(lastError)
      ? 'context_limit'
      : isQuotaZero
        ? 'quota_unavailable'
        : ModelRouter.isRateLimitError(lastError)
          ? 'rate_limit'
          : ModelRouter.isOverloadError(lastError)
            ? 'provider_overload'
            : 'provider_error';
    return this._executeFailover(activePrimary, effectiveChatParams, lastError, reasonType, options);
  }

  async _sleepWithSignal(ms: number, signal?: AbortSignal) {
    if (ms <= 0) return;
    if (signal?.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async _waitAndResumeRateLimit(primaryProvider: any, chatParams: Record<string, any>, primaryError: any, options: Record<string, any> = {}) {
    const primaryName = primaryProvider.name || this.config.provider || 'om';
    const primaryModel = primaryProvider.model || this.config.model || 'default';
    const maxWaitMs = Number(options.maxRateLimitWaitMs ?? this.routingConfig.maxRateLimitWaitMs ?? 65000);
    if (options.waitOnRateLimit === false || maxWaitMs <= 0) {
      throw primaryError;
    }

    const key = this._cooldownKey(primaryName, primaryModel);
    const until = this.cooldowns.get(key);
    const rawWait = until ? Math.max(0, until - Date.now()) : Number(primaryError?.retryAfterMs || this.routingConfig.rateLimitCooldownMs || 15000);
    const waitMs = Math.min(Math.max(rawWait, 250), maxWaitMs);

    this.stats.retries++;
    this.onEvent('retry', {
      attempt: 1,
      maxRetries: 1,
      provider: primaryName,
      model: primaryModel,
      reason: `Rate limit reached — waiting ${Math.ceil(waitMs / 1000)}s to resume`,
      waitMs,
      timestamp: new Date().toISOString()
    });

    await this._sleepWithSignal(waitMs, chatParams.signal);
    this.cooldowns.delete(key);

    const { response, ttftMs, latencyMs } = await this._invokeWithTelemetry(
      primaryProvider,
      primaryName,
      primaryModel,
      chatParams
    );
    this.recordSuccess(primaryName, primaryModel);
    const tok = Number(response.usage?.total_tokens ?? response.usage?.totalTokenCount ?? 0) || 0;
    this.stats.totalTokens += tok;
    this.stats.estimatedCostUsd += ModelRouter.estimateCost(primaryName, primaryModel, response.usage);
    return {
      ...response,
      routedProvider: primaryProvider.name || primaryName,
      routedModel: primaryProvider.model || primaryModel,
      fallbackUsed: false,
      rateLimitWaitedMs: waitMs,
      ttftMs,
      latencyMs
    };
  }

  async _executeFailover(primaryProvider: any, chatParams: Record<string, any>, primaryError: any, reasonType: string, options: Record<string, any> = {}) {
    const primaryName = primaryProvider.name || this.config.provider || 'om';
    const primaryModel = primaryProvider.model || this.config.model || 'default';
    const candidates = this.getFallbackCandidates(primaryName, primaryModel);

    if (candidates.length === 0) {
      if (reasonType.includes('rate_limit')) {
        return this._waitAndResumeRateLimit(primaryProvider, chatParams, primaryError, options);
      }
      throw primaryError;
    }

    const errors = [`${primaryName}/${primaryModel}: ${primaryError.message}`];

    for (const candidate of candidates) {
      try {
        const targetProvider = this._getOrCreateProvider(candidate);

        // Reformat tools if switching between provider families (e.g. vLLM/OpenAI -> Gemini/Anthropic)
        let adaptedTools = chatParams.tools;
        if (options.getToolsForProvider && typeof options.getToolsForProvider === 'function') {
          adaptedTools = options.getToolsForProvider(candidate.provider);
        }

        const fallbackEvent = {
          fromProvider: primaryName,
          fromModel: primaryModel,
          toProvider: candidate.provider,
          toModel: candidate.model,
          reasonType,
          reason: primaryError.message,
          timestamp: new Date().toISOString()
        };

        this.stats.fallbacks++;
        if (reasonType.includes('context')) {
          this.stats.contextHandoffs++;
        }
        if (reasonType.includes('rate_limit')) {
          this.stats.rateLimitFallbacks++;
        }
        this.stats.history.push(fallbackEvent);
        if (this.stats.history.length > 200) this.stats.history.shift();
        this.onEvent('fallback', fallbackEvent);

        const { response, ttftMs, latencyMs } = await this._invokeWithTelemetry(
          targetProvider,
          candidate.provider,
          targetProvider.model || candidate.model,
          {
            ...chatParams,
            tools: adaptedTools
          }
        );
        this.recordSuccess(candidate.provider, candidate.model);

        const tok = Number(response.usage?.total_tokens ?? response.usage?.totalTokenCount ?? 0) || 0;
        this.stats.totalTokens += tok;
        this.stats.estimatedCostUsd += ModelRouter.estimateCost(candidate.provider, targetProvider.model || candidate.model, response.usage);

        return {
          ...response,
          routedProvider: candidate.provider,
          routedModel: targetProvider.model || candidate.model,
          fallbackUsed: true,
          fallbackInfo: fallbackEvent,
          ttftMs,
          latencyMs
        };
      } catch (fallbackErr: any) {
        if (fallbackErr.name === 'AbortError' || chatParams.signal?.aborted) {
          throw fallbackErr;
        }
        if (fallbackErr._emittedTokens > 0) {
          this.onEvent('stream_reset', {
            provider: candidate.provider,
            model: candidate.model,
            emittedTokens: fallbackErr._emittedTokens,
            reason: fallbackErr.message
          });
        }
        if (ModelRouter.isRateLimitError(fallbackErr)) {
          this.markCooldown(candidate.provider, candidate.model, fallbackErr.retryAfterMs);
        } else if (ModelRouter.isOverloadError(fallbackErr)) {
          this.markCooldown(candidate.provider, candidate.model, fallbackErr.retryAfterMs || this.routingConfig.overloadCooldownMs || 8000);
        } else if (
          fallbackErr.status === 408 ||
          fallbackErr.status === 401 ||
          fallbackErr.status === 403 ||
          fallbackErr.status === 404
        ) {
          this.markCooldown(candidate.provider, candidate.model);
        } else if (!ModelRouter.isContextLimitError(fallbackErr)) {
          this.recordFailure(candidate.provider, candidate.model);
        }
        errors.push(`${candidate.provider}/${candidate.model}: ${fallbackErr.message}`);
      }
    }

    if (reasonType.includes('rate_limit') && options.waitOnRateLimit !== false) {
      try {
        return await this._waitAndResumeRateLimit(primaryProvider, chatParams, primaryError, options);
      } catch (waitErr: any) {
        if (waitErr.name === 'AbortError' || chatParams.signal?.aborted) throw waitErr;
        errors.push(`rate_limit_wait_retry: ${waitErr.message}`);
      }
    }

    const combined: Error & { primaryError?: Error } = new Error(
      `All model providers failed after failover. Primary error: ${primaryError.message}. Chain errors: [${errors.join(' | ')}]`
    );
    combined.primaryError = primaryError;
    throw combined;
  }

  getStats() {
    const providerMetrics: Record<string, ProviderHealthMetrics> = {};
    for (const [k, v] of this.providerMetrics.entries()) {
      const slashIdx = k.indexOf('/');
      const prov = slashIdx >= 0 ? k.slice(0, slashIdx) : k;
      const mod = slashIdx >= 0 ? k.slice(slashIdx + 1) : 'default';
      providerMetrics[k] = {
        ...v,
        inFlight: this._getInFlight(prov, mod),
        rpm60s: this._getRecentRpm(prov, mod)
      };
    }
    return {
      ...this.stats,
      enabled: this.routingConfig.enabled,
      strategy: this.routingConfig.strategy,
      fallbackChain: this.routingConfig.fallbackChain,
      providerMetrics
    };
  }
}

