import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaEngine, ModelRouter } from '../dist/index.js';

test('LayaEngine gracefully degrades when disabled or no ONNX model is present', async () => {
  const laya = new LayaEngine({ enabled: false, modelDir: './nonexistent-laya-dir' });
  assert.equal(laya.isConfigured(), false);
  assert.equal(await laya.classifyComplexity({ messages: [{ role: 'user', content: 'hi' }] }), null);
  assert.equal(await laya.assessToolRisk('http_request', { url: 'https://example.com' }), null);
  assert.equal(await laya.triageToolFailure('exec_command', 'ENOENT'), null);
  assert.equal(await laya.evaluateAssertion('p', 'a', 'c'), null);

  const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.deepEqual(await laya.shortlistTools('find file', tools, 2), tools);
});

test('LayaEngine handles all 4 integration points with an injected predictor', async () => {
  const mockPredictor = {
    async predict(state, questions) {
      if (questions.complexity) {
        return { answers: { complexity: { choice: 'complex' } } };
      }
      if (questions.is_destructive) {
        const score = state.tool === 'http_request' && String(state.args?.method || 'GET') === 'GET' ? 0.05 : 0.85;
        return { answers: { is_destructive: { noul: score } } };
      }
      if (questions.relevant) {
        const score = state.tool === 'read_file' ? 0.95 : state.tool === 'git_status' ? 0.8 : 0.1;
        return { answers: { relevant: { noul: score } } };
      }
      if (questions.cause) {
        return { answers: { cause: { choice: 'bad_tool_args' } } };
      }
      if (questions.passes) {
        return { answers: { passes: { noul: 0.92 } } };
      }
      return { answers: {} };
    }
  };

  const laya = new LayaEngine({ enabled: true, riskThreshold: 0.15, toolShortlistK: 2 }, { predictor: mockPredictor });
  assert.equal(laya.isConfigured(), true);

  // A. Complexity classification
  const complexity = await laya.classifyComplexity({ messages: [{ role: 'user', content: 'Refactor auth' }] });
  assert.equal(complexity, 'complex');

  // B. Tool risk gating
  const safeCall = await laya.assessToolRisk('http_request', { method: 'GET', url: 'http://127.0.0.1:3000/health' });
  assert.equal(safeCall?.safeToAutoApprove, true);

  const riskyCall = await laya.assessToolRisk('http_request', { method: 'DELETE', url: 'https://api.example.com/users' });
  assert.equal(riskyCall?.safeToAutoApprove, false);

  // C. Tool shortlisting
  const shortlisted = await laya.shortlistTools('check repo and read file', [
    { name: 'web_search', description: 'search web' },
    { name: 'read_file', description: 'read file' },
    { name: 'git_status', description: 'git status' }
  ], 2);
  assert.deepEqual(shortlisted.map((t) => t.name), ['read_file', 'git_status']);

  // D1. Self-heal triage
  const cause = await laya.triageToolFailure('read_file', 'ENOENT: no such file');
  assert.equal(cause, 'bad_tool_args');

  // D2. Eval semantic assertion
  const evalCheck = await laya.evaluateAssertion('What is 2+2?', '4', 'Correctly answers 4');
  assert.equal(evalCheck?.ok, true);
  assert.equal(evalCheck?.score, 0.92);
});

test('ModelRouter uses LayaEngine complexity classifier when available', async () => {
  const mockLaya = new LayaEngine(
    { enabled: true },
    {
      predictor: {
        async predict() {
          return { answers: { complexity: { choice: 'simple' } } };
        }
      }
    }
  );

  const called = [];
  const router = new ModelRouter({
    config: { provider: 'openai', model: 'gpt-4o' },
    laya: mockLaya,
    routing: {
      complexityRouting: {
        enabled: true,
        simpleToLocal: true,
        localTarget: { provider: 'om', model: 'om-turbo' }
      }
    },
    providerFactory: (cfg) => ({
      async chat() {
        called.push({ provider: cfg.provider, model: cfg.model });
        return { content: 'ok', usage: { total_tokens: 10 } };
      }
    })
  });

  const primaryProvider = {
    name: 'openai',
    model: 'gpt-4o',
    async chat() {
      throw new Error('should have routed to local om-turbo');
    }
  };
  const res = await router.chat(primaryProvider, { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(res.complexityRouted, true);
  assert.equal(res.routedProvider, 'om');
  assert.deepEqual(called, [{ provider: 'om', model: 'om-turbo' }]);
});

test('LayaEngine device:auto tunes settings for GPU vs CPU/RAM', async () => {
  const gpuEngine = new LayaEngine(
    { enabled: true, device: 'auto', multilingualModelDir: './models/laya-multilingual' },
    { hardwareDetector: async () => ({ hasCudaGpu: true, vramMb: 8192, totalRamGb: 16 }) }
  );
  const gpuProfile = await gpuEngine.getResolvedProfile();
  assert.equal(gpuProfile.device, 'cuda');
  assert.equal(gpuProfile.toolShortlisting, true);
  assert.equal(gpuProfile.loadMultilingual, true);

  const lowRamCpuEngine = new LayaEngine(
    { enabled: true, device: 'auto', multilingualModelDir: './models/laya-multilingual' },
    { hardwareDetector: async () => ({ hasCudaGpu: false, vramMb: 0, totalRamGb: 8 }) }
  );
  const cpuProfile = await lowRamCpuEngine.getResolvedProfile();
  assert.equal(cpuProfile.device, 'cpu');
  assert.equal(cpuProfile.toolShortlisting, false);
  assert.equal(cpuProfile.loadMultilingual, false);
});
