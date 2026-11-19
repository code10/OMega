import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';

export type SandboxMode = 'off' | 'auto' | 'os' | 'container';
export type SandboxBackend = 'none' | 'bwrap' | 'wsl-bwrap' | 'win-job' | 'sandbox-exec' | 'docker' | 'podman';

export interface SandboxConfig {
  mode?: SandboxMode;
  strict?: boolean;
  allowNetwork?: boolean;
  containerImage?: string;
  maxOutputBytes?: number;
  memoryMb?: number;
  cpus?: number;
  maxProcesses?: number;
}

export interface SandboxedInvocation {
  backend: SandboxBackend;
  executable: string;
  args: string[];
  cleanup: () => void;
}

export type BinaryProbe = (bin: string) => boolean;

const probeCache = new Map<string, boolean>();

function defaultBinaryProbe(bin: string): boolean {
  if (probeCache.has(bin)) return probeCache.get(bin)!;
  let ok = false;
  try {
    if (bin === 'wsl-bwrap') {
      execFileSync('wsl.exe', ['--exec', 'which', 'bwrap'], { stdio: 'ignore', timeout: 2000 });
      ok = true;
    } else if (path.isAbsolute(bin)) {
      ok = fs.existsSync(bin);
    } else {
      const locator = process.platform === 'win32' ? 'where' : 'which';
      execFileSync(locator, [bin], { stdio: 'ignore', timeout: 1500 });
      ok = true;
    }
  } catch {
    ok = false;
  }
  probeCache.set(bin, ok);
  return ok;
}

export function toWslPath(winPath: string): string {
  const normalized = path.resolve(winPath).replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/**
 * Detect the best available OS or container sandbox backend for the requested mode.
 */
export function detectSandboxBackend(
  mode: SandboxMode = 'auto',
  platform: NodeJS.Platform = process.platform,
  probe: BinaryProbe = defaultBinaryProbe
): SandboxBackend {
  if (mode === 'off') return 'none';

  if (mode === 'auto' || mode === 'os') {
    if (platform === 'linux' && probe('bwrap')) {
      return 'bwrap';
    }
    if (platform === 'darwin' && (probe('/usr/bin/sandbox-exec') || probe('sandbox-exec'))) {
      return 'sandbox-exec';
    }
    if (platform === 'win32') {
      if (mode === 'os' && probe('wsl-bwrap')) {
        return 'wsl-bwrap';
      }
      if (probe('powershell.exe') || probe('powershell')) {
        return 'win-job';
      }
    }
    if (mode === 'os') return 'none';
  }

  if (mode === 'container') {
    if (probe('docker')) return 'docker';
    if (probe('podman')) return 'podman';
  }

  return 'none';
}

const WIN_JOB_HELPER_PATH = path.join(os.tmpdir(), 'om-winjob-v1.exe');

function getOrBuildWinJobHelper(): string | null {
  if (fs.existsSync(WIN_JOB_HELPER_PATH)) return WIN_JOB_HELPER_PATH;
  const csharp = [
    'using System;',
    'using System.Diagnostics;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class OmWinJobRunner {',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);',
    '  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);',
    '  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);',
    '  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);',
    '  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {',
    '    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;',
    '    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;',
    '    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;',
    '  }',
    '  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {',
    '    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;',
    '    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;',
    '  }',
    '  static string QuoteArg(string a) {',
    '    if (string.IsNullOrEmpty(a)) return "\\"\\"";',
    '    if (a.IndexOfAny(new char[] { \' \', \'\\t\', \'\\"\' }) < 0) return a;',
    '    return "\\"" + a.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"") + "\\"";',
    '  }',
    '  public static int Main(string[] args) {',
    '    if (args.Length < 3) return 2;',
    '    ulong memMb = ulong.Parse(args[0]);',
    '    uint maxProcs = uint.Parse(args[1]);',
    '    IntPtr job = CreateJobObject(IntPtr.Zero, null);',
    '    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();',
    '    info.BasicLimitInformation.LimitFlags = 0x2000 | 0x0100 | 0x0008;',
    '    info.BasicLimitInformation.ActiveProcessLimit = maxProcs;',
    '    info.ProcessMemoryLimit = (UIntPtr)(memMb * 1024UL * 1024UL);',
    '    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));',
    '    IntPtr ptr = Marshal.AllocHGlobal(size);',
    '    try { Marshal.StructureToPtr(info, ptr, false); SetInformationJobObject(job, 9, ptr, (uint)size); } finally { Marshal.FreeHGlobal(ptr); }',
    '    var psi = new ProcessStartInfo();',
    '    psi.FileName = args[2];',
    '    psi.UseShellExecute = false;',
    '    if (args.Length > 3) {',
    '      var sb = new StringBuilder();',
    '      for (int i = 3; i < args.Length; i++) { if (i > 3) sb.Append(" "); sb.Append(QuoteArg(args[i])); }',
    '      psi.Arguments = sb.ToString();',
    '    }',
    '    var proc = Process.Start(psi);',
    '    AssignProcessToJobObject(job, proc.Handle);',
    '    proc.WaitForExit();',
    '    int code = proc.ExitCode;',
    '    CloseHandle(job);',
    '    return code;',
    '  }',
    '}'
  ].join('\n');

  const tmpOut = `${WIN_JOB_HELPER_PATH}.${process.pid}.tmp.exe`;
  const b64 = Buffer.from(csharp, 'utf8').toString('base64');
  const buildCmd = `$src=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')); Add-Type -OutputAssembly '${tmpOut.replace(/'/g, "''")}' -OutputType ConsoleApplication -TypeDefinition $src`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildCmd], {
      stdio: 'ignore',
      timeout: 15000
    });
    if (fs.existsSync(tmpOut)) {
      try {
        fs.renameSync(tmpOut, WIN_JOB_HELPER_PATH);
      } catch {
        if (!fs.existsSync(WIN_JOB_HELPER_PATH)) return tmpOut;
      }
      return WIN_JOB_HELPER_PATH;
    }
  } catch {
    try {
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Wrap a command invocation in the selected OS or container sandbox.
 * Throws if `strict` is true and no isolation backend is available.
 */
export function buildSandboxedCommand(
  executable: string,
  args: string[],
  workingDir: string,
  config: SandboxConfig = {},
  options: { platform?: NodeJS.Platform; probe?: BinaryProbe } = {}
): SandboxedInvocation {
  const mode: SandboxMode = config.mode || 'auto';
  const platform = options.platform || process.platform;
  const probe = options.probe || defaultBinaryProbe;
  const allowNetwork = Boolean(config.allowNetwork);
  const backend = detectSandboxBackend(mode, platform, probe);

  if (backend === 'none') {
    if (config.strict && mode !== 'off') {
      throw new Error(
        `Sandbox strict mode is enabled (mode=${mode}), but no OS or container sandbox backend is available on ${platform}.`
      );
    }
    return { backend: 'none', executable, args, cleanup: () => {} };
  }

  if (backend === 'bwrap' || backend === 'wsl-bwrap') {
    const targetDir = backend === 'wsl-bwrap' ? toWslPath(workingDir) : workingDir;
    const bwrapArgs: string[] = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc', '/etc',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--bind', targetDir, targetDir,
      '--chdir', targetDir,
      '--unshare-pid',
      '--unshare-ipc',
      '--die-with-parent',
      '--new-session'
    ];
    if (!allowNetwork) {
      bwrapArgs.push('--unshare-net');
    }
    bwrapArgs.push('--', executable, ...args);
    if (backend === 'wsl-bwrap') {
      return { backend: 'wsl-bwrap', executable: 'wsl.exe', args: ['--exec', 'bwrap', ...bwrapArgs], cleanup: () => {} };
    }
    return { backend: 'bwrap', executable: 'bwrap', args: bwrapArgs, cleanup: () => {} };
  }

  if (backend === 'win-job') {
    const memoryMb = Math.max(64, Number(config.memoryMb) || 512);
    const maxProcs = Math.max(1, Number(config.maxProcesses) || 16);
    if (!options.probe) {
      const helperExe = getOrBuildWinJobHelper();
      if (helperExe) {
        return {
          backend: 'win-job',
          executable: helperExe,
          args: [String(memoryMb), String(maxProcs), executable, ...args],
          cleanup: () => {}
        };
      }
    }
    const payloadB64 = Buffer.from(JSON.stringify({ exe: executable, args }), 'utf8').toString('base64');
    const scriptPath = path.join(os.tmpdir(), `om-winjob-${process.pid}-${Date.now()}.ps1`);
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      `$spec = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${payloadB64}")) | ConvertFrom-Json`,
      '$src = @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class OmWinJob {',
      '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);',
      '  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);',
      '  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);',
      '  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);',
      '  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {',
      '    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;',
      '    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;',
      '    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;',
      '  }',
      '  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }',
      '  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {',
      '    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;',
      '    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;',
      '  }',
      '  public static IntPtr CreateLimitedJob(ulong memBytes, uint maxProcs) {',
      '    IntPtr job = CreateJobObject(IntPtr.Zero, null);',
      '    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();',
      '    info.BasicLimitInformation.LimitFlags = 0x2000 | 0x0100 | 0x0008;', // KILL_ON_JOB_CLOSE | PROCESS_MEMORY | ACTIVE_PROCESS
      '    info.BasicLimitInformation.ActiveProcessLimit = maxProcs;',
      '    info.ProcessMemoryLimit = (UIntPtr)memBytes;',
      '    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));',
      '    IntPtr ptr = Marshal.AllocHGlobal(size);',
      '    try { Marshal.StructureToPtr(info, ptr, false); SetInformationJobObject(job, 9, ptr, (uint)size); } finally { Marshal.FreeHGlobal(ptr); }',
      '    return job;',
      '  }',
      '}',
      '"@',
      'Add-Type -TypeDefinition $src',
      `$job = [OmWinJob]::CreateLimitedJob([uint64](${memoryMb} * 1024 * 1024), [uint32]${maxProcs})`,
      '$psi = New-Object System.Diagnostics.ProcessStartInfo',
      '$psi.FileName = $spec.exe',
      '$psi.UseShellExecute = $false',
      'if ($spec.args) {',
      '  $escaped = @()',
      '  foreach ($a in $spec.args) { $s = [string]$a; if ($s -match "[\\s`"]") { $escaped += "`"" + ($s -replace "`"", "\\`"") + "`"" } else { $escaped += $s } }',
      '  $psi.Arguments = ($escaped -join " ")',
      '}',
      '$proc = [System.Diagnostics.Process]::Start($psi)',
      '[void][OmWinJob]::AssignProcessToJobObject($job, $proc.Handle)',
      '$proc.WaitForExit()',
      '$code = $proc.ExitCode',
      '[void][OmWinJob]::CloseHandle($job)',
      'exit $code'
    ].join('\n');
    fs.writeFileSync(scriptPath, psScript, 'utf8');
    return {
      backend: 'win-job',
      executable: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      cleanup: () => {
        try {
          if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
        } catch {
          // ignore
        }
      }
    };
  }

  if (backend === 'sandbox-exec') {
    const escapedDir = workingDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const profileLines = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec process-fork)',
      '(allow sysctl-read)',
      '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/Library") (subpath "/private/var") (subpath "/dev"))',
      `(allow file-read* file-write* (subpath "${escapedDir}") (subpath "/tmp") (subpath "/private/tmp"))`,
      allowNetwork ? '(allow network*)' : '(deny network-outbound)'
    ];
    const profilePath = path.join(os.tmpdir(), `om-sandbox-${process.pid}-${Date.now()}.sb`);
    fs.writeFileSync(profilePath, profileLines.join('\n'), 'utf8');
    return {
      backend: 'sandbox-exec',
      executable: '/usr/bin/sandbox-exec',
      args: ['-f', profilePath, executable, ...args],
      cleanup: () => {
        try {
          if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
        } catch {
          // ignore cleanup failure
        }
      }
    };
  }

  // docker or podman
  const image = config.containerImage || 'node:22-alpine';
  const memoryMb = Math.max(64, Number(config.memoryMb) || 512);
  const cpus = Math.max(0.25, Number(config.cpus) || 1);
  const containerArgs: string[] = [
    'run',
    '--rm',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid',
    `--memory=${memoryMb}m`,
    `--cpus=${cpus}`,
    ...(allowNetwork ? [] : ['--network=none']),
    '-v', `${workingDir}:/workspace`,
    '-w', '/workspace',
    image,
    executable,
    ...args
  ];
  return { backend, executable: backend, args: containerArgs, cleanup: () => {} };
}

function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

export interface SpawnSandboxedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  errorMessage?: string;
}

/**
 * Spawn a command with process-tree timeout termination and output byte caps.
 */
export function spawnSandboxed(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    maxOutputBytes?: number;
    cleanup?: () => void;
  }
): Promise<SpawnSandboxedResult> {
  const maxBytes = Math.max(4096, Number(options.maxOutputBytes) || 1048576);
  const cleanup = options.cleanup || (() => {});

  return new Promise((resolve) => {
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;

    const finish = (result: SpawnSandboxedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    let child;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (spawnErr: any) {
      finish({
        exitCode: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
        outputTruncated: false,
        errorMessage: spawnErr?.message || String(spawnErr)
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, options.timeoutMs);

    const appendChunk = (target: Buffer[], chunk: Buffer) => {
      if (totalBytes >= maxBytes) {
        outputTruncated = true;
        killProcessTree(child.pid);
        return;
      }
      const remaining = maxBytes - totalBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(slice);
      totalBytes += slice.length;
      if (chunk.length > remaining) {
        outputTruncated = true;
        killProcessTree(child.pid);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderrChunks, chunk));

    child.on('error', (err: any) => {
      finish({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        outputTruncated,
        errorMessage: err?.message || String(err)
      });
    });

    child.on('close', (code) => {
      finish({
        exitCode: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        outputTruncated
      });
    });
  });
}
