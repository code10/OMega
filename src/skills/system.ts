import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { SkillContext, SkillDefinition } from '../types.js';
import { ModelService } from '../modelService.js';

const execFileAsync = promisify(execFile);

/**
 * System, time, model listing, and desktop notification skills
 */
export const systemSkills: SkillDefinition[] = [
  {
    name: 'get_system_info',
    description: 'Return host OS, CPU, memory, and Node.js runtime info.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => {
      const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
      const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
      const usedMemMb = totalMemMb - freeMemMb;
      const cpus = os.cpus().length;
      return {
        success: true,
        summary: `${os.platform()} ${os.arch()} · ${cpus} CPUs · ${usedMemMb}/${totalMemMb} MB RAM · Node ${process.version}`,
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        cpus,
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        totalMemoryMB: totalMemMb,
        freeMemoryMB: freeMemMb,
        usedMemoryMB: usedMemMb,
        uptimeSeconds: Math.round(os.uptime()),
        nodeVersion: process.version,
        cwd: process.cwd()
      };
    }
  },

  {
    name: 'get_current_time',
    description: 'Return current local date, time, UTC ISO string, and timezone.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => {
      const now = new Date();
      return {
        success: true,
        summary: `${now.toLocaleString()} (UTC: ${now.toISOString()})`,
        iso: now.toISOString(),
        localeString: now.toLocaleString(),
        timezoneOffsetMinutes: now.getTimezoneOffset(),
        timestamp: now.getTime()
      };
    }
  },

  {
    name: 'list_models',
    description: 'List available models for the active or specified provider, including hardware-aware local models (use provider="local" to detect CPU/GPU VRAM and list compatible local models).',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Optional provider name (local, all, gemini, openai, anthropic, deepseek, kimi, qwen, glm, lmstudio, vllm, om).'
        },
        includeTight: {
          type: 'boolean',
          description: 'When listing local models, also include tight-fit models.'
        }
      }
    },
    execute: async (args: Record<string, unknown> = {}, context: SkillContext = {}) => {
      const rawProv = String(args.provider || context?.config?.provider || 'gemini').toLowerCase();
      const provider = (rawProv === 'mock' || rawProv === 'omega') ? 'om' : rawProv;
      const includeHardware = provider === 'local' || provider === 'all';
      const hardware = includeHardware ? await ModelService.getHardwareProfile() : undefined;
      const models = await ModelService.listModels({
        provider,
        config: context?.config,
        hardwareProfile: hardware,
        includeTight: Boolean(args.includeTight)
      });
      return {
        success: true,
        provider,
        ...(hardware ? { hardware } : {}),
        count: models.length,
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          displayName: m.displayName,
          description: m.description,
          provider: m.provider,
          target: m.target,
          inputTokenLimit: m.inputTokenLimit,
          outputTokenLimit: m.outputTokenLimit,
          ...(m.installed !== undefined ? { installed: m.installed } : {}),
          ...(m.recommended !== undefined ? { recommended: m.recommended } : {}),
          ...(m.hardwareFit ? { hardwareFit: m.hardwareFit } : {})
        }))
      };
    }
  },

  {
    name: 'notify_user',
    description: 'Show a native desktop notification to alert the user when a task completes or needs attention.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short notification title (default: OMega)' },
        message: { type: 'string', description: 'Notification message body' }
      },
      required: ['message']
    },
    execute: async (args: Record<string, unknown> = {}) => {
      const title = String(args.title || 'OMega').trim();
      const message = String(args.message || '').trim();
      if (!message) return { success: false, error: 'Notification message is required.' };

      try {
        if (process.platform === 'win32') {
          const safeTitle = title.replace(/'/g, "''");
          const safeMsg = message.replace(/'/g, "''");
          const ps = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = '${safeTitle}'
$n.BalloonTipText = '${safeMsg}'
$n.Visible = $true
$n.ShowBalloonTip(4000)
Start-Sleep -Milliseconds 300
$n.Dispose()
`;
          const encoded = Buffer.from(ps, 'utf16le').toString('base64');
          await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            timeout: 8000,
            windowsHide: true
          });
        } else if (process.platform === 'darwin') {
          const safeTitle = title.replace(/"/g, '\\"');
          const safeMsg = message.replace(/"/g, '\\"');
          await execFileAsync('osascript', ['-e', `display notification "${safeMsg}" with title "${safeTitle}"`], {
            timeout: 5000
          });
        } else {
          await execFileAsync('notify-send', [title, message], { timeout: 5000 });
        }
        return { success: true, title, message, summary: `Notification sent: "${title} — ${message}"` };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
];
