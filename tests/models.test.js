import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelService } from '../dist/modelService.js';
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
    const agent = new OMAgent({
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

    const agent = new OMAgent({
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
  });
});

