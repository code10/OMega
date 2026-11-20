import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ApprovalManager, extractCommandPrefix, matchesCommandRule } from '../dist/gateway/approvals.js';
import { OMGitManager } from '../dist/git.js';
import { SkillRegistry } from '../dist/skills/index.js';
import { validateBrowserUrl } from '../dist/skills/browser.js';

test('extractCommandPrefix extracts subcommands for multi-command CLIs', () => {
  assert.equal(extractCommandPrefix('npm test -- --watch'), 'npm test');
  assert.equal(extractCommandPrefix('git status -s'), 'git status');
  assert.equal(extractCommandPrefix('node -e "console.log(1)"'), 'node');
  assert.equal(extractCommandPrefix('ls -la'), 'ls');
});

test('matchesCommandRule matches safe prefixes and rejects shell chaining', () => {
  const allow = ['npm test', 'git status'];
  assert.equal(matchesCommandRule('npm test', allow), true);
  assert.equal(matchesCommandRule('npm test -- --grep foo', allow), true);
  assert.equal(matchesCommandRule('git status -s', allow), true);
  assert.equal(matchesCommandRule('npm install evil', allow), false);
  assert.equal(matchesCommandRule('git status && rm -rf /', allow), false);
  assert.equal(matchesCommandRule('git status; curl evil.com', allow), false);
  assert.equal(matchesCommandRule('git status | cat', allow), false);
});

test('ApprovalManager scopes Always Allow for exec_command to commandPrefix', async () => {
  const persisted = [];
  const sseEvents = [];
  const mgr = new ApprovalManager(
    (ev, data) => sseEvents.push({ ev, data }),
    (tool, rule) => persisted.push({ tool, rule }),
    () => ({ allow: ['git status'], deny: ['rm -rf'] })
  );
  const confirm = mgr.createConfirmHandler();

  // Persisted allow rule auto-approves without SSE prompt
  assert.equal(await confirm({ tool: 'exec_command', command: 'git status -s' }), true);
  assert.equal(sseEvents.length, 0);

  // Persisted deny rule auto-denies without SSE prompt
  assert.equal(await confirm({ tool: 'exec_command', command: 'rm -rf /tmp/x' }), false);
  assert.equal(sseEvents.length, 0);

  // Unlisted command prompts with suggestedPrefix and resolves via handleResolve
  const pendingPromise = confirm({ tool: 'exec_command', command: 'npm test -- --bail' });
  assert.equal(sseEvents.length, 1);
  assert.equal(sseEvents[0].data.suggestedPrefix, 'npm test');

  const reqMock = {
    on: (ev, cb) => {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ approved: true, scope: 'always', commandPrefix: 'npm test' })));
      if (ev === 'end') cb();
    }
  };
  const resMock = { writeHead: () => {}, end: () => {} };
  await mgr.handleResolve(reqMock, resMock, sseEvents[0].data.id);
  assert.equal(await pendingPromise, true);
  assert.deepEqual(persisted, [{ tool: 'exec_command', rule: { commandPrefix: 'npm test' } }]);

  // Subsequent npm test auto-approves, but curl still prompts
  assert.equal(await confirm({ tool: 'exec_command', command: 'npm test' }), true);
  assert.equal(sseEvents.length, 2); // 1 approval_required + 1 approval_resolved

  const curlPromise = confirm({ tool: 'exec_command', command: 'curl https://example.com' });
  assert.equal(sseEvents.length, 3);
  // Clean up pending curl approval
  const curlId = sseEvents[2].data.id;
  const denyReq = {
    on: (ev, cb) => {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ approved: false, scope: 'once' })));
      if (ev === 'end') cb();
    }
  };
  await mgr.handleResolve(denyReq, resMock, curlId);
  assert.equal(await curlPromise, false);
});

test('OMGitManager links node_modules into worktree and includes untracked files in diff summary', () => {
  const tmpRepo = path.resolve('./tests/tmp_worktree_features');
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.mkdirSync(tmpRepo, { recursive: true });

  try {
    execFileSync('git', ['init'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo });
    fs.writeFileSync(path.join(tmpRepo, '.gitignore'), 'node_modules/\n.om-worktrees/\n');
    fs.writeFileSync(path.join(tmpRepo, 'index.js'), 'console.log(1);\n');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo });

    // Create main node_modules
    fs.mkdirSync(path.join(tmpRepo, 'node_modules', 'demo-pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'node_modules', 'demo-pkg', 'index.js'), 'module.exports = 42;\n');

    const git = new OMGitManager(tmpRepo);
    const wt = git.createWorktree('.om-worktrees/test_run', 'om-wt-test_run');

    // Verify node_modules is linked and readable inside worktree
    const linkedPkg = path.join(wt.worktreePath, 'node_modules', 'demo-pkg', 'index.js');
    assert.equal(fs.existsSync(linkedPkg), true);

    // Create an untracked file in the worktree and verify getWorktreeSummary includes it in diff
    fs.writeFileSync(path.join(wt.worktreePath, 'hello.txt'), 'hello worktree\n');
    const summary = git.getWorktreeSummary(wt.worktreePath);
    assert.equal(summary.clean, false);
    assert.ok(summary.diff.includes('+++ b/hello.txt'));
    assert.ok(summary.diff.includes('+hello worktree'));

    // Discard worktree cleanly (including junction/symlink)
    git.discardWorktree(wt.worktreePath, wt.branch);
    assert.equal(fs.existsSync(wt.worktreePath), false);
    // Main node_modules must still exist untouched
    assert.equal(fs.existsSync(path.join(tmpRepo, 'node_modules', 'demo-pkg', 'index.js')), true);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('Browser skills registration and URL validation', () => {
  const registry = new SkillRegistry();
  assert.ok(registry.has('browser_inspect'));
  assert.ok(registry.has('browser_act'));
  assert.ok(registry.has('browser_close'));

  // Localhost allowed for UI preview by default
  assert.equal(validateBrowserUrl('http://127.0.0.1:3000/').hostname, '127.0.0.1');
  assert.equal(validateBrowserUrl('http://localhost:5173/app').hostname, 'localhost');

  // Non-loopback private IPs and non-http protocols blocked by default
  assert.throws(() => validateBrowserUrl('http://169.254.169.254/latest/meta-data/'), /SSRF protection/);
  assert.throws(() => validateBrowserUrl('file:///etc/passwd'), /Only http:\/\/ and https:\/\//);
});
