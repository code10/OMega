import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { assertWritablePath, isExecutableSkillFilename } from '../dist/skills/filesystem.js';
import { getRequiredRole, extractBearerToken } from '../dist/gateway/auth.js';
import { OMGitManager } from '../dist/git.js';
import { validateShellCommandPolicy } from '../dist/skills/shell.js';
import { validateExternalUrl } from '../dist/skills/web.js';
import { DetachedSwarmManager } from '../dist/agent/detachedSwarm.js';
import { saveCheckpoint } from '../dist/agent/checkpoint.js';
import { TerminalSessionManager } from '../dist/skills/terminal.js';
import { startGateway } from '../dist/gateway/server.js';
import { loadConfig } from '../dist/config.js';

test('Finding 1: Write guard blocks .js, .mjs, .cjs, and .ts inside skillsDir', () => {
  const root = path.resolve(os.tmpdir(), 'omega-f1');
  const skillsDir = path.join(root, 'skills');
  for (const ext of ['.js', '.mjs', '.cjs', '.ts']) {
    assert.equal(isExecutableSkillFilename(`evil${ext}`), true);
    assert.throws(
      () => assertWritablePath(path.join(skillsDir, `evil${ext}`), {
        config: { rootDir: root, skillsDir, security: { allowSelfModification: false } }
      }),
      /blocked to prevent self-modification/i
    );
  }
});

test('Findings 2, 3, 7 & Hardening 7: RBAC admin routes and ?token= restriction', () => {
  assert.equal(getRequiredRole('/api/git/diff', 'GET'), 'admin');
  assert.equal(getRequiredRole('/api/git/worktree/diff', 'GET'), 'admin');
  assert.equal(getRequiredRole('/api/providers/keys', 'POST'), 'admin');
  assert.equal(getRequiredRole('/api/webhooks/nightly', 'POST'), 'admin');

  // ?token= only allowed on /api/events (SSE)
  const fakeReq = { headers: {} };
  assert.equal(extractBearerToken(fakeReq, new URL('http://127.0.0.1/api/status?token=secret')), '');
  assert.equal(extractBearerToken(fakeReq, new URL('http://127.0.0.1/api/events?token=secret')), 'secret');
});

test('Finding 6: OMGitManager.getDiff rejects leading-dash options and invalid refs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-git-f6-'));
  try {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "t@omega.local"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "OM"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), '1\n', 'utf8');
    execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

    const git = new OMGitManager(tmpDir);
    const outFile = path.join(tmpDir, 'pwned.txt');
    assert.throws(() => git.getDiff(`--output=${outFile}`), /Invalid git ref/i);
    assert.equal(fs.existsSync(outFile), false);
    assert.throws(() => git.getDiff('--stat'), /Invalid git ref/i);
    assert.equal(typeof git.getDiff('HEAD'), 'string');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Finding 5: DetachedSwarmManager.inspectSession confines checkpoint.logFile to memoryDir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-f5-'));
  const memDir = path.join(tmpDir, 'tenant1', 'memory');
  const secretFile = path.join(tmpDir, 'tenant2', 'secret.txt');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, 'TOP_SECRET_TENANT2_DATA', 'utf8');

    saveCheckpoint(memDir, {
      version: 1,
      sessionId: 'evil_cp',
      prompt: 'hi',
      status: 'completed',
      currentStep: 1,
      maxSteps: 5,
      history: [],
      steps: [],
      logFile: secretFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const mgr = new DetachedSwarmManager({ memoryDir: memDir, workspaceDir: path.join(tmpDir, 'tenant1') });
    const inspected = mgr.inspectSession('evil_cp');
    assert.equal(inspected.logTail, '');
    assert.ok(!inspected.logTail.includes('TOP_SECRET_TENANT2_DATA'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Finding 5 & Hardening 4: TerminalSessionManager enforces workspace ownership and write policy', async () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-t1-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-t2-'));
  const mgr = new TerminalSessionManager();
  const ctx1 = { config: { workspaceDir: tmp1, security: { requireConfirmationForShell: false, allowAllCommands: true } } };
  const ctx2 = { config: { workspaceDir: tmp2, security: { requireConfirmationForShell: false, allowAllCommands: true } } };

  try {
    const started = await mgr.start({ command: 'node -i', waitMs: 300 }, ctx1);
    assert.equal(started.success, true);

    // Tenant 2 cannot list, read, write, or close Tenant 1's terminal
    assert.equal(mgr.list(ctx2).count, 0);
    assert.equal(mgr.read({ sessionId: started.sessionId }, ctx2).success, false);
    assert.equal((await mgr.write({ sessionId: started.sessionId, input: '1+1' }, ctx2)).success, false);
    assert.equal(mgr.close(started.sessionId, ctx2).success, false);

    // Shutdown closeAll() still closes all sessions without caller context
    mgr.closeAll();
    assert.equal(mgr.list(ctx1).count, 0);
  } finally {
    mgr.closeAll();
    await new Promise((r) => setTimeout(r, 250));
    try { fs.rmSync(tmp1, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    try { fs.rmSync(tmp2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
});

test('Hardening 3 & 6: SSRF blocks bracketed IPv6/IPv4-mapped and shell blocks git config alias/hooks', async () => {
  await assert.rejects(() => validateExternalUrl('http://[::1]:3000/'), /SSRF protection/i);
  await assert.rejects(() => validateExternalUrl('http://[::ffff:127.0.0.1]:3000/'), /SSRF protection/i);
  await assert.rejects(() => validateExternalUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'), /SSRF protection/i);

  const aliasCheck = validateShellCommandPolicy('git config alias.pwn !id', {
    allowAllCommands: false,
    allowedCommands: ['git']
  });
  assert.equal(aliasCheck.allowed, false);
  assert.match(aliasCheck.error, /git config alias\.pwn/i);

  const hooksCheck = validateShellCommandPolicy('git config core.hooksPath /tmp/evil', {
    allowAllCommands: false,
    allowedCommands: ['git']
  });
  assert.equal(hooksCheck.allowed, false);
});

test('Finding 3 & 4 & Hardening 5: Gateway rejects newline in /api/providers/keys, enforces approval owner, and gates fetch_page', async () => {
  const cfg = loadConfig({});
  assert.ok(cfg.security?.requireConfirmationForTools?.includes('fetch_page'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-gw-sec-'));
  const gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    workspaceDir: tmpDir,
    memoryDir: path.join(tmpDir, '.mem'),
    tenantsRoot: path.join(tmpDir, 'tenants'),
    provider: 'om',
    model: 'om-turbo',
    auth: {
      mode: 'multiuser',
      jwtSecret: 'pinned-test-secret-123456',
      users: [
        { id: 'admin1', role: 'admin', token: 'tok-admin' },
        { id: 'op1', role: 'operator', token: 'tok-op1' },
        { id: 'viewer1', role: 'viewer', token: 'tok-viewer1' }
      ]
    }
  });

  try {
    const port = gw.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Operator cannot hit /api/providers/keys (403)
    const opKeyRes = await fetch(`${baseUrl}/api/providers/keys`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-op1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKeyEnv: 'OPENAI_API_KEY', apiKey: 'abc\nOM_JWT_SECRET=hacked' })
    });
    assert.equal(opKeyRes.status, 403);

    // Even admin cannot inject newlines into .env
    const adminNlRes = await fetch(`${baseUrl}/api/providers/keys`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKeyEnv: 'OPENAI_API_KEY', apiKey: 'abc\nOM_JWT_SECRET=hacked' })
    });
    assert.equal(adminNlRes.status, 400);

    // Viewer cannot read /api/git/diff (403)
    const viewerDiffRes = await fetch(`${baseUrl}/api/git/diff`, {
      headers: { Authorization: 'Bearer tok-viewer1' }
    });
    assert.equal(viewerDiffRes.status, 403);

    // Operator cannot fire /api/webhooks/:id (403)
    const opHookRes = await fetch(`${baseUrl}/api/webhooks/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-op1', 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(opHookRes.status, 403);
  } finally {
    gw.server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
