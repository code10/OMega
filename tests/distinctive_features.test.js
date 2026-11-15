import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  OMAgent,
  SkillRegistry,
  ModelRouter,
  WorkspaceSnapshotManager,
  OMGitManager,
  SessionReplay,
  OMDaemon,
  OMEvalRunner,
  OMSelfImprover,
  OMTrainingPipeline,
  startGateway
} from '../dist/index.js';
import { MCPClient } from '../dist/mcp/client.js';
import { estimateMessagesTokens, getModelContextLimit } from '../dist/tokenizer.js';
import { createHttpEmbedder } from '../dist/vectorStore.js';
import { compactHistory } from '../dist/agent/compaction.js';
import { execFileSync } from 'node:child_process';

function makeTempDir(prefix = 'omega-feat-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('OMega Core Reliability & Distinctive Features', () => {
  it('1. History compaction never orphans tool messages', () => {
    const tmp = makeTempDir();
    try {
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp,
        maxHistoryMessages: 16
      });
      // Build 18 messages where index length-12 would land on a 'tool' message
      for (let i = 0; i < 6; i++) {
        agent.history.push({ role: 'user', content: `Task ${i}` });
        agent.history.push({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `tc_${i}`, name: 'get_current_time', args: {} }]
        });
        agent.history.push({ role: 'tool', name: 'get_current_time', toolCallId: `tc_${i}`, content: '{"ok":true}' });
      }
      agent._compactHistoryIfNeeded();
      // First message after compacted summary must NOT be role 'tool'
      assert.equal(agent.history[0].role, 'user');
      assert.notEqual(agent.history[1].role, 'tool');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('2. Supports AbortSignal cancellation and live steering', async () => {
    const tmp = makeTempDir();
    try {
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp
      });
      const ac = new AbortController();
      ac.abort();
      const abortedRes = await agent.run('Hello', { signal: ac.signal });
      assert.equal(abortedRes.aborted, true);
      assert.equal(abortedRes.success, false);

      assert.equal(agent.steer('Keep it under 10 words'), true);
      const steeredRes = await agent.run('Tell me the time');
      assert.equal(steeredRes.success, true);
      assert.ok(agent.history.some((m) => String(m.content).includes('[Live Steering Directive]')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('3. Lifecycle hooks (beforeModel, beforeTool, afterTool) can intercept and block tools', async () => {
    const tmp = makeTempDir();
    try {
      const seen = [];
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp
      });
      agent.use({
        beforeModel: (ctx) => { seen.push('beforeModel'); return ctx; },
        beforeTool: (ctx) => {
          seen.push(`beforeTool:${ctx.name}`);
          if (ctx.name === 'get_system_info') {
            return { cancel: true, reason: 'Blocked by policy hook' };
          }
        },
        afterTool: (ctx) => { seen.push(`afterTool:${ctx.name}`); return ctx; }
      });

      const res = await agent.run('Check system info');
      assert.equal(res.success, true);
      assert.ok(seen.includes('beforeModel'));
      assert.ok(seen.includes('beforeTool:get_system_info'));
      const toolStep = res.steps.find((s) => s.toolCalls?.length > 0);
      assert.equal(toolStep.toolCalls[0].result.success, false);
      assert.match(toolStep.toolCalls[0].result.error, /Blocked by policy hook/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('4. SkillRegistry.loadFromDirectory preserves mcp and runtime skills', async () => {
    const tmp = makeTempDir();
    try {
      const skillsDir = path.join(tmp, 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      const registry = new SkillRegistry();
      registry.register({ name: 'mcp_demo_ping', execute: async () => ({ ok: true }) }, 'mcp');
      registry.register({ name: 'custom_runtime_tool', execute: async () => ({ ok: true }) }, 'runtime');

      await registry.loadFromDirectory(skillsDir);
      assert.ok(registry.has('mcp_demo_ping'));
      assert.ok(registry.has('custom_runtime_tool'));
      assert.ok(registry.has('read_file'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('5. MCPClient supports Streamable HTTP transport, resources, and prompts', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const rpc = JSON.parse(body || '{}');
        let result = {};
        if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {} };
        else if (rpc.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo' }] };
        else if (rpc.method === 'resources/list') result = { resources: [{ uri: 'file:///demo.txt', name: 'demo' }] };
        else if (rpc.method === 'prompts/list') result = { prompts: [{ name: 'summarize' }] };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-123' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
      const client = new MCPClient('http-demo', { transport: 'http', url: `http://127.0.0.1:${port}/mcp` });
      await client.connect();
      const tools = await client.listTools();
      const resources = await client.listResources();
      const prompts = await client.listPrompts();
      assert.equal(tools[0].name, 'echo');
      assert.equal(resources[0].name, 'demo');
      assert.equal(prompts[0].name, 'summarize');
    } finally {
      server.close();
    }
  });

  it('6. Subagent forwards telemetry to parent and supports isolated workspace', async () => {
    const tmp = makeTempDir();
    try {
      fs.writeFileSync(path.join(tmp, 'sample.txt'), 'hello', 'utf8');
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp
      });
      const subEvents = [];
      agent.on('subagent_activity', (ev) => subEvents.push(ev));

      const res = await agent.skills.execute(
        'spawn_subagent',
        { task: 'What is the current time?', maxSteps: 3, isolateWorkspace: true },
        { agent }
      );
      assert.equal(res.success, true);
      assert.equal(res.isolatedWorkspace, true);
      assert.ok(subEvents.length > 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('7. ModelRouter enforces token/cost budgets and complexity routing', async () => {
    const router = new ModelRouter({
      routing: {
        budget: { maxSessionTokens: 10 },
        complexityRouting: { enabled: true, simpleToLocal: true }
      }
    });
    const mockCloud = {
      name: 'openai',
      model: 'gpt-4o',
      chat: async () => ({ content: 'cloud', toolCalls: [], usage: { total_tokens: 20 } })
    };
    const res1 = await router.chat(mockCloud, {
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: ''
    });
    assert.equal(res1.complexityRouted, true);
    assert.equal(res1.routedProvider, 'om');

    // Now force token count over budget
    router.stats.totalTokens = 50;
    await assert.rejects(
      () => router.chat(mockCloud, { messages: [{ role: 'user', content: 'Analyze architecture' }], systemPrompt: '' }),
      /budget exceeded/i
    );
  });

  it('8. WorkspaceSnapshotManager captures pre-run files, diffs, and rolls back', async () => {
    const tmp = makeTempDir();
    try {
      const target = path.join(tmp, 'notes.txt');
      fs.writeFileSync(target, 'original content', 'utf8');

      const mgr = new WorkspaceSnapshotManager(tmp);
      const run = mgr.startRun('run_test_1');
      mgr.captureBeforeMutation(run.runId, target);
      mgr.captureBeforeMutation(run.runId, path.join(tmp, 'created.txt'));

      fs.writeFileSync(target, 'modified by agent', 'utf8');
      fs.writeFileSync(path.join(tmp, 'created.txt'), 'new file', 'utf8');

      const diff = mgr.diff(run.runId);
      assert.equal(diff.changes.length, 2);

      const rb = mgr.rollback(run.runId);
      assert.equal(rb.success, true);
      assert.equal(fs.readFileSync(target, 'utf8'), 'original content');
      assert.equal(fs.existsSync(path.join(tmp, 'created.txt')), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('9. SessionReplay forks from step, replays deterministically, and compares models', async () => {
    const tmp = makeTempDir();
    try {
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp
      });
      await agent.run('What is the current time?');
      const origId = agent.sessionId;

      const forked = SessionReplay.forkFromStep(agent.memory, origId, 1);
      assert.notEqual(forked.sessionId, origId);
      assert.equal(forked.forkedFrom.sessionId, origId);

      const replay = await SessionReplay.deterministicReplay(agent, origId);
      assert.equal(replay.promptsReplayed, 1);
      assert.equal(replay.results[0].success, true);

      const cmp = await SessionReplay.compareModels(
        { memoryDir: path.join(tmp, 'mem'), workspaceDir: tmp },
        'Hello',
        [{ provider: 'om', model: 'om-turbo' }, { provider: 'om', model: 'om-reasoning' }]
      );
      assert.equal(cmp.results.length, 2);
      assert.ok(cmp.results.every((r) => r.success));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('10. OMDaemon fires webhook triggers and OMEvalRunner evaluates suites', async () => {
    const tmp = makeTempDir();
    try {
      const daemon = new OMDaemon({
        provider: 'om',
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp
      });
      daemon.addTrigger({ id: 'nightly', type: 'webhook', prompt: 'Hello' });
      const rec = await daemon.fireTrigger('nightly', { source: 'test' });
      assert.equal(rec.success, true);
      assert.equal(daemon.getStatus().triggers[0].runCount, 1);

      const evalReport = await OMEvalRunner.runSuite(
        {
          name: 'Smoke Eval',
          cases: [
            { id: 'time-check', prompt: 'What is the current time?', expectedTools: ['get_current_time'], maxStepsExpected: 4 }
          ]
        },
        { agentOptions: { memoryDir: path.join(tmp, 'mem'), workspaceDir: tmp } }
      );
      assert.equal(evalReport.targets[0].passed, 1);
      assert.equal(evalReport.targets[0].passRate, 100);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('11. Gateway exposes HITL approval, snapshots, fork, and webhook endpoints', async () => {
    const tmp = makeTempDir();
    const gw = await startGateway({
      port: 0,
      host: '127.0.0.1',
      provider: 'om',
      memoryDir: path.join(tmp, 'mem'),
      workspaceDir: tmp
    });
    const base = `http://127.0.0.1:${gw.server.address().port}`;
    try {
      const snapRes = await fetch(`${base}/api/snapshots`);
      assert.equal(snapRes.status, 200);

      const daemonRes = await fetch(`${base}/api/daemon/status`);
      assert.equal(daemonRes.status, 200);

      const abortRes = await fetch(`${base}/api/chat/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(abortRes.status, 200);

      const steerRes = await fetch(`${base}/api/chat/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: 'Be concise' })
      });
      assert.equal(steerRes.status, 200);
    } finally {
      gw.server.close();
      await gw.agent.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('12. Tier 1 (OMSelfImprover) distills daily insights and promotes SKILL.md workflows', async () => {
    const tmp = makeTempDir();
    try {
      const skillsDir = path.join(tmp, 'skills');
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: path.join(tmp, 'mem'),
        skillsDir,
        workspaceDir: tmp
      });
      agent.memory.logDaily('Decided to use PostgreSQL 16 for persistence.');
      await agent.run('What is the current time?');

      const distilled = await OMSelfImprover.distill(agent);
      assert.equal(distilled.success, true);
      assert.ok(distilled.factsAdded >= 1);
      assert.ok(agent.memory.readLongTermMemory().includes('PostgreSQL 16'));

      const promoted = OMSelfImprover.promoteWorkflow(skillsDir, {
        name: 'health-check',
        description: 'Run system health check',
        steps: ['Call get_system_info', 'Summarize findings'],
        triggers: ['health', 'status']
      });
      assert.equal(promoted.success, true);
      assert.ok(fs.existsSync(promoted.path));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('13. Tier 2 (OMTrainingPipeline) exports SFT/DPO JSONL and gates promotion via OMEvalRunner', async () => {
    const tmp = makeTempDir();
    try {
      const memDir = path.join(tmp, 'mem');
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: memDir,
        workspaceDir: tmp
      });
      await agent.run('What is the current time?');

      OMTrainingPipeline.recordPreference(memDir, {
        prompt: 'What is the current time?',
        chosen: 'The current time is 12:00 UTC.',
        rejected: 'I do not know.'
      });

      const exported = OMTrainingPipeline.exportDataset(memDir, path.join(tmp, 'out'));
      assert.equal(exported.success, true);
      assert.ok(exported.sftCount >= 1);
      assert.ok(exported.dpoCount >= 1);
      assert.ok(fs.existsSync(exported.sftPath));
      assert.ok(fs.existsSync(exported.dpoPath));

      const promo = await OMTrainingPipeline.evaluateForPromotion(
        {
          name: 'Gate Suite',
          cases: [{ id: 't1', prompt: 'What is the current time?', expectedTools: ['get_current_time'] }]
        },
        {
          baselineTarget: { provider: 'om', model: 'om-turbo' },
          candidateTarget: { provider: 'om', model: 'om-reasoning' },
          agentOptions: { memoryDir: memDir, workspaceDir: tmp }
        }
      );
      assert.equal(promo.promote, true);
      assert.equal(promo.candidate.passRate, 100);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('provides model-aware token estimation and context limits via tokenizer.js', () => {
    assert.equal(getModelContextLimit('openai', 'gpt-4o'), 128000);
    assert.equal(getModelContextLimit('gemini', 'gemini-2.5-flash'), 1000000);
    assert.equal(getModelContextLimit('anthropic', 'claude-3-5-sonnet-20241022'), 200000);
    assert.ok(getModelContextLimit('custom', 'unknown-custom-model') > 0);

    const usage = estimateMessagesTokens([
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: '```js\nconst x = 42;\nconsole.log(x);\n```' }
    ], 'You are a helpful assistant.');
    assert.ok(usage.estimatedTokens > 15 && usage.estimatedTokens < 200);
  });

  it('supports createHttpEmbedder against an OpenAI-compatible embeddings endpoint', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const embedder = createHttpEmbedder({ url: `http://127.0.0.1:${port}/v1/embeddings`, apiKey: 'test-key' });
      const vec = await embedder('test embedding text');
      assert.deepEqual(vec, [0.1, 0.2, 0.3, 0.4]);
    } finally {
      server.close();
    }
  });

  it('supports LLM-backed OMSelfImprover.distill with graceful heuristic fallback', async () => {
    const tmp = makeTempDir('omega-distill-');
    try {
      const agent = new OMAgent({ provider: 'om', memoryDir: tmp, workspaceDir: tmp });
      await agent.init();
      agent.memory.logDaily('User decided to use PostgreSQL for production.');

      agent.router = /** @type {any} */ ({
        chat: async () => ({ content: '```json\n["Production uses PostgreSQL"]\n```' })
      });
      const llmRes = await OMSelfImprover.distill(agent, { useLLM: true });
      assert.equal(llmRes.mode, 'llm');
      assert.equal(llmRes.factsAdded, 1);
      assert.ok(agent.memory.readLongTermMemory().includes('Production uses PostgreSQL'));

      agent.router = /** @type {any} */ ({
        chat: async () => { throw new Error('offline'); }
      });
      agent.memory.logDaily('We always prefer TypeScript strict mode.');
      const fallbackRes = await OMSelfImprover.distill(agent, { useLLM: true });
      assert.equal(fallbackRes.mode, 'heuristic');
      assert.ok(agent.memory.readLongTermMemory().includes('TypeScript strict mode'));
      await agent.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('compacts history based on compactionThresholdTokens while preserving tool pairs', async () => {
    const tmp = makeTempDir('omega-compact-tok-');
    try {
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: tmp,
        workspaceDir: tmp,
        compactionThresholdTokens: 50
      });
      for (let i = 0; i < 16; i++) {
        agent.history.push({ role: 'user', content: `Turn ${i}: ${'word '.repeat(20)}` });
      }
      agent._compactHistoryIfNeeded();
      assert.ok(agent.history.length < 16);
      assert.ok(String(agent.history[0].content).includes('[Compacted Earlier Context'));
      await agent.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('scores complexity via multi-signal ModelRouter.classifyComplexity', () => {
    assert.equal(ModelRouter.classifyComplexity({ messages: [{ role: 'user', content: 'hi' }], tools: [] }), 'simple');
    assert.equal(
      ModelRouter.classifyComplexity({
        messages: [
          { role: 'user', content: 'Analyze the architecture trade-offs and debug this stack trace:\n```js\nTypeError: x is not a function\n```' }
        ],
        tools: new Array(6).fill({ name: 't' })
      }),
      'complex'
    );
  });

  it('wires config.embedding.url into OMAgent.memory.vectorStore.asyncEmbedder', async () => {
    const tmp = makeTempDir('omega-embed-cfg-');
    try {
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: tmp,
        workspaceDir: tmp,
        embedding: { url: 'http://127.0.0.1:11434/api/embed', model: 'nomic-embed-text' }
      });
      assert.equal(typeof agent.memory.vectorStore.asyncEmbedder, 'function');
      await agent.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports optional LLM-summarized compaction with heuristic fallback', async () => {
    const tmp = makeTempDir('omega-llm-compact-');
    try {
      const agent = new OMAgent({
        provider: 'om',
        memoryDir: tmp,
        workspaceDir: tmp,
        compactionThresholdTokens: 40,
        llmCompaction: true
      });
      for (let i = 0; i < 16; i++) {
        agent.history.push({ role: 'user', content: `Turn ${i}: ${'detail '.repeat(15)}` });
      }
      agent.router = /** @type {any} */ ({
        chat: async () => ({ content: 'Summary: Refactored auth.js and fixed token bug.' })
      });
      const llmRes = await compactHistory(agent);
      assert.equal(llmRes.compacted, true);
      assert.equal(llmRes.mode, 'llm');
      assert.ok(String(agent.history[0].content).includes('Refactored auth.js'));

      // Fallback when router.chat throws
      for (let i = 0; i < 16; i++) {
        agent.history.push({ role: 'user', content: `Extra ${i}: ${'detail '.repeat(15)}` });
      }
      agent.router = /** @type {any} */ ({
        chat: async () => { throw new Error('offline'); }
      });
      const fbRes = await compactHistory(agent);
      assert.equal(fbRes.compacted, true);
      assert.equal(fbRes.mode, 'heuristic');
      await agent.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports OMGitManager status, diff, branching, worktrees, and commits', () => {
    const tmp = makeTempDir('omega-git-');
    const wtDir = path.join(os.tmpdir(), `omega-wt-${Date.now().toString(36)}`);
    try {
      execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmp, 'app.js'), 'console.log(1);\n', 'utf8');

      const git = new OMGitManager(tmp);
      assert.equal(git.isGitRepo(), true);
      const firstCommit = git.commit('initial commit');
      assert.equal(firstCommit.committed, true);

      fs.writeFileSync(path.join(tmp, 'app.js'), 'console.log(2);\n', 'utf8');
      const status = git.getStatus();
      assert.equal(status.clean, false);
      assert.ok(git.getDiff().includes('console.log(2)'));
      git.commit('update app.js');

      const wt = git.createWorktree(wtDir, 'feat-isolated');
      assert.equal(fs.existsSync(wt.worktreePath), true);
      git.removeWorktree(wt.worktreePath);
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exposes built-in git skills and gitWorktree isolation in spawn_subagent', async () => {
    const tmp = makeTempDir('omega-git-skills-');
    const memDir = makeTempDir('omega-git-mem-');
    try {
      execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmp, 'index.js'), 'export const a = 1;\n', 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });

      const agent = new OMAgent({ provider: 'om', memoryDir: memDir, workspaceDir: tmp });
      const statusRes = await agent.skills.execute('git_status', {}, { config: agent.config, agent });
      assert.equal(statusRes.success, true);
      assert.equal(statusRes.clean, true);

      const subRes = await agent.skills.execute(
        'spawn_subagent',
        { task: 'Say ok', maxSteps: 2, gitWorktree: true },
        { agent }
      );
      assert.equal(subRes.success, true);
      assert.equal(subRes.gitWorktree, true);
      await agent.close();
    } finally {
      fs.rmSync(memDir, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports SSE token streaming and multi-modal files/images in http_request', async () => {
    const tmp = makeTempDir('omega-http-mm-');
    let lastContentType = '';
    let lastBodyText = '';
    const server = http.createServer((req, res) => {
      if (req.url === '/sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"world!"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (req.url === '/upload') {
        lastContentType = req.headers['content-type'] || '';
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          lastBodyText = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        });
        return;
      }
      if (req.url === '/image') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from([137, 80, 78, 71]));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const registry = new SkillRegistry();
      const ctx = { config: { workspaceDir: tmp, security: { allowPrivateNetwork: true } } };

      // 1. SSE token streaming
      const sseRes = await registry.execute('http_request', { url: `http://127.0.0.1:${port}/sse`, stream: true }, ctx);
      assert.equal(sseRes.success, true);
      assert.equal(sseRes.streamed, true);
      assert.equal(sseRes.text, 'Hello world!');
      assert.equal(sseRes.events.length, 3);

      // 2. Multi-modal multipart file + base64 image upload
      fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello attachment', 'utf8');
      const uploadRes = await registry.execute(
        'http_request',
        {
          url: `http://127.0.0.1:${port}/upload`,
          method: 'POST',
          files: [{ field: 'doc', path: 'note.txt' }],
          images: [{ field: 'pic', base64: Buffer.from('imgdata').toString('base64'), mimeType: 'image/png', filename: 'test.png' }]
        },
        ctx
      );
      assert.equal(uploadRes.success, true);
      assert.ok(lastContentType.includes('multipart/form-data'));
      assert.ok(lastBodyText.includes('hello attachment'));
      assert.ok(lastBodyText.includes('test.png'));

      // 3. Binary image response
      const imgRes = await registry.execute('http_request', { url: `http://127.0.0.1:${port}/image` }, ctx);
      assert.equal(imgRes.success, true);
      assert.equal(imgRes.isBinary, true);
      assert.equal(imgRes.sizeBytes, 4);
      assert.equal(Buffer.from(imgRes.base64, 'base64')[0], 137);
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('encodes and counts subword tokens via zero-dependency BPETokenizer', async () => {
    const { BPETokenizer, encodeTokens, countTokens } = await import('../dist/tokenizer.js');
    const tok = new BPETokenizer();
    const ids = tok.encode('const result = await fetch("https://example.com");');
    assert.ok(Array.isArray(ids) && ids.length > 5 && ids.length < 30);
    assert.equal(ids.length, tok.count('const result = await fetch("https://example.com");'));
    assert.deepEqual(encodeTokens('function return const'), encodeTokens('function return const'));
    assert.ok(countTokens('hello world', 'claude-3-5-sonnet') >= countTokens('hello world', 'gpt-4o'));
  });

  it('hardens WHATWG SSE parsing (multi-line data, indentation, retry, id, buffer cap)', async () => {
    const { consumeSSEStream } = await import('../dist/utils/http.js');
    const ssePayload = [
      ': keepalive comment',
      'id: evt-42',
      'retry: 2500',
      'event: delta',
      'data: line1',
      'data:   indented',
      '',
      ''
    ].join('\n');

    const res = new Response(ssePayload, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });

    const events = [];
    let retrySeen = null;
    await consumeSSEStream(
      res,
      (dataStr, eventName, id) => events.push({ dataStr, eventName, id }),
      { onRetry: (ms) => { retrySeen = ms; } }
    );

    assert.equal(retrySeen, 2500);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventName, 'delta');
    assert.equal(events[0].id, 'evt-42');
    assert.equal(events[0].dataStr, 'line1\n  indented');

    const oversized = new Response('data: ' + 'x'.repeat(200) + '\n\n');
    await assert.rejects(
      () => consumeSSEStream(oversized, () => {}, { maxBufferBytes: 64 }),
      /SSE stream buffer exceeded/
    );
  });
});

