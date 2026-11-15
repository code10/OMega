import { createProvider } from './index.js';
import { estimateMessagesTokens, getModelContextLimit } from '../tokenizer.js';

/**
 * Multi-Model Router & Automatic Failover Engine for OMega.
 *
 * Provides:
 * - Graceful failover between local models (LM Studio, vLLM, OM)
 *   and cloud providers (Gemini, OpenAI, Anthropic).
 * - Automatic retry with exponential backoff on transient failures.
 * - Context window overflow / token limit detection with seamless handoff
 *   to larger-context cloud models.
 * - Full telemetry and event emission ('retry', 'fallback') for UI & CLI visibility.
 */
export class ModelRouter {
  config: Record<string, any>;
  routingConfig: Record<string, any>;
  onEvent: (event: string, payload: any) => void;
  providerFactory: (cfg: Record<string, any>) => any;
  cooldowns: Map<string, number>;
  stats: Record<string, any>;

  constructor(options: Record<string, any> = {}) {
    this.config = options.config || {};
    this.routingConfig = {
      enabled: true,
      maxRetries: 1,
      retryDelayMs: 150,
      rateLimitCooldownMs: 60000,
      contextLimitChars: 48000, // ~12k tokens default local context threshold before handoff if configured
      autoHandoffOnContextLimit: true,
      fallbackChain: [
        { provider: 'gemini', model: 'gemini-3-flash-preview' },
        { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
        { provider: 'om', model: 'om-reasoning' }
      ],
      ...(this.config.routing || {}),
      ...(options.routing || {})
    };
    this.onEvent = options.onEvent || (() => {});
    this.providerFactory = options.providerFactory || createProvider;
    this.cooldowns = new Map();
    this.stats = {
      totalCalls: 0,
      retries: 0,
      fallbacks: 0,
      contextHandoffs: 0,
      rateLimitFallbacks: 0,
      complexityRoutes: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      history: []
    };
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
    else if (m.includes('sonnet') || m.includes('gpt-4o') && !m.includes('mini')) { inPerM = 3; outPerM = 15; }
    else if (m.includes('pro')) { inPerM = 1.25; outPerM = 5; }
    else if (m.includes('flash-lite') || m.includes('mini')) { inPerM = 0.1; outPerM = 0.4; }
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

  _cooldownKey(provider: string, model?: string) {
    return `${(provider || '').toLowerCase()}/${model || 'default'}`;
  }

  isInCooldown(provider: string, model?: string) {
    const key = this._cooldownKey(provider, model);
    const until = this.cooldowns.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldowns.delete(key);
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
   * Determine if an error indicates rate-limit / quota exhaustion (HTTP 429)
   */
  static isRateLimitError(err: any) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    return (
      err.status === 429 ||
      err.code === 'RATE_LIMIT_EXCEEDED' ||
      msg.includes('429') ||
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
    return ['lmstudio', 'vllm', 'om', 'omega', 'mock'].includes(p);
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
  getFallbackCandidates(primaryProviderName: string, primaryModel: string) {
    const primaryIsLocal = ModelRouter.isLocalProvider(primaryProviderName);
    const chain = this.routingConfig.fallbackChain || [];
    const usable = [];

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

      if (this.canUseCandidate(cand)) {
        usable.push({
          provider: candProv,
          model: candModel,
          providerInstance: cand.providerInstance || null,
          reason: cand.reason || null
        });
      }
    }

    return usable;
  }

  getDefaultModelForProvider(providerName: string) {
    const p = (providerName || 'om').toLowerCase();
    const defaults: Record<string, string> = {
      gemini: this.config.providers?.gemini?.model || 'gemini-3-flash-preview',
      openai: this.config.providers?.openai?.model || 'gpt-4o',
      anthropic: this.config.providers?.anthropic?.model || 'claude-3-5-sonnet-20241022',
      deepseek: this.config.providers?.deepseek?.model || 'deepseek-chat',
      kimi: this.config.providers?.kimi?.model || 'kimi-k2-0711-preview',
      moonshot: this.config.providers?.kimi?.model || 'kimi-k2-0711-preview',
      qwen: this.config.providers?.qwen?.model || 'qwen-plus',
      dashscope: this.config.providers?.qwen?.model || 'qwen-plus',
      glm: this.config.providers?.glm?.model || 'glm-4.5-flash',
      zhipu: this.config.providers?.glm?.model || 'glm-4.5-flash',
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
        : ModelRouter.classifyComplexity(chatParams);
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

    const usage = ModelRouter.estimateContextUsage(chatParams.messages, chatParams.systemPrompt, primaryModel);
    const contextLimitTokens = options.contextLimitTokens || this.routingConfig.contextLimitTokens || (this.routingConfig.autoDetectContextLimit ? getModelContextLimit(primaryName, primaryModel) : 0);

    // 1. Proactive Context Limit Handoff: if local model has a configured token limit and input exceeds it
    if (
      this.routingConfig.enabled &&
      this.routingConfig.autoHandoffOnContextLimit &&
      isLocal &&
      contextLimitTokens > 0 &&
      usage.estimatedTokens > contextLimitTokens
    ) {
      const contextErr: Error & { code?: string } = new Error(
        `Local model '${primaryModel}' (${primaryName}) context limit exceeded (${usage.estimatedTokens} estimated tokens > ${contextLimitTokens} limit)`
      );
      contextErr.code = 'CONTEXT_LIMIT_EXCEEDED';
      return this._executeFailover(primaryProvider, chatParams, contextErr, 'context_limit_exceeded', options);
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

    // 2. Attempt primary provider with automatic retries for transient errors
    const maxRetries = options.maxRetries ?? this.routingConfig.maxRetries ?? 1;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.stats.retries++;
          const retryEvent = {
            attempt,
            maxRetries,
            provider: primaryName,
            model: primaryModel,
            reason: lastError?.message || 'Transient error',
            timestamp: new Date().toISOString()
          };
          this.onEvent('retry', retryEvent);
          const delay = (this.routingConfig.retryDelayMs || 100) * attempt;
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }

        const response = await primaryProvider.chat(chatParams);
        const tok = Number(response.usage?.total_tokens ?? response.usage?.totalTokenCount ?? 0) || 0;
        this.stats.totalTokens += tok;
        this.stats.estimatedCostUsd += ModelRouter.estimateCost(primaryName, primaryModel, response.usage);
        return {
          ...response,
          routedProvider: primaryProvider.name || primaryName,
          routedModel: primaryProvider.model || primaryModel,
          fallbackUsed: false,
          attempts: attempt + 1
        };
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError' || chatParams.signal?.aborted) {
          throw err;
        }
        // Never waste retries on context limit or 429 rate-limit errors — fail over immediately
        if (ModelRouter.isContextLimitError(err)) {
          break;
        }
        if (ModelRouter.isRateLimitError(err)) {
          this.markCooldown(primaryName, primaryModel, err.retryAfterMs);
          break;
        }
      }
    }

    // 3. If routing/failover is disabled, rethrow primary error
    if (this.routingConfig.enabled === false || options.disableFailover) {
      throw lastError;
    }

    // 4. Execute seamless failover to fallback chain
    const reasonType = ModelRouter.isContextLimitError(lastError)
      ? 'context_limit'
      : ModelRouter.isRateLimitError(lastError)
        ? 'rate_limit'
        : 'provider_error';
    return this._executeFailover(primaryProvider, chatParams, lastError, reasonType, options);
  }

  async _executeFailover(primaryProvider: any, chatParams: Record<string, any>, primaryError: any, reasonType: string, options: Record<string, any> = {}) {
    const primaryName = primaryProvider.name || this.config.provider || 'om';
    const primaryModel = primaryProvider.model || this.config.model || 'default';
    const candidates = this.getFallbackCandidates(primaryName, primaryModel);

    if (candidates.length === 0) {
      throw primaryError;
    }

    const errors = [`${primaryName}/${primaryModel}: ${primaryError.message}`];

    for (const candidate of candidates) {
      try {
        const targetProvider = candidate.providerInstance || this.providerFactory({
          ...this.config,
          provider: candidate.provider,
          model: candidate.model
        });

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
        this.onEvent('fallback', fallbackEvent);

        const response = await targetProvider.chat({
          ...chatParams,
          tools: adaptedTools
        });

        return {
          ...response,
          routedProvider: candidate.provider,
          routedModel: targetProvider.model || candidate.model,
          fallbackUsed: true,
          fallbackInfo: fallbackEvent
        };
      } catch (fallbackErr: any) {
        if (ModelRouter.isRateLimitError(fallbackErr)) {
          this.markCooldown(candidate.provider, candidate.model, fallbackErr.retryAfterMs);
        }
        errors.push(`${candidate.provider}/${candidate.model}: ${fallbackErr.message}`);
      }
    }

    const combined: Error & { primaryError?: Error } = new Error(
      `All model providers failed after failover. Primary error: ${primaryError.message}. Chain errors: [${errors.join(' | ')}]`
    );
    combined.primaryError = primaryError;
    throw combined;
  }

  getStats() {
    return {
      ...this.stats,
      enabled: this.routingConfig.enabled,
      fallbackChain: this.routingConfig.fallbackChain
    };
  }
}

