import { estimateMessagesTokens, getModelContextLimit } from '../tokenizer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('OMAgent:Compaction');

/**
 * Compute the split point for history compaction, preserving assistant/tool pairs.
 */
function findCompactionSplit(agent: any): { older: any[]; recent: any[]; totalTokens: number } | null {
  const maxMsgs = agent.config.maxHistoryMessages || 80;
  const modelLimit = getModelContextLimit(agent.config.provider, agent.config.model);
  // Scale compaction threshold with the active model's real context window instead of capping at 32K
  const defaultTokenThreshold = Math.min(Math.max(Math.floor(modelLimit * 0.72), 16000), 180000);
  const thresholdTokens = agent.config.compactionThresholdTokens
    || (agent.config.compactionThresholdChars ? Math.ceil(agent.config.compactionThresholdChars / 4) : defaultTokenThreshold);

  const { estimatedTokens: totalTokens } = estimateMessagesTokens(agent.history, '', agent.config.model);
  if (agent.history.length <= maxMsgs && totalTokens <= thresholdTokens) return null;

  const keepRecent = 12;
  if (agent.history.length <= keepRecent) return null;

  // Snap cutIndex so `recent` never starts on an orphaned `tool` message
  let cutIndex = agent.history.length - keepRecent;
  while (cutIndex > 0 && agent.history[cutIndex]?.role === 'tool') {
    cutIndex--;
  }
  if (cutIndex === 0) return null;

  return {
    older: agent.history.slice(0, cutIndex),
    recent: agent.history.slice(cutIndex),
    totalTokens
  };
}

/**
 * Token-aware history compaction for OMAgent.
 * Preserves assistant/tool message pairs and supports both `compactionThresholdTokens`
 * and legacy `compactionThresholdChars`.
 */
export function compactHistoryIfNeeded(agent: any) {
  const split = findCompactionSplit(agent);
  if (!split) return;
  const { older, recent, totalTokens } = split;

  const summaryLines: string[] = [];
  const touchedFiles = new Set<string>();
  const recentErrors: string[] = [];

  for (const msg of older) {
    if (msg.role === 'user') {
      summaryLines.push(`User: ${String(msg.content || '').slice(0, 300)}`);
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        summaryLines.push(`Assistant: ${String(msg.content).slice(0, 300)}`);
      }
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const p = tc?.args?.path || tc?.args?.from || tc?.args?.to;
          if (typeof p === 'string' && p.trim()) touchedFiles.add(p.trim());
        }
      }
    } else if (msg.role === 'tool') {
      const contentStr = String(msg.content || '');
      summaryLines.push(`Tool(${msg.name}): ${contentStr.slice(0, 250)}`);
      if (contentStr.includes('"success":false') || contentStr.includes('Error:')) {
        recentErrors.push(`${msg.name}: ${contentStr.slice(0, 180)}`);
      }
    }
  }

  const sections: string[] = [
    `[Compacted Earlier Context (${older.length} turns)]`
  ];
  if (touchedFiles.size > 0) {
    sections.push(`Touched files: ${Array.from(touchedFiles).slice(-25).join(', ')}`);
  }
  if (recentErrors.length > 0) {
    sections.push(`Key errors encountered:\n${recentErrors.slice(-5).map((e) => `- ${e}`).join('\n')}`);
  }
  sections.push(summaryLines.slice(-40).join('\n'));

  const compactedMsg = {
    role: 'user',
    content: sections.join('\n')
  };

  agent.history = [compactedMsg, ...recent];
  agent.lastContextUsage = null;
  log.debug(`Compacted history from ${older.length + recent.length} to ${agent.history.length} messages (~${totalTokens} tokens)`);
}

/**
 * Async history compaction that optionally uses the agent's LLM to summarize
 * older turns (`agent.config.llmCompaction` or `options.useLLM`), falling back
 * cleanly to deterministic heuristic compaction on error or when disabled.
 * @param {any} agent
 * @param {{ useLLM?: boolean, model?: string }} [options]
 * @returns {Promise<{ compacted: boolean, mode?: 'llm' | 'heuristic' }>}
 */
export async function compactHistory(
  agent: any,
  options: { useLLM?: boolean; model?: string } = {}
): Promise<{ compacted: boolean; mode?: 'llm' | 'heuristic' }> {
  const split = findCompactionSplit(agent);
  if (!split) {
    return { compacted: false };
  }
  const { older, recent } = split;
  const useLLM = options.useLLM ?? Boolean(agent.config.llmCompaction);

  if (useLLM && (agent.router?.chat || agent.provider?.chat)) {
    try {
      const transcript = older.map((m: any) => {
        if (m.role === 'tool') return `Tool(${m.name}): ${String(m.content || '').slice(0, 400)}`;
        return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${String(m.content || '').slice(0, 800)}`;
      }).join('\n');

      const chatParams = {
        model: options.model || agent.config.model,
        systemPrompt: 'Summarize this earlier conversation concisely. Preserve exact file paths, symbol names, key decisions, errors resolved, and pending tasks.',
        messages: [{ role: 'user', content: transcript.slice(0, 16000) }],
        temperature: 0.1
      };
      const res = agent.router?.chat
        ? await agent.router.chat(agent.provider, chatParams)
        : await agent.provider.chat(chatParams);

      const summary = String(res?.content || '').trim();
      if (summary) {
        agent.history = [{
          role: 'user',
          content: `[LLM-Compacted Earlier Context (${older.length} turns)]\n${summary}`
        }, ...recent];
        agent.lastContextUsage = null;
        log.debug(`LLM-compacted history from ${older.length + recent.length} to ${agent.history.length} messages`);
        return { compacted: true, mode: 'llm' };
      }
    } catch (err: any) {
      log.warn(`LLM compaction failed, falling back to heuristic compaction: ${err.message}`);
    }
  }

  compactHistoryIfNeeded(agent);
  return { compacted: true, mode: 'heuristic' };
}
