import { loadConfig } from './config.js';
import { detectSystemHardware, type HardwareProfile } from './deviceSpecs.js';
import {
  evaluateModelHardwareFit,
  listAnthropicModels as listAnthropicCatalog,
  listCompatCloudModels as listCompatCloudCatalog,
  listGeminiModels as listGeminiCatalog,
  listHardwareMatchedLocalModels,
  listLMStudioModels as listLMStudioCatalog,
  listLocalSafetensorsModels as listLocalSafetensorsCatalog,
  listOMModels as listOMCatalog,
  listOpenAIModels as listOpenAICatalog,
  listVLLMModels as listVLLMCatalog,
  type ModelCatalogEntry,
  type ModelHardwareFit
} from './modelService/catalog.js';

export type { ModelCatalogEntry, ModelHardwareFit };
export { evaluateModelHardwareFit, listHardwareMatchedLocalModels };

/**
 * Service to inspect, discover, and list available LLM models from providers,
 * implementing ModelService.ListModels (e.g. for Google Gemini v1beta REST API)
 * as well as other supported providers (OpenAI, Anthropic, vLLM, LM Studio, OMega)
 * and hardware-aware local model discovery.
 */
export class ModelService {
  config: Record<string, any>;
  private static _catalogCache = new Map<string, { at: number; models: ModelCatalogEntry[] }>();
  private static _inFlightCatalog = new Map<string, Promise<ModelCatalogEntry[]>>();
  private static _hardwareCache: { at: number; profile: HardwareProfile } | null = null;
  private static readonly CATALOG_TTL_MS = 30000;

  constructor(config: Record<string, any> = {}) {
    this.config = config;
  }

  static async getHardwareProfile(options: { refresh?: boolean; hardwareProfile?: HardwareProfile } = {}): Promise<HardwareProfile> {
    if (options.hardwareProfile) return options.hardwareProfile;
    if (!options.refresh && ModelService._hardwareCache && Date.now() - ModelService._hardwareCache.at < ModelService.CATALOG_TTL_MS) {
      return ModelService._hardwareCache.profile;
    }
    const profile = await detectSystemHardware();
    ModelService._hardwareCache = { at: Date.now(), profile };
    return profile;
  }

  static async listLocalModels(options: Record<string, any> = {}): Promise<ModelCatalogEntry[]> {
    const config = options.config || loadConfig();
    const hardware = await ModelService.getHardwareProfile({
      refresh: options.refresh,
      hardwareProfile: options.hardwareProfile
    });

    const annotate = (m: ModelCatalogEntry, installed: boolean): ModelCatalogEntry => ({
      ...m,
      target: 'local',
      installed: m.installed ?? installed,
      hardwareFit: m.hardwareFit || evaluateModelHardwareFit(m, hardware)
    });

    const safetensorsModels = ModelService.listLocalSafetensorsModels({ ...options, config }).map((m) => annotate(m, true));

    const [lmStudioRes, vllmRes] = await Promise.allSettled([
      (async () => {
        const lmUrl = options.lmStudioBaseUrl || config.providers?.lmstudio?.baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
        return (await ModelService.listLMStudioModels({ baseUrl: lmUrl })).map((m) => annotate(m, true));
      })(),
      (async () => {
        const vllmUrl = options.vllmBaseUrl || config.providers?.vllm?.baseUrl || process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1';
        return (await ModelService.listVLLMModels({ baseUrl: vllmUrl })).map((m) => annotate(m, true));
      })()
    ]);

    const discovered: ModelCatalogEntry[] = [
      ...(lmStudioRes.status === 'fulfilled' ? lmStudioRes.value : []),
      ...(vllmRes.status === 'fulfilled' ? vllmRes.value : []),
      ...safetensorsModels
    ];

    // Filter discovered local models by detected system hardware unless includeUnsupported is explicitly set.
    // On CPU-only or low-VRAM PCs, models that exceed the machine's RAM/VRAM are excluded;
    // on high-VRAM GPUs, larger installed models are included and marked optimal/fits.
    const includeUnsupported = options.includeUnsupported === true;
    const rankStatus: Record<ModelHardwareFit['status'], number> = {
      optimal: 0,
      fits: 1,
      tight: 2,
      unsupported: 3
    };
    const compatibleDiscovered = discovered
      .filter((m) => includeUnsupported || m.hardwareFit?.status !== 'unsupported')
      .sort((a, b) => {
        const sa = rankStatus[a.hardwareFit?.status || 'unsupported'];
        const sb = rankStatus[b.hardwareFit?.status || 'unsupported'];
        if (sa !== sb) return sa - sb;
        return (b.hardwareFit?.paramsB || 0) - (a.hardwareFit?.paramsB || 0);
      });

    const result: ModelCatalogEntry[] = [];
    const seenIds = new Set<string>();

    // 1. Actually installed / running local models on this PC that fit the detected hardware
    for (const m of compatibleDiscovered) {
      const idKey = m.id.toLowerCase();
      if (!seenIds.has(idKey)) {
        seenIds.add(idKey);
        result.push(m);
      }
    }

    // 2. Optional: include curated hardware-matched suggestions ONLY when explicitly requested
    if (options.includeRecommended === true) {
      const hardwareMatched = listHardwareMatchedLocalModels(hardware, {
        includeTight: Boolean(options.includeTight),
        includeUnsupported
      });
      for (const m of hardwareMatched) {
        const idKey = m.id.toLowerCase();
        if (!seenIds.has(idKey)) {
          seenIds.add(idKey);
          result.push(m);
        }
      }
    }

    return result;
  }

  static async listModels(options: Record<string, any> = {}) {
    const config = options.config || loadConfig();
    const providerName = (options.provider || config.provider || 'gemini').toLowerCase();

    if (providerName === 'local') {
      return ModelService.listLocalModels({ ...options, config });
    }

    if (providerName === 'all' || options.all || options.scope) {
      return ModelService.listAllModels(options);
    }

    switch (providerName) {
      case 'gemini':
      case 'google':
        return ModelService.listGeminiModels({
          apiKey: options.apiKey || config.providers?.gemini?.apiKey || process.env.GEMINI_API_KEY,
          baseUrl: options.baseUrl || config.providers?.gemini?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
          onlyGenerative: options.onlyGenerative
        });

      case 'openai':
      case 'gpt':
      case 'chatgpt':
        return ModelService.listOpenAIModels({
          apiKey: options.apiKey || config.providers?.openai?.apiKey || process.env.OPENAI_API_KEY,
          baseUrl: options.baseUrl || config.providers?.openai?.baseUrl || 'https://api.openai.com/v1',
          onlyGenerative: options.onlyGenerative
        });

      case 'anthropic':
      case 'claude':
        return ModelService.listAnthropicModels({
          apiKey: options.apiKey || config.providers?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
          baseUrl: options.baseUrl || config.providers?.anthropic?.baseUrl || 'https://api.anthropic.com/v1'
        });

      case 'deepseek':
        return ModelService.listCompatCloudModels('deepseek', { ...options, config });

      case 'kimi':
      case 'moonshot':
        return ModelService.listCompatCloudModels('kimi', { ...options, config });

      case 'qwen':
      case 'dashscope':
        return ModelService.listCompatCloudModels('qwen', { ...options, config });

      case 'glm':
      case 'zhipu':
        return ModelService.listCompatCloudModels('glm', { ...options, config });

      case 'lmstudio':
        return ModelService.listLMStudioModels({
          baseUrl: options.baseUrl || config.providers?.lmstudio?.baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1'
        });

      case 'vllm': {
        const remote = await ModelService.listVLLMModels({
          baseUrl: options.baseUrl || config.providers?.vllm?.baseUrl || process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1'
        });
        const localDirs = ModelService.listLocalSafetensorsModels({ ...options, config });
        const byId = new Map<string, ModelCatalogEntry>();
        for (const m of remote) byId.set(m.id, m);
        for (const m of localDirs) {
          if (!byId.has(m.id)) byId.set(m.id, m);
        }
        return Array.from(byId.values());
      }

      case 'om':
      case 'omega':
      case 'mock':
      default:
        return ModelService.listOMModels();
    }
  }

  static async ListModels(options: Record<string, any> = {}) {
    return ModelService.listModels(options);
  }

  async listModels(options: Record<string, any> = {}) {
    return ModelService.listModels({ config: this.config, ...options });
  }

  async ListModels(options: Record<string, any> = {}) {
    return this.listModels(options);
  }

  static async listGeminiModels(options: { apiKey?: string; baseUrl?: string; onlyGenerative?: boolean }) {
    return listGeminiCatalog(options);
  }

  static async listOpenAIModels(options: Record<string, any>) {
    return listOpenAICatalog(options);
  }

  static async listAnthropicModels(options: { apiKey?: string; baseUrl?: string }) {
    return listAnthropicCatalog(options);
  }

  static async listLMStudioModels(options: { baseUrl?: string } = {}) {
    return listLMStudioCatalog(options);
  }

  static async listVLLMModels(options: { baseUrl?: string } = {}) {
    return listVLLMCatalog(options);
  }

  static listLocalSafetensorsModels(options: Record<string, any> = {}) {
    return listLocalSafetensorsCatalog(options);
  }

  static listOMModels() {
    return listOMCatalog();
  }

  static listMockModels() {
    return ModelService.listOMModels();
  }

  static async listAllModels(options: Record<string, any> = {}) {
    const scope = options.scope === 'cloud' || options.scope === 'local' ? options.scope : 'all';
    const hasCustomEndpoint = Boolean(
      options.apiKey ||
      options.lmStudioBaseUrl ||
      options.vllmBaseUrl ||
      options.modelsDir ||
      options.hardwareProfile ||
      options.includeTight ||
      options.includeUnsupported
    );
    const useCache = !options.refresh && !hasCustomEndpoint;

    if (useCache) {
      const cached = ModelService._catalogCache.get(scope);
      if (cached && Date.now() - cached.at < ModelService.CATALOG_TTL_MS) {
        return cached.models;
      }
      const inFlight = ModelService._inFlightCatalog.get(scope);
      if (inFlight) {
        return inFlight;
      }
    }

    const fetchPromise = (async () => {
      const config = options.config || loadConfig();
      const models: ModelCatalogEntry[] = [];
      const tasks: Array<Promise<ModelCatalogEntry[]>> = [];

      if (scope !== 'cloud') {
        tasks.push(ModelService.listLocalModels({ ...options, config }));
      }

      if (scope !== 'local') {
        tasks.push(
          (async () => {
            try {
              const geminiKey = options.apiKey || config.providers?.gemini?.apiKey || process.env.GEMINI_API_KEY;
              if (geminiKey) {
                return await ModelService.listGeminiModels({ apiKey: geminiKey, onlyGenerative: true });
              }
              return [
                { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', description: 'Next-generation multimodal model built for speed and coding', supportedGenerationMethods: ['generateContent'], provider: 'gemini', target: 'cloud', canGenerate: true },
                { id: 'gemini-3.8-flash', name: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', description: 'Balanced high-efficiency Gemini cloud model', supportedGenerationMethods: ['generateContent'], provider: 'gemini', target: 'cloud', canGenerate: true },
                { id: 'gemini-3.8-pro', name: 'gemini-3.8-pro', displayName: 'Gemini 3.8 Pro', description: 'Deep reasoning and complex architecture synthesis', supportedGenerationMethods: ['generateContent'], provider: 'gemini', target: 'cloud', canGenerate: true }
              ];
            } catch {
              return [
                { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', description: 'Next-generation multimodal model built for speed and coding', supportedGenerationMethods: ['generateContent'], provider: 'gemini', target: 'cloud', canGenerate: true }
              ];
            }
          })(),
          (async () => {
            try {
              const openAiKey = config.providers?.openai?.apiKey || process.env.OPENAI_API_KEY;
              if (openAiKey) {
                return await ModelService.listOpenAIModels({ apiKey: openAiKey, onlyGenerative: true });
              }
              return [
                { id: 'gpt-4o', name: 'gpt-4o', displayName: 'GPT-4o', description: 'High-intelligence flagship OpenAI cloud model', supportedGenerationMethods: ['generateContent', 'chat'], provider: 'openai', target: 'cloud', canGenerate: true },
                { id: 'gpt-4o-mini', name: 'gpt-4o-mini', displayName: 'GPT-4o Mini', description: 'Fast, lightweight intelligence for everyday tasks', supportedGenerationMethods: ['generateContent', 'chat'], provider: 'openai', target: 'cloud', canGenerate: true },
                { id: 'o3-mini', name: 'o3-mini', displayName: 'o3-mini', description: 'High-speed reasoning model for coding and STEM', supportedGenerationMethods: ['generateContent', 'chat'], provider: 'openai', target: 'cloud', canGenerate: true }
              ];
            } catch {
              return [];
            }
          })(),
          (async () => {
            try {
              const anthropicKey = config.providers?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
              return await ModelService.listAnthropicModels({ apiKey: anthropicKey });
            } catch {
              return [
                { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', description: 'Flagship reasoning and coding model by Anthropic', supportedGenerationMethods: ['generateContent'], provider: 'anthropic', target: 'cloud', canGenerate: true },
                { id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku', description: 'Fastest Claude model for rapid iteration', supportedGenerationMethods: ['generateContent'], provider: 'anthropic', target: 'cloud', canGenerate: true }
              ];
            }
          })(),
          ...(['deepseek', 'kimi', 'qwen', 'glm'] as const).map((prov) =>
            ModelService.listCompatCloudModels(prov, { config, onlyGenerative: true }).catch(() => [] as ModelCatalogEntry[])
          )
        );
      }

      const results = await Promise.allSettled(tasks);
      const seenKeys = new Set(models.map((m) => `${m.provider}:${m.id}`));
      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          for (const entry of r.value) {
            const key = `${entry.provider}:${entry.id}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              models.push(entry);
            }
          }
        }
      }

      const filtered =
        scope === 'cloud'
          ? models.filter((m) => m.target === 'cloud')
          : scope === 'local'
            ? models.filter((m) => m.target === 'local')
            : models;

      if (useCache) {
        ModelService._catalogCache.set(scope, { at: Date.now(), models: filtered });
      }
      return filtered;
    })();

    if (useCache) {
      ModelService._inFlightCatalog.set(scope, fetchPromise);
      try {
        return await fetchPromise;
      } finally {
        ModelService._inFlightCatalog.delete(scope);
      }
    }

    return fetchPromise;
  }

  static async listCompatCloudModels(provider: 'deepseek' | 'kimi' | 'qwen' | 'glm', options: Record<string, any> = {}) {
    return listCompatCloudCatalog(provider, options);
  }
}
