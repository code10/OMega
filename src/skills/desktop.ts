import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SkillContext, SkillDefinition } from '../types.js';

const execFileAsync = promisify(execFile);

function getErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function requireDesktopApproval(
  context: SkillContext,
  tool: string,
  summary: string,
  args: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sec = context.config?.security;
  const confirmFn = context.confirmCommand || (context.agent as { confirmCommand?: SkillContext['confirmCommand'] } | undefined)?.confirmCommand;
  if (sec?.allowAllCommands && !confirmFn) {
    return { ok: true };
  }
  if (!confirmFn) {
    return {
      ok: false,
      error: `Desktop GUI tool '${tool}' requires human approval (${summary}), but no confirmation handler is attached.`
    };
  }
  const approved = await confirmFn({ tool, command: summary, args });
  if (!approved) {
    return { ok: false, error: `Desktop action rejected by user: ${summary}` };
  }
  return { ok: true };
}

async function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: timeoutMs, windowsHide: true }
  );
  return stdout.trim();
}

export function escapeSendKeysText(text: string): string {
  return String(text || '').replace(/([+^%~(){}[\]])/g, '{$1}');
}

export function mapHotkeyToSendKeys(keys: string[]): string {
  const mods: string[] = [];
  let mainKey = '';
  for (const raw of keys) {
    const k = String(raw || '').trim().toLowerCase();
    if (!k) continue;
    if (k === 'ctrl' || k === 'control') mods.push('^');
    else if (k === 'alt') mods.push('%');
    else if (k === 'shift') mods.push('+');
    else if (k === 'enter' || k === 'return') mainKey = '{ENTER}';
    else if (k === 'tab') mainKey = '{TAB}';
    else if (k === 'esc' || k === 'escape') mainKey = '{ESC}';
    else if (k === 'backspace') mainKey = '{BACKSPACE}';
    else if (k === 'delete' || k === 'del') mainKey = '{DELETE}';
    else if (/^f\d{1,2}$/.test(k)) mainKey = `{${k.toUpperCase()}}`;
    else mainKey = k.length === 1 ? k : `{${k.toUpperCase()}}`;
  }
  return `${mods.join('')}${mainKey}`;
}

export const desktopSkills: SkillDefinition[] = [
  {
    name: 'screen_capture',
    description: 'Capture a PNG screenshot of the desktop screen for visual inspection.',
    parameters: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: 'Optional output PNG file path (defaults to memory/screenshots/)' }
      }
    },
    execute: async (rawArgs: Record<string, unknown>, context: SkillContext = {}) => {
      try {
        const memDir = context.config?.memoryDir || path.join(context.config?.workspaceDir || process.cwd(), 'memory');
        const outPath = rawArgs.outputPath
          ? path.resolve(context.config?.workspaceDir || process.cwd(), String(rawArgs.outputPath))
          : path.join(path.resolve(memDir), 'screenshots', `screen-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });

        if (process.platform === 'win32') {
          const safeOut = outPath.replace(/'/g, "''");
          const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${safeOut}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$($bounds.Width)x$($bounds.Height)"
`;
          const dims = await runPowerShell(ps);
          const stat = fs.statSync(outPath);
          return { success: true, path: outPath, resolution: dims, sizeBytes: stat.size };
        }

        if (process.platform === 'darwin') {
          await execFileAsync('screencapture', ['-x', outPath], { timeout: 15_000 });
          const stat = fs.statSync(outPath);
          return { success: true, path: outPath, sizeBytes: stat.size };
        }

        await execFileAsync('import', ['-window', 'root', outPath], { timeout: 15_000 });
        const stat = fs.statSync(outPath);
        return { success: true, path: outPath, sizeBytes: stat.size };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  },
  {
    name: 'list_windows',
    description: 'List currently open desktop application windows (PID, process name, window title).',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        if (process.platform === 'win32') {
          const out = await runPowerShell(
            `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress`
          );
          const parsed = out ? JSON.parse(out) : [];
          const list = Array.isArray(parsed) ? parsed : [parsed];
          return {
            success: true,
            windows: list.map((w: { Id?: number; ProcessName?: string; MainWindowTitle?: string }) => ({
              pid: w.Id,
              process: w.ProcessName,
              title: w.MainWindowTitle
            }))
          };
        }

        if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('osascript', [
            '-e',
            'tell application "System Events" to get name of every process whose visible is true'
          ]);
          const windows = stdout.split(',').map((s) => ({ title: s.trim() })).filter((w) => w.title);
          return { success: true, windows };
        }

        const { stdout } = await execFileAsync('wmctrl', ['-l']);
        const windows = stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => ({ title: line.split(/\s+/).slice(3).join(' ') }));
        return { success: true, windows };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  },
  {
    name: 'desktop_click',
    description: 'Move mouse to (x, y) and click on the desktop (requires human approval).',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen X coordinate in pixels' },
        y: { type: 'number', description: 'Screen Y coordinate in pixels' },
        button: { type: 'string', description: 'Mouse button: left (default) or right' },
        doubleClick: { type: 'boolean', description: 'Double-click instead of single click' }
      },
      required: ['x', 'y']
    },
    execute: async (rawArgs: Record<string, unknown>, context: SkillContext = {}) => {
      const x = Math.round(Number(rawArgs.x));
      const y = Math.round(Number(rawArgs.y));
      const button = String(rawArgs.button || 'left').toLowerCase() === 'right' ? 'right' : 'left';
      const doubleClick = Boolean(rawArgs.doubleClick);

      const gate = await requireDesktopApproval(
        context,
        'desktop_click',
        `Desktop ${doubleClick ? 'double-' : ''}${button}-click at (${x}, ${y})`,
        { x, y, button, doubleClick }
      );
      if (!gate.ok) return { success: false, error: gate.error };

      try {
        if (process.platform === 'win32') {
          const down = button === 'right' ? '0x0008' : '0x0002';
          const up = button === 'right' ? '0x0010' : '0x0004';
          const clicks = doubleClick ? 2 : 1;
          const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class OMMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[OMMouse]::SetCursorPos(${x}, ${y}) | Out-Null
for ($i = 0; $i -lt ${clicks}; $i++) {
  [OMMouse]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
  [OMMouse]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}
`;
          await runPowerShell(ps);
          return { success: true, x, y, button, doubleClick };
        }

        const xdoBtn = button === 'right' ? '3' : '1';
        const args = ['mousemove', String(x), String(y), 'click', ...(doubleClick ? ['--repeat', '2'] : []), xdoBtn];
        await execFileAsync('xdotool', args, { timeout: 10_000 });
        return { success: true, x, y, button, doubleClick };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  },
  {
    name: 'desktop_type',
    description: 'Type text into the currently focused desktop window (requires human approval).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing (default: false)' }
      },
      required: ['text']
    },
    execute: async (rawArgs: Record<string, unknown>, context: SkillContext = {}) => {
      const text = String(rawArgs.text || '');
      const pressEnter = Boolean(rawArgs.pressEnter);

      const gate = await requireDesktopApproval(
        context,
        'desktop_type',
        `Type "${text.slice(0, 60)}"${pressEnter ? ' + Enter' : ''}`,
        { textLength: text.length, pressEnter }
      );
      if (!gate.ok) return { success: false, error: gate.error };

      try {
        if (process.platform === 'win32') {
          const escaped = (escapeSendKeysText(text) + (pressEnter ? '{ENTER}' : '')).replace(/'/g, "''");
          await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
          return { success: true, typedLength: text.length, pressEnter };
        }
        if (process.platform === 'darwin') {
          const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          await execFileAsync('osascript', ['-e', `tell application "System Events" to keystroke "${safe}"`]);
          if (pressEnter) await execFileAsync('osascript', ['-e', 'tell application "System Events" to key code 36']);
          return { success: true, typedLength: text.length, pressEnter };
        }
        await execFileAsync('xdotool', ['type', '--delay', '10', text]);
        if (pressEnter) await execFileAsync('xdotool', ['key', 'Return']);
        return { success: true, typedLength: text.length, pressEnter };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  },
  {
    name: 'desktop_hotkey',
    description: 'Send a keyboard shortcut (e.g. ["ctrl", "s"]) to the focused window (requires human approval).',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of keys to press together, e.g. ["ctrl", "s"] or ["alt", "tab"]'
        }
      },
      required: ['keys']
    },
    execute: async (rawArgs: Record<string, unknown>, context: SkillContext = {}) => {
      const keys = Array.isArray(rawArgs.keys) ? rawArgs.keys.map(String) : [];
      if (keys.length === 0) return { success: false, error: 'keys array must not be empty' };

      const gate = await requireDesktopApproval(
        context,
        'desktop_hotkey',
        `Send hotkey ${keys.join('+')}`,
        { keys }
      );
      if (!gate.ok) return { success: false, error: gate.error };

      try {
        if (process.platform === 'win32') {
          const seq = mapHotkeyToSendKeys(keys).replace(/'/g, "''");
          await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${seq}')`);
          return { success: true, keys };
        }
        await execFileAsync('xdotool', ['key', keys.join('+')]);
        return { success: true, keys };
      } catch (err: unknown) {
        return { success: false, error: getErrMsg(err) };
      }
    }
  }
];
