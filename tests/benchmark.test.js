import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  OMAgent,
  ModelRouter,
  BaseProvider,
  VectorStore,
  embedText,
  cosineSimilarity,
  runInitCommand
} from '../dist/index.js';

const BENCH_DIR = path.resolve('./tests/tmp_benchmark_suite');

test('OMega Autonomous Evaluation & Benchmark Suite', async (t) => {
  if (!fs.existsSync(BENCH_DIR)) {
    fs.mkdirSync(BENCH_DIR, { recursive: true });
  }

  t.after(() => {
    try {
      fs.rmSync(BENCH_DIR, { recursive: true, force: true });
    } catch (_) {}
  });

  // ==========================================================================
  // 1. SMARTER MULTI-MODEL ROUTING & FALLBACK BENCHMARKS
  // ==========================================================================
  await t.test('1. Multi-Model Routing: Local-to-Cloud Failover on Context Limit & Provider Failure', async (sub) => {
    await sub.test('1a. Automatically retries transient failure on local model and recovers', async () => {
      let callCount = 0;
      const flakyLocalProvider = {
        name: 'lmstudio',
        model: 'qwen2.5-7b-instruct',
        async chat() {
          callCount++;
          if (callCount === 1) {
            throw new Error('LM Studio socket hang up (transient error)');
          }
          return {
            content: 'Recovered on retry attempt 2!',
            toolCalls: []
          };
        }
      };

      const retryEvents = [];
      const agent = new OMAgent({
        memoryDir: path.join(BENCH_DIR, 'mem_retry'),
        workspaceDir: BENCH_DIR,
        providerInstance: flakyLocalProvider,
        routing: {
          enabled: true,
          maxRetries: 2,
          retryDelayMs: 10
        }
      });

      agent.on('retry', (ev) => retryEvents.push(ev));
      const res = await agent.run('Hello local model');

      assert.equal(res.success, true);
      assert.equal(res.content, 'Recovered on retry attempt 2!');
      assert.equal(callCount, 2);
      assert.equal(retryEvents.length, 1);
      assert.equal(retryEvents[0].attempt, 1);
    });

    await sub.test('1b. Local model can only fall back to another Local model, never to Cloud', async () => {
      const localContextLimitedProvider = {
        name: 'lmstudio',
        model: 'qwen2.5-7b-instruct',
        async chat() {
          const err = new Error('Context length exceeded: prompt is 16384 tokens, maximum context window is 8192');
          err.status = 413;
          throw err;
        }
      };

      let cloudCalled = false;
      const cloudFallbackProvider = {
        name: 'gemini',
        model: 'gemini-3.5-flash',
        async chat() {
          cloudCalled = true;
          return { content: 'Should not be called', toolCalls: [] };
        }
      };

      const localFallbackProvider = {
        name: 'om',
        model: 'om-reasoning',
        async chat() {
          return { content: 'Handled by local fallback (om-reasoning).', toolCalls: [] };
        }
      };

      const fallbackEvents = [];
      const agent = new OMAgent({
        memoryDir: path.join(BENCH_DIR, 'mem_context_failover'),
        workspaceDir: BENCH_DIR,
        provider: 'lmstudio',
        model: 'qwen2.5-7b-instruct',
        providerInstance: localContextLimitedProvider,
        routing: {
          enabled: true,
          maxRetries: 1,
          fallbackChain: [
            {
              provider: 'gemini',
              model: 'gemini-3.5-flash',
              providerInstance: cloudFallbackProvider
            },
            {
              provider: 'om',
              model: 'om-reasoning',
              providerInstance: localFallbackProvider
            }
          ]
        }
      });

      agent.on('fallback', (ev) => fallbackEvents.push(ev));
      const res = await agent.run('Analyze this large repository context');
      assert.equal(res.success, true);
      assert.equal(cloudCalled, false);
      assert.equal(res.fallbackUsed, true);
      assert.equal(res.provider, 'om');
      assert.equal(res.model, 'om-reasoning');
      assert.equal(fallbackEvents.length, 1);
      assert.equal(fallbackEvents[0].toProvider, 'om');
    });

    await sub.test('1c. Local model does not proactively hand off to Cloud when over token budget', async () => {
      let cloudCalled = false;
      const smallLocalProvider = {
        name: 'lmstudio',
        model: 'phi3-mini',
        async chat() {
          return { content: 'Should not reach here when over budget', toolCalls: [] };
        }
      };

      const cloudProvider = {
        name: 'openai',
        model: 'gpt-4o',
        async chat() {
          cloudCalled = true;
          return { content: 'Should not be called', toolCalls: [] };
        }
      };

      const agent = new OMAgent({
        memoryDir: path.join(BENCH_DIR, 'mem_proactive'),
        workspaceDir: BENCH_DIR,
        provider: 'lmstudio',
        model: 'phi3-mini',
        providerInstance: smallLocalProvider,
        routing: {
          enabled: true,
          autoHandoffOnContextLimit: true,
          contextLimitTokens: 50,
          fallbackChain: [
            { provider: 'openai', model: 'gpt-4o', providerInstance: cloudProvider }
          ]
        }
      });

      await assert.rejects(
        () => agent.run('Please process this prompt which together with system prompt exceeds 50 tokens.'),
        /context limit exceeded/i
      );
      assert.equal(cloudCalled, false);
    });
  });

  // ==========================================================================
  // 2. AUTONOMOUS BENCHMARK SUITE: TOOL ACCURACY, MULTI-STEP PLANNING & RECOVERY
  // ==========================================================================
  await t.test('2. Autonomous Benchmark Suite: Tool-Calling Accuracy, Multi-Step Planning & Error Recovery', async (sub) => {
    await sub.test('2a. Tool-Calling Accuracy across standard benchmark tasks', async () => {
      const agent = new OMAgent({
        provider: 'mock',
        memoryDir: path.join(BENCH_DIR, 'mem_accuracy'),
        workspaceDir: BENCH_DIR,
        skillsDir: path.resolve('./skills')
      });
      await agent.init();

      const benchmarkCases = [
        { prompt: 'List available models', expectedTool: 'list_models', expectedSubstring: 'om' },
        { prompt: 'Inspect system hardware specs', expectedTool: 'get_system_info', expectedSubstring: 'Platform' },
        { prompt: 'What is the current time and date?', expectedTool: 'get_current_time', expectedSubstring: 'ISO' },
        { prompt: 'Remember that production deployments require green CI checks', expectedTool: 'save_memory', expectedSubstring: 'Noted' },
        { prompt: 'List files in current workspace', expectedTool: 'list_dir', expectedSubstring: 'Directory listing' }
      ];

      let passed = 0;
      for (const tc of benchmarkCases) {
        const res = await agent.run(tc.prompt);
        const executedTools = res.steps.flatMap((s) => (s.toolCalls || []).map((c) => c.name));
        assert.ok(
          executedTools.includes(tc.expectedTool),
          `Expected tool '${tc.expectedTool}' for prompt "${tc.prompt}", got [${executedTools.join(', ')}]`
        );
        assert.ok(
          res.content.includes(tc.expectedSubstring),
          `Expected response to include "${tc.expectedSubstring}", got "${res.content}"`
        );
        passed++;
      }
      assert.equal(passed, benchmarkCases.length);
    });

    await sub.test('2b. Multi-Step Planning: Sequential file creation, reading, patching, and verification', async () => {
      const targetFile = path.join(BENCH_DIR, 'plan_artifact.txt');
      let stepIdx = 0;

      // Custom deterministic multi-step planner provider
      const multiStepPlannerProvider = {
        name: 'mock',
        model: 'om-reasoning',
        async chat({ messages }) {
          stepIdx++;
          if (stepIdx === 1) {
            return {
              content: 'Step 1: Creating initial configuration artifact file.',
              toolCalls: [
                {
                  id: 'call_step_1',
                  name: 'write_file',
                  args: { path: targetFile, content: 'STATUS=pending\nVERSION=1.0.0\n' }
                }
              ]
            };
          }
          if (stepIdx === 2) {
            return {
              content: 'Step 2: Patching status from pending to verified.',
              toolCalls: [
                {
                  id: 'call_step_2',
                  name: 'patch_file',
                  args: { path: targetFile, targetText: 'STATUS=pending', replacementText: 'STATUS=verified' }
                }
              ]
            };
          }
          if (stepIdx === 3) {
            return {
              content: 'Step 3: Reading back file to verify patch integrity.',
              toolCalls: [
                {
                  id: 'call_step_3',
                  name: 'read_file',
                  args: { path: targetFile }
                }
              ]
            };
          }
          const lastToolMsg = [...messages].reverse().find((m) => m.role === 'tool');
          return {
            content: `Multi-step plan completed in 4 steps. Final verified file state: ${lastToolMsg?.content}`,
            toolCalls: []
          };
        }
      };

      const agent = new OMAgent({
        memoryDir: path.join(BENCH_DIR, 'mem_multistep'),
        workspaceDir: BENCH_DIR,
        providerInstance: multiStepPlannerProvider
      });
      await agent.init();

      const res = await agent.run('Execute 3-step file provisioning and verification plan');
      assert.equal(res.success, true);
      assert.equal(res.totalSteps, 4);
      assert.ok(res.content.includes('STATUS=verified'));
      assert.equal(fs.readFileSync(targetFile, 'utf8').includes('STATUS=verified'), true);
      await agent.close();
    });

    await sub.test('2c. Autonomous Error Recovery when a tool fails mid-trajectory', async () => {
      const recoveryFile = path.join(BENCH_DIR, 'recovered_config.json');
      let turn = 0;

      const recoveryProvider = {
        name: 'mock',
        model: 'om-reasoning',
        async chat({ messages }) {
          turn++;
          if (turn === 1) {
            // Attempt to read a non-existent file first
            return {
              content: 'Attempting to read existing config file.',
              toolCalls: [
                { id: 'tc_fail_1', name: 'read_file', args: { path: recoveryFile } }
              ]
            };
          }
          if (turn === 2) {
            // Inspect tool failure and recover by creating the missing file
            const lastTool = messages[messages.length - 1];
            const parsed = JSON.parse(lastTool.content);
            assert.equal(parsed.success, false);
            return {
              content: 'File did not exist. Recovering by creating default config file.',
              toolCalls: [
                { id: 'tc_recover_2', name: 'write_file', args: { path: recoveryFile, content: '{"recovered":true}' } }
              ]
            };
          }
          return {
            content: 'Successfully recovered from missing file error by initializing default configuration.',
            toolCalls: []
          };
        }
      };

      const agent = new OMAgent({
        memoryDir: path.join(BENCH_DIR, 'mem_recovery'),
        workspaceDir: BENCH_DIR,
        providerInstance: recoveryProvider
      });
      await agent.init();

      const res = await agent.run('Load or initialize recovered_config.json');
      assert.equal(res.success, true);
      assert.equal(res.totalSteps, 3);
      assert.equal(fs.existsSync(recoveryFile), true);
      assert.ok(res.content.includes('Successfully recovered'));
      await agent.close();
    });
  });

  // ==========================================================================
  // 3. ENHANCED MEMORY WITH LOCAL VECTOR SEARCH BENCHMARKS
  // ==========================================================================
  await t.test('3. Enhanced Memory with Local Vector Embeddings & Semantic Search', async (sub) => {
    await sub.test('3a. Vector embeddings produce high cosine similarity for semantically related concepts', () => {
      const vecTS = embedText('We use TypeScript compiler and static types for frontend code');
      const vecJS = embedText('JavaScript and TS typing in our codebase');
      const vecCooking = embedText('Baking sourdough bread in a hot stone oven');

      const simRelated = cosineSimilarity(vecTS, vecJS);
      const simUnrelated = cosineSimilarity(vecTS, vecCooking);

      assert.ok(simRelated > 0.35, `Expected high similarity for TS/JS (${simRelated})`);
      assert.ok(simRelated > simUnrelated + 0.2, `Expected related similarity (${simRelated}) >> unrelated (${simUnrelated})`);
    });

    await sub.test('3b. OMMemory indexes facts, daily journals, sessions, and project knowledge for semantic search', async () => {
      const agent = new OMAgent({
        provider: 'mock',
        memoryDir: path.join(BENCH_DIR, 'mem_vectors'),
        workspaceDir: BENCH_DIR
      });
      await agent.init();

      // 1. Add diverse facts to memory
      agent.memory.appendFact('The backend database runs on PostgreSQL 16 with connection pooling', 'Architecture');
      agent.memory.appendFact('Authentication uses JWT bearer tokens with 24h expiration', 'Security');
      agent.memory.appendFact('User prefers concise code explanations in TypeScript', 'User Preferences');

      // 2. Index project knowledge base document
      const chunks = agent.memory.indexKnowledge(
        'deployment-guide.md',
        `Production deployments are orchestrated via Docker containers on Linux.\n\nAll environment secrets must be stored in .env with 0600 permissions.`
      );
      assert.equal(chunks, 2);

      // 3. Query via search_memory skill using conceptual terms
      const authSearch = await agent.skills.execute(
        'search_memory',
        { query: 'How does login security and token auth work?', topK: 3 },
        { memory: agent.memory, config: agent.config }
      );
      assert.equal(authSearch.success, true);
      assert.ok(authSearch.results.length >= 1);
      assert.ok(
        authSearch.results[0].text.includes('JWT') || authSearch.results[0].text.includes('Authentication'),
        `Expected top semantic match to be JWT/Authentication, got: ${authSearch.results[0].text}`
      );

      const dbSearch = await agent.skills.execute(
        'search_memory',
        { query: 'SQL storage engine', topK: 3 },
        { memory: agent.memory, config: agent.config }
      );
      assert.ok(dbSearch.results.some((r) => r.text.includes('PostgreSQL')));
    });
  });

  // ==========================================================================
  // 4. COMMUNITY-READY PACKAGING & CLI QUICKSTART (`npx omega-agent init`)
  // ==========================================================================
  await t.test('4. Community CLI Quickstart Scaffolder (`npx omega-agent init`)', async () => {
    const initTargetDir = path.join(BENCH_DIR, 'quickstart_project');
    const result = await runInitCommand({
      targetDir: initTargetDir,
      silent: true
    });

    assert.equal(result.success, true);
    assert.equal(fs.existsSync(path.join(initTargetDir, '.env.example')), true);
    assert.equal(fs.existsSync(path.join(initTargetDir, '.env')), true);
    assert.equal(fs.existsSync(path.join(initTargetDir, '.gitignore')), true);
    assert.equal(fs.existsSync(path.join(initTargetDir, 'om.config.json')), true);
    assert.equal(fs.existsSync(path.join(initTargetDir, 'skills', 'hello-tool.js')), true);
    assert.equal(fs.existsSync(path.join(initTargetDir, 'skills', 'code-review', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(initTargetDir, 'memory', 'MEMORY.md')), true);

    // Verify .gitignore protects .env
    const gitignore = fs.readFileSync(path.join(initTargetDir, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.env'));
  });
});
