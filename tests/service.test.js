import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import {
  renderSystemdUnit,
  renderLaunchdPlist,
  buildWindowsTaskArgs,
  getServiceSpec
} from '../dist/service.js';

test('loadConfig honors OM_WORKSPACE_DIR and OM_MEMORY_DIR', () => {
  const prevWs = process.env.OM_WORKSPACE_DIR;
  const prevMem = process.env.OM_MEMORY_DIR;

  process.env.OM_WORKSPACE_DIR = './tests/tmp_ws_env';
  process.env.OM_MEMORY_DIR = './tests/tmp_mem_env';

  try {
    const cfg = loadConfig({});
    assert.equal(cfg.workspaceDir, path.resolve('./tests/tmp_ws_env'));
    assert.equal(cfg.memoryDir, path.resolve('./tests/tmp_mem_env'));
  } finally {
    if (prevWs === undefined) delete process.env.OM_WORKSPACE_DIR;
    else process.env.OM_WORKSPACE_DIR = prevWs;
    if (prevMem === undefined) delete process.env.OM_MEMORY_DIR;
    else process.env.OM_MEMORY_DIR = prevMem;
  }
});

test('OS service generators produce valid systemd, launchd, and Windows task specs', () => {
  const systemd = renderSystemdUnit({
    serviceName: 'omega',
    nodePath: '/usr/bin/node',
    cliPath: '/opt/omega/bin/om.js',
    mode: 'gateway',
    workspaceDir: '/srv/repo',
    memoryDir: '/srv/repo/memory'
  });
  assert.ok(systemd.includes('Restart=always'));
  assert.ok(systemd.includes('Environment=OM_WORKSPACE_DIR=/srv/repo'));
  assert.ok(systemd.includes('ExecStart="/usr/bin/node" "/opt/omega/bin/om.js" gateway'));

  const plist = renderLaunchdPlist({
    label: 'com.omega.harness',
    nodePath: '/usr/local/bin/node',
    cliPath: '/opt/omega/bin/om.js',
    mode: 'daemon',
    workspaceDir: '/Users/dev/repo',
    memoryDir: '/Users/dev/repo/memory',
    logDir: '/Users/dev/repo/memory'
  });
  assert.ok(plist.includes('<key>KeepAlive</key>'));
  assert.ok(plist.includes('<key>RunAtLoad</key>'));
  assert.ok(plist.includes('<string>daemon</string>'));

  const winArgs = buildWindowsTaskArgs({
    taskName: 'OMegaHarness',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\OMega\\bin\\om.js',
    mode: 'gateway'
  });
  assert.ok(winArgs.includes('ONLOGON'));
  assert.ok(winArgs.includes('OMegaHarness'));

  const winSpec = getServiceSpec({
    platform: 'win32',
    mode: 'gateway',
    workspaceDir: 'C:\\repo',
    memoryDir: 'C:\\repo\\memory'
  });
  assert.equal(winSpec.manager, 'schtasks');
  assert.ok(winSpec.content.includes('OM_WORKSPACE_DIR=C:\\repo'));
});
