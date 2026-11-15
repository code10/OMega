import os from 'node:os';
import type { SkillContext } from '../types.js';
import { ModelService } from '../modelService.js';

/**
 * System and time inspection skills
 */
export const systemSkills = [
  {
    name: 'get_system_info',
    description: 'Get information about the host operating system, CPU, memory, platform, and runtime environment.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => {
      const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
      const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
      return {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        totalMemoryMB: totalMemMb,
        freeMemoryMB: freeMemMb,
        usedMemoryMB: totalMemMb - freeMemMb,
        uptimeSeconds: Math.round(os.uptime()),
        nodeVersion: process.version,
        cwd: process.cwd()
      };
    }
  },

  {
    name: 'get_current_time',
    description: 'Get the current local time, date, UTC time, and timezone information.',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => {
      const now = new Date();
      return {
        iso: now.toISOString(),
        localeString: now.toLocaleString(),
        timezoneOffsetMinutes: now.getTimezoneOffset(),
        timestamp: now.getTime()
      };
    }
  },

  {
    name: 'list_models',
    description: 'List available AI models from the current provider (e.g. Gemini via ModelService.ListModels) or a specified provider.',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider name (gemini, openai, anthropic, vllm, lmstudio, om). Defaults to the active provider.'
        }
      }
    },
    execute: async (args: Record<string, any> = {}, context: SkillContext = {}) => {
      const rawProv = (args.provider || context?.config?.provider || 'gemini').toLowerCase();
      const provider = (rawProv === 'mock' || rawProv === 'omega') ? 'om' : rawProv;
      const models = await ModelService.listModels({
        provider,
        config: context?.config
      });
      return {
        provider,
        count: models.length,
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          displayName: m.displayName,
          description: m.description,
          inputTokenLimit: m.inputTokenLimit,
          outputTokenLimit: m.outputTokenLimit
        }))
      };
    }
  }
];
