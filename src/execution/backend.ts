import { exec, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { buildSandboxedCommand, spawnSandboxed } from '../skills/sandbox.js';
import type {
  ExecutionBackend,
  ExecutionDirEntry,
  ExecutionExecOptions,
  ExecutionFileStat,
  ExecutionInteractiveOptions,
  ExecutionProcessResult,
  ExecutionSpawnOptions,
  SkillContext
} from '../types.js';

/**
 * Default local ExecutionBackend backed by node:fs, node:child_process, and OMega's sandbox layer.
 */
export class LocalExecutionBackend implements ExecutionBackend {
  readonly name = 'local';

  exists(targetPath: string): boolean {
    return fs.existsSync(targetPath);
  }

  stat(targetPath: string): ExecutionFileStat {
    const s = fs.statSync(targetPath);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtimeMs: s.mtimeMs
    };
  }

  realpath(targetPath: string): string {
    return fs.realpathSync(targetPath);
  }

  readFile(targetPath: string, encoding: BufferEncoding = 'utf8'): string {
    return fs.readFileSync(targetPath, encoding);
  }

  writeFile(targetPath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
    fs.writeFileSync(targetPath, content, encoding);
  }

  mkdir(targetPath: string, options?: { recursive?: boolean }): void {
    fs.mkdirSync(targetPath, options);
  }

  readdir(targetPath: string): ExecutionDirEntry[] {
    return fs.readdirSync(targetPath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory()
    }));
  }

  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): void {
    fs.rmSync(targetPath, options);
  }

  copyFile(srcPath: string, destPath: string): void {
    fs.copyFileSync(srcPath, destPath);
  }

  symlink(targetPath: string, linkPath: string, type: 'dir' | 'file' | 'junction' = 'dir'): void {
    fs.symlinkSync(targetPath, linkPath, type);
  }

  isSymlink(targetPath: string): boolean {
    try {
      return fs.lstatSync(targetPath).isSymbolicLink();
    } catch (_) {
      return false;
    }
  }

  unlink(targetPath: string): void {
    if (process.platform === 'win32') {
      try {
        fs.rmdirSync(targetPath);
        return;
      } catch (_) {}
    }
    fs.unlinkSync(targetPath);
  }

  execSync(executable: string, args: string[], options: { cwd: string }): string {
    return execFileSync(executable, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  }

  exec(command: string, options: ExecutionExecOptions): Promise<ExecutionProcessResult> {
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          shell: options.shell,
          env: options.env,
          maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            timedOut: Boolean(error?.killed),
            errorMessage: error ? error.message : undefined
          });
        }
      );
    });
  }

  async spawn(executable: string, args: string[], options: ExecutionSpawnOptions): Promise<ExecutionProcessResult> {
    const sandboxPrefix = Array.isArray(options.sandboxCommand) && options.sandboxCommand.length > 0
      ? options.sandboxCommand.map((part) => String(part).replaceAll('${cwd}', options.cwd))
      : null;

    let invocation: {
      backend: string;
      executable: string;
      args: string[];
      cleanup: () => void;
    };

    if (sandboxPrefix) {
      invocation = {
        backend: 'custom',
        executable: sandboxPrefix[0],
        args: [...sandboxPrefix.slice(1), executable, ...args],
        cleanup: () => {}
      };
    } else {
      invocation = buildSandboxedCommand(executable, args, options.cwd, options.sandbox || {});
    }

    const res = await spawnSandboxed(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      cleanup: invocation.cleanup
    });

    return {
      ...res,
      sandboxBackend: invocation.backend
    };
  }

  spawnInteractive(
    executable: string,
    args: string[],
    options: ExecutionInteractiveOptions
  ): ChildProcessWithoutNullStreams {
    return spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: Boolean(options.shell),
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }
}

export const defaultLocalExecutionBackend = new LocalExecutionBackend();

/**
 * Resolve the active ExecutionBackend from SkillContext, falling back to LocalExecutionBackend.
 */
export function getExecutionBackend(context?: SkillContext): ExecutionBackend {
  return context?.execution ?? defaultLocalExecutionBackend;
}
