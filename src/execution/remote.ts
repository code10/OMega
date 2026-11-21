import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type {
  ExecutionBackend,
  ExecutionBackendConfig,
  ExecutionDirEntry,
  ExecutionExecOptions,
  ExecutionFileStat,
  ExecutionInteractiveOptions,
  ExecutionProcessResult,
  ExecutionSpawnOptions
} from '../types.js';
import { defaultLocalExecutionBackend } from './backend.js';

function shellQuote(arg: string): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

/**
 * Shared base for remote POSIX-shell-over-transport ExecutionBackends (Docker, SSH).
 */
export abstract class RemoteShellExecutionBackend implements ExecutionBackend {
  abstract readonly name: string;
  protected readonly localWorkspaceDir?: string;
  protected readonly remoteWorkdir?: string;

  constructor(localWorkspaceDir?: string, remoteWorkdir?: string) {
    this.localWorkspaceDir = localWorkspaceDir ? path.resolve(localWorkspaceDir) : undefined;
    this.remoteWorkdir = remoteWorkdir;
  }

  protected abstract buildTransportArgs(remoteCommand: string): { binary: string; args: string[] };

  protected mapPath(targetPath: string): string {
    if (this.localWorkspaceDir && this.remoteWorkdir) {
      const resolved = path.resolve(targetPath);
      const rel = path.relative(this.localWorkspaceDir, resolved);
      if (rel === '') return this.remoteWorkdir;
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return path.posix.join(this.remoteWorkdir, rel.split(path.sep).join('/'));
      }
    }
    return targetPath.replace(/\\/g, '/');
  }

  protected runRemoteSync(remoteCommand: string): string {
    const { binary, args } = this.buildTransportArgs(remoteCommand);
    return execFileSync(binary, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  protected runRemoteAsync(
    remoteCommand: string,
    timeoutMs: number,
    input?: string
  ): Promise<ExecutionProcessResult> {
    const { binary, args } = this.buildTransportArgs(remoteCommand);
    return new Promise((resolve) => {
      const child = execFile(
        binary,
        args,
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            timedOut: Boolean(error?.killed),
            errorMessage: error ? error.message : undefined
          });
        }
      );
      if (input !== undefined && child.stdin) {
        child.stdin.write(input);
        child.stdin.end();
      }
    });
  }

  exists(targetPath: string): boolean {
    const rp = shellQuote(this.mapPath(targetPath));
    try {
      this.runRemoteSync(`test -e ${rp}`);
      return true;
    } catch (_) {
      return false;
    }
  }

  stat(targetPath: string): ExecutionFileStat {
    const rp = shellQuote(this.mapPath(targetPath));
    const out = this.runRemoteSync(
      `node -e "const s=require('fs').statSync(${JSON.stringify(this.mapPath(targetPath))});console.log(JSON.stringify({isFile:s.isFile(),isDirectory:s.isDirectory(),size:s.size,mtimeMs:s.mtimeMs}))" 2>/dev/null || stat -c '%F|%s|%Y' ${rp}`
    ).trim();
    if (out.startsWith('{')) {
      return JSON.parse(out) as ExecutionFileStat;
    }
    const [kind, sizeStr, mtimeSec] = out.split('|');
    return {
      isFile: kind?.includes('regular') ?? false,
      isDirectory: kind?.includes('directory') ?? false,
      size: Number(sizeStr) || 0,
      mtimeMs: (Number(mtimeSec) || 0) * 1000
    };
  }

  realpath(targetPath: string): string {
    const rp = shellQuote(this.mapPath(targetPath));
    return this.runRemoteSync(`realpath ${rp} 2>/dev/null || readlink -f ${rp}`).trim();
  }

  readFile(targetPath: string, encoding: BufferEncoding = 'utf8'): string {
    const rp = shellQuote(this.mapPath(targetPath));
    const b64 = this.runRemoteSync(`base64 < ${rp}`).replace(/\s+/g, '');
    return Buffer.from(b64, 'base64').toString(encoding);
  }

  async writeFile(targetPath: string, content: string, encoding: BufferEncoding = 'utf8'): Promise<void> {
    const rp = shellQuote(this.mapPath(targetPath));
    const b64 = Buffer.from(content, encoding).toString('base64');
    const res = await this.runRemoteAsync(`base64 -d > ${rp}`, 30000, b64);
    if (res.exitCode !== 0) {
      throw new Error(res.stderr || res.errorMessage || `Failed to write remote file ${targetPath}`);
    }
  }

  mkdir(targetPath: string, options?: { recursive?: boolean }): void {
    const rp = shellQuote(this.mapPath(targetPath));
    const flag = options?.recursive ? '-p ' : '';
    this.runRemoteSync(`mkdir ${flag}${rp}`);
  }

  readdir(targetPath: string): ExecutionDirEntry[] {
    const rp = shellQuote(this.mapPath(targetPath));
    const out = this.runRemoteSync(
      `for f in ${rp}/* ${rp}/.[!.]* ${rp}/..?*; do [ -e "$f" ] || continue; if [ -d "$f" ]; then printf 'd\\t%s\\n' "$(basename "$f")"; else printf 'f\\t%s\\n' "$(basename "$f")"; fi; done`
    );
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [kind, name] = line.split('\t');
        return {
          name,
          isDirectory: kind === 'd',
          isFile: kind === 'f'
        };
      });
  }

  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): void {
    const rp = shellQuote(this.mapPath(targetPath));
    const flags = `${options?.recursive ? 'r' : ''}${options?.force ? 'f' : ''}`;
    this.runRemoteSync(`rm ${flags ? `-${flags} ` : ''}${rp}`);
  }

  copyFile(srcPath: string, destPath: string): void {
    this.runRemoteSync(`cp ${shellQuote(this.mapPath(srcPath))} ${shellQuote(this.mapPath(destPath))}`);
  }

  symlink(targetPath: string, linkPath: string): void {
    this.runRemoteSync(`ln -s ${shellQuote(this.mapPath(targetPath))} ${shellQuote(this.mapPath(linkPath))}`);
  }

  isSymlink(targetPath: string): boolean {
    try {
      this.runRemoteSync(`test -L ${shellQuote(this.mapPath(targetPath))}`);
      return true;
    } catch (_) {
      return false;
    }
  }

  unlink(targetPath: string): void {
    this.runRemoteSync(`rm -f ${shellQuote(this.mapPath(targetPath))}`);
  }

  execSync(executable: string, args: string[], options: { cwd: string }): string {
    const cwd = shellQuote(this.mapPath(options.cwd));
    const cmd = [executable, ...args].map(shellQuote).join(' ');
    return this.runRemoteSync(`cd ${cwd} && ${cmd}`).trim();
  }

  async exec(command: string, options: ExecutionExecOptions): Promise<ExecutionProcessResult> {
    const cwd = shellQuote(this.mapPath(options.cwd));
    return this.runRemoteAsync(`cd ${cwd} && ${command}`, options.timeoutMs);
  }

  async spawn(executable: string, args: string[], options: ExecutionSpawnOptions): Promise<ExecutionProcessResult> {
    const cwd = shellQuote(this.mapPath(options.cwd));
    const cmd = [executable, ...args].map(shellQuote).join(' ');
    const res = await this.runRemoteAsync(`cd ${cwd} && ${cmd}`, options.timeoutMs);
    return { ...res, sandboxBackend: this.name };
  }

  spawnInteractive(
    executable: string,
    args: string[],
    options: ExecutionInteractiveOptions
  ): ChildProcessWithoutNullStreams {
    const cwd = shellQuote(this.mapPath(options.cwd));
    const cmd = [executable, ...args].map(shellQuote).join(' ');
    const { binary, args: transportArgs } = this.buildTransportArgs(`cd ${cwd} && ${cmd}`);
    return spawn(binary, transportArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }
}

/**
 * Built-in Docker/Podman container ExecutionBackend (`docker exec`).
 */
export class DockerExecutionBackend extends RemoteShellExecutionBackend {
  readonly name = 'docker';
  readonly container: string;
  readonly dockerBinary: string;

  constructor(options: {
    container: string;
    workdir?: string;
    localWorkspaceDir?: string;
    dockerBinary?: string;
  }) {
    super(options.localWorkspaceDir, options.workdir);
    if (!options.container) {
      throw new Error('DockerExecutionBackend requires a container name or ID.');
    }
    this.container = options.container;
    this.dockerBinary = options.dockerBinary || 'docker';
  }

  protected buildTransportArgs(remoteCommand: string): { binary: string; args: string[] } {
    return {
      binary: this.dockerBinary,
      args: ['exec', '-i', this.container, 'sh', '-c', remoteCommand]
    };
  }
}

/**
 * Built-in SSH remote ExecutionBackend (`ssh`).
 */
export class SSHExecutionBackend extends RemoteShellExecutionBackend {
  readonly name = 'ssh';
  readonly host: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly sshBinary: string;

  constructor(options: {
    host: string;
    port?: number;
    identityFile?: string;
    workdir?: string;
    localWorkspaceDir?: string;
    sshBinary?: string;
  }) {
    super(options.localWorkspaceDir, options.workdir);
    if (!options.host) {
      throw new Error('SSHExecutionBackend requires a host (e.g. user@host).');
    }
    this.host = options.host;
    this.port = options.port;
    this.identityFile = options.identityFile;
    this.sshBinary = options.sshBinary || 'ssh';
  }

  protected buildTransportArgs(remoteCommand: string): { binary: string; args: string[] } {
    const args: string[] = ['-o', 'BatchMode=yes'];
    if (this.port) args.push('-p', String(this.port));
    if (this.identityFile) args.push('-i', this.identityFile);
    args.push(this.host, remoteCommand);
    return { binary: this.sshBinary, args };
  }
}

/**
 * Factory to create an ExecutionBackend from OMConfig.execution.
 */
export function createExecutionBackend(
  config?: ExecutionBackendConfig,
  localWorkspaceDir?: string
): ExecutionBackend {
  if (!config || !config.type || config.type === 'local') {
    return defaultLocalExecutionBackend;
  }
  if (config.type === 'docker') {
    return new DockerExecutionBackend({
      container: config.container || '',
      workdir: config.workdir,
      localWorkspaceDir: config.localWorkspaceDir || localWorkspaceDir,
      dockerBinary: config.dockerBinary
    });
  }
  if (config.type === 'ssh') {
    return new SSHExecutionBackend({
      host: config.host || '',
      port: config.port,
      identityFile: config.identityFile,
      workdir: config.workdir,
      localWorkspaceDir: config.localWorkspaceDir || localWorkspaceDir,
      sshBinary: config.sshBinary
    });
  }
  throw new Error(`Unknown execution backend type: '${String(config.type)}'`);
}
