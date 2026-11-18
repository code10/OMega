import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OMConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Lightweight .env parser (zero external dependencies)
 * @param {string} [customPath] - Optional path to .env file
 * @param {boolean} [override=false] - Whether to overwrite existing process.env keys
 */
export function loadEnv(customPath?: string, override = false) {
  const envPath = customPath || path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (override || !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/**
 * Load and merge config from om.config.json and environment.
 */
export function loadConfig(overrides: Record<string, any> = {}): OMConfig {
  loadEnv(undefined, Boolean(overrides.reloadEnv));

  const configPath = path.join(ROOT_DIR, 'om.config.json');
  let fileConfig: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err: any) {
      console.warn(`[OM Config] Warning: Could not parse om.config.json: ${err.message}`);
    }
  }

  // Resolve directory paths relative to project root
  const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p));

  let provider = (overrides.provider || process.env.OM_PROVIDER || fileConfig.provider || 'auto').toLowerCase();
  const providerAliases: Record<string, string> = {
    mock: 'om',
    omega: 'om',
    moonshot: 'kimi',
    dashscope: 'qwen',
    zhipu: 'glm'
  };
  if (providerAliases[provider]) {
    provider = providerAliases[provider];
  }

  // Auto-detect real LLM provider only when set to 'auto'
  if (provider === 'auto') {
    if (process.env.GEMINI_API_KEY) {
      provider = 'gemini';
    } else if (process.env.OPENAI_API_KEY) {
      provider = 'openai';
    } else if (process.env.ANTHROPIC_API_KEY) {
      provider = 'anthropic';
    } else if (process.env.DEEPSEEK_API_KEY) {
      provider = 'deepseek';
    } else if (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) {
      provider = 'kimi';
    } else if (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) {
      provider = 'qwen';
    } else if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY) {
      provider = 'glm';
    } else {
      provider = 'om';
    }
  }

  const defaultModels: Record<string, string> = {
    gemini: fileConfig.providers?.gemini?.model || 'gemini-3-flash-preview',
    openai: fileConfig.providers?.openai?.model || 'gpt-4o',
    anthropic: fileConfig.providers?.anthropic?.model || 'claude-3-5-sonnet-20241022',
    deepseek: fileConfig.providers?.deepseek?.model || 'deepseek-chat',
    kimi: fileConfig.providers?.kimi?.model || 'kimi-k2-0711-preview',
    qwen: fileConfig.providers?.qwen?.model || 'qwen-plus',
    glm: fileConfig.providers?.glm?.model || 'glm-4.5-flash',
    vllm: process.env.VLLM_MODEL || fileConfig.providers?.vllm?.model || 'default',
    lmstudio: process.env.LMSTUDIO_MODEL || fileConfig.providers?.lmstudio?.model || 'local-model',
    om: (fileConfig.providers?.om?.model || fileConfig.providers?.mock?.model || 'om-turbo').replace(/^om-mock-/, 'om-')
  };

  let model = overrides.model || process.env.OM_MODEL || defaultModels[provider] || fileConfig.model || 'om-turbo';
  if (typeof model === 'string' && model.startsWith('om-mock-')) {
    model = model.replace('om-mock-', 'om-');
  }

  return {
    ...fileConfig,
    ...overrides,
    rootDir: ROOT_DIR,
    provider,
    model,
    memoryDir: resolvePath(overrides.memoryDir || fileConfig.memoryDir || './memory'),
    skillsDir: resolvePath(overrides.skillsDir || fileConfig.skillsDir || './skills'),
    workspaceDir: resolvePath(overrides.workspaceDir || fileConfig.workspaceDir || './workspace'),
    maxSteps: Number(overrides.maxSteps || fileConfig.maxSteps || 15),
    routing: {
      enabled: true,
      maxRetries: 1,
      autoHandoffOnContextLimit: true,
      fallbackChain: [
        { provider: 'gemini', model: 'gemini-3-flash-preview' },
        { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
        { provider: 'om', model: 'om-reasoning' }
      ],
      ...(fileConfig.routing || {}),
      ...(overrides.routing || {})
    },
    systemOne: {
      device: overrides.systemOne?.device || fileConfig.systemOne?.device || 'auto',
      dtype: overrides.systemOne?.dtype || fileConfig.systemOne?.dtype || 'q8',
      model: overrides.systemOne?.model || fileConfig.systemOne?.model || '',
      complexityRouting: overrides.systemOne?.complexityRouting ?? fileConfig.systemOne?.complexityRouting ?? true,
      riskGating: overrides.systemOne?.riskGating ?? fileConfig.systemOne?.riskGating ?? true,
      riskThreshold: Number(overrides.systemOne?.riskThreshold ?? fileConfig.systemOne?.riskThreshold ?? 0.45),
      toolShortlisting: overrides.systemOne?.toolShortlisting ?? fileConfig.systemOne?.toolShortlisting ?? true,
      toolShortlistK: Number(overrides.systemOne?.toolShortlistK ?? fileConfig.systemOne?.toolShortlistK ?? 20),
      selfHealTriage: overrides.systemOne?.selfHealTriage ?? fileConfig.systemOne?.selfHealTriage ?? true,
      ...(fileConfig.systemOne || {}),
      ...(overrides.systemOne || {}),
      enabled: (process.env.NODE_TEST_CONTEXT && overrides.systemOne?.enabled === undefined)
        ? false
        : Boolean(overrides.systemOne?.enabled ?? fileConfig.systemOne?.enabled ?? false),
    },
    security: {
      requireConfirmationForShell: true,
      requireConfirmationForTools: ['exec_command', 'http_request'],
      allowedCommands: ['node', 'git', 'python', 'python3'],
      deniedCommands: ['format', 'rm -rf /', 'del /f /s /q C:\\*'],
      ...(fileConfig.security || {}),
      ...(overrides.security || {})
    },
    gateway: {
      ...(fileConfig.gateway || {}),
      ...(overrides.gateway || {}),
      port: Number(process.env.OM_GATEWAY_PORT || overrides.port || overrides.gateway?.port || fileConfig.gateway?.port || 3000),
      host: overrides.host || overrides.gateway?.host || fileConfig.gateway?.host || '127.0.0.1',
      openBrowser: Boolean(overrides.gateway?.openBrowser ?? fileConfig.gateway?.openBrowser ?? false),
    },
    embedding: {
      url: overrides.embedding?.url || process.env.OM_EMBEDDING_URL || fileConfig.embedding?.url || '',
      model: overrides.embedding?.model || process.env.OM_EMBEDDING_MODEL || fileConfig.embedding?.model || 'text-embedding-3-small',
      apiKey: overrides.embedding?.apiKey || process.env.OM_EMBEDDING_API_KEY || fileConfig.embedding?.apiKey || ''
    },
    llmCompaction: overrides.llmCompaction ?? (process.env.OM_LLM_COMPACTION === 'true' || Boolean(fileConfig.llmCompaction)),
    selfHeal: {
      enabled: false,
      autoCommit: true,
      testCommand: 'npm test',
      maxHealAttempts: 1,
      maxSubagentSteps: 6,
      healOnToolFailure: true,
      healOnUnhandledError: true,
      ...(fileConfig.selfHeal && typeof fileConfig.selfHeal === 'object' ? fileConfig.selfHeal : {}),
      ...(overrides.selfHeal === true
        ? { enabled: true }
        : overrides.selfHeal === false
          ? { enabled: false }
          : overrides.selfHeal && typeof overrides.selfHeal === 'object'
            ? overrides.selfHeal
            : {})
    }
  };
}

/**
 * Persist the active provider and model to om.config.json and .env so it remains active on next launch
 */
export function persistActiveProvider(provider: string, model?: string) {
  const configPath = path.join(ROOT_DIR, 'om.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fileConfig.provider = provider;
      if (model) {
        fileConfig.model = model;
        if (fileConfig.providers && fileConfig.providers[provider]) {
          fileConfig.providers[provider].model = model;
        }
      }
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n', 'utf8');
    } catch (err: any) {
      console.warn(`[OM Config] Warning: Could not persist om.config.json: ${err.message}`);
    }
  }

  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    try {
      let envContent = fs.readFileSync(envPath, 'utf8');
      if (/^OM_PROVIDER=/m.test(envContent)) {
        envContent = envContent.replace(/^OM_PROVIDER=.*$/m, `OM_PROVIDER=${provider}`);
      } else {
        envContent = `OM_PROVIDER=${provider}\n` + envContent;
      }
      process.env.OM_PROVIDER = provider;

      if (model) {
        if (/^OM_MODEL=/m.test(envContent)) {
          envContent = envContent.replace(/^OM_MODEL=.*$/m, `OM_MODEL=${model}`);
        } else if (/^#\s*OM_MODEL=/m.test(envContent)) {
          envContent = envContent.replace(/^#\s*OM_MODEL=.*$/m, `OM_MODEL=${model}`);
        }
        process.env.OM_MODEL = model;
      }

      fs.writeFileSync(envPath, envContent, 'utf8');
    } catch (err: any) {
      console.warn(`[OM Config] Warning: Could not persist .env: ${err.message}`);
    }
  }
}

/**
 * Persist a partial runtime config update (e.g. temperature, systemPrompt, provider, model)
 * back to om.config.json when present.
 */
export function saveConfigPatch(
  patch: Partial<Pick<OMConfig, 'provider' | 'model' | 'temperature' | 'systemPrompt' | 'routing'>>,
  rootDir: string = ROOT_DIR
): boolean {
  const configPath = path.join(rootDir, 'om.config.json');
  if (!fs.existsSync(configPath)) return false;

  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (patch.provider !== undefined) fileConfig.provider = patch.provider;
    if (patch.model !== undefined) fileConfig.model = patch.model;
    if (patch.temperature !== undefined) fileConfig.temperature = patch.temperature;
    if (patch.systemPrompt !== undefined) fileConfig.systemPrompt = patch.systemPrompt;
    if (patch.routing !== undefined) {
      fileConfig.routing = { ...(fileConfig.routing || {}), ...patch.routing };
    }

    fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n', 'utf8');
    return true;
  } catch (err: any) {
    console.warn(`[OM Config] Warning: Could not save config patch to om.config.json: ${err.message}`);
    return false;
  }
}
