import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OMAgent, DockerExecutionBackend, SSHExecutionBackend, createExecutionBackend, OMGitManager } from '../dist/index.js';

test('Unified ExecutionBackend seam routes filesystem and process skills through custom backend', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-exec-seam-'));
  const memFiles = new Map();
  const recordedOps = [];

  const mockBackend = {
    name: 'mock-remote',
    exists(p) {
      recordedOps.push(['exists', p]);
      return memFiles.has(p) || p === tmpDir || p.startsWith(tmpDir);
    },
    stat(p) {
      recordedOps.push(['stat', p]);
      const content = memFiles.get(p) ?? '';
      return {
        isFile: memFiles.has(p),
        isDirectory: !memFiles.has(p),
        size: Buffer.byteLength(content, 'utf8'),
        mtimeMs: Date.now()
      };
    },
    realpath(p) {
      return p;
    },
    readFile(p) {
      recordedOps.push(['readFile', p]);
      return memFiles.get(p) ?? '';
    },
    writeFile(p, content) {
      recordedOps.push(['writeFile', p]);
      memFiles.set(p, content);
    },
    mkdir(p) {
      recordedOps.push(['mkdir', p]);
    },
    readdir() {
      return Array.from(memFiles.keys()).map((k) => ({
        name: path.basename(k),
        isFile: true,
        isDirectory: false
      }));
    },
    async exec(command) {
      recordedOps.push(['exec', command]);
      return {
        exitCode: 0,
        stdout: `mock-exec:${command}`,
        stderr: '',
        timedOut: false
      };
    },
    async spawn(executable, args) {
      recordedOps.push(['spawn', executable, ...args]);
      return {
        exitCode: 0,
        stdout: `mock-spawn:${executable}`,
        stderr: '',
        timedOut: false,
        sandboxBackend: 'mock'
      };
    }
  };

  try {
    const agent = new OMAgent({
      provider: 'om',
      workspaceDir: tmpDir,
      memoryDir: path.join(tmpDir, 'mem'),
      executionBackend: mockBackend,
      security: {
        requireConfirmationForShell: false,
        allowAllCommands: true,
        sandbox: { mode: 'off' }
      }
    });

    const ctx = { config: agent.config, execution: agent.execution };
    const targetFile = path.join(tmpDir, 'hello.txt');

    const writeRes = await agent.skills.execute('write_file', { path: 'hello.txt', content: 'hello world' }, ctx);
    assert.equal(writeRes.success, true);
    assert.equal(memFiles.get(targetFile), 'hello world');

    const readRes = await agent.skills.execute('read_file', { path: 'hello.txt' }, ctx);
    assert.equal(readRes.success, true);
    assert.equal(readRes.content, '1: hello world');

    const patchRes = await agent.skills.execute('patch_file', {
      path: 'hello.txt',
      targetText: 'world',
      replacementText: 'seam'
    }, ctx);
    assert.equal(patchRes.success, true);
    assert.equal(memFiles.get(targetFile), 'hello seam');

    const execRes = await agent.skills.execute('exec_command', { command: 'echo test' }, ctx);
    assert.equal(execRes.success, true);
    assert.equal(execRes.stdout, 'mock-exec:echo test');

    assert.ok(recordedOps.some((op) => op[0] === 'writeFile'));
    assert.ok(recordedOps.some((op) => op[0] === 'readFile'));
    assert.ok(recordedOps.some((op) => op[0] === 'exec'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Persistent interactive terminal skills support start, write, read, list, and close', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-term-'));
  const agent = new OMAgent({
    provider: 'om',
    workspaceDir: tmpDir,
    memoryDir: path.join(tmpDir, 'mem'),
    security: {
      requireConfirmationForShell: false,
      allowAllCommands: true
    }
  });
  const ctx = { config: agent.config, execution: agent.execution };

  let sessionId = '';
  try {
    const startRes = await agent.skills.execute('terminal_start', {
      command: 'node -i',
      label: 'node-repl',
      waitMs: 500
    }, ctx);
    assert.equal(startRes.success, true);
    assert.ok(startRes.sessionId);
    assert.equal(startRes.alive, true);
    sessionId = startRes.sessionId;

    const listRes = await agent.skills.execute('terminal_list', {}, ctx);
    assert.equal(listRes.success, true);
    assert.ok(listRes.sessions.some((s) => s.sessionId === sessionId && s.label === 'node-repl'));

    const writeRes = await agent.skills.execute('terminal_write', {
      sessionId,
      input: 'console.log("TERM_OK_" + (21 * 2))',
      waitMs: 1200
    }, ctx);
    assert.equal(writeRes.success, true);

    let combinedOut = writeRes.output || '';
    if (!/TERM_OK_42/.test(combinedOut)) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 300));
        const poll = await agent.skills.execute('terminal_read', { sessionId, tailLines: 20 }, ctx);
        combinedOut = poll.output || '';
        if (/TERM_OK_42/.test(combinedOut)) break;
      }
    }
    assert.match(combinedOut, /TERM_OK_42/);

    const readRes = await agent.skills.execute('terminal_read', {
      sessionId,
      tailLines: 20
    }, ctx);
    assert.equal(readRes.success, true);
    assert.match(readRes.output, /TERM_OK_42/);

    const closeRes = await agent.skills.execute('terminal_close', { sessionId }, ctx);
    assert.equal(closeRes.success, true);
    sessionId = '';
  } finally {
    if (sessionId) {
      await agent.skills.execute('terminal_close', { sessionId }, ctx);
    }
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

test('get_workspace_diagnostics reports structured TypeScript compiler errors across workspace', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-diag-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true
      },
      include: ['*.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'broken.ts'), 'const x: number = "not_a_number";\n', 'utf8');

    const agent = new OMAgent({
      provider: 'om',
      workspaceDir: tmpDir,
      memoryDir: path.join(tmpDir, 'mem')
    });
    const ctx = { config: agent.config, execution: agent.execution };

    const res = await agent.skills.execute('get_workspace_diagnostics', {}, ctx);
    assert.equal(res.success, true);
    assert.ok(res.errorCount >= 1);
    assert.ok(res.diagnostics.some((d) => d.file.endsWith('broken.ts') && d.code === 'TS2322'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('OMGitManager, WorkspaceSnapshotManager, terminal_start allowlist, and OMAgent.close() cleanup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-polish-'));
  const gitCalls = [];
  const snapOps = [];

  const mockBackend = {
    name: 'mock-polish',
    exists: (p) => fs.existsSync(p),
    stat: (p) => {
      const s = fs.statSync(p);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    },
    realpath: (p) => fs.realpathSync(p),
    readFile: (p, enc = 'utf8') => fs.readFileSync(p, enc),
    writeFile: (p, content, enc = 'utf8') => {
      snapOps.push(['writeFile', p]);
      fs.writeFileSync(p, content, enc);
    },
    mkdir: (p, opts) => {
      snapOps.push(['mkdir', p]);
      fs.mkdirSync(p, opts);
    },
    readdir: (p) => fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory()
    })),
    copyFile: (src, dest) => {
      snapOps.push(['copyFile', src, dest]);
      fs.copyFileSync(src, dest);
    },
    rm: (p, opts) => {
      snapOps.push(['rm', p]);
      fs.rmSync(p, opts);
    },
    execSync: (exe, args) => {
      gitCalls.push([exe, ...args]);
      if (args[0] === 'rev-parse') return 'true';
      if (args[0] === 'symbolic-ref') return 'main';
      if (args[0] === 'status') return '';
      return '';
    },
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
  };

  try {
    const agent = new OMAgent({
      provider: 'om',
      workspaceDir: tmpDir,
      memoryDir: path.join(tmpDir, 'mem'),
      executionBackend: mockBackend,
      security: {
        requireConfirmationForShell: false,
        allowAllCommands: false,
        allowedCommands: ['git']
      }
    });

    // 1. OMGitManager routes through custom ExecutionBackend
    assert.equal(agent.git.isGitRepo(), true);
    assert.equal(agent.git.getStatus().branch, 'main');
    assert.ok(gitCalls.some((c) => c[0] === 'git' && c[1] === 'rev-parse'));

    // 2. WorkspaceSnapshotManager routes through custom ExecutionBackend
    const targetFile = path.join(tmpDir, 'snap.txt');
    fs.writeFileSync(targetFile, 'v1', 'utf8');
    agent.snapshots.captureBeforeMutation('run_1', targetFile);
    assert.ok(snapOps.some((op) => op[0] === 'copyFile'));
    assert.ok(snapOps.some((op) => op[0] === 'writeFile'));

    // 3. terminal_start enforces security.allowedCommands
    const ctx = { config: agent.config, execution: agent.execution };
    const blocked = await agent.skills.execute('terminal_start', { command: 'node -e "1+1"' }, ctx);
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /allowedCommands/i);

    // 4. OMAgent.close() closes active terminal sessions
    const permissiveAgent = new OMAgent({
      provider: 'om',
      workspaceDir: tmpDir,
      memoryDir: path.join(tmpDir, 'mem2'),
      security: { requireConfirmationForShell: false, allowAllCommands: true }
    });
    const started = await permissiveAgent.skills.execute('terminal_start', { command: 'node -i', waitMs: 300 }, {
      config: permissiveAgent.config,
      execution: permissiveAgent.execution
    });
    assert.equal(started.success, true);
    await permissiveAgent.close();
    const listed = await permissiveAgent.skills.execute('terminal_list', {}, { config: permissiveAgent.config });
    assert.equal(listed.sessions.some((s) => s.sessionId === started.sessionId), false);
    await agent.close();
  } finally {
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

test('Built-in DockerExecutionBackend, SSHExecutionBackend, createExecutionBackend, and git symlink seam', () => {
  const localBackend = createExecutionBackend({ type: 'local' });
  assert.equal(localBackend.name, 'local');

  const dockerBackend = createExecutionBackend({
    type: 'docker',
    container: 'om-sandbox',
    workdir: '/workspace',
    localWorkspaceDir: '/host/proj'
  });
  assert.ok(dockerBackend instanceof DockerExecutionBackend);
  assert.equal(dockerBackend.name, 'docker');
  assert.equal(dockerBackend.container, 'om-sandbox');

  const sshBackend = createExecutionBackend({
    type: 'ssh',
    host: 'user@example.com',
    port: 2222,
    identityFile: '~/.ssh/id_ed25519',
    workdir: '/srv/proj'
  });
  assert.ok(sshBackend instanceof SSHExecutionBackend);
  assert.equal(sshBackend.name, 'ssh');
  assert.equal(sshBackend.host, 'user@example.com');
  assert.equal(sshBackend.port, 2222);

  // Verify OMGitManager._linkWorktreeDependencies and _unlinkWorktreeDependencies use ExecutionBackend
  const ops = [];
  const symlinkBackend = {
    name: 'mock-symlink',
    exists: (p) => {
      ops.push(['exists', p]);
      return p.endsWith('main\\node_modules') || p.endsWith('main/node_modules');
    },
    stat: () => ({ isFile: false, isDirectory: true, size: 0, mtimeMs: 0 }),
    realpath: (p) => p,
    readFile: () => '',
    writeFile: () => {},
    mkdir: () => {},
    readdir: () => [],
    symlink: (target, link, type) => ops.push(['symlink', target, link, type]),
    isSymlink: (p) => {
      ops.push(['isSymlink', p]);
      return true;
    },
    unlink: (p) => ops.push(['unlink', p]),
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
  };

  const gitMgr = new OMGitManager('/tmp/main', symlinkBackend);
  gitMgr._linkWorktreeDependencies('/tmp/wt');
  gitMgr._unlinkWorktreeDependencies('/tmp/wt');

  assert.ok(ops.some((op) => op[0] === 'symlink'));
  assert.ok(ops.some((op) => op[0] === 'isSymlink'));
  assert.ok(ops.some((op) => op[0] === 'unlink'));
});
