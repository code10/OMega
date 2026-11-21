import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { getExecutionBackend } from '../execution/backend.js';
import { buildSafeChildEnv, redactSecrets } from '../utils/redact.js';
import type { SkillContext, SkillDefinition } from '../types.js';
import { resolveSafePath } from './filesystem.js';
import { validateShellCommandPolicy } from './shell.js';

const MAX_OUTPUT_BUFFER_CHARS = 200_000;

interface TerminalSession {
  id: string;
  label?: string;
  command: string;
  cwd: string;
  proc: ChildProcessWithoutNullStreams;
  startedAt: number;
  alive: boolean;
  exitCode: number | null;
  buffer: string;
  readCursor: number;
}

export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>();
  private counter = 0;

  async start(
    options: { command?: string; cwd?: string; label?: string; waitMs?: number },
    context: SkillContext = {}
  ) {
    const security = context.config?.security || {};
    const commandText = (options.command || '').trim();
    const defaultShell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';

    // Security check 1: Enforce same command policy (deniedCommands + allowedCommands + git flags) as exec_command
    const policy = validateShellCommandPolicy(commandText || defaultShell, security);
    if (!policy.allowed) {
      return { success: false, error: policy.error };
    }

    // Security check 2: Require confirmation if configured
    if (security.requireConfirmationForShell) {
      const confirmFn = context.confirmCommand || context.agent?.confirmCommand;
      if (typeof confirmFn !== 'function') {
        return {
          success: false,
          confirmationRequired: true,
          error: 'Interactive terminal requires human confirmation (security.requireConfirmationForShell is enabled, but no confirmation handler is attached).'
        };
      }
      const approved = await confirmFn({
        tool: 'terminal_start',
        command: commandText || defaultShell,
        cwd: options.cwd
      });
      if (!approved) {
        return {
          success: false,
          confirmationRequired: true,
          error: 'Interactive terminal start was denied by user confirmation.'
        };
      }
    }

    const baseWorkspace = context.config?.workspaceDir || process.cwd();
    let workingDir: string;
    try {
      workingDir = resolveSafePath(options.cwd || '.', baseWorkspace, context);
    } catch (err: any) {
      return { success: false, error: err.message };
    }

    const backend = getExecutionBackend(context);
    if (!(await backend.exists(workingDir))) {
      await backend.mkdir(workingDir, { recursive: true });
    }

    const allowedEnvVars = Array.isArray(security.allowedEnvVars) ? security.allowedEnvVars : [];
    const childEnv = buildSafeChildEnv(process.env, {}, Boolean(security.inheritSensitiveEnv), allowedEnvVars);

    const shellArgs = os.platform() === 'win32'
      ? (commandText ? ['-NoLogo', '-NoExit', '-Command', commandText] : ['-NoLogo', '-NoExit'])
      : (commandText ? ['-lc', `${commandText}; exec ${defaultShell}`] : ['-l']);

    const proc = backend.spawnInteractive
      ? backend.spawnInteractive(defaultShell, shellArgs, { cwd: workingDir, env: childEnv })
      : spawn(defaultShell, shellArgs, { cwd: workingDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    proc.unref?.();
    (proc.stdin as any)?.unref?.();
    (proc.stdout as any)?.unref?.();
    (proc.stderr as any)?.unref?.();

    const id = `term_${++this.counter}_${Date.now().toString(36)}`;
    const session: TerminalSession = {
      id,
      label: options.label,
      command: commandText || defaultShell,
      cwd: workingDir,
      proc,
      startedAt: Date.now(),
      alive: true,
      exitCode: null,
      buffer: '',
      readCursor: 0
    };

    const appendChunk = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      session.buffer += text;
      if (session.buffer.length > MAX_OUTPUT_BUFFER_CHARS) {
        const overflow = session.buffer.length - MAX_OUTPUT_BUFFER_CHARS;
        session.buffer = session.buffer.slice(overflow);
        session.readCursor = Math.max(0, session.readCursor - overflow);
      }
    };

    proc.stdout.on('data', appendChunk);
    proc.stderr.on('data', appendChunk);
    proc.on('exit', (code) => {
      session.alive = false;
      session.exitCode = code ?? 0;
    });
    proc.on('error', (err) => {
      appendChunk(`\n[terminal error: ${err.message}]\n`);
      session.alive = false;
    });

    this.sessions.set(id, session);

    const waitMs = Math.min(Math.max(0, Number(options.waitMs ?? 200)), 5000);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const initialOutput = redactSecrets(session.buffer.slice(session.readCursor));
    session.readCursor = session.buffer.length;

    return {
      success: true,
      sessionId: id,
      pid: proc.pid,
      cwd: workingDir,
      alive: session.alive,
      output: initialOutput
    };
  }

  async write(options: { sessionId: string; input?: string; appendNewline?: boolean; interrupt?: boolean; waitMs?: number }) {
    const session = this.sessions.get(options.sessionId);
    if (!session) {
      return { success: false, error: `Terminal session '${options.sessionId}' not found.` };
    }
    if (!session.alive) {
      return { success: false, error: `Terminal session '${options.sessionId}' has already exited (code ${session.exitCode}).` };
    }

    if (options.interrupt) {
      session.proc.stdin.write('\x03');
    } else if (typeof options.input === 'string') {
      const payload = options.appendNewline !== false ? `${options.input}\n` : options.input;
      session.proc.stdin.write(payload);
    } else {
      return { success: false, error: 'Either input or interrupt=true is required.' };
    }

    const waitMs = Math.min(Math.max(0, Number(options.waitMs ?? 250)), 5000);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const newOutput = redactSecrets(session.buffer.slice(session.readCursor));
    session.readCursor = session.buffer.length;

    return {
      success: true,
      sessionId: session.id,
      alive: session.alive,
      exitCode: session.exitCode,
      output: newOutput
    };
  }

  read(options: { sessionId: string; tailLines?: number; unreadOnly?: boolean }) {
    const session = this.sessions.get(options.sessionId);
    if (!session) {
      return { success: false, error: `Terminal session '${options.sessionId}' not found.` };
    }

    let raw: string;
    if (options.unreadOnly) {
      raw = session.buffer.slice(session.readCursor);
      session.readCursor = session.buffer.length;
    } else {
      const lines = session.buffer.split(/\r?\n/);
      const tail = Math.max(1, Number(options.tailLines ?? 100));
      raw = lines.slice(-tail).join('\n');
      session.readCursor = session.buffer.length;
    }

    return {
      success: true,
      sessionId: session.id,
      alive: session.alive,
      exitCode: session.exitCode,
      output: redactSecrets(raw)
    };
  }

  list() {
    const now = Date.now();
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.id,
      label: s.label,
      command: s.command,
      pid: s.proc.pid,
      cwd: path.resolve(s.cwd),
      alive: s.alive,
      exitCode: s.exitCode,
      uptimeMs: now - s.startedAt
    }));
    return {
      success: true,
      count: sessions.length,
      sessions
    };
  }

  close(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: `Terminal session '${sessionId}' not found.` };
    }
    if (session.alive) {
      try {
        session.proc.stdin?.destroy();
        session.proc.stdout?.destroy();
        session.proc.stderr?.destroy();
      } catch (_) {}
      if (os.platform() === 'win32' && session.proc.pid) {
        try {
          const tk = execFile('taskkill', ['/pid', String(session.proc.pid), '/T', '/F'], () => {});
          tk.unref?.();
        } catch (_) {}
      } else {
        try {
          session.proc.kill('SIGTERM');
        } catch (_) {}
        setTimeout(() => {
          if (session.alive) {
            try {
              session.proc.kill('SIGKILL');
            } catch (_) {}
          }
        }, 1000).unref?.();
      }
      session.alive = false;
    }
    this.sessions.delete(sessionId);
    return {
      success: true,
      sessionId,
      message: 'Terminal session closed.'
    };
  }

  closeAll() {
    for (const id of Array.from(this.sessions.keys())) {
      this.close(id);
    }
  }
}

export const defaultTerminalManager = new TerminalSessionManager();

export const terminalSkills: SkillDefinition<any>[] = [
  {
    name: 'terminal_start',
    description: 'Start a persistent interactive terminal session (e.g. for dev servers, REPLs, watchers, or multi-step shell workflows).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Optional initial command to run in the interactive session' },
        cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' },
        label: { type: 'string', description: 'Optional human-readable label for the session' },
        waitMs: { type: 'number', description: 'Optional milliseconds to wait for initial output (default: 200)' }
      }
    },
    execute: async (args: { command?: string; cwd?: string; label?: string; waitMs?: number }, context: SkillContext = {}) => {
      return defaultTerminalManager.start(args, context);
    }
  },
  {
    name: 'terminal_write',
    description: 'Send input (or Ctrl-C interrupt) to an active persistent terminal session and return new output.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal sessionId returned by terminal_start' },
        input: { type: 'string', description: 'Text/command to send to stdin' },
        appendNewline: { type: 'boolean', description: 'Append newline after input (default: true)' },
        interrupt: { type: 'boolean', description: 'Send Ctrl-C (SIGINT) instead of text input' },
        waitMs: { type: 'number', description: 'Milliseconds to wait for output after writing (default: 250)' }
      },
      required: ['sessionId']
    },
    execute: async (args: { sessionId: string; input?: string; appendNewline?: boolean; interrupt?: boolean; waitMs?: number }) => {
      return defaultTerminalManager.write(args);
    }
  },
  {
    name: 'terminal_read',
    description: 'Read buffered or unread output from a persistent terminal session.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal sessionId' },
        tailLines: { type: 'number', description: 'Number of trailing lines to return when unreadOnly is false (default: 100)' },
        unreadOnly: { type: 'boolean', description: 'Return only new output since the last read/write (default: false)' }
      },
      required: ['sessionId']
    },
    execute: async (args: { sessionId: string; tailLines?: number; unreadOnly?: boolean }) => {
      return defaultTerminalManager.read(args);
    }
  },
  {
    name: 'terminal_list',
    description: 'List all active and recently exited persistent terminal sessions.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => {
      return defaultTerminalManager.list();
    }
  },
  {
    name: 'terminal_close',
    description: 'Terminate and clean up a persistent terminal session.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target terminal sessionId to close' }
      },
      required: ['sessionId']
    },
    execute: async ({ sessionId }: { sessionId: string }) => {
      return defaultTerminalManager.close(sessionId);
    }
  }
];
