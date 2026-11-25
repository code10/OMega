import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  OMAgent,
  ReplayProvider,
  SkillRegistry,
  startGateway
} from '../dist/index.js';
import { detectLspLanguage, getFileDiagnostics } from '../dist/skills/codeIntel.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // ignore Windows cleanup race
  }
}

describe('OMega Next-Gen Functional Upgrades', () => {
  it('1. repo_map builds a dependency-ranked symbol map across TypeScript and Python files', async () => {
    const tmp = makeTempDir('om-repomap-');
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'core.ts'), 'export function coreUtil() {}\nexport class CoreEngine {}\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'import { coreUtil } from "./core.js";\nexport function featA() { return coreUtil(); }\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'import { CoreEngine } from "./core.js";\nexport function featB() { return CoreEngine; }\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'src', 'helper.py'), 'def parse_data():\n    pass\nclass Worker:\n    pass\n', 'utf8');

      const reg = new SkillRegistry();
      const res = await reg.execute('repo_map', { dir: tmp }, { config: { workspaceDir: tmp } });
      assert.equal(res.success, true);
      assert.equal(res.totalScanned, 4);
      // src/core.ts has 2 inbound refs so it must rank #1
      assert.equal(res.files[0].file, 'src/core.ts');
      assert.equal(res.files[0].inboundRefs, 2);
      assert.ok(res.files[0].symbols.includes('coreUtil'));
      assert.ok(res.files[0].symbols.includes('CoreEngine'));
      assert.ok(res.map.includes('src/helper.py: parse_data, Worker'));
    } finally {
      safeRm(tmp);
    }
  });

  it('2. Multi-Language LSP Manager detects TS/Python/Go/Rust/C++ and custom servers, degrading gracefully', async () => {
    assert.equal(detectLspLanguage('app.ts'), 'typescript');
    assert.equal(detectLspLanguage('main.py'), 'python');
    assert.equal(detectLspLanguage('server.go'), 'go');
    assert.equal(detectLspLanguage('lib.rs'), 'rust');
    assert.equal(detectLspLanguage('engine.cpp'), 'cpp');
    assert.equal(detectLspLanguage('main.zig', { zig: { extensions: ['.zig'], command: 'zls' } }), 'zig');

    const tmp = makeTempDir('om-lsp-');
    try {
      const zigFile = path.join(tmp, 'main.zig');
      fs.writeFileSync(zigFile, 'pub fn main() void {}\n', 'utf8');
      // Non-existent custom binary must gracefully return [] instead of throwing
      const diags = await getFileDiagnostics(zigFile, tmp, 10, undefined, {
        zig: { extensions: ['.zig'], command: 'definitely_nonexistent_lsp_bin_xyz' }
      });
      assert.deepEqual(diags, []);
    } finally {
      safeRm(tmp);
    }
  });

  it('3. patch_file supports whitespace-tolerant indentation fallback while enforcing uniqueness', async () => {
    const tmp = makeTempDir('om-fuzzy-patch-');
    try {
      const file = path.join(tmp, 'indent.ts');
      fs.writeFileSync(file, 'function run() {\n    const x = 1;\n    return x + 2;\n}\n', 'utf8');

      const reg = new SkillRegistry();
      const ctx = { config: { workspaceDir: tmp } };
      // Wrong indentation (0 spaces instead of 4 spaces)
      const res = await reg.execute('patch_file', {
        path: file,
        targetText: 'const x = 1;\nreturn x + 2;',
        replacementText: 'const x = 10;\nreturn x + 20;'
      }, ctx);
      assert.equal(res.success, true);
      assert.equal(res.matchMode, 'whitespace-tolerant');
      assert.equal(fs.readFileSync(file, 'utf8'), 'function run() {\n    const x = 10;\n    return x + 20;\n}\n');
    } finally {
      safeRm(tmp);
    }
  });

  it('4. Deterministic Post-Edit Verification Gate blocks conclusion on failure and passes after fix', async () => {
    const tmp = makeTempDir('om-verify-gate-');
    try {
      const targetFile = path.join(tmp, 'flag.txt');
      const scriptedTurns = [
        // Step 1: write bad value
        {
          content: 'Writing flag.txt',
          toolCalls: [{ id: 'tc_1', name: 'write_file', args: { path: 'flag.txt', content: 'BAD' } }]
        },
        // Step 2: attempt to conclude (verification gate will fail and feed error back!)
        {
          content: 'Done!',
          toolCalls: []
        },
        // Step 3: fix flag.txt after seeing verification failure
        {
          content: 'Fixing flag.txt to GOOD',
          toolCalls: [{ id: 'tc_2', name: 'write_file', args: { path: 'flag.txt', content: 'GOOD' } }]
        },
        // Step 4: conclude cleanly (verification gate now passes)
        {
          content: 'Verified and fixed!',
          toolCalls: []
        }
      ];

      const agent = new OMAgent({
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp,
        provider: 'om',
        model: 'om-turbo',
        providerInstance: new ReplayProvider(scriptedTurns, { name: 'replay', model: 'om-turbo' }),
        verification: {
          enabled: true,
          onCodeEdit: ['node -e "const fs=require(\'fs\'); if(fs.readFileSync(\'flag.txt\',\'utf8\').trim()!==\'GOOD\'){console.error(\'Expected GOOD\');process.exit(1);}"'],
          maxRetries: 2
        }
      });
      await agent.init();
      const res = await agent.run('Write GOOD to flag.txt', { disableFailover: true });
      assert.equal(res.success, true);
      assert.equal(fs.readFileSync(targetFile, 'utf8'), 'GOOD');
      assert.equal(res.verification?.passed, true);
      assert.equal(res.verification?.attempts, 2);
      await agent.close();
    } finally {
      safeRm(tmp);
    }
  });

  it('5. Plan Mode (/plan on, /execute, planMode: true) blocks mutating tools', async () => {
    const tmp = makeTempDir('om-plan-mode-');
    try {
      let observedToolNames = [];
      const inspectingProvider = {
        name: 'inspect',
        model: 'inspect-1',
        async chat({ tools }) {
          observedToolNames = (tools || []).map((t) => t.name || t.function?.name);
          return { content: '1. Inspect files\n2. Apply patch', toolCalls: [] };
        }
      };

      const agent = new OMAgent({
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp,
        provider: 'om',
        model: 'inspect-1',
        providerInstance: inspectingProvider
      });
      await agent.init();

      const toggleOn = await agent.run('/plan on');
      assert.equal(toggleOn.success, true);
      assert.equal(agent.config.planMode, true);

      const planRes = await agent.run('Plan a refactor', { disableFailover: true });
      assert.equal(planRes.success, true);
      assert.equal(planRes.planMode, true);
      assert.ok(observedToolNames.includes('read_file'));
      assert.ok(!observedToolNames.includes('write_file'));
      assert.ok(!observedToolNames.includes('patch_file'));
      assert.ok(!observedToolNames.includes('exec_command'));

      const toggleOff = await agent.run('/execute');
      assert.equal(toggleOff.success, true);
      assert.equal(agent.config.planMode, false);
      await agent.close();
    } finally {
      safeRm(tmp);
    }
  });

  it('6. Role-Based Subagent Pipeline (run_pipeline) orchestrates Researcher -> Coder -> Reviewer', async () => {
    const tmp = makeTempDir('om-pipeline-');
    try {
      const stageCalls = [];
      const mockProvider = {
        name: 'pipe-mock',
        model: 'pipe-1',
        async chat({ messages }) {
          const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
          if (lastUser.includes('[Role: Researcher')) {
            stageCalls.push('researcher');
            return { content: 'Brief: Edit target.ts', toolCalls: [] };
          }
          if (lastUser.includes('[Role: Coder]')) {
            stageCalls.push('coder');
            return { content: 'Patched target.ts cleanly.', toolCalls: [] };
          }
          if (lastUser.includes('[Role: Independent Reviewer]')) {
            stageCalls.push('reviewer');
            return { content: 'VERDICT: APPROVED — diff looks clean.', toolCalls: [] };
          }
          return { content: 'ok', toolCalls: [] };
        }
      };

      const agent = new OMAgent({
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp,
        provider: 'om',
        model: 'pipe-1',
        providerInstance: mockProvider
      });
      await agent.init();
      const res = await agent.skills.execute('run_pipeline', { task: 'Add validation' }, { agent, config: agent.config });
      assert.equal(res.success, true);
      assert.equal(res.approved, true);
      assert.deepEqual(stageCalls, ['researcher', 'coder', 'reviewer']);
      await agent.close();
    } finally {
      safeRm(tmp);
    }
  });

  it('7. Gateway exposes Tape Export, Save Regression Eval, Git Revert File, and MCP Resources/Prompts APIs', async () => {
    const tmp = makeTempDir('om-gw-nextgen-');
    const wsDir = path.join(tmp, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: wsDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@omega.local'], { cwd: wsDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'OMega Test'], { cwd: wsDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'original\n', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: wsDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: wsDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'modified\n', 'utf8');

    const gw = await startGateway({
      port: 0,
      host: '127.0.0.1',
      authToken: 'test-nextgen-tok',
      memoryDir: path.join(tmp, 'mem'),
      workspaceDir: wsDir,
      persistConfig: false
    });
    try {
      const headers = { Authorization: 'Bearer test-nextgen-tok', 'Content-Type': 'application/json' };

      // 1. Git revert-file restores a.txt
      const revRes = await fetch(`${gw.url}/api/git/revert-file`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file: 'a.txt' })
      });
      assert.equal(revRes.status, 200);
      assert.equal(fs.readFileSync(path.join(wsDir, 'a.txt'), 'utf8').trim(), 'original');

      // 2. MCP resources & prompts endpoints return cleanly
      const mcpRes = await fetch(`${gw.url}/api/mcp/resources`, { headers });
      assert.equal(mcpRes.status, 200);
      const mcpResBody = await mcpRes.json();
      assert.equal(mcpResBody.success, true);
      assert.ok(Array.isArray(mcpResBody.resources));

      const mcpPrompts = await fetch(`${gw.url}/api/mcp/prompts`, { headers });
      assert.equal(mcpPrompts.status, 200);
      const mcpPromptsBody = await mcpPrompts.json();
      assert.equal(mcpPromptsBody.success, true);
      assert.ok(Array.isArray(mcpPromptsBody.prompts));

      // 3. Session tape export & save-eval endpoints
      gw.agent.memory.saveSession('sess_demo', {
        sessionId: 'sess_demo',
        provider: 'om',
        model: 'om-turbo',
        history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
        answers: [{ prompt: 'hi', answer: 'hello' }],
        steps: [{ step: 1, answer: 'hello', toolCalls: [] }]
      });
      const tapeRes = await fetch(`${gw.url}/api/sessions/sess_demo/tape`, { headers });
      assert.equal(tapeRes.status, 200);
      const tapeJson = await tapeRes.json();
      assert.equal(tapeJson.sourceSessionId, 'sess_demo');

      const saveEvalRes = await fetch(`${gw.url}/api/sessions/sess_demo/save-eval`, { method: 'POST', headers });
      assert.equal(saveEvalRes.status, 200);
      const saveEvalJson = await saveEvalRes.json();
      assert.equal(saveEvalJson.success, true);
      assert.equal(saveEvalJson.caseId, 'regression_sess_demo');
      assert.ok(fs.existsSync(saveEvalJson.suitePath));
    } finally {
      gw.server.close();
      safeRm(tmp);
    }
  });
});
