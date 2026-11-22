import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ServiceOptions {
  platform?: NodeJS.Platform;
  mode?: 'gateway' | 'daemon';
  nodePath?: string;
  cliPath?: string;
  workspaceDir?: string;
  memoryDir?: string;
  serviceName?: string;
  homeDir?: string;
}

export interface ServiceSpec {
  platform: NodeJS.Platform;
  serviceName: string;
  manager: 'systemd-user' | 'launchd' | 'schtasks';
  definitionPath: string;
  content: string;
  execCommand: string;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderSystemdUnit(opts: {
  serviceName: string;
  nodePath: string;
  cliPath: string;
  mode: 'gateway' | 'daemon';
  workspaceDir: string;
  memoryDir: string;
}): string {
  return `[Unit]
Description=OMega Local-First Agent Harness (${opts.mode})
After=network.target

[Service]
Type=simple
WorkingDirectory=${opts.workspaceDir}
Environment=OM_WORKSPACE_DIR=${opts.workspaceDir}
Environment=OM_MEMORY_DIR=${opts.memoryDir}
ExecStart="${opts.nodePath}" "${opts.cliPath}" ${opts.mode}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function renderLaunchdPlist(opts: {
  label: string;
  nodePath: string;
  cliPath: string;
  mode: 'gateway' | 'daemon';
  workspaceDir: string;
  memoryDir: string;
  logDir: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.nodePath)}</string>
    <string>${escapeXml(opts.cliPath)}</string>
    <string>${escapeXml(opts.mode)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.workspaceDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OM_WORKSPACE_DIR</key>
    <string>${escapeXml(opts.workspaceDir)}</string>
    <key>OM_MEMORY_DIR</key>
    <string>${escapeXml(opts.memoryDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(opts.logDir, 'omega-service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(opts.logDir, 'omega-service.err.log'))}</string>
</dict>
</plist>
`;
}

export function buildWindowsTaskArgs(opts: {
  taskName: string;
  nodePath: string;
  cliPath: string;
  mode: 'gateway' | 'daemon';
}): string[] {
  const tr = `"${opts.nodePath}" "${opts.cliPath}" ${opts.mode}`;
  return ['/Create', '/F', '/SC', 'ONLOGON', '/TN', opts.taskName, '/TR', tr];
}

export function getServiceSpec(options: ServiceOptions = {}): ServiceSpec {
  const platform = options.platform || process.platform;
  const mode = options.mode === 'daemon' ? 'daemon' : 'gateway';
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || path.resolve(process.cwd(), 'bin', 'om.js');
  const workspaceDir = path.resolve(options.workspaceDir || process.cwd());
  const memoryDir = path.resolve(options.memoryDir || path.join(workspaceDir, 'memory'));
  const homeDir = options.homeDir || os.homedir();

  if (platform === 'darwin') {
    const label = options.serviceName || 'com.omega.harness';
    const definitionPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    return {
      platform,
      serviceName: label,
      manager: 'launchd',
      definitionPath,
      execCommand: `"${nodePath}" "${cliPath}" ${mode}`,
      content: renderLaunchdPlist({
        label,
        nodePath,
        cliPath,
        mode,
        workspaceDir,
        memoryDir,
        logDir: memoryDir
      })
    };
  }

  if (platform === 'win32') {
    const taskName = options.serviceName || 'OMegaHarness';
    const definitionPath = path.join(memoryDir, `${taskName}.cmd`);
    const wrapper = `@echo off\r\nset "OM_WORKSPACE_DIR=${workspaceDir}"\r\nset "OM_MEMORY_DIR=${memoryDir}"\r\n"${nodePath}" "${cliPath}" ${mode}\r\n`;
    return {
      platform,
      serviceName: taskName,
      manager: 'schtasks',
      definitionPath,
      execCommand: wrapper.trim(),
      content: wrapper
    };
  }

  const serviceName = options.serviceName || 'omega';
  const definitionPath = path.join(homeDir, '.config', 'systemd', 'user', `${serviceName}.service`);
  return {
    platform,
    serviceName,
    manager: 'systemd-user',
    definitionPath,
    execCommand: `"${nodePath}" "${cliPath}" ${mode}`,
    content: renderSystemdUnit({
      serviceName,
      nodePath,
      cliPath,
      mode,
      workspaceDir,
      memoryDir
    })
  };
}

export function installService(options: ServiceOptions & { dryRun?: boolean } = {}) {
  const spec = getServiceSpec(options);
  if (options.dryRun) {
    return { installed: false, dryRun: true, spec };
  }

  fs.mkdirSync(path.dirname(spec.definitionPath), { recursive: true });
  fs.writeFileSync(spec.definitionPath, spec.content, 'utf8');

  if (spec.manager === 'systemd-user') {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', `${spec.serviceName}.service`], { stdio: 'inherit' });
  } else if (spec.manager === 'launchd') {
    try { execFileSync('launchctl', ['unload', spec.definitionPath], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['load', '-w', spec.definitionPath], { stdio: 'inherit' });
  } else if (spec.manager === 'schtasks') {
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', spec.serviceName, '/TR', `cmd.exe /c "${spec.definitionPath}"`], {
      stdio: 'inherit'
    });
  }

  return { installed: true, dryRun: false, spec };
}

export function uninstallService(options: ServiceOptions = {}) {
  const spec = getServiceSpec(options);

  if (spec.manager === 'systemd-user') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', `${spec.serviceName}.service`], { stdio: 'ignore' }); } catch {}
    if (fs.existsSync(spec.definitionPath)) fs.unlinkSync(spec.definitionPath);
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
  } else if (spec.manager === 'launchd') {
    try { execFileSync('launchctl', ['unload', spec.definitionPath], { stdio: 'ignore' }); } catch {}
    if (fs.existsSync(spec.definitionPath)) fs.unlinkSync(spec.definitionPath);
  } else if (spec.manager === 'schtasks') {
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', spec.serviceName], { stdio: 'ignore' }); } catch {}
    if (fs.existsSync(spec.definitionPath)) fs.unlinkSync(spec.definitionPath);
  }

  return { uninstalled: true, spec };
}

export function getServiceStatus(options: ServiceOptions = {}) {
  const spec = getServiceSpec(options);
  const installed = fs.existsSync(spec.definitionPath);
  let active = false;
  let rawStatus = '';

  try {
    if (spec.manager === 'systemd-user') {
      rawStatus = execFileSync('systemctl', ['--user', 'is-active', `${spec.serviceName}.service`], {
        encoding: 'utf8'
      }).trim();
      active = rawStatus === 'active';
    } else if (spec.manager === 'launchd') {
      rawStatus = execFileSync('launchctl', ['list', spec.serviceName], { encoding: 'utf8' }).trim();
      active = Boolean(rawStatus);
    } else if (spec.manager === 'schtasks') {
      rawStatus = execFileSync('schtasks', ['/Query', '/TN', spec.serviceName, '/FO', 'LIST'], {
        encoding: 'utf8'
      }).trim();
      active = /Running/i.test(rawStatus);
    }
  } catch {
    active = false;
  }

  return {
    installed,
    active,
    manager: spec.manager,
    serviceName: spec.serviceName,
    definitionPath: spec.definitionPath,
    rawStatus
  };
}
