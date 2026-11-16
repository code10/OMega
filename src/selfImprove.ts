import fs from 'node:fs';
import path from 'node:path';
import { distillMemory, type DistillOptions } from './memory/distiller.js';

/**
 * Tier 1: Zero-Training Daily Self-Improvement & Autonomous Distillation.
 * Distills daily journals and successful session traces into persistent MEMORY.md facts,
 * semantic vector knowledge, and reusable SKILL.md playbooks.
 */
export class OMSelfImprover {
  /**
   * Distill recent daily logs and successful sessions into long-term memory & vector store.
   * Runs zero-token algorithmic distillation + redundant turn pruning by default.
   */
  static async distill(agent: any, options: DistillOptions = {}) {
    return distillMemory(agent.memory, options, agent);
  }

  /**
   * Promote a proven multi-step procedure into a reusable SKILL.md playbook.
   */
  static promoteWorkflow(skillsDir: string, { name, description, steps = [], triggers = [] }: Record<string, any>) {
    if (!name || !skillsDir) {
      throw new Error('promoteWorkflow requires skillsDir and name');
    }
    const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const dir = path.join(skillsDir, safeName);
    fs.mkdirSync(dir, { recursive: true });

    const bodyLines = Array.isArray(steps)
      ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : String(steps || '');

    const md = `---
name: ${safeName}
description: ${description || `Distilled workflow for ${safeName}`}
triggers: [${triggers.join(', ')}]
---

# ${safeName}

${bodyLines}
`;
    const filePath = path.join(dir, 'SKILL.md');
    fs.writeFileSync(filePath, md, 'utf8');
    return { success: true, name: safeName, path: filePath };
  }

  /**
   * Register a nightly zero-token cron trigger on OMDaemon to run distillation automatically.
   */
  static registerNightlyTrigger(daemon: any, agent: any, cron = '0 2 * * *') {
    return daemon.addTrigger({
      id: 'nightly_memory_distillation',
      type: 'cron',
      cron,
      handler: async (_payload: any, activeAgent: any) => {
        return OMSelfImprover.distill(activeAgent || agent, { useLLM: false, prune: true });
      },
      enabled: true
    });
  }
}
