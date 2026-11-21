import os from 'node:os';
import path from 'node:path';
import { resolveSafePath } from './filesystem.js';
import { buildSafeChildEnv, redactSecrets } from '../utils/redact.js';
import { getExecutionBackend } from '../execution/backend.js';
import type { SecurityConfig, SkillContext } from '../types.js';

const SHELL_CONTROL_PATTERN = /[;|&`<>\r\n]|\$\(/;
const DEFAULT_ALLOWED_COMMANDS = ['git'];

/**
 * Tokenize a command string into [executable, ...args] respecting single/double quotes.
 * @param {string} input
 * @returns {string[]}
 */
function tokenizeCommand(input: string): string[] {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        current += input[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (quote) {
    throw new Error('Invalid command syntax: unterminated quote.');
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export interface ShellPolicyCheckResult {
  allowed: boolean;
  error?: string;
  directExecutable: string | null;
  directArgs: string[];
}

/**
 * Shared command security policy validator for exec_command and terminal_start.
 */
export function validateShellCommandPolicy(
  commandText: string,
  security: SecurityConfig = {},
  executable?: string,
  args?: unknown[]
): ShellPolicyCheckResult {
  const defaultDenied = [':(){ :|:& };:', 'rm -rf /', 'mkfs.', 'dd if=/dev/zero'];
  const denied = [...defaultDenied, ...(security.deniedCommands || [])];
  for (const d of denied) {
    if (d && commandText.toLowerCase().includes(d.toLowerCase())) {
      return {
        allowed: false,
        error: `Security violation: Command contains blocked substring '${d}'`,
        directExecutable: null,
        directArgs: []
      };
    }
  }

  const configuredAllowed = Array.isArray(security.allowedCommands) ? security.allowedCommands.filter(Boolean) : [];
  const allowedList = security.allowAllCommands === true
    ? []
    : (configuredAllowed.length > 0 ? configuredAllowed : DEFAULT_ALLOWED_COMMANDS);
  let directExecutable = executable ? String(executable).trim() : null;
  let directArgs = Array.isArray(args) ? args.map(String) : [];

  if (allowedList.length > 0) {
    if (!executable && SHELL_CONTROL_PATTERN.test(commandText)) {
      return {
        allowed: false,
        error: 'Security violation: Shell control operators (;, |, &, `, $(, <, >, newline) are not permitted when security.allowedCommands is active.',
        directExecutable: null,
        directArgs: []
      };
    }

    if (!directExecutable) {
      let tokens: string[];
      try {
        tokens = tokenizeCommand(commandText.trim());
      } catch (tokErr: any) {
        return {
          allowed: false,
          error: `Security violation: ${tokErr.message}`,
          directExecutable: null,
          directArgs: []
        };
      }
      if (tokens.length === 0) {
        return {
          allowed: false,
          error: 'Security violation: Empty command is not permitted.',
          directExecutable: null,
          directArgs: []
        };
      }
      directExecutable = tokens[0];
      directArgs = tokens.slice(1);
    }

    const resolvedName = path.basename(directExecutable).toLowerCase();
    const resolvedStem = resolvedName.replace(/\.(exe|cmd|bat|ps1)$/i, '');
    const isPermitted = allowedList.some((entry) => {
      const e = path.basename(String(entry).trim()).toLowerCase();
      const eStem = e.replace(/\.(exe|cmd|bat|ps1)$/i, '');
      return resolvedName === e || resolvedStem === eStem;
    });

    if (!isPermitted) {
      return {
        allowed: false,
        error: `Security violation: Command '${resolvedName}' is not in security.allowedCommands`,
        directExecutable: null,
        directArgs: []
      };
    }

    if (resolvedStem === 'git') {
      const isRebase = directArgs.some((a) => a === 'rebase');
      for (const arg of directArgs) {
        const lowerArg = String(arg).toLowerCase();
        if (
          lowerArg === '-c' ||
          lowerArg.startsWith('-c=') ||
          lowerArg === '--config-env' ||
          lowerArg.startsWith('--config-env=') ||
          lowerArg === '--exec-path' ||
          lowerArg.startsWith('--exec-path=') ||
          lowerArg === '--upload-pack' ||
          lowerArg.startsWith('--upload-pack=') ||
          lowerArg === '-u' ||
          lowerArg === '--receive-pack' ||
          lowerArg.startsWith('--receive-pack=') ||
          lowerArg === '--exec' ||
          lowerArg.startsWith('--exec=') ||
          lowerArg === '--ext-diff' ||
          (isRebase && (lowerArg === '-x' || lowerArg.startsWith('-x=')))
        ) {
          return {
            allowed: false,
            error: `Security violation: Dangerous git flag '${arg}' is blocked.`,
            directExecutable: null,
            directArgs: []
          };
        }
      }
    }
  }

  return {
    allowed: true,
    directExecutable,
    directArgs
  };
}

/**
 * Shell execution skill
 */
export const shellSkills = [
  {
    name: 'exec_command',
    description: 'Execute a command in the local system shell (PowerShell on Windows, bash/sh on Unix). Use this to run scripts, compile code, git operations, or inspect the system.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute'
        },
        executable: {
          type: 'string',
          description: 'Optional explicit executable path/name to run directly without a shell'
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional argument array when using executable'
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (optional, defaults to workspace root)'
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait before terminating in milliseconds (default: 30000)'
        }
      },
      required: ['command']
    },
    execute: async ({ command = '', executable, args, cwd, timeoutMs = 30000 }: Record<string, any>, context: SkillContext = {}) => {
      const security = context.config?.security || {};
      const commandText = executable
        ? [executable, ...(Array.isArray(args) ? args : [])].join(' ')
        : String(command || '');

      if (!commandText.trim()) {
        return { success: false, error: 'Command or executable is required.' };
      }

      const policy = validateShellCommandPolicy(commandText, security, executable, args);
      if (!policy.allowed) {
        return { success: false, error: policy.error };
      }
      const { directExecutable, directArgs } = policy;

      // Security check 3: Require interactive confirmation if configured
      if (security.requireConfirmationForShell) {
        const confirmFn = context.confirmCommand || context.agent?.confirmCommand;
        if (typeof confirmFn !== 'function') {
          return {
            success: false,
            confirmationRequired: true,
            error: 'Shell execution requires human confirmation (security.requireConfirmationForShell is enabled, but no confirmation handler is attached).'
          };
        }
        const approved = await confirmFn({ command: commandText, cwd });
        if (!approved) {
          return {
            success: false,
            confirmationRequired: true,
            error: 'Shell command execution was denied by user confirmation.'
          };
        }
      }

      const safeTimeout = Math.min(Math.max(1000, Number(timeoutMs) || 30000), 600000);

      // Security check 4: Confine cwd inside workspaceDir / allowedPaths
      const baseWorkspace = context.config?.workspaceDir || process.cwd();
      let workingDir;
      try {
        workingDir = resolveSafePath(cwd || '.', baseWorkspace, context);
      } catch (pathErr: any) {
        return {
          success: false,
          error: pathErr.message
        };
      }

      const backend = getExecutionBackend(context);
      if (!(await backend.exists(workingDir))) {
        try {
          await backend.mkdir(workingDir, { recursive: true });
        } catch (mkdirErr: any) {
          return {
            success: false,
            error: `Failed to create working directory '${workingDir}': ${mkdirErr.message}`
          };
        }
      }
      const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';

      // Scrub child shell env via allowlist unless explicitly opted in
      const allowedEnvVars = Array.isArray(security.allowedEnvVars) ? security.allowedEnvVars : [];
      const childEnv = buildSafeChildEnv(process.env, {}, Boolean(security.inheritSensitiveEnv), allowedEnvVars);

      const formatProcessResult = (res: {
        exitCode: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        outputTruncated?: boolean;
        errorMessage?: string;
        sandboxBackend?: string;
      }) => {
        const outStr = redactSecrets((res.stdout || '').trim());
        const errStr = redactSecrets((res.stderr || '').trim());
        if (res.errorMessage && !outStr && !errStr) {
          return {
            success: false,
            exitCode: res.exitCode,
            error: redactSecrets(res.errorMessage),
            ...(res.sandboxBackend ? { sandboxBackend: res.sandboxBackend } : {})
          };
        }
        return {
          success: res.exitCode === 0 && !res.timedOut && !res.outputTruncated,
          exitCode: res.exitCode,
          stdout: outStr || '(no stdout output)',
          stderr: errStr ? errStr : undefined,
          timedOut: res.timedOut,
          ...(res.outputTruncated ? { outputTruncated: true } : {}),
          ...(res.sandboxBackend ? { sandboxBackend: res.sandboxBackend } : {})
        };
      };

      if (directExecutable) {
        try {
          const res = await backend.spawn(directExecutable, directArgs, {
            cwd: workingDir,
            env: childEnv,
            timeoutMs: safeTimeout,
            maxOutputBytes: security.sandbox?.maxOutputBytes,
            sandbox: security.sandbox || {},
            sandboxCommand: security.sandboxCommand
          });
          return formatProcessResult(res);
        } catch (sandboxErr: any) {
          return { success: false, error: sandboxErr?.message || String(sandboxErr) };
        }
      }

      if (security.sandbox?.strict || security.sandbox?.mode === 'os' || security.sandbox?.mode === 'container') {
        const shellFlag = os.platform() === 'win32' ? '-Command' : '-c';
        try {
          const res = await backend.spawn(shell, [shellFlag, commandText], {
            cwd: workingDir,
            env: childEnv,
            timeoutMs: safeTimeout,
            maxOutputBytes: security.sandbox?.maxOutputBytes,
            sandbox: security.sandbox || {}
          });
          return formatProcessResult(res);
        } catch (sandboxErr: any) {
          return { success: false, error: sandboxErr?.message || String(sandboxErr) };
        }
      }

      const res = await backend.exec(commandText, {
        cwd: workingDir,
        timeoutMs: safeTimeout,
        shell,
        env: childEnv,
        maxBuffer: 10 * 1024 * 1024
      });
      return formatProcessResult(res);
    }
  }
];
