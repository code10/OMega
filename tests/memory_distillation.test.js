import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OMAgent,
  OMDaemon,
  OMMemory,
  OMSelfImprover,
  distillMemory,
  readDistillState
} from '../dist/index.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Zero-Token Semantic Memory & Autonomous Distillation', async (t) => {
  await t.test('1. Algorithmic distillation extracts architectural insights & deduplicates with zero LLM tokens', async () => {
    const tmpDir = makeTempDir('omega-distill-');
    try {
      const memory = new OMMemory(tmpDir);
      const today = memory.getTodayFilename();
      const dailyPath = path.join(memory.dailyDir, today);

      fs.writeFileSync(dailyPath, [
        `# Daily Journal - ${today.replace('.md', '')}`,
        '[10:00:01] hi',
        '[10:01:00] Decided to always use local hybrid vector embeddings instead of external Pinecone containers',
        '[10:02:00] Fixed race condition in SQLite vector store flush during concurrent writes',
        '[10:03:00] Architecture: OMDaemon runs zero-token background distillation on daily journals',
        '[10:04:00] Architecture: OMDaemon runs zero-token background distillation on daily journals',
        '[10:05:00] ok thanks'
      ].join('\n'), 'utf8');

      const report = await distillMemory(memory, { useLLM: false, prune: false });
      assert.equal(report.success, true);
      assert.equal(report.mode, 'heuristic');
      assert.equal(report.tokenCost, 0);
      assert.equal(report.factsAdded, 3, 'Should extract 3 unique heuristics and skip noise/duplicates');

      const longTerm = memory.readLongTermMemory();
      assert.match(longTerm, /Architectural Insights/);
      assert.match(longTerm, /Resolved Fixes/);
      assert.match(longTerm, /Decisions & Constraints/);

      // Re-running should add 0 duplicates
      const secondRun = await distillMemory(memory, { useLLM: false, prune: false });
      assert.equal(secondRun.factsAdded, 0);

      memory.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('2. Prunes redundant session turns and compresses older daily journals while retaining insights', async () => {
    const tmpDir = makeTempDir('omega-prune-');
    try {
      const memory = new OMMemory(tmpDir);

      // Create an old daily journal (2025-01-01.md)
      const oldDailyPath = path.join(memory.dailyDir, '2025-01-01.md');
      const verboseNoise = Array.from({ length: 25 }, (_, i) => `[09:00:${String(i).padStart(2, '0')}] Routine heartbeat check #${i}`).join('\n');
      fs.writeFileSync(oldDailyPath, [
        '# Daily Journal - 2025-01-01',
        '[08:55:00] Architecture: Gateway routes use modular handleMemoryRoutes pipeline',
        verboseNoise
      ].join('\n'), 'utf8');

      // Create a verbose session with 12 turns
      const steps = [];
      for (let i = 1; i <= 10; i++) {
        steps.push({
          step: i,
          toolCalls: [{ name: 'read_file', args: { path: `file${i}.ts` }, result: { success: true, content: 'x'.repeat(500) } }]
        });
      }
      steps.push({
        step: 11,
        toolCalls: [{ name: 'patch_file', args: { path: 'src/daemon.ts' }, result: { success: true, message: 'Patched' } }]
      });
      steps.push({
        step: 12,
        toolCalls: [{ name: 'exec_command', args: { command: 'npm test' }, result: { success: true, content: '95 passed' } }]
      });

      memory.saveSession('session_1', {
        sessionId: 'session_1',
        steps,
        answers: [{ prompt: 'Implement autonomous distillation', answer: 'Fixed compaction pipeline and added daemon trigger.' }]
      });

      const report = await distillMemory(memory, {
        prune: true,
        compressDaily: true,
        retainDailyDays: 1,
        maxRetainedTurns: 4
      });

      assert.equal(report.success, true);
      assert.ok(report.turnsPruned >= 8, `Expected >= 8 pruned turns, got ${report.turnsPruned}`);
      assert.equal(report.sessionsCompressed, 1);
      assert.equal(report.journalsCompressed, 1);
      assert.ok(report.bytesSaved > 0);

      const compressedDaily = fs.readFileSync(oldDailyPath, 'utf8');
      assert.ok(compressedDaily.includes('<!-- DISTILLED -->'));
      assert.ok(compressedDaily.includes('Gateway routes use modular handleMemoryRoutes pipeline'));

      const prunedSession = memory.loadSession('session_1');
      assert.equal(prunedSession.distilled, true);
      assert.ok(prunedSession.steps.length <= 4);
      assert.ok(prunedSession.distilledSummary);

      const state = readDistillState(tmpDir);
      assert.equal(state.totalRuns, 1);
      assert.ok(state.totalBytesSaved > 0);

      memory.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('3. getPromptContext bounds MEMORY.md injection while preserving full semantic search', async () => {
    const tmpDir = makeTempDir('omega-prompt-cap-');
    try {
      const memory = new OMMemory(tmpDir);
      for (let i = 1; i <= 40; i++) {
        memory.appendFact(`Architectural rule #${i}: keep module ${i} decoupled via clean interfaces`, 'Architectural Insights');
      }

      const promptCtx = memory.getPromptContext({ maxMemoryLines: 15, maxDailyLines: 10 });
      assert.ok(promptCtx.includes('older facts omitted from prompt; query via semantic memory recall'));

      // Full history remains searchable via semantic vector store
      const hits = memory.search('decoupled interfaces module 1', { topK: 5 });
      assert.ok(hits.length > 0);

      memory.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('4. OMDaemon.enableAutonomousDistillation runs zero-token background distillation without calling agent.run', async () => {
    const tmpDir = makeTempDir('omega-daemon-distill-');
    const memDir = path.join(tmpDir, 'memory');
    try {
      const agent = new OMAgent({
        workspaceDir: tmpDir,
        memoryDir: memDir,
        skillsDir: path.join(tmpDir, 'skills'),
        provider: 'om',
        model: 'om-turbo'
      });
      await agent.init();

      let agentRunCalled = false;
      agent.run = async () => {
        agentRunCalled = true;
        return { success: true, content: 'should not be called' };
      };

      agent.memory.logDaily('Architecture: Hybrid LSH vector index enables zero-token semantic recall');

      const daemon = new OMDaemon(agent);
      let distilledEvent = null;
      daemon.on('distillation', (res) => {
        distilledEvent = res;
      });

      daemon.enableAutonomousDistillation({ intervalMs: 60000, runOnStart: true });
      await daemon.start();

      // Wait briefly for runOnStart async handler
      await new Promise((r) => setTimeout(r, 80));
      daemon.stop();

      assert.equal(agentRunCalled, false, 'Background distillation must not invoke LLM agent.run()');
      assert.ok(distilledEvent, 'Expected distillation event to be emitted');
      assert.equal(distilledEvent.tokenCost, 0);
      assert.ok(distilledEvent.factsAdded >= 1);

      await agent.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('5. OMSelfImprover.registerNightlyTrigger registers zero-token handler trigger', async () => {
    const tmpDir = makeTempDir('omega-nightly-');
    const memDir = path.join(tmpDir, 'memory');
    try {
      const agent = new OMAgent({
        workspaceDir: tmpDir,
        memoryDir: memDir,
        skillsDir: path.join(tmpDir, 'skills'),
        provider: 'om',
        model: 'om-turbo'
      });
      await agent.init();
      agent.memory.logDaily('Resolved root cause of context bloat by capping prompt memory lines');

      const daemon = new OMDaemon(agent);
      OMSelfImprover.registerNightlyTrigger(daemon, agent, '0 2 * * *');

      const record = await daemon.fireTrigger('nightly_memory_distillation');
      assert.equal(record.success, true);
      assert.equal(record.zeroToken, true);
      assert.equal(record.result.tokenCost, 0);
      assert.ok(record.result.factsAdded >= 1);

      await agent.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
