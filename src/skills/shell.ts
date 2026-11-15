import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSafePath } from './filesystem.js';
import type { SkillContext } from '../types.js';

const SHELL_CONTROL_PATTERN = /[;|&`<>\r\n]|\$\(/;

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

      // Security check 1: Built-in destructive commands protection + user-configured denied commands
      const defaultDenied = [':(){ :|:& };:', 'rm -rf /', 'mkfs.', 'dd if=/dev/zero'];
      const denied = [...defaultDenied, ...(security.deniedCommands || [])];
      for (const d of denied) {
        if (d && commandText.toLowerCase().includes(d.toLowerCase())) {
          return {
            success: false,
            error: `Security violation: Command contains blocked substring '${d}'`
          };
        }
      }

      // Security check 2: Enforce allowedCommands allowlist if configured (non-empty)
      const allowed = Array.isArray(security.allowedCommands) ? security.allowedCommands.filter(Boolean) : [];
      let directExecutable = executable ? String(executable).trim() : null;
      let directArgs = Array.isArray(args) ? args.map(String) : [];

      if (allowed.length > 0) {
        if (!executable && SHELL_CONTROL_PATTERN.test(commandText)) {
          return {
            success: false,
            error: 'Security violation: Shell control operators (;, |, &, `, $(, <, >, newline) are not permitted when security.allowedCommands is active.'
          };
        }

        if (!directExecutable) {
          let tokens;
          try {
            tokens = tokenizeCommand(commandText.trim());
          } catch (tokErr: any) {
            return { success: false, error: `Security violation: ${tokErr.message}` };
          }
          if (tokens.length === 0) {
            return { success: false, error: 'Security violation: Empty command is not permitted.' };
          }
          directExecutable = tokens[0];
          directArgs = tokens.slice(1);
        }

        const resolvedName = path.basename(directExecutable).toLowerCase();
        const resolvedStem = resolvedName.replace(/\.(exe|cmd|bat|ps1)$/i, '');
        const isPermitted = allowed.some((entry) => {
          const e = path.basename(String(entry).trim()).toLowerCase();
          const eStem = e.replace(/\.(exe|cmd|bat|ps1)$/i, '');
          return resolvedName === e || resolvedStem === eStem;
        });

        if (!isPermitted) {
          return {
            success: false,
            error: `Security violation: Command '${resolvedName}' is not in security.allowedCommands`
          };
        }
      }

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

      if (!fs.existsSync(workingDir)) {
        try {
          fs.mkdirSync(workingDir, { recursive: true });
        } catch (mkdirErr: any) {
          return {
            success: false,
            error: `Failed to create working directory '${workingDir}': ${mkdirErr.message}`
          };
        }
      }
      const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash';

      // Scrub sensitive API keys / gateway tokens from child shell env unless explicitly opted in
      const childEnv = { ...process.env };
      if (!security.inheritSensitiveEnv) {
        delete childEnv.OPENAI_API_KEY;
        delete childEnv.ANTHROPIC_API_KEY;
        delete childEnv.GEMINI_API_KEY;
        delete childEnv.DEEPSEEK_API_KEY;
        delete childEnv.KIMI_API_KEY;
        delete childEnv.MOONSHOT_API_KEY;
        delete childEnv.QWEN_API_KEY;
        delete childEnv.DASHSCOPE_API_KEY;
        delete childEnv.GLM_API_KEY;
        delete childEnv.ZHIPU_API_KEY;
        delete childEnv.OM_GATEWAY_TOKEN;
      }

      return new Promise((resolve) => {
        const handleResult = (error: any, stdout: string, stderr: string) => {
          const outStr = (stdout || '').trim();
          const errStr = (stderr || '').trim();
          const exitCode = error ? (error.code ?? 1) : 0;

          if (error && !outStr && !errStr) {
            resolve({
              success: false,
              exitCode,
              error: error.message
            });
          } else {
            resolve({
              success: exitCode === 0,
              exitCode,
              stdout: outStr || '(no stdout output)',
              stderr: errStr ? errStr : undefined,
              timedOut: error?.killed || false
            });
          }
        };

        if (directExecutable) {
          const sandboxPrefix = Array.isArray(security.sandboxCommand) && security.sandboxCommand.length > 0
            ? security.sandboxCommand.map((part) => String(part).replaceAll('${cwd}', workingDir))
            : null;
          const finalExec = sandboxPrefix ? sandboxPrefix[0] : directExecutable;
          const finalArgs = sandboxPrefix
            ? [...sandboxPrefix.slice(1), directExecutable, ...directArgs]
            : directArgs;

          execFile(
            finalExec,
            finalArgs,
            {
              cwd: workingDir,
              timeout: safeTimeout,
              shell: false,
              env: childEnv,
              maxBuffer: 10 * 1024 * 1024 // 10MB
            },
            handleResult
          );
        } else {
          exec(
            commandText,
            {
              cwd: workingDir,
              timeout: safeTimeout,
              shell,
              env: childEnv,
              maxBuffer: 10 * 1024 * 1024 // 10MB
            },
            handleResult
          );
        }
      });
    }
  }
];
