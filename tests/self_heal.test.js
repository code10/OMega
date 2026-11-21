import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OMAgent, OMSelfHealer } from '../dist/index.js';
import { disposeAllLspClients } from '../dist/skills/codeIntel.js';

function makeTempGitRepo(prefix = 'omega-heal-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'omega-test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'OMega Test'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (_) {}
}

describe('Autonomous Framework Self-Healing (The Recursive Immune System)', () => {
  it('1. Parses Node.js stack traces and resolves workspace offending files (including dist -> src mapping)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-stack-'));
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'adapter.ts'), 'export function fetchUser() {}\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'dist', 'adapter.js'), 'export function fetchUser() {}\n', 'utf8');

      const distUrl = pathToFileURL(path.join(tmp, 'dist', 'adapter.js')).href;
      const err = new Error('Endpoint /v1/user returned 410 Gone');
      err.stack = [
        'Error: Endpoint /v1/user returned 410 Gone',
        `    at fetchUser (${distUrl}:42:11)`,
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)'
      ].join('\n');

      const parsed = OMSelfHealer.parseStackTrace(err, tmp);
      assert.equal(parsed.message, 'Endpoint /v1/user returned 410 Gone');
      assert.equal(parsed.offendingFile, 'src/adapter.ts');
      assert.equal(parsed.offendingLine, 42);
      assert.equal(parsed.frames.length, 1);
      assert.equal(parsed.frames[0].inWorkspace, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('2. Intercepts tool failure in ReAct loop, spawns diagnostic sub-agent, patches, runs npm test, and commits autonomously', async () => {
    const repoDir = makeTempGitRepo();
    try {
      // Create a broken adapter + test suite in the temp git repo
      fs.writeFileSync(
        path.join(repoDir, 'package.json'),
        JSON.stringify({
          name: 'heal-fixture',
          version: '1.0.0',
          type: 'module',
          scripts: {
            test: 'node --test adapter.test.mjs'
          }
        }, null, 2),
        'utf8'
      );

      fs.writeFileSync(
        path.join(repoDir, 'adapter.mjs'),
        `export function getEndpointVersion() {\n  throw new Error('Deprecated v1 endpoint removed');\n}\n`,
        'utf8'
      );

      fs.writeFileSync(
        path.join(repoDir, 'adapter.test.mjs'),
        `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { getEndpointVersion } from './adapter.mjs';\n\ntest('returns v2 endpoint', () => {\n  assert.equal(getEndpointVersion(), 'v2');\n});\n`,
        'utf8'
      );

      execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'chore: initial broken adapter'], { cwd: repoDir, stdio: 'ignore' });

      // Mock provider that drives both the main ReAct loop and the diagnostic sub-agent
      let mainStep = 0;
      let subStep = 0;
      const mockProvider = {
        name: 'om',
        model: 'om-self-heal-mock',
        async chat({ messages }) {
          const isDiagnosticSubagent = messages.some(
            (m) => m.role === 'user' && String(m.content || '').includes('Autonomous Diagnostic & Self-Patching Sub-Agent')
          );

          if (isDiagnosticSubagent) {
            subStep++;
            if (subStep === 1) {
              return {
                content: 'Inspecting offending file adapter.mjs.',
                toolCalls: [{ id: 'heal_tc_1', name: 'read_file', args: { path: 'adapter.mjs' } }]
              };
            }
            if (subStep === 2) {
              return {
                content: 'Patching adapter.mjs to use v2 endpoint.',
                toolCalls: [{
                  id: 'heal_tc_2',
                  name: 'patch_file',
                  args: {
                    path: 'adapter.mjs',
                    targetText: "  throw new Error('Deprecated v1 endpoint removed');",
                    replacementText: "  return 'v2';"
                  }
                }]
              };
            }
            return {
              content: 'Root cause: v1 endpoint was removed. Patched adapter.mjs to return v2.',
              toolCalls: []
            };
          }

          mainStep++;
          if (mainStep === 1) {
            return {
              content: 'Calling check_adapter tool.',
              toolCalls: [{ id: 'main_tc_1', name: 'check_adapter', args: {} }]
            };
          }
          return {
            content: 'Adapter recovered via self-healing and returned v2.',
            toolCalls: []
          };
        }
      };

      const agent = new OMAgent({
        provider: 'om',
        providerInstance: mockProvider,
        workspaceDir: repoDir,
        memoryDir: path.join(repoDir, '.mem'),
        selfHeal: {
          enabled: true,
          autoCommit: true,
          testCommand: 'npm test',
          maxHealAttempts: 1
        }
      });

      // Register a tool that dynamically imports adapter.mjs (with cache-busting) so the patch takes effect live
      let callCount = 0;
      agent.skills.register({
        name: 'check_adapter',
        description: 'Calls adapter.mjs getEndpointVersion()',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          callCount++;
          const modUrl = `${pathToFileURL(path.join(repoDir, 'adapter.mjs')).href}?v=${callCount}`;
          const mod = await import(modUrl);
          return { success: true, version: mod.getEndpointVersion() };
        }
      });

      const events = [];
      agent.on('self_heal_start', (e) => events.push({ type: 'start', ...e }));
      agent.on('self_heal_success', (e) => events.push({ type: 'success', ...e }));

      const res = await agent.run('Verify the adapter endpoint');
      assert.equal(res.success, true);
      assert.equal(res.selfHealed, true);
      assert.equal(res.healEvents.length, 1);
      assert.equal(res.healEvents[0].healed, true);
      assert.equal(res.healEvents[0].committed, true);
      assert.ok(res.healEvents[0].commitHash);
      assert.equal(res.healEvents[0].offendingFile, 'adapter.mjs');
      assert.equal(res.healEvents[0].testResult.passed, true);
      assert.ok(res.healEvents[0].patch.includes("return 'v2';"));
      assert.equal(callCount, 2); // First call crashed, second call succeeded after self-heal

      assert.equal(events.map((e) => e.type).join(','), 'start,success');

      // Verify git commit was created autonomously
      const lastCommitMsg = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repoDir, encoding: 'utf8' }).trim();
      assert.ok(lastCommitMsg.startsWith('fix(self-heal):'));
    } finally {
      disposeAllLspClients();
      cleanupTempDir(repoDir);
    }
  });

  it('3. Rolls back patch and does not commit when test suite fails after patching', async () => {
    const repoDir = makeTempGitRepo('omega-heal-fail-');
    try {
      const targetFile = path.join(repoDir, 'service.mjs');
      const originalContent = "export function ping() {\n  throw new Error('broken');\n}\n";
      fs.writeFileSync(targetFile, originalContent, 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'chore: initial service'], { cwd: repoDir, stdio: 'ignore' });

      let subStep = 0;
      const mockProvider = {
        name: 'om',
        model: 'om-self-heal-mock',
        async chat() {
          subStep++;
          if (subStep === 1) {
            return {
              content: 'Applying bad patch.',
              toolCalls: [{
                id: 'bad_tc_1',
                name: 'patch_file',
                args: {
                  path: 'service.mjs',
                  targetText: "  throw new Error('broken');",
                  replacementText: "  return 'wrong_value';"
                }
              }]
            };
          }
          return { content: 'Patched service.mjs.', toolCalls: [] };
        }
      };

      const agent = new OMAgent({
        provider: 'om',
        providerInstance: mockProvider,
        workspaceDir: repoDir,
        memoryDir: path.join(repoDir, '.mem')
      });

      const failedEvents = [];
      agent.on('self_heal_failed', (e) => failedEvents.push(e));

      const err = new Error('broken');
      err.stack = `Error: broken\n    at ping (${pathToFileURL(targetFile).href}:2:9)`;

      const healRes = await OMSelfHealer.heal(agent, {
        error: err,
        source: 'tool_failure',
        toolName: 'ping_tool'
      }, {
        testRunner: async () => ({ passed: false, exitCode: 1, output: '1 test failed' })
      });

      assert.equal(healRes.healed, false);
      assert.equal(healRes.committed, false);
      assert.equal(healRes.rolledBack, true);
      assert.equal(failedEvents.length, 1);

      // Verify file was rolled back to original content
      assert.equal(fs.readFileSync(targetFile, 'utf8'), originalContent);
    } finally {
      disposeAllLspClients();
      cleanupTempDir(repoDir);
    }
  });

  it('4. Intercepts unhandled error in ReAct loop, heals, and resumes execution to completion', async () => {
    const repoDir = makeTempGitRepo('omega-heal-unhandled-');
    try {
      const cfgFile = path.join(repoDir, 'endpoint.json');
      fs.writeFileSync(cfgFile, JSON.stringify({ url: 'https://old.example.com' }), 'utf8');
      execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'chore: initial endpoint'], { cwd: repoDir, stdio: 'ignore' });

      let mainCalls = 0;
      let subCalls = 0;
      const mockProvider = {
        name: 'om',
        model: 'om-self-heal-mock',
        async chat({ messages }) {
          const isDiag = messages.some(
            (m) => m.role === 'user' && String(m.content || '').includes('Autonomous Diagnostic & Self-Patching Sub-Agent')
          );
          if (isDiag) {
            subCalls++;
            if (subCalls === 1) {
              return {
                content: 'Updating endpoint.json.',
                toolCalls: [{
                  id: 'diag_1',
                  name: 'write_file',
                  args: { path: 'endpoint.json', content: JSON.stringify({ url: 'https://new.example.com' }) }
                }]
              };
            }
            return { content: 'Updated endpoint.json.', toolCalls: [] };
          }

          mainCalls++;
          if (mainCalls === 1) {
            const err = new Error('Unhandled API schema mismatch');
            err.stack = `Error: Unhandled API schema mismatch\n    at callApi (${pathToFileURL(cfgFile).href}:1:1)`;
            throw err;
          }
          return { content: 'Completed after self-healing.', toolCalls: [] };
        }
      };

      const agent = new OMAgent({
        provider: 'om',
        providerInstance: mockProvider,
        workspaceDir: repoDir,
        memoryDir: path.join(repoDir, '.mem'),
        routing: { enabled: false, maxRetries: 0 },
        selfHeal: {
          enabled: true,
          autoCommit: true,
          testRunner: async () => ({ passed: true, exitCode: 0, output: 'ok' })
        }
      });

      const res = await agent.run('Run task');
      assert.equal(res.success, true);
      assert.equal(res.content, 'Completed after self-healing.');
      assert.equal(res.selfHealed, true);
      assert.equal(res.healEvents.length, 1);
      assert.equal(res.healEvents[0].committed, true);
    } finally {
      disposeAllLspClients();
      cleanupTempDir(repoDir);
    }
  });

  it('5. Prevents recursive self-healing inside diagnostic sub-agents', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-heal-guard-'));
    try {
      const agent = new OMAgent({
        provider: 'om',
        workspaceDir: tmp,
        memoryDir: path.join(tmp, '.mem')
      });
      agent._isSelfHealing = true;
      const res = await OMSelfHealer.heal(agent, {
        error: new Error('Recursive error'),
        source: 'unhandled_error'
      });
      assert.equal(res.healed, false);
      assert.equal(res.skipped, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
