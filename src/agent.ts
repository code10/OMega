import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, persistActiveProvider } from './config.js';
import { OMMemory } from './memory.js';
import { SkillRegistry } from './skills/index.js';
import { createProvider, ModelRouter } from './providers/index.js';
import { ModelService } from './modelService.js';
import { MCPManager } from './mcp/client.js';
import { WorkspaceSnapshotManager } from './snapshot.js';
import { OMGitManager } from './git.js';
import { createHttpEmbedder } from './vectorStore.js';
import { createLogger } from './utils/logger.js';
import { handleSlashControl } from './agent/slashCommands.js';
import { compactHistoryIfNeeded } from './agent/compaction.js';
import { buildPromptParts as buildAgentPromptParts, buildRecallContext, buildSystemPrompt as buildAgentSystemPrompt } from './agent/promptBuilder.js';
import { executeAgentRun } from './agent/runner.js';
import { OMSystemOne } from './systemOne.js';
import { createExecutionBackend } from './execution/remote.js';
import { defaultTerminalManager } from './skills/terminal.js';
import { disposeAllLspClients } from './skills/codeIntel.js';
import { OMAuditLedger } from './audit.js';
import { countTokens, estimateMessagesTokens, getModelContextLimit } from './tokenizer.js';
import type {
  AgentActivityEntry,
  AgentHook,
  AgentRunOptions,
  AgentRunResult,
  AgentUsageStats,
  ChatMessage,
  ConfirmCommandHandler,
  ExecutionBackend,
  ModelInfo,
  OMAgentOptions,
  OMConfig,
  ProviderLike,
  SkillDefinition,
  TokenUsage
} from './types.js';

const log = createLogger('OMAgent');

const PROVIDER_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  google: 'gemini',
  gpt: 'openai',
  chatgpt: 'openai',
  moonshot: 'kimi',
  dashscope: 'qwen',
  zhipu: 'glm',
  mock: 'om',
  omega: 'om'
};
const SUPPORTED_PROVIDERS = new Set(['gemini', 'openai', 'anthropic', 'deepseek', 'kimi', 'qwen', 'glm', 'lmstudio', 'vllm', 'om']);
const MAX_TOOL_OUTPUT_CHARS = 48000;

export class OMAgent extends EventEmitter {
  static ModelService = ModelService;
  options: OMAgentOptions;
  config: OMConfig;
  memory: OMMemory;
  git: OMGitManager;
  skills: SkillRegistry;
  provider: ProviderLike;
  router: ModelRouter;
  systemOne: OMSystemOne;
  execution: ExecutionBackend;
  history: ChatMessage[];
  answers: Record<string, any>[];
  activityLog: AgentActivityEntry[];
  sessionId: string;
  _watchers: fs.FSWatcher[];
  _ignoreWatchUntil: number;
  _toolsCache: Map<string, any[]>;
  _isSelfHealing?: boolean;
  modelService: typeof ModelService;
  mcpManager: MCPManager;
  snapshots: WorkspaceSnapshotManager;
  lastRunId: string | null;
  hooks: AgentHook[];
  _activeAbortController: AbortController | null;
  _steeringQueue: string[];
  confirmCommand: ConfirmCommandHandler | null;
  usageStats: AgentUsageStats;
  lastContextUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    historyLength: number;
    model: string;
  } | null;
  audit: OMAuditLedger;

  static normalizeModel(model: string) {
    if (typeof model !== 'string') return model;
    return model.startsWith('om-mock-') ? model.replace('om-mock-', 'om-') : model;
  }

  static normalizeProvider(name?: string) {
    const p = (name || 'om').toLowerCase().trim();
    return PROVIDER_ALIASES[p] || p;
  }

  constructor(options: OMAgentOptions = {}) {
    super();
    this.options = options;
    this.config = loadConfig(options);
    this.config.model = OMAgent.normalizeModel(this.config.model);
    const asyncEmbedder = options.asyncEmbedder
      || (this.config.embedding?.url ? createHttpEmbedder(this.config.embedding) : undefined);
    this.memory = new OMMemory(this.config.memoryDir, { asyncEmbedder });
    this.execution = options.executionBackend || createExecutionBackend(this.config.execution, this.config.workspaceDir);
    this.git = new OMGitManager(this.config.workspaceDir, this.execution);
    this.skills = new SkillRegistry();
    this.provider = options.providerInstance || createProvider(this.config);
    this.systemOne = new OMSystemOne(this.config.systemOne, { embedder: options.systemOneEmbedder });
    this.router = new ModelRouter({
      config: this.config,
      routing: options.routing || this.config.routing,
      systemOne: this.systemOne,
      onEvent: (event: string, payload: any) => {
        this.emit(event, payload);
        this._recordActivity(event, payload);
      }
    });
    this.history = [];
    this.answers = [];
    this.activityLog = [];
    this.sessionId = options.sessionId || this.memory.getNextSessionId();
    this._watchers = [];
    this._ignoreWatchUntil = 0;
    this._toolsCache = new Map();
    this.modelService = ModelService;
    this.mcpManager = new MCPManager();
    this.snapshots = new WorkspaceSnapshotManager(this.config.workspaceDir, null, this.execution);
    this.lastRunId = null;
    this.hooks = [];
    if (Array.isArray(options.hooks)) this.hooks.push(...options.hooks);
    else if (options.hooks && typeof options.hooks === 'object') this.hooks.push(options.hooks);
    this._activeAbortController = null;
    this._steeringQueue = [];
    this.confirmCommand = options.confirmCommand || null;
    this.usageStats = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      calls: 0
    };
    this.lastContextUsage = null;
    this.audit = new OMAuditLedger(this.config.memoryDir, {
      ownerId: typeof (options as Record<string, unknown>).ownerId === 'string'
        ? String((options as Record<string, unknown>).ownerId)
        : 'local'
    });
  }

  _getTarget(providerName = this.config.provider) {
    return ModelRouter.isLocalProvider(providerName) ? 'local' : 'cloud';
  }

  _invalidateToolsCache() {
    this._toolsCache.clear();
  }

  /**
   * Record structured activity events for live dashboard visibility
   */
  _recordActivity(type: string, data: Record<string, unknown> = {}): AgentActivityEntry {
    const entry = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      timestamp: new Date().toISOString(),
      provider: this.config.provider,
      model: this.config.model,
      sessionId: this.sessionId,
      data
    };
    this.activityLog.push(entry);
    if (this.activityLog.length > 200) this.activityLog.shift();
    this.emit('activity', entry);
    return entry;
  }

  /**
   * Check whether a provider has the required API key configured
   */
  checkProviderCredentials(providerName: string) {
    const pName = OMAgent.normalizeProvider(providerName);
    const checks: Record<string, { key?: string; envVar: string; label: string }> = {
      anthropic: { key: this.config.providers?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY, envVar: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)' },
      openai: { key: this.config.providers?.openai?.apiKey || process.env.OPENAI_API_KEY, envVar: 'OPENAI_API_KEY', label: 'OpenAI (GPT)' },
      gemini: { key: this.config.providers?.gemini?.apiKey || process.env.GEMINI_API_KEY, envVar: 'GEMINI_API_KEY', label: 'Google' },
      deepseek: { key: this.config.providers?.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY, envVar: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
      kimi: { key: this.config.providers?.kimi?.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY, envVar: 'KIMI_API_KEY', label: 'Kimi (Moonshot)' },
      qwen: { key: this.config.providers?.qwen?.apiKey || process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY, envVar: 'QWEN_API_KEY', label: 'Qwen (DashScope)' },
      glm: { key: this.config.providers?.glm?.apiKey || process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY, envVar: 'GLM_API_KEY', label: 'GLM (Zhipu)' }
    };
    const entry = checks[pName];
    if (entry && !entry.key) {
      return { ok: false, envVar: entry.envVar, label: entry.label };
    }
    return { ok: true };
  }

  /**
   * Switch the active LLM provider and/or model dynamically at runtime and persist it
   */
  setProvider(providerName: string, modelOverride?: string, persist = true) {
    const pName = OMAgent.normalizeProvider(providerName);
    if (!SUPPORTED_PROVIDERS.has(pName)) {
      throw new Error(`Unknown provider '${providerName}'. Supported providers: gemini, openai (gpt), anthropic (claude), deepseek, kimi (moonshot), qwen (dashscope), glm (zhipu), lmstudio, vllm, om.`);
    }

    const credCheck = this.checkProviderCredentials(pName);
    if (!credCheck.ok) {
      throw new Error(`Cannot switch to ${credCheck.label}${modelOverride ? ` (${modelOverride})` : ''}: ${credCheck.envVar} is not set in your .env file.`);
    }

    const defaultModels: Record<string, string> = {
      gemini: this.config.providers?.gemini?.model || 'gemini-3.5-flash',
      openai: this.config.providers?.openai?.model || 'gpt-4o',
      anthropic: this.config.providers?.anthropic?.model || 'claude-3-5-sonnet-20241022',
      deepseek: this.config.providers?.deepseek?.model || 'deepseek-chat',
      kimi: this.config.providers?.kimi?.model || 'kimi-k2-0711-preview',
      qwen: this.config.providers?.qwen?.model || 'qwen-plus',
      glm: this.config.providers?.glm?.model || 'glm-4.5-flash',
      lmstudio: process.env.LMSTUDIO_MODEL || this.config.providers?.lmstudio?.model || 'local-model',
      vllm: process.env.VLLM_MODEL || this.config.providers?.vllm?.model || 'default',
      om: this.config.providers?.om?.model || this.config.providers?.mock?.model || 'om-turbo'
    };

    this.config.provider = pName;
    this.config.model = OMAgent.normalizeModel(modelOverride || defaultModels[pName] || this.config.model);
    this.provider = createProvider({
      ...this.config,
      provider: pName,
      model: this.config.model,
      providers: {
        ...this.config.providers,
        [pName]: {
          ...this.config.providers?.[pName],
          model: this.config.model
        }
      }
    });
    if (persist) {
      this._ignoreWatchUntil = Date.now() + 1000;
      persistActiveProvider(this.config.provider, this.config.model, this.config.rootDir);
    }
    this._emitConfigUpdate();
    return this;
  }

  /**
   * List available models using ModelService
   */
  async listModels(providerName?: string, options: Record<string, unknown> = {}): Promise<ModelInfo[]> {
    const pName = OMAgent.normalizeProvider(providerName || this.config.provider || 'gemini');
    return ModelService.listModels({
      provider: pName,
      config: this.config,
      ...options
    });
  }

  async ListModels(providerName?: string, options: Record<string, unknown> = {}): Promise<ModelInfo[]> {
    return this.listModels(providerName, options);
  }

  _emitConfigUpdate() {
    this._invalidateToolsCache();
    const skillList = this.skills.list();
    this.emit('config_updated', {
      provider: this.config.provider,
      model: this.config.model,
      skillsCount: skillList.length,
      skills: skillList,
      memoryDir: this.config.memoryDir
    });
  }

  /**
   * Start real-time filesystem watchers on .env, om.config.json, and skills/ directory
   */
  startWatching() {
    this.stopWatching();
    let debounceTimer: NodeJS.Timeout | null = null;

    const triggerReload = (source: string) => {
      if (source === 'config' && Date.now() < this._ignoreWatchUntil) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const prevSkillsCount = this.skills.list().length;
          if (source === 'skills') {
            if (this.config.skillsDir) await this.skills.loadFromDirectory(this.config.skillsDir);
            if (this.skills.list().length !== prevSkillsCount) this._emitConfigUpdate();
          } else {
            const freshConfig = loadConfig({ ...this.options, reloadEnv: true });
            const providerChanged = freshConfig.provider !== this.config.provider || freshConfig.model !== this.config.model;
            this.config = freshConfig;
            if (providerChanged && !this.options.providerInstance) {
              this.provider = createProvider(this.config);
            }
            if (this.config.skillsDir) await this.skills.loadFromDirectory(this.config.skillsDir);
            if (providerChanged || this.skills.list().length !== prevSkillsCount) {
              this._emitConfigUpdate();
            }
          }
        } catch (err: any) {
          log.warn(`Hot-reload watcher error (${source}): ${err.message}`);
        }
      }, 150);
    };

    for (const file of [path.join(this.config.rootDir, '.env'), path.join(this.config.rootDir, 'om.config.json')]) {
      if (fs.existsSync(file)) {
        try {
          const w = fs.watch(file, () => triggerReload('config'));
          w.unref?.();
          this._watchers.push(w);
        } catch (err: any) {
          log.debug(`Could not watch config file ${file}: ${err.message}`);
        }
      }
    }

    if (this.config.skillsDir && fs.existsSync(this.config.skillsDir)) {
      try {
        const w = fs.watch(this.config.skillsDir, { recursive: true }, () => triggerReload('skills'));
        w.unref?.();
        this._watchers.push(w);
      } catch (err: any) {
        log.debug(`Could not watch skillsDir: ${err.message}`);
      }
    }

    return this;
  }

  stopWatching() {
    for (const w of this._watchers) {
      try {
        w.close();
      } catch (err: any) {
        log.debug(`Error closing watcher: ${err.message}`);
      }
    }
    this._watchers = [];
  }

  /**
   * Initialize agent environment, dynamic skill plugins, and configured MCP servers
   */
  async init() {
    // Warm up SystemOne ONNX pipeline in the background so turn 1 doesn't stall on cold start
    if (this.systemOne?.isConfigured() && !this.systemOne.isReady()) {
      this.systemOne.warmup();
    }
    if (this.config.skillsDir) {
      await this.skills.loadFromDirectory(this.config.skillsDir);
      this._invalidateToolsCache();
    }
    if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
      await this.mcpManager.connectAll(this.config.mcpServers, this.skills);
      this._invalidateToolsCache();
    }
    return this;
  }

  async close() {
    this.stopWatching();
    defaultTerminalManager.closeAll();
    disposeAllLspClients();
    this.mcpManager?.closeAll();
    await this.memory?.flush?.();
    this.memory?.close?.();
  }

  /**
   * Register a custom skill dynamically
   */
  registerSkill(skill: SkillDefinition) {
    this.skills.register(skill, 'custom');
    this._emitConfigUpdate();
    return this;
  }

  /**
   * Reset the conversation context and start a new sequential session
   */
  reset() {
    this.history = [];
    this.answers = [];
    this.lastContextUsage = null;
    this.sessionId = this.memory.getNextSessionId();
    return this;
  }

  /**
   * Clear the active session history keeping the current sessionId
   */
  clearCurrentSession() {
    this.history = [];
    this.answers = [];
    this.lastContextUsage = null;
    this.memory.saveSession(this.sessionId, {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      provider: this.config.provider,
      model: this.config.model,
      target: this._getTarget(),
      answers: [],
      history: [],
      steps: []
    });
    this._emitConfigUpdate();
    return { success: true, sessionId: this.sessionId, message: 'Page cleared.' };
  }

  /**
   * Delete all saved sessions and reset session counter back to 1
   */
  resetSessionCounter() {
    this.memory.clearAllSessions();
    this.history = [];
    this.answers = [];
    this.lastContextUsage = null;
    this.sessionId = 'session_1';
    this._emitConfigUpdate();
    return {
      success: true,
      sessionId: 'session_1',
      message: 'All sessions deleted and counter reset to 1'
    };
  }

  /**
   * Resume an existing conversation session from saved logs
   */
  resumeSession(sessionId: string) {
    const data = this.memory.loadSession(sessionId);
    if (!data) throw new Error(`Session ${sessionId} not found`);
    this.sessionId = sessionId;
    this.history = data.history || [];
    this.answers = data.answers || [];
    this.lastContextUsage = null;
    return data;
  }

  /**
   * Build high-relevance semantic memory recall for the active query
   */
  _buildRecallContext(query: string, topK = 4) {
    return buildRecallContext(this, query, topK);
  }

  /**
   * Build the complete dynamic system prompt with memory, semantic recall, and environment context
   */
  buildSystemPrompt(options = {}) {
    return buildAgentSystemPrompt(this, options);
  }

  /**
   * Build cache-friendly static system prompt + separate dynamic context block
   */
  buildPromptParts(options = {}) {
    return buildAgentPromptParts(this, options);
  }

  /**
   * Format registered skills for the active or specified provider (cached per provider type)
   */
  getFormattedTools(providerOverride?: string): any[] {
    const pName = OMAgent.normalizeProvider(providerOverride || this.provider.name || '');
    const cacheKey = pName === 'anthropic' ? 'anthropic' : pName === 'gemini' ? 'gemini' : 'openai';
    if (this._toolsCache.has(cacheKey)) {
      return this._toolsCache.get(cacheKey) || [];
    }
    let formatted;
    if (cacheKey === 'anthropic') formatted = this.skills.toAnthropicTools();
    else if (cacheKey === 'gemini') formatted = this.skills.toGeminiTools();
    else formatted = this.skills.toOpenAITools();
    this._toolsCache.set(cacheKey, formatted);
    return formatted;
  }

  _compactToolOutput(rawOutput: any) {
    const limit = Number((this.config as Record<string, any>).maxToolOutputChars) || MAX_TOOL_OUTPUT_CHARS;
    if (typeof rawOutput === 'string') {
      if (rawOutput.length <= limit) return rawOutput;
      return `${rawOutput.slice(0, limit)}\n...[truncated ${rawOutput.length - limit} chars for token efficiency]`;
    }

    const str = JSON.stringify(rawOutput);
    if (str.length <= limit) return str;

    // Preserve valid JSON by truncating large string fields inside object results
    if (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
      const cloned: Record<string, any> = { ...rawOutput, outputTruncated: true };
      const largeStringFields = ['content', 'stdout', 'stderr', 'output', 'text', 'body', 'diff'];
      let excess = str.length - limit + 256; // leave room for truncation notice + outputTruncated flag

      for (const field of largeStringFields) {
        if (excess <= 0) break;
        if (typeof cloned[field] === 'string' && cloned[field].length > 512) {
          const curLen = cloned[field].length;
          const keepLen = Math.max(256, curLen - excess);
          const removed = curLen - keepLen;
          if (removed > 0) {
            cloned[field] = `${cloned[field].slice(0, keepLen)}\n...[truncated ${removed} chars for token efficiency]`;
            excess -= removed;
          }
        }
      }

      const compacted = JSON.stringify(cloned);
      if (compacted.length <= limit) return compacted;

      // Secondary pass: truncate any remaining oversized string properties
      for (const [k, v] of Object.entries(cloned)) {
        if (typeof v === 'string' && v.length > 2000) {
          cloned[k] = `${v.slice(0, 1500)}...[truncated ${v.length - 1500} chars]`;
        }
      }
      const secondPass = JSON.stringify(cloned);
      if (secondPass.length <= limit) return secondPass;
    }

    return JSON.stringify({
      success: rawOutput?.success !== false,
      outputTruncated: true,
      preview: `${str.slice(0, Math.max(512, limit - 200))}...[truncated ${str.length - Math.max(512, limit - 200)} chars for token efficiency]`
    });
  }

  _conciseOutput(text: any) {
    if (typeof text !== 'string') return '';
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  _handleSlashControl(trimmedPrompt: string) {
    return handleSlashControl(this, trimmedPrompt);
  }

  _accumulateUsage(usage: TokenUsage | Record<string, unknown> | undefined) {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? u.promptTokens ?? 0) || 0;
    const completion = Number(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? u.completionTokens ?? 0) || 0;
    const total = Number(u.total_tokens ?? u.totalTokenCount ?? u.totalTokens ?? (prompt + completion)) || (prompt + completion);
    this.usageStats.promptTokens += prompt;
    this.usageStats.completionTokens += completion;
    this.usageStats.totalTokens += total;
    this.usageStats.calls += 1;
    if (prompt > 0) {
      this.lastContextUsage = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
        historyLength: this.history.length,
        model: this.config.model
      };
    }
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
  }

  /**
   * Compute accurate current context window occupancy using the latest provider-reported
   * token usage when aligned with active history, falling back to the built-in BPE tokenizer
   * over system prompt, tool schemas, and conversation history.
   */
  getContextUsage() {
    const model = this.config.model || '';
    const provider = this.config.provider || '';
    const contextLimit =
      Number(this.config.routing?.contextLimitTokens || 0) ||
      getModelContextLimit(provider, model);

    const history = Array.isArray(this.history) ? this.history : [];
    const { estimatedTokens: historyTokens } = estimateMessagesTokens(history, '', model);

    let systemTokens = 0;
    let toolsTokens = 0;
    try {
      const sysPrompt = this.buildSystemPrompt();
      systemTokens = sysPrompt ? countTokens(sysPrompt, model) + 4 : 0;
    } catch (_) {
      systemTokens = 0;
    }
    try {
      const formattedTools = this.getFormattedTools();
      toolsTokens = Array.isArray(formattedTools) && formattedTools.length > 0
        ? countTokens(formattedTools, model)
        : 0;
    } catch (_) {
      toolsTokens = 0;
    }

    const overheadTokens = systemTokens + toolsTokens;

    if (history.length === 0) {
      return {
        usedTokens: 0,
        contextLimit,
        historyTokens: 0,
        systemTokens,
        toolsTokens,
        overheadTokens,
        lastPromptTokens: 0,
        lastCompletionTokens: 0,
        sessionTotalTokens: this.usageStats.totalTokens,
        messageCount: 0,
        source: 'idle' as const
      };
    }

    const last = this.lastContextUsage;
    const providerAligned =
      Boolean(last) &&
      (last?.promptTokens || 0) > 0 &&
      last?.model === model &&
      Math.abs(history.length - (last?.historyLength ?? -99)) <= 2;

    if (providerAligned && last) {
      const usedTokens = last.promptTokens + last.completionTokens;
      return {
        usedTokens,
        contextLimit,
        historyTokens,
        systemTokens,
        toolsTokens,
        overheadTokens,
        lastPromptTokens: last.promptTokens,
        lastCompletionTokens: last.completionTokens,
        sessionTotalTokens: this.usageStats.totalTokens,
        messageCount: history.length,
        source: 'provider' as const
      };
    }

    return {
      usedTokens: historyTokens + overheadTokens,
      contextLimit,
      historyTokens,
      systemTokens,
      toolsTokens,
      overheadTokens,
      lastPromptTokens: last?.promptTokens || 0,
      lastCompletionTokens: last?.completionTokens || 0,
      sessionTotalTokens: this.usageStats.totalTokens,
      messageCount: history.length,
      source: 'bpe' as const
    };
  }

  use(hookObj: AgentHook) {
    if (hookObj && typeof hookObj === 'object') {
      this.hooks.push(hookObj);
    }
    return this;
  }

  async _runHooks(hookName: string, payload: Record<string, unknown>) {
    let current: Record<string, unknown> = payload;
    for (const h of this.hooks) {
      const fn = h?.[hookName];
      if (typeof fn === 'function') {
        const res = await (fn as (ctx: Record<string, unknown>, agent: OMAgent) => Promise<unknown> | unknown)(current, this);
        if (res && typeof res === 'object') {
          current = { ...current, ...(res as Record<string, unknown>) };
        }
      }
    }
    return current;
  }

  abort(reason = 'Aborted by user') {
    if (this._activeAbortController && !this._activeAbortController.signal.aborted) {
      this._activeAbortController.abort(new Error(reason));
      return true;
    }
    return false;
  }

  steer(instruction: string) {
    if (typeof instruction === 'string' && instruction.trim()) {
      this._steeringQueue.push(instruction.trim());
      return true;
    }
    return false;
  }

  _compactHistoryIfNeeded() {
    compactHistoryIfNeeded(this);
  }

  /**
   * Execute a single user prompt through the autonomous ReAct loop
   * @param {string} prompt - User request or instruction
   * @param {Record<string, any>} [options] - Per-call options
   * @returns {Promise<{ content: string, answer?: string, provider?: string, model?: string, target?: string, usage?: Record<string, number>, steps: Array<any>, totalSteps?: number, sessionId?: string, runId?: string, aborted?: boolean, fallbackUsed?: boolean, fallbackEvents?: Array<any>, answers?: Array<any>, success: boolean }>}
   */
  async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    return executeAgentRun(this, prompt, options) as Promise<AgentRunResult>;
  }
}
