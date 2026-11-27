import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelService } from '../dist/modelService.js';
import { classifyHardwareProfile, detectSystemHardware } from '../dist/deviceSpecs.js';
import { OMAgent } from '../dist/agent.js';
import { SkillRegistry } from '../dist/skills/index.js';
import { OMProvider } from '../dist/providers/omega.js';
import { createProvider } from '../dist/providers/index.js';

test('ModelService and ListModels command verification', async (t) => {
  await t.test('ModelService.ListModels returns OM models when provider is om', async () => {
    const models = await ModelService.ListModels({ provider: 'om' });
    assert.ok(Array.isArray(models));
    assert.ok(models.length >= 3);
    assert.ok(models.some((m) => m.id === 'om-v1'));
    assert.ok(models.some((m) => m.id === 'om-turbo'));
    assert.ok(models.some((m) => m.id === 'om-reasoning'));
    assert.equal(models[0].provider, 'om');
  });

  await t.test('ModelService.listModels instance and static methods behave identically', async () => {
    const service = new ModelService({ provider: 'om' });
    const instanceList = await service.ListModels();
    const staticList = await ModelService.ListModels({ provider: 'om' });
    assert.deepEqual(instanceList, staticList);
  });

  await t.test('OMAgent.listModels and OMAgent.ListModels delegate to ModelService', async () => {
    const agent = new OMAgent({
      provider: 'om',
      providers: {
        deepseek: { apiKey: 'test-deepseek-key' },
        kimi: { apiKey: 'test-kimi-key' },
        qwen: { apiKey: 'test-qwen-key' },
        glm: { apiKey: 'test-glm-key' }
      }
    });
    const models = await agent.ListModels();
    assert.ok(Array.isArray(models));
    assert.ok(models.length >= 3);
    assert.ok(models.some((m) => m.id === 'om-v1'));
  });

  await t.test('Provider instance listModels and ListModels work', async () => {
    const provider = new OMProvider();
    const models = await provider.ListModels();
    assert.ok(Array.isArray(models));
    assert.ok(models.length >= 3);
  });

  await t.test('list_models skill is registered and executable', async () => {
    const registry = new SkillRegistry();
    assert.equal(registry.has('list_models'), true);
    const result = await registry.execute('list_models', { provider: 'om' });
    assert.equal(result.provider, 'om');
    assert.ok(result.count >= 3);
    assert.ok(result.models.some((m) => m.id === 'om-v1'));
  });

  await t.test('ModelService.listGeminiModels validates API key requirement', async () => {
    await assert.rejects(
      async () => {
        await ModelService.listGeminiModels({ apiKey: '' });
      },
      /GEMINI_API_KEY is required/
    );
  });

  await t.test('OMProvider answers directly with reasoning and does not dump capabilities', async () => {
    const provider = new OMProvider();
    const reply1 = await provider.chat({
      messages: [{ role: 'user', content: 'why is the sky blue?' }]
    });
    assert.equal(reply1.toolCalls.length, 0);
    assert.ok(reply1.content.includes('Rayleigh scattering') || reply1.content.includes('scattering'));
    assert.equal(reply1.content.includes('I have access to full system capabilities'), false);
    assert.equal(reply1.content.includes('Try asking me:'), false);

    const reply2 = await provider.chat({
      messages: [{ role: 'user', content: 'generate a bird image' }]
    });
    assert.equal(reply2.content.includes('I have access to full system capabilities'), false);
    assert.ok(reply2.content.includes('bird') || reply2.content.includes('text'));
  });

  await t.test('ModelService.listAllModels returns categorized cloud and local models', async () => {
    const allModels = await ModelService.listAllModels();
    assert.ok(Array.isArray(allModels));
    assert.ok(allModels.length > 3);
    assert.ok(allModels.some((m) => m.target === 'local'));
    assert.ok(allModels.some((m) => m.target === 'cloud'));

    const cloudOnly = await ModelService.listAllModels({ scope: 'cloud' });
    assert.ok(cloudOnly.every((m) => m.target === 'cloud'));

    const localOnly = await ModelService.listAllModels({ scope: 'local' });
    assert.ok(localOnly.every((m) => m.target === 'local'));
  });

  await t.test('OMAgent chat command /local and /cloud switch mode directly', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-models-test-'));
    try {
      const agent = new OMAgent({
        rootDir: tmpRoot,
        provider: 'om',
        providers: {
          deepseek: { apiKey: 'test-deepseek-key' },
          kimi: { apiKey: 'test-kimi-key' },
          qwen: { apiKey: 'test-qwen-key' },
          glm: { apiKey: 'test-glm-key' }
        }
      });
      const localRes = await agent.run('/local om-turbo');
      assert.equal(localRes.success, true);
      assert.equal(agent.config.provider, 'om');
      assert.equal(agent.config.model, 'om-turbo');
      assert.ok(localRes.content.includes('Local'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('ModelService auto-discovery for LM Studio and vLLM probes local endpoints safely', async () => {
    // When offline, functions return empty arrays gracefully within timeout without throwing
    const lmModels = await ModelService.listLMStudioModels({ baseUrl: 'http://127.0.0.1:54321/v1' });
    assert.ok(Array.isArray(lmModels));

    const vllmModels = await ModelService.listVLLMModels({ baseUrl: 'http://127.0.0.1:54322/v1' });
    assert.ok(Array.isArray(vllmModels));
  });

  await t.test('DeepSeek, Kimi, Qwen, and GLM providers are registered in createProvider, ModelService, and slash commands', async () => {
    const cases = [
      { input: 'deepseek', canonical: 'deepseek', defaultModel: 'deepseek-chat', expectedHost: 'api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      { input: 'kimi', canonical: 'kimi', defaultModel: 'kimi-k2-0711-preview', expectedHost: 'api.moonshot.ai', apiKeyEnv: 'KIMI_API_KEY' },
      { input: 'moonshot', canonical: 'kimi', defaultModel: 'kimi-k2-0711-preview', expectedHost: 'api.moonshot.ai', apiKeyEnv: 'KIMI_API_KEY' },
      { input: 'qwen', canonical: 'qwen', defaultModel: 'qwen-plus', expectedHost: 'dashscope-intl.aliyuncs.com', apiKeyEnv: 'QWEN_API_KEY' },
      { input: 'dashscope', canonical: 'qwen', defaultModel: 'qwen-plus', expectedHost: 'dashscope-intl.aliyuncs.com', apiKeyEnv: 'QWEN_API_KEY' },
      { input: 'glm', canonical: 'glm', defaultModel: 'glm-4.5-flash', expectedHost: 'open.bigmodel.cn', apiKeyEnv: 'GLM_API_KEY' },
      { input: 'zhipu', canonical: 'glm', defaultModel: 'glm-4.5-flash', expectedHost: 'open.bigmodel.cn', apiKeyEnv: 'GLM_API_KEY' }
    ];

    for (const c of cases) {
      const prov = createProvider({ name: 'OM Agent', provider: c.input });
      assert.equal(prov.name, c.canonical);
      assert.equal(prov.model, c.defaultModel);
      assert.equal(prov.apiKeyEnv, c.apiKeyEnv);
      assert.ok(prov.baseUrl.includes(c.expectedHost));
    }

    const allCloud = await ModelService.listAllModels({ scope: 'cloud' });
    for (const expectedProv of ['deepseek', 'kimi', 'qwen', 'glm']) {
      assert.ok(allCloud.some((m) => m.provider === expectedProv), `Expected ${expectedProv} in cloud models`);
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-models-test-'));
    try {
      const agent = new OMAgent({
        rootDir: tmpRoot,
        provider: 'om',
        providers: {
          deepseek: { apiKey: 'test-deepseek-key' },
          kimi: { apiKey: 'test-kimi-key' },
          qwen: { apiKey: 'test-qwen-key' },
          glm: { apiKey: 'test-glm-key' }
        }
      });
      const slashCases = [
        { cmd: '/cloud deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner' },
        { cmd: '/cloud kimi-latest', provider: 'kimi', model: 'kimi-latest' },
        { cmd: '/cloud qwen-max', provider: 'qwen', model: 'qwen-max' },
        { cmd: '/cloud glm-4-flash', provider: 'glm', model: 'glm-4-flash' }
      ];
      for (const sc of slashCases) {
        const res = await agent.run(sc.cmd);
        assert.equal(res.success, true);
        assert.equal(agent.config.provider, sc.provider);
        assert.equal(agent.config.model, sc.model);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('Multi-model local safetensors discovery and /local model switching', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-local-models-'));
    try {
      for (const folder of ['Gemma 3-4b', 'Gemma 4-E2B', 'Gemma 4-E4B', 'Qwen 3.8-27b']) {
        const dir = path.join(tmpRoot, folder);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'model.safetensors'), 'stub');
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model_type: 'gemma' }));
      }
      const discovered = ModelService.listLocalSafetensorsModels({ localModelsDir: tmpRoot });
      const ids = discovered.map((m) => m.id);
      assert.ok(ids.includes('gemma-3-4b'));
      assert.ok(ids.includes('gemma-4-e2b'));
      assert.ok(ids.includes('gemma-4-e4b'));
      assert.ok(ids.includes('qwen-3.8-27b'));

      const agent = new OMAgent({ rootDir: tmpRoot, provider: 'vllm', model: 'gemma-3-4b' });
      for (const localModel of ['gemma-4-e2b', 'gemma-4-e4b', 'qwen-3.8-27b']) {
        const res = await agent.run(`/local ${localModel}`);
        assert.equal(res.success, true);
        assert.equal(agent.config.provider, 'vllm');
        assert.equal(agent.config.model, localModel);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('Hardware detection classifies CPU-only, mid GPU, high-VRAM GPU, and workstation tiers accurately', async () => {
    const cpuOnly = classifyHardwareProfile({
      system: { platform: 'win32', arch: 'x64' },
      cpu: { model: 'Intel Core i5-12400', logicalCores: 12 },
      ram: { totalGb: 8, freeGb: 4.5 },
      gpus: [{ name: 'Microsoft Basic Display Adapter', vendor: 'Microsoft', vramTotalMb: 0, vramUsedMb: null, vramFreeMb: null, utilizationPct: null, temperatureC: null, driverVersion: null, cudaCapable: false }]
    });
    assert.equal(cpuOnly.tier, 'cpu-only');
    assert.equal(cpuOnly.hasGpu, false);
    assert.equal(cpuOnly.accelerator, 'cpu');
    assert.equal(cpuOnly.recommendedMaxParamsB, 3);

    const midGpu = classifyHardwareProfile({
      system: { platform: 'win32', arch: 'x64' },
      cpu: { model: 'AMD Ryzen 7 5800X', logicalCores: 16 },
      ram: { totalGb: 32, freeGb: 20 },
      gpus: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'NVIDIA', vramTotalMb: 12288, vramUsedMb: 500, vramFreeMb: 11788, utilizationPct: 5, temperatureC: 42, driverVersion: '555.0', cudaCapable: true }]
    });
    assert.equal(midGpu.tier, 'gpu-mid');
    assert.equal(midGpu.hasGpu, true);
    assert.equal(midGpu.accelerator, 'cuda');
    assert.equal(midGpu.totalVramGb, 12);
    assert.equal(midGpu.recommendedMaxParamsB, 14);

    const highGpu = classifyHardwareProfile({
      system: { platform: 'linux', arch: 'x64' },
      cpu: { model: 'AMD Ryzen 9 7950X', logicalCores: 32 },
      ram: { totalGb: 64, freeGb: 48 },
      gpus: [{ name: 'NVIDIA GeForce RTX 4090', vendor: 'NVIDIA', vramTotalMb: 24576, vramUsedMb: 1000, vramFreeMb: 23576, utilizationPct: 2, temperatureC: 38, driverVersion: '560.0', cudaCapable: true }]
    });
    assert.equal(highGpu.tier, 'gpu-high');
    assert.equal(highGpu.totalVramGb, 24);
    assert.equal(highGpu.recommendedRuntime, 'vllm');
    assert.equal(highGpu.recommendedMaxParamsB, 32);

    const workstation = classifyHardwareProfile({
      system: { platform: 'linux', arch: 'x64' },
      cpu: { model: 'AMD EPYC 9654', logicalCores: 64 },
      ram: { totalGb: 256, freeGb: 200 },
      gpus: [{ name: 'NVIDIA A100 80GB PCIe', vendor: 'NVIDIA', vramTotalMb: 81920, vramUsedMb: 0, vramFreeMb: 81920, utilizationPct: 0, temperatureC: 35, driverVersion: '560.0', cudaCapable: true }]
    });
    assert.equal(workstation.tier, 'gpu-workstation');
    assert.equal(workstation.totalVramGb, 80);
    assert.equal(workstation.recommendedMaxParamsB, 72);

    const appleSilicon = classifyHardwareProfile({
      system: { platform: 'darwin', arch: 'arm64' },
      cpu: { model: 'Apple M3 Max', logicalCores: 16 },
      ram: { totalGb: 64, freeGb: 40 },
      gpus: [{ name: 'Apple M3 Max', vendor: 'Apple', vramTotalMb: 49152, vramUsedMb: null, vramFreeMb: null, utilizationPct: null, temperatureC: null, driverVersion: null, cudaCapable: false, unifiedMemory: true }]
    });
    assert.equal(appleSilicon.tier, 'gpu-workstation');
    assert.equal(appleSilicon.accelerator, 'metal');
    assert.equal(appleSilicon.unifiedMemory, true);
  });

  await t.test('ModelService.listModels({ provider: "local" }) only lists installed models on this PC filtered by CPU-only vs high-VRAM GPU', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-hw-local-'));
    try {
      for (const folder of ['Qwen 2.5-3b', 'Gemma 3-4b', 'Qwen 3.8-27b', 'Llama 3.3-70b']) {
        const dir = path.join(tmpRoot, folder);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'model.safetensors'), 'stub');
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model_type: 'llama' }));
      }

      const cpuOnly = classifyHardwareProfile({
        system: { platform: 'win32', arch: 'x64' },
        cpu: { model: 'Intel Core i5', logicalCores: 8 },
        ram: { totalGb: 8, freeGb: 4 },
        gpus: []
      });
      const highVram = classifyHardwareProfile({
        system: { platform: 'linux', arch: 'x64' },
        cpu: { model: 'AMD EPYC', logicalCores: 32 },
        ram: { totalGb: 128, freeGb: 100 },
        gpus: [{ name: 'NVIDIA A100 80GB', vendor: 'NVIDIA', vramTotalMb: 81920, vramUsedMb: 0, vramFreeMb: 81920, utilizationPct: 0, temperatureC: 35, driverVersion: '560.0', cudaCapable: true }]
      });

      const cpuModels = await ModelService.listModels({
        provider: 'local',
        hardwareProfile: cpuOnly,
        localModelsDir: tmpRoot,
        lmStudioBaseUrl: 'http://127.0.0.1:54321/v1',
        vllmBaseUrl: 'http://127.0.0.1:54322/v1'
      });
      assert.ok(cpuModels.every((m) => m.target === 'local' && m.installed === true));
      assert.ok(cpuModels.some((m) => m.id === 'qwen-2.5-3b' && m.hardwareFit?.mode === 'cpu'));
      assert.equal(cpuModels.some((m) => m.id === 'qwen-3.8-27b'), false, 'CPU-only 8GB should not list installed 27B models');
      assert.equal(cpuModels.some((m) => m.id === 'llama-3.3-70b'), false, 'CPU-only 8GB should not list installed 70B models');
      assert.equal(cpuModels.some((m) => m.id === 'phi-4-mini-instruct'), false, 'Should not list uninstalled curated placeholders by default');

      const gpuModels = await ModelService.listModels({
        provider: 'local',
        hardwareProfile: highVram,
        localModelsDir: tmpRoot,
        lmStudioBaseUrl: 'http://127.0.0.1:54321/v1',
        vllmBaseUrl: 'http://127.0.0.1:54322/v1'
      });
      assert.ok(gpuModels.every((m) => m.installed === true));
      assert.ok(gpuModels.some((m) => m.id === 'llama-3.3-70b' && m.hardwareFit?.status === 'optimal'));
      assert.ok(gpuModels.some((m) => m.id === 'qwen-3.8-27b' && m.provider === 'local'));
      assert.ok(gpuModels.some((m) => m.id === 'gemma-3-4b' && m.provider === 'local'));

      // Zero-port LocalDirectProvider does not require any HTTP baseUrl/port
      const localProv = createProvider({ provider: 'local', model: 'gemma-3-4b' });
      assert.equal(localProv.name, 'local');
      assert.equal(localProv.baseUrl, undefined);

      // ModelRouter must never silently latency-balance a real local model onto the OM simulator
      const { ModelRouter } = await import('../dist/providers/index.js');
      const router = new ModelRouter({
        routing: {
          enabled: true,
          strategy: 'latency',
          balancePrimary: true,
          fallbackChain: [{ provider: 'om', model: 'om-reasoning' }]
        }
      });
      router.providerMetrics.set('local/gemma-3-4b', { ewmaLatencyMs: 12000, ewmaTtftMs: 5000 });
      router.providerMetrics.set('om/om-reasoning', { ewmaLatencyMs: 1, ewmaTtftMs: 1 });
      assert.equal(router._selectBalancedTarget(localProv, 'local', 'gemma-3-4b'), null);

      // Live host detection & list_models skill integration
      const liveHw = await detectSystemHardware();
      assert.ok(liveHw.tier);
      assert.ok(liveHw.totalRamGb > 0);
      const registry = new SkillRegistry();
      const skillRes = await registry.execute('list_models', { provider: 'local' });
      assert.equal(skillRes.success, true);
      assert.ok(skillRes.hardware && skillRes.hardware.tier);
      assert.ok(skillRes.count > 0);
      assert.ok(skillRes.models.every((m) => m.hardwareFit && m.installed === true));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

