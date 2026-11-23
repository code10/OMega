import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OMAgent, BaseProvider, startGateway } from '../dist/index.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // ignore Windows file lock cleanup race
  }
}

class FlakyEdgeCaseProvider extends BaseProvider {
  constructor(script, options = {}) {
    super({ name: options.name || 'openai', model: options.model || 'gpt-4o' });
    this.script = script;
    this.calls = 0;
  }

  async chat(params) {
    const idx = this.calls++;
    const action = this.script[Math.min(idx, this.script.length - 1)];
    if (typeof action === 'function') {
      return action(params, idx);
    }
    if (action instanceof Error) {
      throw action;
    }
    return action;
  }
}

describe('Production Battle-Testing: Diverse Repo Topologies & Edge-Case LLM Providers', () => {
  it('1. Handles monorepo with Unicode, CRLF/LF mixed files, binary assets, and dirty git worktree merge', async () => {
    const tmp = makeTempDir('om-battle-repo-');
    const wsDir = path.join(tmp, 'monorepo');
    const memDir = path.join(tmp, 'memory');

    try {
      // Create diverse monorepo layout
      fs.mkdirSync(path.join(wsDir, 'packages', 'api', 'src', 'deep', 'nested'), { recursive: true });
      fs.mkdirSync(path.join(wsDir, 'packages', 'web', 'assets'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'packages', 'api', 'src', 'deep', 'nested', 'handler.ts'), 'export const greeting = "héllo — café 🚀";\r\nexport const version = 1;\r\n', 'utf8');
      fs.writeFileSync(path.join(wsDir, 'packages', 'web', 'assets', 'pixel.bin'), Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]));

      execFileSync('git', ['init'], { cwd: wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'ci@omega.local'], { cwd: wsDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'OMega CI'], { cwd: wsDir, stdio: 'ignore' });
      execFileSync('git', ['add', '-A'], { cwd: wsDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init monorepo'], { cwd: wsDir, stdio: 'ignore' });

      // Leave an untracked dirty file in base repo to simulate real developer workspace
      fs.writeFileSync(path.join(wsDir, 'LOCAL_SCRATCH.txt'), 'do not touch', 'utf8');

      const provider = new FlakyEdgeCaseProvider([
        {
          content: 'Inspecting nested handler and patching version.',
          toolCalls: [
            { id: 'c1', name: 'read_file', args: { path: 'packages/api/src/deep/nested/handler.ts' } }
          ],
          usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 }
        },
        {
          content: 'Patching version from 1 to 2.',
          toolCalls: [
            {
              id: 'c2',
              name: 'patch_file',
              args: {
                path: 'packages/api/src/deep/nested/handler.ts',
                targetText: 'export const version = 1;',
                replacementText: 'export const version = 2;'
              }
            }
          ],
          usage: { promptTokens: 260, completionTokens: 50, totalTokens: 310 }
        },
        {
          content: 'Updated nested handler version to 2 safely.',
          toolCalls: [],
          usage: { promptTokens: 300, completionTokens: 25, totalTokens: 325 }
        }
      ], { name: 'om', model: 'om-turbo' });

      const agent = new OMAgent({
        workspaceDir: wsDir,
        memoryDir: memDir,
        provider: 'om',
        model: 'om-turbo',
        providerInstance: provider
      });
      await agent.init();

      const res = await agent.run('Bump version in nested handler', {
        worktree: true,
        autoMergeWorktree: true,
        disableFailover: true
      });
      await agent.close();

      assert.equal(res.success, true);
      assert.equal(res.worktree?.merged, true, `Expected merged worktree, got: ${JSON.stringify(res.worktree)}`);
      const updated = fs.readFileSync(path.join(wsDir, 'packages', 'api', 'src', 'deep', 'nested', 'handler.ts'), 'utf8');
      assert.ok(updated.includes('export const version = 2;'));
      assert.ok(updated.includes('héllo — café 🚀'), 'Unicode preserved across patch + worktree merge');
      assert.equal(fs.readFileSync(path.join(wsDir, 'LOCAL_SCRATCH.txt'), 'utf8'), 'do not touch');
    } finally {
      safeRm(tmp);
    }
  });

  it('2. Recovers from HTTP 502/503 transient bursts via retry and 429 rate-limits via automatic failover', async () => {
    const tmp = makeTempDir('om-battle-llm-');
    try {
      // 2a. Transient 502 + 503 burst recovers via ModelRouter retries
      const badGatewayErr = Object.assign(new Error('502 Bad Gateway'), { status: 502 });
      const serverErr = Object.assign(new Error('503 Service Unavailable'), { status: 503 });

      const flaky = new FlakyEdgeCaseProvider([
        badGatewayErr,
        serverErr,
        {
          content: 'Recovered cleanly after transient 502 and 503 errors.',
          toolCalls: [],
          usage: { promptTokens: 150, completionTokens: 25, totalTokens: 175 }
        }
      ], { name: 'openai', model: 'gpt-4o' });

      const agent = new OMAgent({
        workspaceDir: path.join(tmp, 'ws'),
        memoryDir: path.join(tmp, 'mem'),
        provider: 'openai',
        model: 'gpt-4o',
        providerInstance: flaky,
        routing: { enabled: true, maxRetries: 2, retryDelayMs: 10, fallbackChain: [] }
      });
      await agent.init();

      const res = await agent.run('Ping after transient failures', { maxRetries: 2, disableFailover: true });
      assert.equal(res.success, true);
      assert.ok(res.content.includes('Recovered cleanly'));
      assert.equal(flaky.calls, 3);
      assert.equal(agent.audit.verifyChain().valid, true);
      assert.ok(agent.audit.getCostSummary().costUsd > 0, 'Cost ledger recorded recovered OpenAI usage');
      await agent.close();

      // 2b. HTTP 429 rate-limit triggers immediate cooldown + automatic cloud-to-cloud failover
      const rateLimitErr = Object.assign(new Error('429 Too Many Requests: rate limit exceeded'), { status: 429 });
      const rateLimited = new FlakyEdgeCaseProvider([rateLimitErr], { name: 'openai', model: 'gpt-4o' });
      const backupCloud = new FlakyEdgeCaseProvider([
        {
          content: 'Failover backup cloud provider responded cleanly.',
          toolCalls: [],
          usage: { promptTokens: 90, completionTokens: 20, totalTokens: 110 }
        }
      ], { name: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
      const failoverAgent = new OMAgent({
        workspaceDir: path.join(tmp, 'ws2'),
        memoryDir: path.join(tmp, 'mem2'),
        provider: 'openai',
        model: 'gpt-4o',
        providerInstance: rateLimited,
        routing: {
          enabled: true,
          maxRetries: 1,
          fallbackChain: [
            { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', providerInstance: backupCloud }
          ]
        }
      });
      await failoverAgent.init();
      const failoverRes = await failoverAgent.run('Respond via failover after 429');
      assert.equal(failoverRes.success, true);
      assert.equal(failoverRes.fallbackUsed, true);
      assert.equal(failoverRes.provider, 'anthropic');
      assert.equal(failoverAgent.router.isInCooldown('openai', 'gpt-4o'), true);
      await failoverAgent.close();
    } finally {
      safeRm(tmp);
    }
  });

  it('3. Handles parallel mixed tool success/failure, unknown tools, repeated-tool cycle detection, and empty responses', async () => {
    const tmp = makeTempDir('om-battle-tools-');
    const wsDir = path.join(tmp, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'ok.txt'), 'valid-data', 'utf8');

    try {
      let sawCycleNotice = false;
      const chaotic = new FlakyEdgeCaseProvider([
        // Turn 1: parallel call with one valid tool and one hallucinated tool
        {
          content: 'Running parallel tools.',
          toolCalls: [
            { id: 't1', name: 'read_file', args: { path: 'ok.txt' } },
            { id: 't2', name: 'nonexistent_hallucinated_tool', args: { foo: 'bar' } }
          ],
          usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 }
        },
        // Turn 2: repeat exact same read_file call to trigger cycle notice
        {
          content: 'Repeating read_file.',
          toolCalls: [
            { id: 't3', name: 'read_file', args: { path: 'ok.txt' } }
          ],
          usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 }
        },
        // Turn 3: verify cycle notice was injected into history, then return empty content
        (params) => {
          const histText = JSON.stringify(params.messages || []);
          sawCycleNotice = histText.includes('OM Cycle Notice');
          return {
            content: '',
            toolCalls: [],
            usage: { promptTokens: 140, completionTokens: 5, totalTokens: 145 }
          };
        }
      ], { name: 'om', model: 'om-turbo' });

      const agent = new OMAgent({
        workspaceDir: wsDir,
        memoryDir: path.join(tmp, 'mem'),
        provider: 'om',
        model: 'om-turbo',
        providerInstance: chaotic
      });
      await agent.init();

      const res = await agent.run('Stress test tool errors and cycles', { disableFailover: true });
      assert.equal(res.success, true);
      assert.equal(sawCycleNotice, true, 'Cycle detector must inject [OM Cycle Notice] on repeated tool calls');
      assert.ok(res.content.length > 0, 'Empty assistant response should fall back to safe completion notice');

      const toolEntries = agent.audit.query({ type: 'tool_call' });
      assert.ok(toolEntries.some((e) => e.data.toolName === 'read_file' && e.data.success === true));
      assert.ok(toolEntries.some((e) => e.data.toolName === 'nonexistent_hallucinated_tool' && e.data.success === false));
      assert.equal(agent.audit.verifyChain().valid, true);
      await agent.close();
    } finally {
      safeRm(tmp);
    }
  });

  it('4. Web UI renders the Audit Ledger & Cost Telemetry panel elements cleanly', async () => {
    const tmp = makeTempDir('om-battle-ui-');
    const gw = await startGateway({
      port: 0,
      host: '127.0.0.1',
      workspaceDir: path.join(tmp, 'ws'),
      memoryDir: path.join(tmp, 'mem'),
      persistConfig: false
    });
    try {
      const htmlRes = await fetch(`${gw.url}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      for (const id of [
        'auditLedgerCard',
        'auditChainBadge',
        'auditTypeFilter',
        'refreshAuditBtn',
        'auditCostSummary',
        'auditTotalCostUsd',
        'auditTotalTokens',
        'auditTotalCalls',
        'auditLedgerList'
      ]) {
        assert.ok(html.includes(`id="${id}"`), `Rendered Web UI missing #${id}`);
      }
    } finally {
      gw.server.close();
      safeRm(tmp);
    }
  });
});
