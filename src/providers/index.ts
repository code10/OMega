import { OMProvider, OmegaProvider, MockProvider } from './omega.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { ModelRouter } from './router.js';

interface OpenAICompatSpec {
  canonical: string;
  defaultModel: string;
  defaultBaseUrl: string;
  apiKeyEnvs: string[];
  baseUrlEnvs: string[];
  fallbackApiKey?: string;
}

const OPENAI_COMPAT_PROVIDERS: Record<string, OpenAICompatSpec> = {
  deepseek: {
    canonical: 'deepseek',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvs: ['DEEPSEEK_API_KEY'],
    baseUrlEnvs: ['DEEPSEEK_BASE_URL']
  },
  kimi: {
    canonical: 'kimi',
    defaultModel: 'kimi-k2-0711-preview',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnvs: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    baseUrlEnvs: ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL']
  },
  moonshot: {
    canonical: 'kimi',
    defaultModel: 'kimi-k2-0711-preview',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnvs: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    baseUrlEnvs: ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL']
  },
  qwen: {
    canonical: 'qwen',
    defaultModel: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvs: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    baseUrlEnvs: ['QWEN_BASE_URL', 'DASHSCOPE_BASE_URL']
  },
  dashscope: {
    canonical: 'qwen',
    defaultModel: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvs: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    baseUrlEnvs: ['QWEN_BASE_URL', 'DASHSCOPE_BASE_URL']
  },
  glm: {
    canonical: 'glm',
    defaultModel: 'glm-4.5-flash',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvs: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
    baseUrlEnvs: ['GLM_BASE_URL', 'ZHIPU_BASE_URL']
  },
  zhipu: {
    canonical: 'glm',
    defaultModel: 'glm-4.5-flash',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvs: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
    baseUrlEnvs: ['GLM_BASE_URL', 'ZHIPU_BASE_URL']
  },
  lmstudio: {
    canonical: 'lmstudio',
    defaultModel: 'local-model',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    apiKeyEnvs: ['LMSTUDIO_API_KEY'],
    baseUrlEnvs: ['LMSTUDIO_BASE_URL'],
    fallbackApiKey: 'lm-studio'
  },
  vllm: {
    canonical: 'vllm',
    defaultModel: 'default',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    apiKeyEnvs: ['VLLM_API_KEY'],
    baseUrlEnvs: ['VLLM_BASE_URL'],
    fallbackApiKey: 'vllm'
  }
};

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return undefined;
}

export function createProvider(config: Record<string, any> = {}) {
  const providerName = (config.provider || 'om').toLowerCase();

  const getOptions = (key: string) => ({
    ...(config.providers?.[key] || {}),
    ...config,
    ...(config.model ? { model: config.model } : {})
  });

  if (providerName in OPENAI_COMPAT_PROVIDERS) {
    const spec = OPENAI_COMPAT_PROVIDERS[providerName];
    const provCfg = config.providers?.[spec.canonical] || config.providers?.[providerName] || {};
    const apiKeyEnv = provCfg.apiKeyEnv || spec.apiKeyEnvs[0];
    return new OpenAIProvider({
      ...getOptions(spec.canonical),
      name: spec.canonical,
      apiKeyEnv,
      baseUrl: provCfg.baseUrl || firstEnv(spec.baseUrlEnvs) || spec.defaultBaseUrl,
      apiKey: provCfg.apiKey || firstEnv(spec.apiKeyEnvs) || spec.fallbackApiKey,
      model: config.model || provCfg.model || spec.defaultModel
    });
  }

  switch (providerName) {
    case 'openai':
    case 'gpt':
    case 'chatgpt':
      return new OpenAIProvider(getOptions('openai'));
    case 'anthropic':
    case 'claude':
      return new AnthropicProvider(getOptions('anthropic'));
    case 'gemini':
    case 'google':
      return new GeminiProvider(getOptions('gemini'));
    case 'om':
    case 'omega':
    case 'mock':
    default:
      return new OMProvider(getOptions('om'));
  }
}

export {
  OMProvider,
  OmegaProvider,
  MockProvider,
  OpenAIProvider,
  AnthropicProvider,
  GeminiProvider,
  ModelRouter
};
