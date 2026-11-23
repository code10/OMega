import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { OMDaemon } from '../dist/daemon.js';
import { startGateway } from '../dist/gateway/server.js';

const TMP_BASE = path.resolve('./tests/tmp_daemon_last_mile');

function setupTempGitRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@omega.local"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "OMega Test"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
}

test('Deterministic-first check skips LLM on pass and wakes LLM with guardrails on fail', async () => {
  const dir = path.join(TMP_BASE, 'det_check');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const memDir = path.join(dir, 'memory');

  let llmCalls = 0;
  let lastRunOpts = null;
  let lastPrompt = '';
  const mockAgent = {
    config: { workspaceDir: dir, memoryDir: memDir },
    options: { workspaceDir: dir, memoryDir: memDir },
    async run(prompt, opts) {
      llmCalls += 1;
      lastPrompt = prompt;
      lastRunOpts = opts;
      return { success: true, content: 'Fixed it', usage: { totalTokens: 42 } };
    }
  };

  const daemon = new OMDaemon({ workspaceDir: dir, memoryDir: memDir });
  daemon.agent = mockAgent;

  let sawRunInStatusDuringEvent = false;
  daemon.on('trigger_run', (rec) => {
    const runs = daemon.getStatus().recentRuns;
    if (runs.some((r) => r.runId === rec.runId)) {
      sawRunInStatusDuringEvent = true;
    }
  });

  daemon.addTrigger({
    id: 'pass-check',
    checkCommand: 'node -e "process.exit(0)"',
    prompt: 'Should not run',
    maxSteps: 12,
    maxTokens: 1500
  });

  const passRec = await daemon.fireTrigger('pass-check');
  assert.equal(passRec.success, true);
  assert.equal(passRec.zeroToken, true);
  assert.equal(passRec.checkPassed, true);
  assert.equal(llmCalls, 0);
  assert.equal(sawRunInStatusDuringEvent, true);

  daemon.addTrigger({
    id: 'fail-check',
    checkCommand: 'node -e "console.error(\'broken_lint\'); process.exit(1)"',
    prompt: 'Fix the lint error',
    maxSteps: 7,
    maxTokens: 2000
  });

  const failRec = await daemon.fireTrigger('fail-check');
  assert.equal(failRec.success, true);
  assert.equal(failRec.checkPassed, false);
  assert.equal(llmCalls, 1);
  assert.ok(lastPrompt.includes('broken_lint'));
  assert.equal(lastRunOpts.maxSteps, 7);
  assert.equal(lastRunOpts.budgets.maxTokens, 2000);

  // Verify persistent run logs reload on a fresh OMDaemon instance
  const daemon2 = new OMDaemon({ workspaceDir: dir, memoryDir: memDir });
  assert.equal(daemon2.history.length, 2);
  assert.equal(daemon2.history[0].triggerId, 'pass-check');
  assert.equal(daemon2.history[1].triggerId, 'fail-check');

  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

test('Isolated worktree trigger captures diff and supports 1-click merge & discard', async () => {
  const repoDir = path.join(TMP_BASE, 'wt_repo');
  setupTempGitRepo(repoDir);
  const memDir = path.join(repoDir, '.mem');

  const daemon = new OMDaemon({ workspaceDir: repoDir, memoryDir: memDir });
  daemon.agent = {
    config: { workspaceDir: repoDir, memoryDir: memDir },
    options: { workspaceDir: repoDir, memoryDir: memDir }
  };

  // Handler modifies a file inside the isolated worktree
  daemon.addTrigger({
    id: 'wt-fix',
    isolatedWorktree: true,
    handler: async (payload) => {
      fs.writeFileSync(path.join(payload.workspaceDir, 'fix.txt'), 'overnight fix\n', 'utf8');
      return { success: true };
    }
  });

  const rec = await daemon.fireTrigger('wt-fix');
  assert.equal(rec.success, true);
  assert.ok(rec.worktree);
  assert.equal(rec.worktree.status, 'pending');
  assert.ok(rec.worktree.diff.includes('overnight fix'));
  // Main workspace must remain untouched before approval
  assert.equal(fs.existsSync(path.join(repoDir, 'fix.txt')), false);

  // 1-click approve & merge
  const merged = daemon.mergeRunWorktree(rec.runId);
  assert.equal(merged.merged, true);
  assert.equal(fs.existsSync(path.join(repoDir, 'fix.txt')), true);
  assert.equal(daemon.getRun(rec.runId).worktree.status, 'merged');

  // Test discard flow
  daemon.addTrigger({
    id: 'wt-discard',
    isolatedWorktree: true,
    handler: async (payload) => {
      fs.writeFileSync(path.join(payload.workspaceDir, 'bad.txt'), 'bad fix\n', 'utf8');
      return { success: true };
    }
  });
  const rec2 = await daemon.fireTrigger('wt-discard');
  assert.equal(rec2.worktree.status, 'pending');
  const discarded = daemon.discardRunWorktree(rec2.runId);
  assert.equal(discarded.discarded, true);
  assert.equal(fs.existsSync(path.join(repoDir, 'bad.txt')), false);
  assert.equal(daemon.getRun(rec2.runId).worktree.status, 'discarded');

  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

test('Gateway daemon API routes create, run, inspect, and delete triggers', async () => {
  const dir = path.join(TMP_BASE, 'gw_daemon');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const token = 'test-daemon-token';
  const gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    workspaceDir: dir,
    memoryDir: path.join(dir, '.mem'),
    authToken: token,
    provider: 'om',
    model: 'om-turbo'
  });

  try {
    const port = gw.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    const createRes = await fetch(`${baseUrl}/api/daemon/triggers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'api-check',
        type: 'cron',
        cron: '0 3 * * *',
        checkCommand: 'node -e "process.exit(0)"',
        isolatedWorktree: true,
        maxSteps: 10,
        maxTokens: 5000
      })
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.equal(created.success, true);
    assert.equal(created.trigger.id, 'api-check');

    const runRes = await fetch(`${baseUrl}/api/daemon/triggers/api-check/run`, {
      method: 'POST',
      headers,
      body: '{}'
    });
    assert.equal(runRes.status, 200);
    const runData = await runRes.json();
    assert.equal(runData.record.zeroToken, true);
    assert.equal(runData.record.checkPassed, true);

    const statusRes = await fetch(`${baseUrl}/api/daemon/status`, { headers });
    const statusData = await statusRes.json();
    assert.ok(statusData.triggers.some((t) => t.id === 'api-check'));
    assert.ok(statusData.recentRuns.some((r) => r.triggerId === 'api-check'));

    const delRes = await fetch(`${baseUrl}/api/daemon/triggers/api-check`, {
      method: 'DELETE',
      headers
    });
    assert.equal(delRes.status, 200);
  } finally {
    gw.server.close();
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  }
});
