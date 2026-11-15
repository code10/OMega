import fs from 'node:fs';
import path from 'node:path';

/**
 * Tier 1: Zero-Training Daily Self-Improvement.
 * Distills daily journals and successful session traces into persistent MEMORY.md facts,
 * semantic vector knowledge, and reusable SKILL.md playbooks.
 */
export class OMSelfImprover {
  /**
   * Distill recent daily logs and successful sessions into long-term memory & vector store.
   * @param {any} agent
   * @param {{ date?: string, useLLM?: boolean, model?: string }} [options]
   */
  static async distill(agent: any, options: { date?: string; useLLM?: boolean; model?: string } = {}) {
    const memory = agent.memory;
    const memoryDir = memory.baseDir || agent.config.memoryDir;
    const existingMemory = memory.readLongTermMemory() || '';
    /** @type {string[]} */
    const addedFacts: string[] = [];

    // 1. Scan daily journal entries for high-signal lines (LLM-backed when requested, else heuristic)
    const daily = memory.readDailyJournal(options.date) || '';
    let usedLLM = false;

    if (options.useLLM && daily.trim() && agent?.router?.chat) {
      try {
        const res = await agent.router.chat(agent.provider, {
          model: options.model || agent.model,
          systemPrompt: 'Extract only durable, reusable facts, user preferences, architectural decisions, or resolved fixes from the daily log. Return ONLY a JSON array of concise strings (max 15 items). Return [] if none.',
          messages: [{ role: 'user', content: daily.slice(0, 12000) }],
          temperature: 0.1
        });
        const raw = String(res?.content || '').trim();
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          usedLLM = true;
          for (const item of parsed) {
            const fact = String(item || '').trim();
            if (fact && !existingMemory.includes(fact) && !addedFacts.includes(fact)) {
              memory.appendFact(fact, 'Distilled Insights');
              addedFacts.push(fact);
            }
          }
        }
      } catch (_) {
        // Fall back to zero-dep heuristic extractor below
      }
    }

    if (!usedLLM) {
      for (const rawLine of daily.split(/\r?\n/)) {
        const line = rawLine.replace(/^- \[\d{2}:\d{2}:\d{2}\]\s*/, '').trim();
        if (!line || line.startsWith('#')) continue;
        if (/\b(decided|fixed|prefer|always|never|architecture|configured|resolved)\b/i.test(line)) {
          if (!existingMemory.includes(line) && !addedFacts.includes(line)) {
            memory.appendFact(line, 'Distilled Insights');
            addedFacts.push(line);
          }
        }
      }
    }

    // 2. Scan recent successful sessions for reusable tool-use patterns
    const sessionsDir = path.join(memoryDir, 'sessions');
    let sessionsScanned = 0;
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).slice(-25);
      for (const file of files) {
        try {
          const sess = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
          sessionsScanned++;
          const steps = Array.isArray(sess.steps) ? sess.steps : [];
          const toolsUsed = steps.flatMap((s: any) => (s.toolCalls || []).map((t: any) => t.name));
          const hadErrors = steps.some((s: any) => (s.toolCalls || []).some((t: any) => t.result?.success === false));
          const lastAnswer = sess.answers?.[sess.answers.length - 1];
          if (!hadErrors && toolsUsed.length >= 2 && lastAnswer?.prompt) {
            const summary = `Successful workflow for "${String(lastAnswer.prompt).slice(0, 100)}": used [${[...new Set(toolsUsed)].join(' -> ')}]`;
            if (!existingMemory.includes(summary)) {
              memory.indexKnowledge(`distilled_${sess.sessionId || file}`, summary);
            }
          }
        } catch (_) {
          // skip corrupt session
        }
      }
    }

    return {
      success: true,
      mode: usedLLM ? 'llm' : 'heuristic',
      sessionsScanned,
      factsAdded: addedFacts.length,
      addedFacts
    };
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
   * Register a nightly cron trigger on OMDaemon to run distillation automatically.
   */
  static registerNightlyTrigger(daemon: any, _agent: any, cron = '0 2 * * *') {
    return daemon.addTrigger({
      id: 'nightly_memory_distillation',
      type: 'cron',
      cron,
      prompt: 'Run memory distillation',
      enabled: true
    });
  }
}
