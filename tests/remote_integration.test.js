import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerExecutionBackend, SSHExecutionBackend, OMAgent } from '../dist/index.js';

function isDockerAvailable() {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    });
    return true;
  } catch (_) {
    return false;
  }
}

const HAS_DOCKER = isDockerAvailable();
const SSH_TEST_HOST = process.env.OM_SSH_TEST_HOST || '';

/**
 * Shared contract suite run against any live RemoteShellExecutionBackend (Docker or SSH).
 */
async function verifyRemoteBackendContract(backend, remoteWorkdir) {
  const testDir = path.posix.join(remoteWorkdir, `om_e2e_${Date.now().toString(36)}`);
  const filePath = path.posix.join(testDir, 'hello.txt');
  const copyPath = path.posix.join(testDir, 'hello_copy.txt');
  const linkPath = path.posix.join(testDir, 'hello_link.txt');

  backend.mkdir(testDir, { recursive: true });
  assert.equal(backend.exists(testDir), true);

  await backend.writeFile(filePath, 'hello remote world\nline2', 'utf8');
  assert.equal(backend.exists(filePath), true);
  assert.equal(backend.readFile(filePath, 'utf8'), 'hello remote world\nline2');

  const st = backend.stat(filePath);
  assert.equal(st.isFile, true);
  assert.equal(st.isDirectory, false);
  assert.ok(st.size > 0);

  backend.copyFile(filePath, copyPath);
  assert.equal(backend.readFile(copyPath, 'utf8'), 'hello remote world\nline2');

  backend.symlink(filePath, linkPath);
  assert.equal(backend.isSymlink(linkPath), true);
  backend.unlink(linkPath);
  assert.equal(backend.exists(linkPath), false);

  const entries = backend.readdir(testDir);
  assert.ok(entries.some((e) => e.name === 'hello.txt' && e.isFile));

  const execRes = await backend.exec('echo REMOTE_EXEC_OK', {
    cwd: testDir,
    shell: 'sh',
    env: process.env,
    timeoutMs: 10000
  });
  assert.equal(execRes.exitCode, 0);
  assert.match(execRes.stdout, /REMOTE_EXEC_OK/);

  const spawnRes = await backend.spawn('printf', ['REMOTE_SPAWN_OK'], {
    cwd: testDir,
    env: process.env,
    timeoutMs: 10000
  });
  assert.equal(spawnRes.exitCode, 0);
  assert.equal(spawnRes.stdout, 'REMOTE_SPAWN_OK');

  backend.rm(testDir, { recursive: true, force: true });
  assert.equal(backend.exists(testDir), false);
}

test('Live DockerExecutionBackend end-to-end integration', {
  skip: HAS_DOCKER ? false : 'Docker daemon not available on this host'
}, async () => {
  const containerName = `om-e2e-${Date.now().toString(36)}`;
  execFileSync('docker', ['run', '-d', '--rm', '--name', containerName, 'alpine:latest', 'sleep', '120'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000
  });

  const tmpHost = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-docker-e2e-'));
  try {
    const backend = new DockerExecutionBackend({
      container: containerName,
      workdir: '/tmp',
      localWorkspaceDir: tmpHost
    });
    await verifyRemoteBackendContract(backend, '/tmp');

    const agent = new OMAgent({
      provider: 'om',
      workspaceDir: tmpHost,
      memoryDir: path.join(tmpHost, 'mem'),
      executionBackend: backend,
      security: { requireConfirmationForShell: false, allowAllCommands: true }
    });
    const res = await agent.skills.execute('exec_command', { command: 'uname -s' }, {
      config: agent.config,
      execution: agent.execution
    });
    assert.equal(res.success, true);
    assert.match(res.stdout, /Linux/);
    await agent.close();
  } finally {
    try {
      execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 10000 });
    } catch (_) {}
    fs.rmSync(tmpHost, { recursive: true, force: true });
  }
});

test('Live SSHExecutionBackend end-to-end integration', {
  skip: SSH_TEST_HOST ? false : 'Set OM_SSH_TEST_HOST (and optional OM_SSH_TEST_PORT/OM_SSH_TEST_KEY) to run live SSH test'
}, async () => {
  const workdir = process.env.OM_SSH_TEST_WORKDIR || '/tmp';
  const backend = new SSHExecutionBackend({
    host: SSH_TEST_HOST,
    port: process.env.OM_SSH_TEST_PORT ? Number(process.env.OM_SSH_TEST_PORT) : undefined,
    identityFile: process.env.OM_SSH_TEST_KEY || undefined,
    workdir
  });
  await verifyRemoteBackendContract(backend, workdir);
});

test('RemoteShellExecutionBackend subprocess transport end-to-end (Node transport shim)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-remote-shim-'));
  try {
    // Real executable shim (invoked via execFileSync / execFile) that simulates remote POSIX shell over transport
    const shimScript = path.join(tmpDir, 'transport.mjs');
    fs.writeFileSync(shimScript, `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      const cmd = args[args.length - 1] || '';
      if (cmd.startsWith('test -e ')) {
        const p = cmd.slice(8).replace(/^'|'$/g, '');
        process.exit(fs.existsSync(p) ? 0 : 1);
      } else if (cmd.startsWith('mkdir -p ')) {
        const p = cmd.slice(9).replace(/^'|'$/g, '');
        fs.mkdirSync(p, { recursive: true });
      } else if (cmd.startsWith('base64 -d > ')) {
        const p = cmd.slice(12).replace(/^'|'$/g, '');
        const b64 = fs.readFileSync(0, 'utf8').trim();
        fs.writeFileSync(p, Buffer.from(b64, 'base64'));
      } else if (cmd.startsWith('base64 < ')) {
        const p = cmd.slice(9).replace(/^'|'$/g, '');
        process.stdout.write(fs.readFileSync(p).toString('base64'));
      } else if (cmd.includes('ECHO_SHIM_OK')) {
        process.stdout.write('ECHO_SHIM_OK');
      }
    `, 'utf8');

    class ShimSSHBackend extends SSHExecutionBackend {
      buildTransportArgs(remoteCommand) {
        return { binary: process.execPath, args: [shimScript, remoteCommand] };
      }
    }

    const backend = new ShimSSHBackend({
      host: 'shim@localhost',
      workdir: tmpDir,
      localWorkspaceDir: tmpDir
    });

    const subDir = path.join(tmpDir, 'sub');
    backend.mkdir(subDir, { recursive: true });
    assert.equal(backend.exists(subDir), true);

    const f = path.join(subDir, 'note.txt');
    await backend.writeFile(f, 'shim payload', 'utf8');
    assert.equal(backend.readFile(f, 'utf8'), 'shim payload');

    const res = await backend.exec('echo ECHO_SHIM_OK', {
      cwd: subDir,
      shell: 'sh',
      env: process.env,
      timeoutMs: 5000
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, 'ECHO_SHIM_OK');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
