import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkillDefinition } from '../types.js';

const execFileAsync = promisify(execFile);

function getErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeStdinToProcess(bin: string, args: string[], input: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Clipboard write timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${bin} exited with code ${code}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

export const clipboardSkills: SkillDefinition[] = [
  {
    name: 'clipboard_read',
    description: 'Read the current plain-text contents of the OS clipboard.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Optional max characters to return (default: 16000)' }
      }
    },
    execute: async (args: Record<string, unknown> = {}) => {
      const maxChars = Math.max(100, Number(args.maxChars || 16_000));
      try {
        let text = '';
        if (process.platform === 'win32') {
          const { stdout } = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
            { timeout: 5000, windowsHide: true }
          );
          text = stdout;
        } else if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('pbpaste', [], { timeout: 5000 });
          text = stdout;
        } else {
          try {
            const { stdout } = await execFileAsync('wl-paste', ['--no-newline'], { timeout: 5000 });
            text = stdout;
          } catch (_err: unknown) {
            const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-o'], { timeout: 5000 });
            text = stdout;
          }
        }
        const truncated = text.length > maxChars;
        const output = truncated ? text.slice(0, maxChars) : text;
        return {
          success: true,
          text: output,
          length: text.length,
          truncated,
          summary: text.length ? `Read ${text.length} char(s) from clipboard.` : 'Clipboard is empty.'
        };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  },
  {
    name: 'clipboard_write',
    description: 'Copy plain text to the OS clipboard.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to copy into the clipboard' }
      },
      required: ['text']
    },
    execute: async (args: Record<string, unknown> = {}) => {
      const text = String(args.text ?? '');
      try {
        if (process.platform === 'win32') {
          await writeStdinToProcess('clip.exe', [], text);
        } else if (process.platform === 'darwin') {
          await writeStdinToProcess('pbcopy', [], text);
        } else {
          try {
            await writeStdinToProcess('wl-copy', [], text);
          } catch (_err: unknown) {
            await writeStdinToProcess('xclip', ['-selection', 'clipboard'], text);
          }
        }
        return { success: true, length: text.length, summary: `Copied ${text.length} char(s) to clipboard.` };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  }
];
