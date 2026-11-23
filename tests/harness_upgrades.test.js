import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OMAgent,
  OMAuditLedger,
  estimateCostUsd,
  SessionReplay,
  ReplayProvider,
  OMEvalRunner,
  startGateway
} from '../dist/index.js';
import { buildSandboxedCommand, spawnSandboxed } from '../dist/skills/sandbox.js';

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

describe('OMega Harness Upgrades (Sandbox, Audit Ledger, Eval/Replay, CI)', () => {
  it('1. Windows OS-level sandbox enables restricted token + UI restrictions by default and executes cleanly', async () => {
    const tmp = makeTempDir('om-sandbox-win-');
    try {
      const mocked = buildSandboxedCommand(
        'node',
        ['-v'],
        tmp,
        { mode: 'auto' },
        { platform: 'win32', probe: (bin) => bin === 'powershell.exe' }
      );
      assert.equal(mocked.backend, 'win-job');
      mocked.cleanup();

      if (process.platform === 'win32') {
        const live = buildSandboxedCommand('node', ['-e', 'console.log("sandbox-v2-ok")'], tmp, {
          mode: 'auto',
          memoryMb: 512,
          maxProcesses: 16
        });
        assert.equal(live.backend, 'win-job');
        // Args format for om-winjob-v2.exe: [memMb, maxProcs, restrictToken, uiRestrictions, exe, ...args]
        if (live.executable.endsWith('om-winjob-v2.exe')) {
          assert.equal(live.args[2], '1');
          assert.equal(live.args[3], '1');
        }
        const res = await spawnSandboxed(live.executable, live.args, {
          cwd: tmp,
          env: process.env,
          timeoutMs: 15000,
          cleanup: live.cleanup
        });
        assert.equal(res.exitCode, 0, `Sandbox exit failed: ${res.stderr} ${res.errorMessage || ''}`);
        assert.ok(res.stdout.includes('sandbox-v2-ok'), `Expected sandbox-v2-ok, got: ${res.stdout}`);
      }
    } finally {
      safeRm(tmp);
    }
  });

  it('2. OMAuditLedger maintains a tamper-evident SHA-256 hash chain, redacts secrets, and aggregates costs', () => {
    const tmp = makeTempDir('om-audit-');
    try {
      const ledger = new OMAuditLedger(tmp, { ownerId: 'alice' });

      const e1 = ledger.recordToolCall({
        toolName: 'http_request',
        args: { url: 'https://example.com', token: 'sk-1234567890abcdefghijklmnop' },
        success: true,
        durationMs: 42,
        sessionId: 'sess_1'
      });
      assert.equal(e1.seq, 1);
      assert.equal(e1.prevHash, 'GENESIS');
      assert.ok(!JSON.stringify(e1.data).includes('sk-1234567890abcdefghijklmnop'), 'Secret must be redacted');

      ledger.recordApproval({
        requestId: 'appr_1',
        toolName: 'exec_command',
        command: 'npm test',
        approved: true,
        scope: 'once',
        ownerId: 'alice'
      });

      ledger.recordLlmUsage({
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        sessionId: 'sess_1',
        ownerId: 'alice'
      });

      ledger.recordLlmUsage({
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        promptTokens: 2000,
        completionTokens: 1000,
        totalTokens: 3000,
        sessionId: 'sess_2',
        ownerId: 'bob'
      });

      const verified = ledger.verifyChain();
      assert.equal(verified.valid, true);
      assert.equal(verified.entriesChecked, 4);

      const expectedOpenAiCost = estimateCostUsd('openai', 'gpt-4o', { promptTokens: 1000, completionTokens: 500 });
      assert.equal(expectedOpenAiCost, 0.0075);

      const costs = ledger.getCostSummary();
      assert.equal(costs.calls, 2);
      assert.equal(costs.totalTokens, 4500);
      assert.ok(costs.costUsd > expectedOpenAiCost);
      assert.ok(costs.byModel['openai/gpt-4o']);
      assert.ok(costs.byOwner.alice);
      assert.ok(costs.byOwner.bob);

      // Tamper with entry #2 in the JSONL file and verify chain catches it
      const raw = fs.readFileSync(ledger.filePath, 'utf8');
      const tampered = raw.replace('"approved":true', '"approved":false');
      fs.writeFileSync(ledger.filePath, tampered, 'utf8');

      const afterTamper = ledger.verifyChain();
      assert.equal(afterTamper.valid, false);
      assert.equal(afterTamper.brokenAtSeq, 2);
    } finally {
      safeRm(tmp);
    }
  });

  it('3. End-to-end deterministic SessionTape export, offline ReplayProvider playback, and Eval baseline diffing', async () => {
    const tmp = makeTempDir('om-replay-');
    const memDir = path.join(tmp, 'memory');
    const wsDir = path.join(tmp, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'note.txt'), 'hello-replay-world', 'utf8');

    try {
      const scriptedTurns = [
        {
          content: 'Reading note.txt to inspect contents.',
          toolCalls: [{ id: 'tc_1', name: 'read_file', args: { path: 'note.txt' } }],
          usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
        },
        {
          content: 'The file contains: hello-replay-world',
          toolCalls: [],
          usage: { promptTokens: 180, completionTokens: 20, totalTokens: 200 }
        }
      ];

      const agent = new OMAgent({
        memoryDir: memDir,
        workspaceDir: wsDir,
        provider: 'om',
        model: 'om-turbo',
        providerInstance: new ReplayProvider(scriptedTurns, { name: 'replay', model: 'om-turbo' })
      });
      await agent.init();
      const runRes = await agent.run('Read note.txt and tell me what is inside.', { disableFailover: true });
      assert.equal(runRes.success, true);
      assert.ok(runRes.content.includes('hello-replay-world'));

      // Verify OMAgent automatically populated the tamper-evident audit ledger
      const auditEntries = agent.audit.query({ sessionId: agent.sessionId });
      assert.ok(auditEntries.some((e) => e.type === 'tool_call' && e.data.toolName === 'read_file'));
      assert.ok(auditEntries.some((e) => e.type === 'llm_usage'));
      assert.equal(agent.audit.verifyChain().valid, true);

      // Export tape, save to disk, reload, and replay offline without touching workspace
      const tape = SessionReplay.exportTape(agent.memory, agent.sessionId);
      const tapeFile = SessionReplay.saveTape(tape, path.join(tmp, 'tapes', 'read_note.tape.json'));
      const reloadedTape = SessionReplay.loadTape(tapeFile);
      await agent.close();

      // Remove note.txt to prove offline replay uses recorded tool output (0 side effects)
      fs.unlinkSync(path.join(wsDir, 'note.txt'));

      const replayDiff = await SessionReplay.replayTape(reloadedTape, {
        agentOptions: { memoryDir: path.join(tmp, 'replay_mem'), workspaceDir: wsDir }
      });
      assert.equal(replayDiff.passed, true);
      assert.equal(replayDiff.toolSequenceMatch, true);
      assert.equal(replayDiff.answersMatch, true);
      assert.equal(replayDiff.stepDelta, 0);

      // Run OMEvalRunner with the tape case & verify baseline regression diffing
      const suite = {
        name: 'Deterministic Replay Suite',
        cases: [{ id: 'tape_read_note', tapePath: tapeFile, maxStepsExpected: 3 }]
      };
      const baselineReport = await OMEvalRunner.runSuite(suite, {
        agentOptions: { memoryDir: path.join(tmp, 'eval_mem'), workspaceDir: wsDir }
      });
      assert.equal(baselineReport.targets[0].passRate, 100);

      const cleanDiff = OMEvalRunner.compareBaseline(baselineReport, baselineReport);
      assert.equal(cleanDiff.passed, true);
      assert.equal(cleanDiff.regressions.length, 0);

      // Simulate a regressed report and confirm compareBaseline catches it
      const regressedReport = structuredClone(baselineReport);
      regressedReport.targets[0].passRate = 0;
      regressedReport.targets[0].cases[0].passed = false;
      const failDiff = OMEvalRunner.compareBaseline(baselineReport, regressedReport);
      assert.equal(failDiff.passed, false);
      assert.ok(failDiff.regressions.some((r) => r.kind === 'pass_rate_drop'));
      assert.ok(failDiff.regressions.some((r) => r.kind === 'case_regressed'));
    } finally {
      safeRm(tmp);
    }
  });

  it('4. Gateway exposes /api/audit and /api/audit/costs with chain verification', async () => {
    const tmp = makeTempDir('om-audit-gw-');
    const gw = await startGateway({
      port: 0,
      host: '127.0.0.1',
      authToken: 'test-audit-token',
      memoryDir: path.join(tmp, 'memory'),
      workspaceDir: path.join(tmp, 'workspace'),
      persistConfig: false
    });
    try {
      gw.agent.audit.recordLlmUsage({
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 500,
        completionTokens: 250,
        totalTokens: 750,
        sessionId: 'gw_sess_1'
      });

      const headers = { Authorization: 'Bearer test-audit-token' };
      const auditRes = await fetch(`${gw.url}/api/audit`, { headers });
      assert.equal(auditRes.status, 200);
      const auditBody = await auditRes.json();
      assert.equal(auditBody.chain.valid, true);
      assert.ok(auditBody.count >= 1);

      const costsRes = await fetch(`${gw.url}/api/audit/costs`, { headers });
      assert.equal(costsRes.status, 200);
      const costsBody = await costsRes.json();
      assert.equal(costsBody.totalTokens, 750);
      assert.ok(costsBody.costUsd > 0);
    } finally {
      gw.server.close();
      safeRm(tmp);
    }
  });

  it('5. GitHub Actions CI runs build, lint, and full npm test on Linux, macOS, and Windows', () => {
    const ciPath = path.resolve('.github/workflows/ci.yml');
    assert.ok(fs.existsSync(ciPath), '.github/workflows/ci.yml must exist');
    const ci = fs.readFileSync(ciPath, 'utf8');
    assert.ok(ci.includes('ubuntu-latest'));
    assert.ok(ci.includes('macos-latest'));
    assert.ok(ci.includes('windows-latest'));
    assert.ok(ci.includes('npm run build'));
    assert.ok(ci.includes('npm run lint'));
    assert.ok(ci.includes('npm test'));
  });
});
