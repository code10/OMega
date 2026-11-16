import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OMAgent,
  DetachedSwarmManager,
  loadCheckpoint,
  listCheckpoints,
  forkCheckpoint
} from '../dist/index.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Headless Multi-Session Agent Swarms with Persistent State Recovery', async (t) => {
  await t.test('1. Checkpoints ReAct state after every step and recovers from mid-flight crash', async () => {
    const tmpDir = makeTempDir('omega-cp-');
    const memDir = path.join(tmpDir, 'memory');
    try {
      const agent = new OMAgent({
        sessionId: 'crash_recovery_1',
        workspaceDir: tmpDir,
        memoryDir: memDir,
        skillsDir: path.join(tmpDir, 'skills'),
        provider: 'om',
        model: 'om-turbo'
      });
      await agent.init();

      // Simulate a 2-step run where step 1 executes a tool and step 2 throws a crash error
      let callCount = 0;
      agent.router.chat = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: 'Step 1: checking system info',
            toolCalls: [{ id: 'tc_1', name: 'get_current_time', args: {} }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
          };
        }
        throw new Error('Simulated process crash on step 2');
      };

      await assert.rejects(
        () => agent.run('Check time and summarize', { maxSteps: 5, selfHeal: false }),
        /Simulated process crash on step 2/
      );

      // Verify step 1 was persisted to disk despite crash on step 2
      const cp = loadCheckpoint(memDir, 'crash_recovery_1');
      assert.ok(cp, 'Checkpoint should exist on disk');
      assert.equal(cp.status, 'failed');
      assert.equal(cp.steps.length, 1);
      assert.equal(cp.steps[0].toolCalls[0].name, 'get_current_time');
      assert.ok(cp.history.length >= 3); // user + assistant + tool

      // Resume from the saved checkpoint
      const resumedAgent = new OMAgent({
        sessionId: 'crash_recovery_1',
        workspaceDir: tmpDir,
        memoryDir: memDir,
        skillsDir: path.join(tmpDir, 'skills'),
        provider: 'om',
        model: 'om-turbo'
      });
      await resumedAgent.init();

      let resumedCalls = 0;
      resumedAgent.router.chat = async () => {
        resumedCalls++;
        return {
          content: 'Recovered and completed final answer.',
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 }
        };
      };

      const res = await resumedAgent.run('Check time and summarize', {
        maxSteps: 5,
        resumeCheckpoint: cp
      });

      assert.equal(res.success, true);
      assert.equal(resumedCalls, 1, 'Should resume directly at synthesis without repeating step 1');
      assert.equal(res.steps.length, 2, 'Should retain step 1 + new final step');
      assert.equal(res.answer, 'Recovered and completed final answer.');

      const completedCp = loadCheckpoint(memDir, 'crash_recovery_1');
      assert.equal(completedCp.status, 'completed');

      await agent.close();
      await resumedAgent.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('2. Forks any historical checkpointed session at a specific step without orphaned tool messages', async () => {
    const tmpDir = makeTempDir('omega-fork-');
    const memDir = path.join(tmpDir, 'memory');
    try {
      const agent = new OMAgent({
        sessionId: 'parent_sess',
        workspaceDir: tmpDir,
        memoryDir: memDir,
        skillsDir: path.join(tmpDir, 'skills'),
        provider: 'om',
        model: 'om-turbo'
      });
      await agent.init();

      let stepNum = 0;
      agent.router.chat = async () => {
        stepNum++;
        if (stepNum === 1) {
          return {
            content: 'Step 1 tool call',
            toolCalls: [{ id: 'tc_a', name: 'get_current_time', args: {} }],
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }
          };
        }
        if (stepNum === 2) {
          return {
            content: 'Step 2 tool call',
            toolCalls: [{ id: 'tc_b', name: 'get_system_info', args: {} }],
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }
          };
        }
        return {
          content: 'Final answer at step 3',
          toolCalls: [],
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }
        };
      };

      const runRes = await agent.run('Multi-step task', { maxSteps: 5 });
      assert.equal(runRes.steps.length, 3);

      const forked = forkCheckpoint(memDir, 'parent_sess', {
        step: 1,
        newSessionId: 'forked_at_step_1'
      });

      assert.equal(forked.sessionId, 'forked_at_step_1');
      assert.equal(forked.currentStep, 1);
      assert.equal(forked.steps.length, 1);
      assert.equal(forked.status, 'paused');
      assert.notEqual(forked.history[forked.history.length - 1]?.role, 'tool');

      const all = listCheckpoints(memDir);
      assert.equal(all.length, 2);

      await agent.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('3. DetachedSwarmManager spawns a process-detached headless worker that checkpoints and completes', async () => {
    const tmpDir = makeTempDir('omega-detached-');
    const memDir = path.join(tmpDir, 'memory');
    try {
      const manager = new DetachedSwarmManager({
        memoryDir: memDir,
        workspaceDir: tmpDir,
        provider: 'om',
        model: 'om-turbo'
      });

      const handle = manager.spawnDetached({
        sessionId: 'headless_worker_1',
        prompt: 'Compute 2 + 2 concisely',
        maxSteps: 3
      });

      assert.equal(handle.sessionId, 'headless_worker_1');
      assert.ok(handle.pid && handle.pid > 0, 'Expected a real OS child PID');
      assert.ok(fs.existsSync(handle.logFile));

      // Poll briefly until the detached worker completes
      let inspected = null;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        inspected = manager.inspectSession('headless_worker_1');
        if (inspected.status === 'completed' || inspected.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.ok(inspected);
      assert.equal(inspected.status, 'completed', `Expected completed, got ${inspected.status}: ${inspected.error || inspected.logTail}`);
      assert.ok(inspected.steps.length >= 1);
      assert.ok(inspected.logTail.includes('completed'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
