import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  supportedGenerationMethods: string[];
  canGenerate: boolean;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  thinking?: boolean;
  provider: string;
  target: 'cloud' | 'local';
  localPath?: string;
}

const COMPAT_SPECS: Record<
  'deepseek' | 'kimi' | 'qwen' | 'glm',
  {
    baseUrl: string;
    apiKeyEnvs: string[];
    baseUrlEnvs: string[];
    fallback: Array<{ id: string; displayName: string; description: string }>;
  }
> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvs: ['DEEPSEEK_API_KEY'],
    baseUrlEnvs: ['DEEPSEEK_BASE_URL'],
    fallback: [
      { id: 'deepseek-chat', displayName: 'DeepSeek Chat (V3)', description: 'General-purpose chat & coding model by DeepSeek' },
      { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner (R1)', description: 'Step-by-step reasoning model by DeepSeek' }
    ]
  },
  kimi: {
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnvs: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    baseUrlEnvs: ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL'],
    fallback: [
      { id: 'kimi-k2-0711-preview', displayName: 'Kimi K2', description: 'Flagship agentic & coding model by Moonshot AI' },
      { id: 'kimi-latest', displayName: 'Kimi Latest', description: 'Latest auto-routed Kimi model by Moonshot AI' },
      { id: 'moonshot-v1-128k', displayName: 'Moonshot v1 128K', description: 'Long-context Moonshot AI model' }
    ]
  },
  qwen: {
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyEnvs: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    baseUrlEnvs: ['QWEN_BASE_URL', 'DASHSCOPE_BASE_URL'],
    fallback: [
      { id: 'qwen-max', displayName: 'Qwen Max', description: 'Flagship Alibaba Cloud Qwen model' },
      { id: 'qwen-plus', displayName: 'Qwen Plus', description: 'Balanced high-performance Qwen model' },
      { id: 'qwen-turbo', displayName: 'Qwen Turbo', description: 'Fast, low-latency Qwen model' },
      { id: 'qwq-plus', displayName: 'QwQ Plus (Reasoning)', description: 'Deep reasoning Qwen model' },
      { id: 'qwen-coder-plus', displayName: 'Qwen Coder Plus', description: 'Specialized code generation Qwen model' }
    ]
  },
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnvs: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
    baseUrlEnvs: ['GLM_BASE_URL', 'ZHIPU_BASE_URL'],
    fallback: [
      { id: 'glm-4.5-flash', displayName: 'GLM-4.5 Flash (Free)', description: 'Free high-speed GLM-4.5 model by Zhipu AI' },
      { id: 'glm-4.5-air', displayName: 'GLM-4.5 Air', description: 'Balanced GLM-4.5 model by Zhipu AI' },
      { id: 'glm-4.5', displayName: 'GLM-4.5', description: 'Flagship GLM-4.5 model by Zhipu AI' }
    ]
  }
};

export async function listGeminiModels({
  apiKey,
  baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  onlyGenerative: _onlyGenerative = false
}: {
  apiKey?: string;
  baseUrl?: string;
  onlyGenerative?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required to list Gemini models via ModelService.ListModels');
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const allModels: any[] = [];
  let pageToken: string | null = null;

  do {
    let url = `${cleanBase}/models?key=${apiKey}&pageSize=100`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err: any) {
      throw new Error(`Failed to connect to Gemini ModelService (${url}): ${err.message}`);
    }

    if (!res.ok) {
      const text = await res.text();
      let errMsg = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error?.message) errMsg = parsed.error.message;
      } catch {}
      throw new Error(`Gemini ModelService.ListModels error [${res.status}]: ${errMsg}`);
    }

    const data: any = await res.json();
    if (Array.isArray(data.models)) {
      allModels.push(...data.models);
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  const priorityList = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-pro-latest',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
    'gemini-3-flash-preview',
    'gemini-4-argon'
  ];

  return allModels
    .map((m: any): ModelCatalogEntry => {
      const id = m.name?.replace(/^models\//, '') || m.name;
      const methods: string[] = m.supportedGenerationMethods || [];
      return {
        id,
        name: m.name,
        displayName: m.displayName || id,
        description: m.description || '',
        supportedGenerationMethods: methods,
        canGenerate: methods.includes('generateContent'),
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        temperature: m.temperature,
        topP: m.topP,
        topK: m.topK,
        thinking: m.thinking,
        provider: 'gemini',
        target: 'cloud'
      };
    })
    .filter((m) => {
      if (!m.canGenerate) return false;
      const id = m.id.toLowerCase();
      const desc = (m.description || '').toLowerCase();
      const disp = (m.displayName || '').toLowerCase();
      if (/^(?:models\/)?(?:gemini-[12]\.|gemma|lyria|aqa|deep-research-pro-preview-12-2025)/i.test(m.name)) {
        return false;
      }
      if (
        id.includes('tts') ||
        id.includes('transcribe') ||
        id.includes('embedding') ||
        id.includes('robotics') ||
        id.includes('live-translate') ||
        id.includes('image') ||
        id.includes('banana') ||
        desc.includes('deprecated') ||
        desc.includes('rerouted') ||
        disp.includes('tts') ||
        disp.includes('transcribe') ||
        disp.includes('embedding')
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const idxA = priorityList.indexOf(a.id);
      const idxB = priorityList.indexOf(b.id);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.id.localeCompare(b.id);
    });
}

export async function listOpenAIModels({
  apiKey,
  baseUrl = 'https://api.openai.com/v1',
  onlyGenerative = false,
  provider = 'openai',
  apiKeyEnv = 'OPENAI_API_KEY'
}: Record<string, any>): Promise<ModelCatalogEntry[]> {
  if (!apiKey) {
    throw new Error(`${apiKeyEnv} is required to list ${provider} models`);
  }
  const cleanBase = baseUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${cleanBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
  } catch (err: any) {
    throw new Error(`Failed to connect to ${provider} API (${cleanBase}): ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${provider} ListModels error [${res.status}]: ${text}`);
  }

  const data: any = await res.json();
  const list: any[] = data.data || [];
  return list
    .map((m: any): ModelCatalogEntry => {
      const isChat = provider !== 'openai'
        ? !/embedding|rerank|tts|whisper|audio|image/i.test(m.id)
        : (m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('chatgpt'));
      return {
        id: m.id,
        name: m.id,
        displayName: m.id,
        description: `${provider} model owned by ${m.owned_by || provider}`,
        supportedGenerationMethods: isChat ? ['generateContent', 'chat'] : ['embed'],
        canGenerate: isChat,
        provider,
        target: 'cloud'
      };
    })
    .filter((m) => (!onlyGenerative ? true : m.canGenerate))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function listAnthropicModels({
  apiKey,
  baseUrl = 'https://api.anthropic.com/v1'
}: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<ModelCatalogEntry[]> {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to list Anthropic models');
  }
  const cleanBase = baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${cleanBase}/models`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    });
    if (res.ok) {
      const data: any = await res.json();
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map((m: any): ModelCatalogEntry => ({
          id: m.id,
          name: m.id,
          displayName: m.display_name || m.id,
          description: m.description || 'Anthropic Claude model',
          supportedGenerationMethods: ['generateContent'],
          canGenerate: true,
          provider: 'anthropic',
          target: 'cloud'
        }));
      }
    }
  } catch {}

  const known = [
    { id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', description: 'Most intelligent model for reasoning and coding' },
    { id: 'claude-3-5-haiku-20241022', displayName: 'Claude 3.5 Haiku', description: 'Fastest, most cost-effective Claude model' },
    { id: 'claude-3-opus-20240229', displayName: 'Claude 3 Opus', description: 'Powerful model for highly complex tasks' }
  ];
  return known.map((m) => ({
    ...m,
    name: m.id,
    supportedGenerationMethods: ['generateContent'],
    canGenerate: true,
    provider: 'anthropic',
    target: 'cloud' as const
  }));
}

async function listLocalOpenAICompatModels(
  provider: 'lmstudio' | 'vllm',
  baseUrl: string,
  label: string
): Promise<ModelCatalogEntry[]> {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${cleanBase}/models`, { signal: AbortSignal.timeout(600) });
    if (!res.ok) return [];
    const data: any = await res.json();
    return (data.data || []).map((m: any): ModelCatalogEntry => ({
      id: m.id,
      name: m.id,
      displayName: m.id,
      description: `${label} (${m.owned_by || provider})`,
      supportedGenerationMethods: ['generateContent'],
      canGenerate: true,
      provider,
      target: 'local'
    }));
  } catch {
    return [];
  }
}

export async function listLMStudioModels({ baseUrl = 'http://127.0.0.1:1234/v1' } = {}) {
  return listLocalOpenAICompatModels('lmstudio', baseUrl, 'Local LM Studio model');
}

export async function listVLLMModels({ baseUrl = 'http://127.0.0.1:8000/v1' } = {}) {
  return listLocalOpenAICompatModels('vllm', baseUrl, 'Local vLLM server model');
}

export function listLocalSafetensorsModels(options: Record<string, any> = {}): ModelCatalogEntry[] {
  const dirPath = options.localModelPath || process.env.LOCAL_MODEL_PATH;
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  try {
    const files = fs.readdirSync(dirPath);
    const shardCount = files.filter((f) => f.endsWith('.safetensors')).length;
    if (shardCount === 0) return [];

    let cfg: Record<string, any> = {};
    const cfgPath = path.join(dirPath, 'config.json');
    if (fs.existsSync(cfgPath)) {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }

    const folderName = path.basename(dirPath);
    const id = folderName.toLowerCase().replace(/\s+/g, '');
    const arch = cfg.architectures?.[0] || cfg.model_type || 'safetensors';
    const maxPos = cfg.text_config?.max_position_embeddings || cfg.max_position_embeddings || 131072;

    return [
      {
        id,
        name: id,
        displayName: `${folderName} (Safetensors)`,
        description: `Local Hugging Face model (${shardCount} safetensors shards, ${arch}) at ${dirPath}`,
        supportedGenerationMethods: ['generateContent'],
        canGenerate: true,
        inputTokenLimit: maxPos,
        outputTokenLimit: 8192,
        provider: 'vllm',
        target: 'local',
        localPath: dirPath
      }
    ];
  } catch {
    return [];
  }
}

export function listOMModels(): ModelCatalogEntry[] {
  return [
    {
      id: 'om-v1',
      name: 'om-v1',
      displayName: 'OM v1',
      description: 'Default local provider simulating full tool calling and reasoning without API keys.',
      supportedGenerationMethods: ['generateContent'],
      canGenerate: true,
      inputTokenLimit: 128000,
      outputTokenLimit: 4096,
      provider: 'om',
      target: 'local'
    },
    {
      id: 'om-turbo',
      name: 'om-turbo',
      displayName: 'OM Turbo',
      description: 'Ultra-fast local simulation for automated testing.',
      supportedGenerationMethods: ['generateContent'],
      canGenerate: true,
      inputTokenLimit: 128000,
      outputTokenLimit: 4096,
      provider: 'om',
      target: 'local'
    },
    {
      id: 'om-reasoning',
      name: 'om-reasoning',
      displayName: 'OM Reasoning',
      description: 'Simulates chain-of-thought and multi-step tool calls.',
      supportedGenerationMethods: ['generateContent'],
      canGenerate: true,
      inputTokenLimit: 128000,
      outputTokenLimit: 8192,
      provider: 'om',
      target: 'local'
    }
  ];
}

export async function listCompatCloudModels(
  provider: 'deepseek' | 'kimi' | 'qwen' | 'glm',
  options: Record<string, any> = {}
): Promise<ModelCatalogEntry[]> {
  const config = options.config || loadConfig();
  const spec = COMPAT_SPECS[provider];
  const provCfg = config.providers?.[provider] || {};
  const apiKey = options.apiKey || provCfg.apiKey || spec.apiKeyEnvs.map((k) => process.env[k]).find(Boolean);
  const baseUrl = options.baseUrl || provCfg.baseUrl || spec.baseUrlEnvs.map((k) => process.env[k]).find(Boolean) || spec.baseUrl;

  const fallbackModels: ModelCatalogEntry[] = spec.fallback.map((m) => ({
    id: m.id,
    name: m.id,
    displayName: m.displayName,
    description: m.description,
    supportedGenerationMethods: ['generateContent', 'chat'],
    canGenerate: true,
    provider,
    target: 'cloud'
  }));

  if (!apiKey) {
    return fallbackModels;
  }

  try {
    const liveModels = await listOpenAIModels({
      provider,
      apiKeyEnv: spec.apiKeyEnvs[0],
      apiKey,
      baseUrl,
      onlyGenerative: options.onlyGenerative ?? true
    });
    if (liveModels.length === 0) return fallbackModels;
    if (provider === 'glm' && !liveModels.some((m) => m.id === 'glm-4.5-flash')) {
      return [fallbackModels[0], ...liveModels];
    }
    return liveModels;
  } catch {
    return fallbackModels;
  }
}
