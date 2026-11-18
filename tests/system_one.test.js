import test from 'node:test';
import assert from 'node:assert/strict';
import { OMSystemOne, ModelRouter, collectDeviceSpecs } from '../dist/index.js';

function makeMockEmbedder() {
  return async (text) => {
    const t = String(text || '').toLowerCase();
    // 4-dimensional semantic basis: [simple, complex, destructive, error_args]
    const isSimple = /greeting|lookup|time|hello|read-only|health|get/.test(t) ? 1 : 0;
    const isComplex = /refactor|architecture|stack trace|security audit|multi-file/.test(t) ? 1 : 0;
    const isDestructive = /delete|rm -rf|mutation|exfiltrate|format/.test(t) ? 1 : 0;
    const isBadArgs = /enoent|no such file|invalid path|missing parameter|bad user input/.test(t) ? 1 : 0;
    const isReadTool = /read_file|git_status/.test(t) ? 1 : 0;
    return [isSimple + isReadTool * 0.5, isComplex, isDestructive, isBadArgs];
  };
}

test('OMSystemOne gracefully degrades when disabled', async () => {
  const sysOne = new OMSystemOne({ enabled: false });
  assert.equal(sysOne.isConfigured(), false);
  assert.equal(await sysOne.classifyComplexity({ messages: [{ role: 'user', content: 'hi' }] }), null);
  assert.equal(await sysOne.assessToolRisk('http_request', { url: 'https://example.com' }), null);
  assert.equal(await sysOne.triageToolFailure('exec_command', 'ENOENT'), null);
  assert.equal(await sysOne.evaluateAssertion('p', 'a', 'c'), null);

  const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.deepEqual(await sysOne.shortlistTools('find file', tools, 2), tools);
});

test('OMSystemOne handles all 4 integration points with hardware-adaptive profiling', async () => {
  const sysOne = new OMSystemOne(
    { enabled: true, riskThreshold: 0.45, toolShortlistK: 2 },
    { embedder: makeMockEmbedder() }
  );
  assert.equal(sysOne.isConfigured(), true);

  // A. Complexity routing
  const complexity = await sysOne.classifyComplexity({
    messages: [{ role: 'user', content: 'Refactor auth across multiple files' }]
  });
  assert.equal(complexity, 'complex');

  // B. Tool risk gating
  const safeCall = await sysOne.assessToolRisk('http_request', { method: 'GET', url: 'http://127.0.0.1:3000/health' });
  assert.equal(safeCall?.safeToAutoApprove, true);

  const riskyCall = await sysOne.assessToolRisk('exec_command', { command: 'rm -rf /tmp/prod && delete' });
  assert.equal(riskyCall?.safeToAutoApprove, false);

  // C. Tool shortlisting
  const shortlisted = await sysOne.shortlistTools('read_file and git_status', [
    { name: 'web_search', description: 'search web' },
    { name: 'read_file', description: 'read_file from disk' },
    { name: 'git_status', description: 'git_status check' }
  ], 2);
  assert.deepEqual(shortlisted.map((t) => t.name), ['read_file', 'git_status']);

  // D1. Self-heal triage
  const cause = await sysOne.triageToolFailure('read_file', 'ENOENT: no such file');
  assert.equal(cause, 'bad_tool_args');

  // D2. Eval semantic assertion
  const evalCheck = await sysOne.evaluateAssertion('Check health', 'read-only health check ok', 'read-only health');
  assert.equal(evalCheck?.ok, true);
});

test('OMSystemOne device:auto adapts to GPU vs CPU hardware', async () => {
  const gpuEngine = new OMSystemOne(
    { enabled: true, device: 'auto' },
    { hardwareDetector: async () => ({ hasCudaGpu: true, vramMb: 8192, totalRamGb: 16 }) }
  );
  const gpuProfile = await gpuEngine.getResolvedProfile();
  assert.equal(gpuProfile.device, 'cuda');
  assert.equal(gpuProfile.dtype, 'fp16');

  const cpuEngine = new OMSystemOne(
    { enabled: true, device: 'auto' },
    { hardwareDetector: async () => ({ hasCudaGpu: false, vramMb: 0, totalRamGb: 15.9 }) }
  );
  const cpuProfile = await cpuEngine.getResolvedProfile();
  assert.equal(cpuProfile.device, 'cpu');
  assert.equal(cpuProfile.dtype, 'q8');
});

test('ModelRouter uses OMSystemOne complexity classifier and puts 408 on cooldown', async () => {
  const sysOne = new OMSystemOne({ enabled: true }, { embedder: makeMockEmbedder() });
  const called = [];
  const router = new ModelRouter({
    config: { provider: 'openai', model: 'gpt-4o' },
    systemOne: sysOne,
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

  const res = await router.chat(
    { name: 'openai', model: 'gpt-4o', async chat() { throw new Error('unused'); } },
    { messages: [{ role: 'user', content: 'hello time lookup' }] }
  );
  assert.equal(res.complexityRouted, true);
  assert.equal(res.routedProvider, 'om');
  assert.deepEqual(called, [{ provider: 'om', model: 'om-turbo' }]);

  // Verify 408 cooldown
  let primaryCalls = 0;
  const failoverRouter = new ModelRouter({
    config: { provider: 'gemini', model: 'gemini-4-hydrogen' },
    routing: {
      enabled: true,
      maxRetries: 1,
      fallbackChain: [{ provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' }]
    },
    providerFactory: () => ({
      name: 'openai',
      model: 'gpt-4o',
      async chat() {
        return { content: 'fallback-ok', usage: { total_tokens: 5 } };
      }
    })
  });
  const hungPrimary = {
    name: 'gemini',
    model: 'gemini-4-hydrogen',
    async chat() {
      primaryCalls++;
      const err = new Error('Request timed out');
      err.status = 408;
      throw err;
    }
  };
  const r1 = await failoverRouter.chat(hungPrimary, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r1.content, 'fallback-ok');
  const r2 = await failoverRouter.chat(hungPrimary, { messages: [{ role: 'user', content: 'hi again' }] });
  assert.equal(r2.content, 'fallback-ok');
  assert.equal(primaryCalls, 1);
});

test('collectDeviceSpecs returns hardware and OMSystemOne engine snapshot', async () => {
  const specs = await collectDeviceSpecs({
    config: {
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      systemOne: { enabled: true, device: 'auto' }
    },
    _getTarget: () => 'cloud'
  });
  assert.ok(specs.cpu.logicalCores >= 1);
  assert.ok(specs.ram.totalGb > 0);
  assert.ok(Array.isArray(specs.gpus));
  assert.equal(typeof specs.npu.detected, 'boolean');
  assert.equal(specs.engine.systemOne.enabled, true);
});
