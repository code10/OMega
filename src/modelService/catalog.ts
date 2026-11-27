import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import type { HardwareProfile } from '../deviceSpecs.js';

export interface ModelHardwareFit {
  status: 'optimal' | 'fits' | 'tight' | 'unsupported';
  mode: 'gpu' | 'cpu' | 'unified' | 'simulator';
  estimatedVramGb?: number;
  estimatedRamGb?: number;
  paramsB?: number;
  quantization?: string;
  reason: string;
}

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
  hardwareFit?: ModelHardwareFit;
  recommended?: boolean;
  installed?: boolean;
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

function normalizeLocalModelId(folderName: string): string {
  return folderName.trim().toLowerCase().replace(/\s+/g, '-');
}

function inspectSafetensorsDir(dirPath: string): ModelCatalogEntry | null {
  if (!dirPath || !fs.existsSync(dirPath)) return null;
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return null;
    const files = fs.readdirSync(dirPath);
    const shardFiles = files.filter((f) => f.endsWith('.safetensors'));
    const onnxFiles = files.filter((f) => f.endsWith('.onnx'));
    const onnxSubDir = path.join(dirPath, 'onnx');
    const hasSubOnnx = fs.existsSync(onnxSubDir) && fs.statSync(onnxSubDir).isDirectory()
      && fs.readdirSync(onnxSubDir).some((f) => f.endsWith('.onnx'));
    const isOnnx = onnxFiles.length > 0 || hasSubOnnx;
    const shardCount = shardFiles.length;
    if (shardCount === 0 && !isOnnx) return null;

    let totalWeightBytes = 0;
    for (const f of [...shardFiles, ...onnxFiles]) {
      try {
        totalWeightBytes += fs.statSync(path.join(dirPath, f)).size;
      } catch {}
    }

    let cfg: Record<string, any> = {};
    const cfgPath = path.join(dirPath, 'config.json');
    if (fs.existsSync(cfgPath)) {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }

    const folderName = path.basename(dirPath);
    const id = normalizeLocalModelId(folderName);
    const arch = cfg.architectures?.[0] || cfg.model_type || (isOnnx ? 'onnx' : 'safetensors');
    const maxPos = cfg.text_config?.max_position_embeddings || cfg.max_position_embeddings || 131072;
    const weightGb = totalWeightBytes > 0 ? Math.round((totalWeightBytes / (1024 ** 3)) * 10) / 10 : 0;
    const sizeNote = weightGb > 0 ? `, ${weightGb} GB on disk` : '';
    const formatNote = isOnnx ? 'ONNX in-process' : `${shardCount} safetensors shard${shardCount === 1 ? '' : 's'}`;

    return {
      id,
      name: id,
      displayName: `${folderName} (Local)`,
      description: `Installed local model (${formatNote}${sizeNote}, ${arch}) — direct zero-port execution at ${dirPath}`,
      supportedGenerationMethods: ['generateContent'],
      canGenerate: true,
      inputTokenLimit: maxPos,
      outputTokenLimit: 8192,
      provider: 'local',
      target: 'local',
      localPath: dirPath,
      installed: true
    };
  } catch {
    return null;
  }
}

function getDefaultLocalModelScanRoots(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'models'),
    path.join(home, 'Documents', 'models'),
    path.join(home, '.lmstudio', 'models'),
    path.join(home, '.cache', 'lm-studio', 'models'),
    path.join(process.cwd(), 'models')
  ];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    const key = resolved.toLowerCase();
    if (!seen.has(key) && fs.existsSync(resolved)) {
      seen.add(key);
      unique.push(resolved);
    }
  }
  return unique;
}

export function listLocalSafetensorsModels(options: Record<string, any> = {}): ModelCatalogEntry[] {
  const seen = new Map<string, ModelCatalogEntry>();
  const addDir = (dirPath?: string, explicitId?: string) => {
    if (!dirPath) return;
    const entry = inspectSafetensorsDir(dirPath);
    if (!entry) return;
    if (explicitId) {
      entry.id = explicitId;
      entry.name = explicitId;
    }
    if (!seen.has(entry.id)) {
      seen.set(entry.id, entry);
    }
  };

  const scanRoot = (rootDir?: string) => {
    if (!rootDir || !fs.existsSync(rootDir)) return;
    try {
      for (const dirent of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
        addDir(path.join(rootDir, dirent.name));
      }
    } catch {
      // Ignore unreadable parent directories
    }
  };

  // 1. Explicit single model path (LOCAL_MODEL_PATH)
  const singlePath = options.localModelPath || process.env.LOCAL_MODEL_PATH;
  addDir(singlePath);

  // 2. Explicit map in config.providers.vllm.localModels (id -> path)
  const localModelsMap = options.config?.providers?.vllm?.localModels;
  if (localModelsMap && typeof localModelsMap === 'object') {
    for (const [id, dirPath] of Object.entries(localModelsMap)) {
      if (typeof dirPath === 'string') addDir(dirPath, id);
    }
  }

  // 3. Scan configured directory of model folders (LOCAL_MODELS_DIR or options.modelsDir / options.localModelsDir)
  const explicitModelsRoot = options.localModelsDir || options.modelsDir;
  if (explicitModelsRoot) {
    scanRoot(explicitModelsRoot);
  } else {
    scanRoot(process.env.LOCAL_MODELS_DIR);
    // 4. Auto-scan current PC's common model locations unless explicitly disabled
    if (options.autoScanHost !== false) {
      for (const rootDir of getDefaultLocalModelScanRoots()) {
        scanRoot(rootDir);
      }
    }
  }

  return Array.from(seen.values());
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
      target: 'local',
      installed: true
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
      target: 'local',
      installed: true
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
      target: 'local',
      installed: true
    }
  ];
}

interface CuratedLocalModelSpec {
  id: string;
  displayName: string;
  description: string;
  paramsB: number;
  quantization: string;
  estimatedVramGb: number;
  estimatedRamGb: number;
  inputTokenLimit: number;
  outputTokenLimit: number;
  cpuFriendly: boolean;
}

const CURATED_LOCAL_MODELS: CuratedLocalModelSpec[] = [
  // Ultra-lightweight (CPU-only & low RAM)
  {
    id: 'llama-3.2-1b-instruct',
    displayName: 'Llama 3.2 1B Instruct',
    description: 'Ultra-lightweight 1B local model optimized for fast CPU-only inference.',
    paramsB: 1,
    quantization: 'Q4_K_M',
    estimatedVramGb: 1.0,
    estimatedRamGb: 2.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 4096,
    cpuFriendly: true
  },
  {
    id: 'gemma-3-1b-it',
    displayName: 'Gemma 3 1B',
    description: 'Compact Google Gemma 3 model for low-RAM and CPU-only laptops.',
    paramsB: 1,
    quantization: 'Q4_K_M',
    estimatedVramGb: 1.0,
    estimatedRamGb: 2.0,
    inputTokenLimit: 32768,
    outputTokenLimit: 4096,
    cpuFriendly: true
  },
  {
    id: 'qwen2.5-1.5b-instruct',
    displayName: 'Qwen 2.5 1.5B Instruct',
    description: 'Fast 1.5B general & coding assistant that runs smoothly on CPU.',
    paramsB: 1.5,
    quantization: 'Q4_K_M',
    estimatedVramGb: 1.3,
    estimatedRamGb: 2.5,
    inputTokenLimit: 32768,
    outputTokenLimit: 4096,
    cpuFriendly: true
  },
  {
    id: 'qwen2.5-3b-instruct',
    displayName: 'Qwen 2.5 3B Instruct',
    description: 'Balanced 3B local model for CPU-only PCs with 8 GB+ RAM or entry GPUs.',
    paramsB: 3,
    quantization: 'Q4_K_M',
    estimatedVramGb: 2.3,
    estimatedRamGb: 4.0,
    inputTokenLimit: 32768,
    outputTokenLimit: 4096,
    cpuFriendly: true
  },
  {
    id: 'llama-3.2-3b-instruct',
    displayName: 'Llama 3.2 3B Instruct',
    description: 'Capable 3B instruction-following model suited for CPU or 4 GB GPUs.',
    paramsB: 3,
    quantization: 'Q4_K_M',
    estimatedVramGb: 2.4,
    estimatedRamGb: 4.2,
    inputTokenLimit: 131072,
    outputTokenLimit: 4096,
    cpuFriendly: true
  },
  {
    id: 'phi-4-mini-instruct',
    displayName: 'Phi-4 Mini (3.8B)',
    description: 'Strong reasoning and coding in a compact 3.8B footprint for CPU/entry GPU.',
    paramsB: 3.8,
    quantization: 'Q4_K_M',
    estimatedVramGb: 2.8,
    estimatedRamGb: 5.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 4096,
    cpuFriendly: true
  },
  // Entry GPU (4-6 GB VRAM) / 16 GB+ CPU
  {
    id: 'gemma-3-4b-it',
    displayName: 'Gemma 3 4B',
    description: 'Efficient 4B model ideal for 4-6 GB GPUs or 16 GB+ RAM CPU systems.',
    paramsB: 4,
    quantization: 'Q4_K_M',
    estimatedVramGb: 3.2,
    estimatedRamGb: 5.5,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: true
  },
  {
    id: 'qwen2.5-coder-7b-instruct',
    displayName: 'Qwen 2.5 Coder 7B',
    description: 'Dedicated 7B local coding model for 6-8 GB GPUs or 16-32 GB RAM CPUs.',
    paramsB: 7,
    quantization: 'Q4_K_M',
    estimatedVramGb: 5.0,
    estimatedRamGb: 8.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: true
  },
  {
    id: 'deepseek-r1-distill-qwen-7b',
    displayName: 'DeepSeek R1 Distill 7B',
    description: 'Local chain-of-thought reasoning model distilled into 7B parameters.',
    paramsB: 7,
    quantization: 'Q4_K_M',
    estimatedVramGb: 5.0,
    estimatedRamGb: 8.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: true
  },
  {
    id: 'llama-3.1-8b-instruct',
    displayName: 'Llama 3.1 8B Instruct',
    description: 'Versatile 8B local model with strong tool calling for 8 GB+ GPUs.',
    paramsB: 8,
    quantization: 'Q4_K_M',
    estimatedVramGb: 5.5,
    estimatedRamGb: 9.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: true
  },
  // Mid-Range GPU (8-16 GB VRAM)
  {
    id: 'gemma-3-12b-it',
    displayName: 'Gemma 3 12B',
    description: 'High-quality 12B local model tailored for 10-16 GB VRAM GPUs.',
    paramsB: 12,
    quantization: 'Q4_K_M',
    estimatedVramGb: 8.2,
    estimatedRamGb: 13.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'qwen2.5-coder-14b-instruct',
    displayName: 'Qwen 2.5 Coder 14B',
    description: 'Strong 14B local software engineering model for 12-16 GB VRAM GPUs.',
    paramsB: 14,
    quantization: 'Q4_K_M',
    estimatedVramGb: 9.5,
    estimatedRamGb: 15.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'deepseek-r1-distill-qwen-14b',
    displayName: 'DeepSeek R1 Distill 14B',
    description: 'Deep local reasoning 14B model suited for 12-16 GB VRAM GPUs.',
    paramsB: 14,
    quantization: 'Q4_K_M',
    estimatedVramGb: 9.5,
    estimatedRamGb: 15.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'phi-4-14b',
    displayName: 'Phi-4 14B',
    description: 'High-accuracy 14B reasoning & STEM model for 12-16 GB VRAM GPUs.',
    paramsB: 14,
    quantization: 'Q4_K_M',
    estimatedVramGb: 9.5,
    estimatedRamGb: 15.0,
    inputTokenLimit: 16384,
    outputTokenLimit: 4096,
    cpuFriendly: false
  },
  // High-VRAM GPU (16-32 GB VRAM)
  {
    id: 'mistral-small-24b-instruct',
    displayName: 'Mistral Small 24B',
    description: 'Fast 24B local model with strong tool calling for 16-24 GB VRAM GPUs.',
    paramsB: 24,
    quantization: 'Q4_K_M',
    estimatedVramGb: 15.5,
    estimatedRamGb: 24.0,
    inputTokenLimit: 32768,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'gemma-3-27b-it',
    displayName: 'Gemma 3 27B',
    description: 'Flagship local Gemma 3 27B model for 24 GB+ VRAM GPUs.',
    paramsB: 27,
    quantization: 'Q4_K_M',
    estimatedVramGb: 17.5,
    estimatedRamGb: 28.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'qwen3-coder-30b-a3b',
    displayName: 'Qwen 3 Coder 30B-A3B (MoE)',
    description: 'High-throughput 30B MoE coding model (3B active) for 24 GB+ VRAM GPUs.',
    paramsB: 30,
    quantization: 'Q4_K_M',
    estimatedVramGb: 19.0,
    estimatedRamGb: 30.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'qwen2.5-coder-32b-instruct',
    displayName: 'Qwen 2.5 Coder 32B',
    description: 'Top-tier 32B local coding & architecture model for 24 GB+ VRAM GPUs.',
    paramsB: 32,
    quantization: 'Q4_K_M',
    estimatedVramGb: 20.5,
    estimatedRamGb: 32.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'deepseek-r1-distill-qwen-32b',
    displayName: 'DeepSeek R1 Distill 32B',
    description: 'Frontier-class local 32B reasoning model for 24 GB+ VRAM GPUs.',
    paramsB: 32,
    quantization: 'Q4_K_M',
    estimatedVramGb: 20.5,
    estimatedRamGb: 32.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  // Workstation / Multi-GPU / High Unified Memory (48-80+ GB VRAM)
  {
    id: 'llama-3.3-70b-instruct',
    displayName: 'Llama 3.3 70B Instruct',
    description: 'Workstation-class 70B local model for 48-80 GB VRAM or 64 GB+ unified memory.',
    paramsB: 70,
    quantization: 'Q4_K_M',
    estimatedVramGb: 42.0,
    estimatedRamGb: 64.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'deepseek-r1-distill-llama-70b',
    displayName: 'DeepSeek R1 Distill 70B',
    description: 'Heavyweight 70B local reasoning model for multi-GPU or 48-80 GB VRAM workstations.',
    paramsB: 70,
    quantization: 'Q4_K_M',
    estimatedVramGb: 42.0,
    estimatedRamGb: 64.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  },
  {
    id: 'qwen2.5-72b-instruct',
    displayName: 'Qwen 2.5 72B Instruct',
    description: 'Flagship 72B local generalist & coding model for 48-80 GB+ VRAM workstations.',
    paramsB: 72,
    quantization: 'Q4_K_M',
    estimatedVramGb: 44.0,
    estimatedRamGb: 68.0,
    inputTokenLimit: 131072,
    outputTokenLimit: 8192,
    cpuFriendly: false
  }
];

export function estimateModelParamsB(idOrName: string): number | null {
  const s = String(idOrName || '').toLowerCase();
  const explicitMatch = s.match(/(?:^|[-_/\s])e?(\d+(?:\.\d+)?)b(?=$|[-_/\s.])/i);
  if (explicitMatch) {
    const val = Number(explicitMatch[1]);
    if (Number.isFinite(val) && val > 0 && val <= 1000) return val;
  }
  if (/\bmini\b/i.test(s)) return 3.8;
  if (/\btiny\b/i.test(s)) return 1.1;
  return null;
}

/**
 * Evaluate how well a local model fits the detected host hardware (CPU-only vs GPU VRAM).
 */
export function evaluateModelHardwareFit(
  model: {
    id: string;
    provider?: string;
    paramsB?: number;
    estimatedVramGb?: number;
    estimatedRamGb?: number;
    quantization?: string;
  },
  hardware: HardwareProfile
): ModelHardwareFit {
  const prov = (model.provider || '').toLowerCase();
  if (prov === 'om' || prov === 'mock' || prov === 'omega') {
    return {
      status: 'optimal',
      mode: 'simulator',
      estimatedRamGb: 0.1,
      reason: 'Built-in local simulator — runs on any CPU or GPU'
    };
  }

  const paramsB = model.paramsB ?? estimateModelParamsB(model.id) ?? 7;
  const quantization = model.quantization || 'Q4_K_M';
  const estVramGb = model.estimatedVramGb ?? Math.round((paramsB * 0.65 + 0.5) * 10) / 10;
  const estRamGb = model.estimatedRamGb ?? Math.round((paramsB * 0.78 + 1.5) * 10) / 10;

  if (hardware.hasGpu) {
    const mode = hardware.unifiedMemory ? 'unified' : 'gpu';
    const memLabel = hardware.unifiedMemory ? 'unified memory' : 'VRAM';
    const vram = hardware.totalVramGb;

    if (estVramGb <= vram * 0.85) {
      const isSweetSpot = paramsB >= hardware.recommendedMaxParamsB * 0.35 || vram <= 8;
      return {
        status: isSweetSpot ? 'optimal' : 'fits',
        mode,
        estimatedVramGb: estVramGb,
        estimatedRamGb: estRamGb,
        paramsB,
        quantization,
        reason: `${isSweetSpot ? 'Optimal' : 'Fits comfortably'} in ${vram} GB ${memLabel} (~${estVramGb} GB ${quantization})`
      };
    }

    if (estVramGb <= vram * 0.98) {
      return {
        status: 'tight',
        mode,
        estimatedVramGb: estVramGb,
        estimatedRamGb: estRamGb,
        paramsB,
        quantization,
        reason: `Tight fit in ${vram} GB ${memLabel} (~${estVramGb} GB ${quantization}; use shorter context)`
      };
    }

    if (estRamGb <= hardware.totalRamGb * 0.72 && paramsB <= 14) {
      return {
        status: 'tight',
        mode: 'cpu',
        estimatedVramGb: estVramGb,
        estimatedRamGb: estRamGb,
        paramsB,
        quantization,
        reason: `Exceeds ${vram} GB ${memLabel} — requires CPU/RAM offload (~${estRamGb} GB of ${hardware.totalRamGb} GB RAM)`
      };
    }

    return {
      status: 'unsupported',
      mode,
      estimatedVramGb: estVramGb,
      estimatedRamGb: estRamGb,
      paramsB,
      quantization,
      reason: `Requires ~${estVramGb} GB ${memLabel}; detected ${vram} GB`
    };
  }

  // CPU-only path
  const ram = hardware.totalRamGb;
  if (paramsB <= hardware.recommendedMaxParamsB && estRamGb <= ram * 0.65) {
    return {
      status: 'optimal',
      mode: 'cpu',
      estimatedVramGb: estVramGb,
      estimatedRamGb: estRamGb,
      paramsB,
      quantization,
      reason: `Optimal for CPU-only (${ram} GB RAM · ~${estRamGb} GB ${quantization})`
    };
  }

  if (estRamGb <= ram * 0.75 && paramsB <= 14) {
    return {
      status: 'fits',
      mode: 'cpu',
      estimatedVramGb: estVramGb,
      estimatedRamGb: estRamGb,
      paramsB,
      quantization,
      reason: `Runs on CPU (${ram} GB RAM · ~${estRamGb} GB ${quantization})`
    };
  }

  if (estRamGb <= ram * 0.88 && paramsB <= 14) {
    return {
      status: 'tight',
      mode: 'cpu',
      estimatedVramGb: estVramGb,
      estimatedRamGb: estRamGb,
      paramsB,
      quantization,
      reason: `Tight on CPU RAM (~${estRamGb} GB of ${ram} GB RAM; slower token/s)`
    };
  }

  return {
    status: 'unsupported',
    mode: 'cpu',
    estimatedVramGb: estVramGb,
    estimatedRamGb: estRamGb,
    paramsB,
    quantization,
    reason: `Too large for CPU-only ${ram} GB RAM (needs ~${estRamGb} GB RAM or ${estVramGb} GB GPU VRAM)`
  };
}

/**
 * List curated local models matched to the detected system's hardware capabilities.
 */
export function listHardwareMatchedLocalModels(
  hardware: HardwareProfile,
  options: { includeTight?: boolean; includeUnsupported?: boolean } = {}
): ModelCatalogEntry[] {
  const defaultProvider = hardware.recommendedRuntime === 'vllm' ? 'vllm' : 'lmstudio';
  const includeTight = options.includeTight === true;
  const includeUnsupported = options.includeUnsupported === true;

  const entries: ModelCatalogEntry[] = [];
  for (const spec of CURATED_LOCAL_MODELS) {
    const fit = evaluateModelHardwareFit(
      {
        id: spec.id,
        provider: defaultProvider,
        paramsB: spec.paramsB,
        estimatedVramGb: spec.estimatedVramGb,
        estimatedRamGb: spec.estimatedRamGb,
        quantization: spec.quantization
      },
      hardware
    );

    if (fit.status === 'unsupported' && !includeUnsupported) continue;
    if (fit.status === 'tight' && !includeTight && !includeUnsupported) continue;

    entries.push({
      id: spec.id,
      name: spec.id,
      displayName: spec.displayName,
      description: spec.description,
      supportedGenerationMethods: ['generateContent'],
      canGenerate: true,
      inputTokenLimit: spec.inputTokenLimit,
      outputTokenLimit: spec.outputTokenLimit,
      provider: defaultProvider,
      target: 'local',
      hardwareFit: fit,
      recommended: fit.status === 'optimal',
      installed: false
    });
  }

  // Sort: optimal first (larger capable models first for GPUs, or best-sized for CPU), then fits, then tight
  const rankStatus: Record<ModelHardwareFit['status'], number> = {
    optimal: 0,
    fits: 1,
    tight: 2,
    unsupported: 3
  };
  entries.sort((a, b) => {
    const sa = rankStatus[a.hardwareFit?.status || 'unsupported'];
    const sb = rankStatus[b.hardwareFit?.status || 'unsupported'];
    if (sa !== sb) return sa - sb;
    const pa = a.hardwareFit?.paramsB || 0;
    const pb = b.hardwareFit?.paramsB || 0;
    return pb - pa;
  });

  return entries;
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
