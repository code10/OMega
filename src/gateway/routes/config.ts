import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { readJsonBody, sendJson } from '../httpUtils.js';
import { saveConfigPatch } from '../../config.js';
import { collectDeviceSpecs } from '../../deviceSpecs.js';

export interface ConfigRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  pathname: string;
  url: URL;
  agent: any;
  sessionManager: any;
  persistConfig: boolean;
}

/**
 * Handle /api/provider, /api/models, and /api/system-prompt routes.
 */
export async function handleConfigRoutes(ctx: ConfigRouteContext): Promise<boolean> {
  const { req, res, pathname, url, agent, sessionManager, persistConfig } = ctx;

  // POST /api/provider (Switch provider/model dynamically)
  if (pathname === '/api/provider' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    const { provider, model } = data;
    if (!provider || typeof provider !== 'string') {
      sendJson(res, 400, { error: 'provider is required' });
      return true;
    }
    try {
      sessionManager.setProvider(provider, model);
      if (persistConfig) {
        saveConfigPatch(
          { provider: agent.config.provider, model: agent.config.model },
          agent.config.rootDir
        );
      }
      sendJson(res, 200, {
        success: true,
        name: 'OMega',
        provider: agent.config.provider,
        model: agent.config.model,
        target: agent._getTarget(),
        skillsCount: Array.isArray(agent.skills?.list?.()) ? agent.skills.list().length : undefined,
        sessionId: agent.sessionId,
        memoryDir: agent.config.memoryDir,
        workspaceDir: agent.config.workspaceDir
      });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  // GET /api/models (List available models via ModelService.ListModels)
  if (pathname === '/api/models' && req.method === 'GET') {
    try {
      const providerParam = url.searchParams.get('provider');
      const scopeParam = url.searchParams.get('scope'); // 'cloud' | 'local' | 'all'
      const targetProvider = providerParam || 'all';
      let models = await agent.listModels(targetProvider, { scope: scopeParam });

      if (scopeParam === 'cloud') {
        models = models.filter((m: any) => m.target === 'cloud');
      } else if (scopeParam === 'local') {
        models = models.filter((m: any) => m.target === 'local');
      }

      sendJson(res, 200, {
        success: true,
        provider: agent.config.provider,
        model: agent.config.model,
        target: agent._getTarget(),
        count: models.length,
        models
      });
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // /api/system-prompt (GET & POST)
  if (pathname === '/api/system-prompt' && (req.method === 'GET' || req.method === 'POST')) {
    const systemPromptsFile = path.join(agent.config.memoryDir || './memory', 'system_prompts.json');

    const readSavedPrompts = (): Array<{ id: string; prompt: string; updatedAt: string }> => {
      try {
        if (!fs.existsSync(systemPromptsFile)) return [];
        const parsed = JSON.parse(fs.readFileSync(systemPromptsFile, 'utf8'));
        return Array.isArray(parsed.savedPrompts) ? parsed.savedPrompts : [];
      } catch (_) {
        return [];
      }
    };

    const persistSystemPrompt = (promptText: string) => {
      try {
        const dir = path.dirname(systemPromptsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const existing = readSavedPrompts().filter((p) => p.prompt !== promptText);
        const entry = {
          id: `prompt_${Date.now()}`,
          prompt: promptText,
          updatedAt: new Date().toISOString()
        };
        const savedPrompts = [entry, ...existing].slice(0, 50);
        fs.writeFileSync(
          systemPromptsFile,
          JSON.stringify({ activePrompt: promptText, savedPrompts }, null, 2),
          'utf8'
        );
        return savedPrompts;
      } catch (_) {
        return [];
      }
    };

    if (req.method === 'GET') {
      sendJson(res, 200, {
        success: true,
        systemPrompt: agent.config.systemPrompt,
        temperature: agent.config.temperature ?? 0.2,
        savedPrompts: readSavedPrompts(),
        savedTo: systemPromptsFile
      });
      return true;
    }

    // POST /api/system-prompt
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;
    const { systemPrompt, temperature } = data;

    let parsedTemp: number | undefined;
    if (temperature !== undefined) {
      parsedTemp = typeof temperature === 'number' ? temperature : parseFloat(String(temperature));
      if (!Number.isFinite(parsedTemp) || parsedTemp < 0 || parsedTemp > 2) {
        sendJson(res, 400, {
          success: false,
          error: 'temperature must be a finite number between 0 and 2'
        });
        return true;
      }
    }

    let savedPrompts = readSavedPrompts();
    const configPatch: { systemPrompt?: string; temperature?: number } = {};

    if (systemPrompt !== undefined) {
      agent.config.systemPrompt = String(systemPrompt);
      savedPrompts = persistSystemPrompt(agent.config.systemPrompt);
      configPatch.systemPrompt = agent.config.systemPrompt;
    }
    if (parsedTemp !== undefined) {
      agent.config.temperature = parsedTemp;
      configPatch.temperature = parsedTemp;
    }

    if (persistConfig && Object.keys(configPatch).length > 0) {
      saveConfigPatch(configPatch, agent.config.rootDir);
    }

    sendJson(res, 200, {
      success: true,
      systemPrompt: agent.config.systemPrompt,
      temperature: agent.config.temperature ?? 0.2,
      savedPrompts,
      savedTo: systemPromptsFile
    });
    return true;
  }

  // GET /api/routing (Routing config, fallback chain readiness, and masked provider key status)
  if (pathname === '/api/routing' && req.method === 'GET') {
    const routingCfg = agent.router?.routingConfig || agent.config.routing || {};
    const providersCfg: Record<string, any> = agent.config.providers || {};
    const localProviders = new Set(['om', 'mock', 'omega', 'lmstudio', 'vllm', 'ollama', 'local']);

    const maskSecret = (val?: string) => {
      if (!val) return '';
      if (val.length <= 6) return '••••';
      return `••••${val.slice(-4)}`;
    };

    const getProviderKeyEnv = (provName: string): string | null => {
      const key = provName.toLowerCase();
      if (providersCfg[key]?.apiKeyEnv) return String(providersCfg[key].apiKeyEnv);
      if (key === 'gemini' || key === 'google') return 'GEMINI_API_KEY';
      if (key === 'openai') return 'OPENAI_API_KEY';
      if (key === 'anthropic') return 'ANTHROPIC_API_KEY';
      return null;
    };

    const rawChain: Array<{ provider: string; model: string }> = Array.isArray(routingCfg.fallbackChain)
      ? routingCfg.fallbackChain
      : [];

    const fallbackChain = rawChain.map((entry) => {
      const prov = String(entry.provider || '').toLowerCase();
      const isLocal = localProviders.has(prov);
      const envName = getProviderKeyEnv(prov);
      const hasKey = envName ? Boolean(process.env[envName]?.trim()) : true;
      return {
        provider: entry.provider,
        model: entry.model,
        isLocal,
        ready: isLocal || hasKey,
        reason: isLocal ? 'Local' : (hasKey ? 'Ready' : `Missing ${envName}`)
      };
    });

    const providerNames = Array.from(
      new Set(['gemini', 'openai', 'anthropic', 'vllm', 'om', ...Object.keys(providersCfg)])
    );
    const providers = providerNames.map((id) => {
      const cfg = providersCfg[id] || {};
      const isLocal = localProviders.has(id.toLowerCase());
      const apiKeyEnv = getProviderKeyEnv(id);
      const rawKey = apiKeyEnv ? (process.env[apiKeyEnv] || '').trim() : '';
      return {
        id,
        model: cfg.model || null,
        baseUrl: cfg.baseUrl || null,
        isLocal,
        apiKeyEnv,
        hasKey: isLocal ? true : Boolean(rawKey),
        maskedKey: rawKey ? maskSecret(rawKey) : ''
      };
    });

    sendJson(res, 200, {
      success: true,
      enabled: routingCfg.enabled !== false,
      maxRetries: Number.isFinite(routingCfg.maxRetries) ? routingCfg.maxRetries : 1,
      autoHandoffOnContextLimit: routingCfg.autoHandoffOnContextLimit !== false,
      activeProvider: agent.config.provider,
      activeModel: agent.config.model,
      target: agent._getTarget(),
      stats: agent.router?.getStats() || {},
      fallbackChain,
      providers
    });
    return true;
  }

  // POST /api/routing (Update routing.enabled, maxRetries, autoHandoffOnContextLimit)
  if (pathname === '/api/routing' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;

    const currentRouting = { ...(agent.config.routing || {}) };
    if (typeof data.enabled === 'boolean') {
      currentRouting.enabled = data.enabled;
      if (agent.router?.routingConfig) agent.router.routingConfig.enabled = data.enabled;
    }
    if (data.maxRetries !== undefined) {
      const retries = Number(data.maxRetries);
      if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
        sendJson(res, 400, { success: false, error: 'maxRetries must be an integer between 0 and 5' });
        return true;
      }
      currentRouting.maxRetries = retries;
      if (agent.router?.routingConfig) agent.router.routingConfig.maxRetries = retries;
    }
    if (typeof data.autoHandoffOnContextLimit === 'boolean') {
      currentRouting.autoHandoffOnContextLimit = data.autoHandoffOnContextLimit;
      if (agent.router?.routingConfig) {
        agent.router.routingConfig.autoHandoffOnContextLimit = data.autoHandoffOnContextLimit;
      }
    }

    agent.config.routing = currentRouting;
    if (persistConfig) {
      saveConfigPatch({ routing: currentRouting }, agent.config.rootDir);
    }

    sendJson(res, 200, {
      success: true,
      enabled: currentRouting.enabled !== false,
      maxRetries: currentRouting.maxRetries ?? 1,
      autoHandoffOnContextLimit: currentRouting.autoHandoffOnContextLimit !== false
    });
    return true;
  }

  // POST /api/providers/keys (Update or clear a known provider API key in process.env and .env)
  if (pathname === '/api/providers/keys' && req.method === 'POST') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return true;

    const envName = typeof data.apiKeyEnv === 'string' ? data.apiKeyEnv.trim() : '';
    const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';

    const allowedEnvVars = new Set<string>(['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
    const providersCfg: Record<string, any> = agent.config.providers || {};
    for (const cfg of Object.values(providersCfg)) {
      if (cfg && typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv.trim()) {
        allowedEnvVars.add(cfg.apiKeyEnv.trim());
      }
    }

    if (!envName || !allowedEnvVars.has(envName)) {
      sendJson(res, 400, { success: false, error: 'Unsupported or missing apiKeyEnv' });
      return true;
    }

    if (apiKey) {
      process.env[envName] = apiKey;
    } else {
      delete process.env[envName];
    }

    const rootDir = agent.config.rootDir || process.cwd();
    const envPath = path.join(rootDir, '.env');
    try {
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      const lines = existing ? existing.split(/\r?\n/) : [];
      const prefix = `${envName}=`;
      const filtered = lines.filter((line) => !line.startsWith(prefix));
      if (apiKey) {
        filtered.push(`${envName}=${apiKey}`);
      }
      const nextContent = filtered.filter((line, idx, arr) => !(idx === arr.length - 1 && line === '')).join('\n');
      fs.writeFileSync(envPath, nextContent ? `${nextContent}\n` : '', 'utf8');
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: `Updated runtime env, but failed to write .env: ${err.message}` });
      return true;
    }

    sendJson(res, 200, {
      success: true,
      apiKeyEnv: envName,
      hasKey: Boolean(apiKey)
    });
    return true;
  }

  // GET /api/device-specs (Hardware CPU/GPU/NPU/VRAM/RAM + Core Engine & Laya specs)
  if (pathname === '/api/device-specs' && req.method === 'GET') {
    try {
      const specs = await collectDeviceSpecs(agent);
      sendJson(res, 200, { success: true, ...specs });
    } catch (err: any) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  return false;
}
