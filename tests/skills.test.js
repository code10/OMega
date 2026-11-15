import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SkillRegistry } from '../dist/skills/index.js';
import { OMMemory } from '../dist/memory.js';

const TEST_DIR = path.resolve('./tests/tmp_test_env');
const TEST_MEMORY_DIR = path.join(TEST_DIR, 'memory');

test('SkillRegistry built-in skills and execution', async (t) => {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  const registry = new SkillRegistry();
  const memory = new OMMemory(TEST_MEMORY_DIR);
  const context = {
    config: { workspaceDir: TEST_DIR },
    memory
  };

  await t.test('Filesystem skills: write, read, patch, list', async () => {
    const testFile = path.join(TEST_DIR, 'hello.txt');

    // 1. write_file
    const writeRes = await registry.execute('write_file', {
      path: testFile,
      content: 'Line 1: Hello World\nLine 2: OM Framework\nLine 3: Test Line'
    }, context);
    assert.equal(writeRes.success, true);
    assert.equal(fs.existsSync(testFile), true);

    // 2. read_file
    const readRes = await registry.execute('read_file', { path: testFile }, context);
    assert.equal(readRes.success, true);
    assert.ok(readRes.content.includes('OM Framework'));

    // 3. patch_file
    const patchRes = await registry.execute('patch_file', {
      path: testFile,
      targetText: 'OM Framework',
      replacementText: 'OM Autonomous Agent'
    }, context);
    assert.equal(patchRes.success, true);

    const reRead = await registry.execute('read_file', { path: testFile }, context);
    assert.ok(reRead.content.includes('OM Autonomous Agent'));

    // 4. list_dir
    const listRes = await registry.execute('list_dir', { path: TEST_DIR }, context);
    assert.equal(listRes.success, true);
    assert.ok(listRes.items.some((i) => i.name === 'hello.txt'));
  });

  await t.test('Shell skill: exec_command', async () => {
    const shellRes = await registry.execute('exec_command', {
      command: 'node -e "console.log(12345)"'
    }, context);
    assert.equal(shellRes.success, true);
    assert.ok(shellRes.stdout.includes('12345'));
  });

  await t.test('System skills: get_system_info & get_current_time', async () => {
    const sysRes = await registry.execute('get_system_info', {}, context);
    assert.ok(sysRes.platform);
    assert.ok(sysRes.totalMemoryMB > 0);

    const timeRes = await registry.execute('get_current_time', {}, context);
    assert.ok(timeRes.iso);
    assert.ok(timeRes.timestamp > 0);
  });

  await t.test('Memory skills: save_memory, read_memory, search_memory', async () => {
    const saveRes = await registry.execute('save_memory', {
      fact: 'Agent name is OM and it is fully verified'
    }, context);
    assert.equal(saveRes.success, true);

    const readRes = await registry.execute('read_memory', {}, context);
    assert.equal(readRes.success, true);
    assert.ok(readRes.content.includes('fully verified'));

    const searchRes = await registry.execute('search_memory', { query: 'verified' }, context);
    assert.equal(searchRes.success, true);
    assert.ok(searchRes.count >= 1);
  });

  await t.test('SKILL.md workflow skills loader and execution', async () => {
    const skillsDir = path.resolve('./skills');
    await registry.loadFromDirectory(skillsDir);

    // Verify state workflow skill was loaded from skills/state/SKILL.md
    assert.equal(registry.has('state'), true);
    const stateSkill = registry.get('state');
    assert.equal(stateSkill.type, 'workflow');
    assert.equal(stateSkill.name, 'state');
    assert.ok(stateSkill.description.includes('recaps what the current thread is doing'));
    assert.equal(stateSkill.disableModelInvocation, false);
    assert.ok(stateSkill.body.includes('remind me what we\'re doing'));

    // Verify deepapi workflow skill was loaded with references
    assert.equal(registry.has('deepapi'), true);
    const deepapiSkill = registry.get('deepapi');
    assert.equal(deepapiSkill.type, 'workflow');
    assert.ok(Array.isArray(deepapiSkill.references));
    assert.ok(deepapiSkill.references.includes('scraping.md'));

    // Verify no-overthinking workflow skill was loaded
    assert.equal(registry.has('no-overthinking'), true);

    // Execute state workflow skill
    const execRes = await registry.execute('state', { instruction: 'Recap right now' });
    assert.equal(execRes.success, true);
    assert.equal(execRes.type, 'workflow');
    assert.ok(execRes.directive.includes('remind me what we\'re doing'));
  });

  // Cleanup test artifacts
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (_) {}
});
