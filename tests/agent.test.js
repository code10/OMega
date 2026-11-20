import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OMAgent } from '../dist/agent.js';

const TEST_DIR = path.resolve('./tests/tmp_agent_test');

test('OMAgent initialization, dynamic skills, and execution loop', async (t) => {
  const agent = new OMAgent({
    provider: 'om',
    memoryDir: path.join(TEST_DIR, 'memory'),
    workspaceDir: TEST_DIR,
    skillsDir: path.resolve('./skills')
  });

  await agent.init();

  await t.test('Loads custom skills from ./skills directory including SKILL.md workflows', async () => {
    assert.equal(agent.skills.has('calculate'), false);
    assert.equal(agent.skills.has('get_weather'), false);
    assert.equal(agent.skills.has('git_inspect'), true);
    assert.equal(agent.skills.has('inspect_json'), true);
    assert.equal(agent.skills.has('state'), true);
    assert.equal(agent.skills.has('no-overthinking'), true);
    assert.equal(agent.skills.has('deepapi'), true);
    assert.equal(agent.skills.get('state').type, 'workflow');

    const jsonRes = await agent.skills.execute('inspect_json', {
      jsonText: '{"routing":{"maxRetries":2}}',
      query: 'routing.maxRetries'
    }, { config: agent.config });
    assert.equal(jsonRes.success, true);
    assert.equal(jsonRes.value, 2);
  });

  await t.test('Expands slash workflow command /state into directive in run()', async () => {
    const res = await agent.run('/state');
    assert.equal(res.success, true);
    // Check that user message added to history contains the workflow directive
    const lastUserMsg = agent.history.filter((m) => m.role === 'user').slice(-1)[0];
    assert.ok(lastUserMsg.content.includes('[Workflow Directive (state)]'));
    assert.ok(lastUserMsg.content.includes('remind me what we\'re doing'));
  });

  await t.test('Executes autonomous ReAct loop with mock provider', async () => {
    let thoughtCount = 0;
    let toolStartCount = 0;

    agent.on('thought', () => thoughtCount++);
    agent.on('tool_start', () => toolStartCount++);

    const result = await agent.run('Inspect my system specs');

    assert.equal(result.success, true);
    assert.ok(result.totalSteps >= 1);
    assert.ok(result.content.includes('system') || result.content.includes('Platform'));
    assert.ok(thoughtCount >= 1);
    assert.ok(toolStartCount >= 1);
  });

  await t.test('Appends and retrieves persistent memory', async () => {
    await agent.run('Remember that user prefers TypeScript');
    const memoryContent = agent.memory.readLongTermMemory();
    assert.ok(memoryContent.includes('TypeScript'));
  });

  await t.test('Optimizes prompt context by truncating long daily activity logs', () => {
    for (let i = 1; i <= 60; i++) {
      agent.memory.logDaily(`Log entry number ${i}`);
    }
    const promptCtx = agent.memory.getPromptContext({ maxDailyLines: 15 });
    assert.ok(promptCtx.includes('trimmed for token efficiency'));
    const sysPrompt = agent.buildSystemPrompt({ maxDailyLines: 15 });
    assert.ok(sysPrompt.includes('trimmed for token efficiency'));
  });

  await t.test('Creates and names sessions ascendingly: session_1, session_2, ...', async () => {
    assert.equal(agent.sessionId, 'session_1');
    const sessionFile1 = path.join(TEST_DIR, 'memory', 'sessions', 'session_1.json');
    assert.equal(fs.existsSync(sessionFile1), true);

    const s1Data = JSON.parse(fs.readFileSync(sessionFile1, 'utf8'));
    assert.ok(Array.isArray(s1Data.answers), 'session_1 should contain answers array');
    assert.ok(s1Data.answers.length > 0, 'session_1 should have at least 1 answer');
    assert.equal(s1Data.answers[0].provider, 'om');
    assert.equal(s1Data.answers[0].model, agent.config.model);
    assert.ok(s1Data.answers[0].answer, 'answer should have content');
    assert.ok(s1Data.answers[0].target, 'answer should indicate target');

    agent.reset();
    assert.equal(agent.sessionId, 'session_2');
    await agent.run('test second session');
    const sessionFile2 = path.join(TEST_DIR, 'memory', 'sessions', 'session_2.json');
    assert.equal(fs.existsSync(sessionFile2), true);

    const s2Data = JSON.parse(fs.readFileSync(sessionFile2, 'utf8'));
    assert.ok(Array.isArray(s2Data.answers), 'session_2 should contain answers array');
    assert.equal(s2Data.answers[0].prompt, 'test second session');
    assert.ok(s2Data.answers[0].answer, 'second session should have answer content');
  });

  await t.test('Injects semantic memory recall and caches tool schemas for intelligence and speed', async () => {
    const toolsFirst = agent.getFormattedTools('openai');
    const toolsSecond = agent.getFormattedTools('openai');
    assert.equal(toolsFirst, toolsSecond, 'Formatted tools should be cached by reference');

    const sysWithQuery = agent.buildSystemPrompt({ query: 'TypeScript preference' });
    assert.ok(sysWithQuery.includes('<RELEVANT_MEMORY_RECALL>'), 'Should auto-inject relevant semantic memory recall');
    assert.ok(sysWithQuery.includes('TypeScript'));

    let callTurn = 0;
    const parallelProvider = {
      name: 'mock',
      model: 'om-turbo',
      async chat() {
        callTurn++;
        if (callTurn === 1) {
          return {
            content: 'Running two calculations in parallel.',
            toolCalls: [
              { id: 'tc_1', name: 'calculate', args: { expression: '10 + 20' } },
              { id: 'tc_2', name: 'calculate', args: { expression: '10 + 20' } }
            ]
          };
        }
        return { content: 'Both returned 30.', toolCalls: [] };
      }
    };

    const fastAgent = new OMAgent({
      provider: 'mock',
      providerInstance: parallelProvider,
      memoryDir: path.join(TEST_DIR, 'memory'),
      workspaceDir: TEST_DIR,
      skillsDir: path.resolve('./skills')
    });
    await fastAgent.init();

    const res = await fastAgent.run('Compute 10 + 20 twice');
    assert.equal(res.success, true);
    assert.equal(res.steps[0].toolCalls.length, 2);
    const toolMsgs = fastAgent.history.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.ok(toolMsgs[1].content.includes('[OM Cycle Notice: Identical tool call repeated'));
  });

  // Cleanup
  await t.test('Per-task git worktree isolation isolates edits and merges cleanly', async () => {
    const { execFileSync } = await import('node:child_process');
    const repoDir = path.join(TEST_DIR, 'wt_repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo\n');
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const wtAgent = new OMAgent({
      provider: 'om',
      model: 'om-turbo',
      workspaceDir: repoDir,
      memoryDir: path.join(TEST_DIR, 'wt_mem'),
      skillsDir: path.join(TEST_DIR, 'wt_skills')
    });

    const res = await wtAgent.run('Write file wt_note.txt with content "isolated worktree"', { worktree: true });
    assert.equal(res.success, true);
    assert.equal(wtAgent.config.workspaceDir, repoDir);
    assert.equal(fs.existsSync(path.join(repoDir, 'wt_note.txt')), false);
    assert.ok(res.worktree && res.worktree.hasChanges);

    const mergeRes = wtAgent.git.mergeWorktree(res.worktree.worktreePath, res.worktree.branch);
    assert.equal(mergeRes.merged, true);
    assert.equal(fs.existsSync(path.join(repoDir, 'wt_note.txt')), true);
  });

  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (_) {}
});
