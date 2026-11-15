import { loadConfig } from './config.js';
import {
  listAnthropicModels as listAnthropicCatalog,
  listCompatCloudModels as listCompatCloudCatalog,
  listGeminiModels as listGeminiCatalog,
  listLMStudioModels as listLMStudioCatalog,
  listLocalSafetensorsModels as listLocalSafetensorsCatalog,
  listOMModels as listOMCatalog,
  listOpenAIModels as listOpenAICatalog,
  listVLLMModels as listVLLMCatalog,
  type ModelCatalogEntry
} from './modelService/catalog.js';

export type { ModelCatalogEntry };

/**
 * Service to inspect, discover, and list available LLM models from providers,
 * implementing ModelService.ListModels (e.g. for Google Gemini v1beta REST API)
 * as well as other supported providers (OpenAI, Anthropic, vLLM, LM Studio, OMega).
 */
export class ModelService {
  config: Record<string, any>;

  constructor(config: Record<string, any> = {}) {
    this.config = config;
  }

  static async listModels(options: Record<string, any> = {}) {
    const config = options.config || loadConfig();
    const providerName = (options.provider || config.provider || 'gemini').toLowerCase();

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

      case 'vllm':
        return ModelService.listVLLMModels({
          baseUrl: options.baseUrl || config.providers?.vllm?.baseUrl || process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1'
        });

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
    const config = options.config || loadConfig();
    const models: ModelCatalogEntry[] = [
      ...ModelService.listOMModels(),
      ...ModelService.listLocalSafetensorsModels(options)
    ];

    const tasks: Array<Promise<ModelCatalogEntry[]>> = [
      (async () => {
        try {
          const lmUrl = options.lmStudioBaseUrl || config.providers?.lmstudio?.baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
          return await ModelService.listLMStudioModels({ baseUrl: lmUrl });
        } catch {
          return [];
        }
      })(),
      (async () => {
        try {
          const vllmUrl = options.vllmBaseUrl || config.providers?.vllm?.baseUrl || process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1';
          return await ModelService.listVLLMModels({ baseUrl: vllmUrl });
        } catch {
          return [];
        }
      })(),
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
    ];

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        models.push(...r.value);
      }
    }

    if (options.scope === 'cloud') {
      return models.filter((m) => m.target === 'cloud');
    }
    if (options.scope === 'local') {
      return models.filter((m) => m.target === 'local');
    }

    return models;
  }

  static async listCompatCloudModels(provider: 'deepseek' | 'kimi' | 'qwen' | 'glm', options: Record<string, any> = {}) {
    return listCompatCloudCatalog(provider, options);
  }
}
