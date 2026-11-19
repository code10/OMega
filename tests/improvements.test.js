import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OMAgent } from '../dist/agent.js';
import { SkillRegistry } from '../dist/skills/index.js';
import { VectorStore } from '../dist/vectorStore.js';
import { startGateway } from '../dist/gateway/server.js';
import { MCPClient } from '../dist/mcp/client.js';
import { ModelRouter } from '../dist/providers/router.js';
import { buildSandboxedCommand } from '../dist/skills/sandbox.js';

const TMP_DIR = path.resolve('./tests/tmp_improvements_test');

test('OMega Architectural & Security Improvements', async (t) => {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  t.after(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('Filesystem sandboxing blocks traversal and external paths', async () => {
    const registry = new SkillRegistry();
    const ctx = { config: { workspaceDir: TMP_DIR } };

    const traversal = await registry.execute('read_file', { path: '../../package.json' }, ctx);
    assert.equal(traversal.success, false);
    assert.ok(traversal.error.includes('Security violation'));

    const externalAbs = await registry.execute('write_file', {
      path: path.resolve('./package.json'),
      content: 'hacked'
    }, ctx);
    assert.equal(externalAbs.success, false);
    assert.ok(externalAbs.error.includes('Security violation'));
  });

  await t.test('Shell skill enforces allowedCommands, confirmation, and scrubs API keys', async () => {
    const registry = new SkillRegistry();

    const denied = await registry.execute('exec_command', { command: 'node -e "console.log(1)"' }, {
      config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['git'] } }
    });
    assert.equal(denied.success, false);
    assert.ok(denied.error.includes('allowedCommands'));

    // Empty allowedCommands still falls back to safe default allowlist (never denylist-only),
    // and default allowlist excludes general-purpose interpreters like node and python
    const emptyAllowDenied = await registry.execute('exec_command', { command: 'whoami' }, {
      config: { workspaceDir: TMP_DIR, security: { allowedCommands: [] } }
    });
    assert.equal(emptyAllowDenied.success, false);
    assert.ok(emptyAllowDenied.error.includes('allowedCommands'));

    for (const interpCmd of ['node -e "console.log(1)"', 'python -c "print(1)"', 'python3 -c "print(1)"']) {
      const interpDenied = await registry.execute('exec_command', { command: interpCmd }, {
        config: { workspaceDir: TMP_DIR }
      });
      assert.equal(interpDenied.success, false);
      assert.ok(interpDenied.error.includes('allowedCommands'));
    }

    // Secret redaction in tool output
    const prevRedactKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-redact-value-123456';
    try {
      const leakTest = await registry.execute('exec_command', {
        command: 'node -e "console.log(\'token=sk-test-redact-value-123456\')"'
      }, { config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['node'] } } });
      assert.equal(leakTest.success, true);
      assert.ok(!leakTest.stdout.includes('sk-test-redact-value-123456'));
      assert.ok(leakTest.stdout.includes('[REDACTED:OPENAI_API_KEY]'));
    } finally {
      if (prevRedactKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevRedactKey;
    }

    const unconfirmed = await registry.execute('exec_command', { command: 'git --version' }, {
      config: { workspaceDir: TMP_DIR, security: { requireConfirmationForShell: true } }
    });
    assert.equal(unconfirmed.success, false);
    assert.equal(unconfirmed.confirmationRequired, true);

    const prevKey = process.env.OPENAI_API_KEY;
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret-test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-test-key';
    try {
      const envCheck = await registry.execute('exec_command', {
        command: 'node',
        executable: 'node',
        args: ['-e', "console.log((process.env.OPENAI_API_KEY || 'SCRUBBED') + ':' + (process.env.AWS_SECRET_ACCESS_KEY || 'SCRUBBED_AWS'))"]
      }, { config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['node'] } } });
      assert.equal(envCheck.success, true);
      assert.ok(envCheck.stdout.includes('SCRUBBED:SCRUBBED_AWS'));
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
    }

    // Block dangerous git flags even when git is in allowedCommands
    for (const badGit of ['git -c core.fsmonitor=evil status', 'git clone --upload-pack=evil https://example.com/r.git']) {
      const gitDenied = await registry.execute('exec_command', { command: badGit }, {
        config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['git'] } }
      });
      assert.equal(gitDenied.success, false);
      assert.ok(gitDenied.error.includes('Dangerous git flag'));
    }

    // Reject shell control operators when allowedCommands is active
    for (const badCmd of ['node -v; whoami', 'node -v && echo hi', 'node -v | cat', 'node -e "$(id)"', 'node -v\nwhoami']) {
      const rejected = await registry.execute('exec_command', { command: badCmd }, {
        config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['node'] } }
      });
      assert.equal(rejected.success, false);
      assert.ok(rejected.error.includes('Shell control operators'));
    }

    // Execute allowed command via execFile (shell: false) using command string and executable+args
    const allowedRun = await registry.execute('exec_command', { command: 'node -e "console.log(40+2)"' }, {
      config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['node'] } }
    });
    assert.equal(allowedRun.success, true);
    assert.equal(allowedRun.stdout, '42');

    const directRun = await registry.execute('exec_command', {
      command: 'node',
      executable: 'node',
      args: ['-e', 'console.log("direct_ok")']
    }, {
      config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['node'] } }
    });
    assert.equal(directRun.success, true);
    assert.equal(directRun.stdout, 'direct_ok');

    // Enforce workspace path confinement on cwd
    const outsideCwd = await registry.execute('exec_command', {
      command: 'git --version',
      cwd: path.join(TMP_DIR, '..', 'outside-cwd-escape')
    }, {
      config: { workspaceDir: TMP_DIR }
    });
    assert.equal(outsideCwd.success, false);
    assert.ok(outsideCwd.error.includes('outside the allowed workspace'));

    // Enforce self-modification write protection on sensitive project paths
    const writeEnv = await registry.execute('write_file', {
      path: path.join(TMP_DIR, '.env'),
      content: 'GEMINI_API_KEY=hacked'
    }, {
      config: { workspaceDir: TMP_DIR, rootDir: TMP_DIR }
    });
    assert.equal(writeEnv.success, false);
    assert.ok(writeEnv.error.includes('write-protected'));

    const writeSrc = await registry.execute('write_file', {
      path: path.join(TMP_DIR, 'src', 'agent.js'),
      content: '// overwritten'
    }, {
      config: { workspaceDir: TMP_DIR, rootDir: TMP_DIR }
    });
    assert.equal(writeSrc.success, false);
    assert.ok(writeSrc.error.includes('self-modification'));
  });

  await t.test('Web skills block SSRF to localhost and metadata IPs', async () => {
    const registry = new SkillRegistry();
    const ssrf1 = await registry.execute('fetch_page', { url: 'http://127.0.0.1:3000/api/status' }, {});
    assert.equal(ssrf1.success, false);
    assert.ok(ssrf1.error.includes('SSRF protection'));

    const ssrf2 = await registry.execute('http_request', { url: 'http://169.254.169.254/latest/meta-data/' }, {});
    assert.equal(ssrf2.success, false);
    assert.ok(ssrf2.error.includes('SSRF protection'));
  });

  await t.test('SkillRegistry validates required and typed arguments', async () => {
    const registry = new SkillRegistry();
    const missing = await registry.execute('read_file', {}, { config: { workspaceDir: TMP_DIR } });
    assert.equal(missing.success, false);
    assert.ok(missing.error.includes('Missing required parameter'));

    const wrongType = await registry.execute('read_file', { path: 12345 }, { config: { workspaceDir: TMP_DIR } });
    assert.equal(wrongType.success, false);
    assert.ok(wrongType.error.includes('must be a string'));
  });

  await t.test('VectorStore supports debounced async flush and pluggable asyncEmbedder', async () => {
    const vecPath = path.join(TMP_DIR, 'vectors.json');
    const store = new VectorStore(vecPath, {
      asyncEmbedder: async () => [0.5, 0.5, 0.5, 0.5]
    });
    await store.upsertDocumentAsync({ text: 'OMega neural embedding test', source: 'test' }, true);
    await store.flush();
    assert.equal(fs.existsSync(vecPath), true);

    const hits = await store.searchAsync('neural embedding');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].text, 'OMega neural embedding test');
  });

  await t.test('OMAgent supports spawn_subagent, history compaction, and usage accounting', async () => {
    const mockProvider = {
      name: 'mock',
      model: 'mock-v1',
      async chat() {
        return {
          content: 'Sub-task complete.',
          toolCalls: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        };
      }
    };

    const agent = new OMAgent({
      provider: 'om',
      providerInstance: mockProvider,
      memoryDir: path.join(TMP_DIR, 'agent_mem'),
      workspaceDir: TMP_DIR,
      maxHistoryMessages: 16
    });

    const subRes = await agent.skills.execute('spawn_subagent', {
      task: 'Summarize status',
      maxSteps: 2
    }, { agent, config: agent.config, memory: agent.memory });
    assert.equal(subRes.success, true);
    assert.equal(subRes.answer, 'Sub-task complete.');
    assert.equal(subRes.usage.totalTokens, 15);

    // Populate > 16 messages and verify compaction runs cleanly
    for (let i = 0; i < 20; i++) {
      agent.history.push({ role: 'user', content: `Turn ${i}` });
    }
    const runRes = await agent.run('Final question');
    assert.equal(runRes.success, true);
    assert.ok(agent.history.length < 20);
    assert.equal(runRes.usage.totalTokens, 15);
    assert.ok(agent.usageStats.calls >= 1);
  });

  await t.test('Gateway enforces Bearer auth when configured and isolates X-Session-Id', async () => {
    const gwDir = path.join(TMP_DIR, 'gw_mem');
    const { server, agent, url } = await startGateway({
      port: 3098,
      host: '127.0.0.1',
      memoryDir: gwDir,
      workspaceDir: TMP_DIR,
      provider: 'om',
      authToken: 'test-secret-token'
    });

    t.after(() => {
      agent.stopWatching();
      server.close();
    });

    const unauth = await fetch(`${url}/api/status`);
    assert.equal(unauth.status, 401);

    const authRes = await fetch(`${url}/api/status`, {
      headers: { Authorization: 'Bearer test-secret-token' }
    });
    assert.equal(authRes.status, 200);

    const chatRes = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-secret-token',
        'X-Session-Id': 'isolated_user_42'
      },
      body: JSON.stringify({ prompt: 'Hello isolated session' })
    });
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.equal(chatData.sessionId, 'isolated_user_42');
    assert.notEqual(agent.sessionId, 'isolated_user_42');
  });

  await t.test('ModelRouter skips retry on 429 and applies rate-limit cooldown circuit breaker', async () => {
    const { ModelRouter } = await import('../dist/providers/router.js');
    let primaryCalls = 0;
    let retries = 0;
    let fallbacks = 0;

    const router = new ModelRouter({
      routing: {
        enabled: true,
        maxRetries: 2,
        rateLimitCooldownMs: 30000,
        fallbackChain: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            providerInstance: {
              name: 'openai',
              model: 'gpt-4o',
              async chat() {
                return { content: 'Fallback response', toolCalls: [] };
              }
            }
          }
        ]
      },
      onEvent: (evt) => {
        if (evt === 'retry') retries++;
        if (evt === 'fallback') fallbacks++;
      }
    });

    const rateLimitedPrimary = {
      name: 'gemini',
      model: 'gemini-4-hydrogen',
      async chat() {
        primaryCalls++;
        const err = new Error('429 rate limit exceeded');
        err.status = 429;
        throw err;
      }
    };

    // 1st call: hits 429 once, does NOT retry, fails over immediately
    const res1 = await router.chat(rateLimitedPrimary, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res1.fallbackUsed, true);
    assert.equal(res1.routedModel, 'gpt-4o');
    assert.equal(primaryCalls, 1);
    assert.equal(retries, 0);
    assert.equal(fallbacks, 1);

    // 2nd call within cooldown: skips primary completely!
    const res2 = await router.chat(rateLimitedPrimary, { messages: [{ role: 'user', content: 'hi again' }] });
    assert.equal(res2.fallbackUsed, true);
    assert.equal(primaryCalls, 1);
    assert.equal(fallbacks, 2);

    // Cloud request must NEVER fall back to a local model (e.g. om / vllm)
    const cloudOnlyRouter = new ModelRouter({
      routing: {
        enabled: true,
        maxRetries: 0,
        fallbackChain: [
          { provider: 'om', model: 'om-reasoning' },
          { provider: 'vllm', model: 'qwen3.8-27b', allowLocalFallback: true }
        ]
      }
    });
    assert.equal(cloudOnlyRouter.getFallbackCandidates('gemini', 'gemini-4-hydrogen').length, 0);
    await assert.rejects(
      () => cloudOnlyRouter.chat(rateLimitedPrimary, { messages: [{ role: 'user', content: 'hi' }] }),
      /429 rate limit exceeded/
    );
  });

  await t.test('OMAgent executes multiple tool calls in parallel within ReAct loop', async () => {
    let callCount = 0;
    const parallelProvider = {
      name: 'mock',
      model: 'mock-parallel',
      async chat() {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Running two slow tools concurrently.',
            toolCalls: [
              { id: 't1', name: 'slow_tool', args: { label: 'A' } },
              { id: 't2', name: 'slow_tool', args: { label: 'B' } }
            ]
          };
        }
        return { content: 'Both done.', toolCalls: [] };
      }
    };

    const agent = new OMAgent({
      provider: 'om',
      providerInstance: parallelProvider,
      memoryDir: path.join(TMP_DIR, 'parallel_mem'),
      workspaceDir: TMP_DIR
    });

    agent.registerSkill({
      name: 'slow_tool',
      description: 'Waits 80ms',
      parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      execute: async ({ label }) => {
        await new Promise((r) => setTimeout(r, 80));
        return { success: true, label };
      }
    });

    const t0 = Date.now();
    const res = await agent.run('Run A and B');
    const elapsed = Date.now() - t0;
    assert.equal(res.success, true);
    assert.equal(res.steps[0].toolCalls.length, 2);
    assert.ok(elapsed < 150, `Expected parallel execution < 150ms, took ${elapsed}ms`);
  });

  await t.test('OMMemory supports async writes, recursive chunking, and memory pruning', async () => {
    const { OMMemory, recursiveChunkText } = await import('../dist/memory.js');
    const memDir = path.join(TMP_DIR, 'async_mem');
    const memory = new OMMemory(memDir);

    await memory.appendFactAsync('User prefers concise TypeScript examples.');
    await memory.logDailyAsync('Completed async memory test.');
    await memory.flush();

    const longDoc = `# Section 1\n${'Alpha sentence. '.repeat(25)}\n\n# Section 2\n${'Beta sentence. '.repeat(25)}`;
    const chunks = recursiveChunkText(longDoc, { chunkSize: 220, chunkOverlap: 40 });
    assert.ok(chunks.length >= 3);

    const indexed = memory.indexKnowledge('arch_guide.md', longDoc, { chunkSize: 220, chunkOverlap: 40 });
    assert.ok(indexed >= 3);

    // Add an expired journal vector and test pruning
    memory.vectorStore.documents.push({
      id: 'old_vec_1',
      text: 'Very old transient journal entry',
      source: 'daily/2020-01-01.md',
      metadata: {},
      hash: 'oldhash1',
      vector: new Array(256).fill(0),
      timestamp: '2020-01-01T00:00:00.000Z'
    });

    const pruneRes = memory.pruneMemories({ maxDocuments: 50, maxAgeDays: 30 });
    assert.ok(pruneRes.removed >= 1);
    assert.ok(memory.vectorStore.documents.some((d) => d.source === 'MEMORY.md'));
    await memory.flush();
  });

  await t.test('SQLiteVectorStore persists and searches vectors using node:sqlite', async () => {
    const { SQLiteVectorStore } = await import('../dist/vectorStore.js');
    const dbPath = path.join(TMP_DIR, 'vectors.sqlite');
    const store = new SQLiteVectorStore(dbPath);
    await store.init();
    store.upsertDocument({ text: 'SQLite vector store test document', source: 'sqlite-test' }, false);
    await store.flush();
    store.close();

    const store2 = new SQLiteVectorStore(dbPath);
    await store2.init();
    const hits = store2.search('SQLite vector store');
    store2.close();
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].source, 'sqlite-test');
  });

  await t.test('MCPClient scrubs sensitive provider keys from child env by default', async () => {
    const prevOpenAI = process.env.OPENAI_API_KEY;
    const prevGateway = process.env.OM_GATEWAY_TOKEN;
    process.env.OPENAI_API_KEY = 'sk-mcp-leak-check';
    process.env.OM_GATEWAY_TOKEN = 'gw-mcp-leak-check';

    const serverScript = [
      'const readline = require("readline");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      '  if (msg.id === undefined) return;',
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");',
      '  } else if (msg.method === "tools/call") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ openai: process.env.OPENAI_API_KEY || null, gateway: process.env.OM_GATEWAY_TOKEN || null, custom: process.env.CUSTOM_MCP_TOKEN || null, gemini: process.env.GEMINI_API_KEY || null }) }] } }) + "\\n");',
      '  }',
      '});'
    ].join(' ');

    try {
      const scrubbedClient = new MCPClient('scrub-test', {
        command: process.execPath,
        args: ['-e', serverScript],
        env: { CUSTOM_MCP_TOKEN: 'per-server-ok', GEMINI_API_KEY: 'explicit-mcp-gemini' }
      });
      await scrubbedClient.connect();
      const res = await scrubbedClient.callTool('inspect_env', {});
      scrubbedClient.close();
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.openai, null);
      assert.equal(parsed.gateway, null);
      assert.equal(parsed.custom, 'per-server-ok');
      assert.equal(parsed.gemini, 'explicit-mcp-gemini');

      const inheritClient = new MCPClient('inherit-test', {
        command: process.execPath,
        args: ['-e', serverScript],
        inheritSensitiveEnv: true
      });
      await inheritClient.connect();
      const res2 = await inheritClient.callTool('inspect_env', {});
      inheritClient.close();
      const parsed2 = JSON.parse(res2.content[0].text);
      assert.equal(parsed2.openai, 'sk-mcp-leak-check');
    } finally {
      if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAI;
      if (prevGateway === undefined) delete process.env.OM_GATEWAY_TOKEN;
      else process.env.OM_GATEWAY_TOKEN = prevGateway;
    }
  });

  await t.test('ModelRouter hardware-aware routing shifts local calls to cloud on VRAM pressure', async () => {
    const events = [];
    let cloudCalls = 0;
    let localCalls = 0;
    const router = new ModelRouter({
      config: { provider: 'lmstudio', model: 'local-32b' },
      onEvent: (evt, payload) => events.push({ evt, payload }),
      hardwareSampler: async () => ({
        gpus: [{ name: 'Mock GPU', vramTotalMb: 8192, vramUsedMb: 7500, vramFreeMb: 692, utilizationPct: 95, temperatureC: 72 }],
        ram: { totalGb: 16, usedGb: 12, freeGb: 4, usedPct: 75 }
      }),
      providerFactory: () => ({
        name: 'openai',
        model: 'gpt-4o',
        async chat() {
          cloudCalls++;
          return { content: 'routed-cloud', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        }
      })
    });

    const localProv = {
      name: 'lmstudio',
      model: 'local-32b',
      async chat() {
        localCalls++;
        return { content: 'local-ok', usage: {} };
      }
    };

    const res = await router.chat(
      localProv,
      { messages: [{ role: 'user', content: 'hi' }] },
      {
        hardwareRouting: {
          enabled: true,
          minFreeVramMb: 1536,
          cloudTarget: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test-hw-route' }
        }
      }
    );

    assert.equal(res.hardwareRouted, true);
    assert.equal(res.routedProvider, 'openai');
    assert.equal(cloudCalls, 1);
    assert.equal(localCalls, 0);
    assert.equal(router.stats.hardwareRoutes, 1);
    assert.ok(events.some((e) => e.evt === 'route_decision' && String(e.payload.reason).includes('hardware_vram_pressure')));
  });

  await t.test('OS/container sandbox wrapper builds isolated commands and fails closed when strict', async () => {
    const linuxBwrap = buildSandboxedCommand(
      'node',
      ['-v'],
      TMP_DIR,
      { mode: 'os', allowNetwork: false },
      { platform: 'linux', probe: (bin) => bin === 'bwrap' }
    );
    assert.equal(linuxBwrap.backend, 'bwrap');
    assert.equal(linuxBwrap.executable, 'bwrap');
    assert.ok(linuxBwrap.args.includes('--unshare-net'));
    assert.ok(linuxBwrap.args.includes('--bind'));

    const macSandbox = buildSandboxedCommand(
      'node',
      ['-v'],
      TMP_DIR,
      { mode: 'os', allowNetwork: false },
      { platform: 'darwin', probe: (bin) => bin.includes('sandbox-exec') }
    );
    assert.equal(macSandbox.backend, 'sandbox-exec');
    assert.equal(macSandbox.args[0], '-f');
    assert.ok(fs.existsSync(macSandbox.args[1]));
    macSandbox.cleanup();
    assert.ok(!fs.existsSync(macSandbox.args[1]));

    const wslBwrap = buildSandboxedCommand(
      'node',
      ['-v'],
      'C:\\Users\\demo\\proj',
      { mode: 'os', allowNetwork: false },
      { platform: 'win32', probe: (bin) => bin === 'wsl-bwrap' }
    );
    assert.equal(wslBwrap.backend, 'wsl-bwrap');
    assert.equal(wslBwrap.executable, 'wsl.exe');
    assert.ok(wslBwrap.args.includes('/mnt/c/Users/demo/proj'));
    assert.ok(wslBwrap.args.includes('--unshare-net'));

    const winJob = buildSandboxedCommand(
      'node',
      ['-v'],
      TMP_DIR,
      { mode: 'os', memoryMb: 256, maxProcesses: 8 },
      { platform: 'win32', probe: (bin) => bin === 'powershell.exe' }
    );
    assert.equal(winJob.backend, 'win-job');
    assert.equal(winJob.executable, 'powershell.exe');
    const psArgIdx = winJob.args.indexOf('-File');
    assert.ok(psArgIdx !== -1 && fs.existsSync(winJob.args[psArgIdx + 1]));
    winJob.cleanup();
    assert.ok(!fs.existsSync(winJob.args[psArgIdx + 1]));

    const dockerSandbox = buildSandboxedCommand(
      'node',
      ['-v'],
      TMP_DIR,
      { mode: 'container', allowNetwork: false, containerImage: 'node:22-alpine' },
      { platform: 'win32', probe: (bin) => bin === 'docker' }
    );
    assert.equal(dockerSandbox.backend, 'docker');
    assert.ok(dockerSandbox.args.includes('--network=none'));
    assert.ok(dockerSandbox.args.includes('--read-only'));

    assert.throws(
      () =>
        buildSandboxedCommand(
          'node',
          ['-v'],
          TMP_DIR,
          { mode: 'os', strict: true },
          { platform: 'win32', probe: () => false }
        ),
      /strict mode/i
    );

    const registry = new SkillRegistry();
    const strictRun = await registry.execute(
      'exec_command',
      { command: 'node -v' },
      { config: { workspaceDir: TMP_DIR, security: { allowedCommands: ['node'], sandbox: { mode: 'os', strict: true } } } }
    );
    if (process.platform === 'win32') {
      assert.equal(strictRun.success, true);
      assert.ok(['wsl-bwrap', 'win-job'].includes(strictRun.sandboxBackend));
    }
  });
});

