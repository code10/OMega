import { estimateMessagesTokens, getModelContextLimit } from '../tokenizer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('OMAgent:Compaction');

/**
 * Token-aware history compaction for OMAgent.
 * Preserves assistant/tool message pairs and supports both `compactionThresholdTokens`
 * and legacy `compactionThresholdChars`.
 * @param {any} agent
 */
export function compactHistoryIfNeeded(agent: any) {
  const maxMsgs = agent.config.maxHistoryMessages || 48;
  const modelLimit = getModelContextLimit(agent.config.provider, agent.config.model);
  const defaultTokenThreshold = Math.min(Math.floor(modelLimit * 0.75), 32000);
  const thresholdTokens = agent.config.compactionThresholdTokens
    || (agent.config.compactionThresholdChars ? Math.ceil(agent.config.compactionThresholdChars / 4) : defaultTokenThreshold);

  const { estimatedTokens: totalTokens } = estimateMessagesTokens(agent.history, '', agent.config.model);
  if (agent.history.length <= maxMsgs && totalTokens <= thresholdTokens) return;

  const keepRecent = 12;
  if (agent.history.length <= keepRecent) return;

  // Snap cutIndex so `recent` never starts on an orphaned `tool` message
  let cutIndex = agent.history.length - keepRecent;
  while (cutIndex > 0 && agent.history[cutIndex]?.role === 'tool') {
    cutIndex--;
  }
  if (cutIndex === 0) return;

  const older = agent.history.slice(0, cutIndex);
  const recent = agent.history.slice(cutIndex);

  /** @type {string[]} */
  const summaryLines = [];
  for (const msg of older) {
    if (msg.role === 'user') {
      summaryLines.push(`User: ${String(msg.content || '').slice(0, 160)}`);
    } else if (msg.role === 'assistant' && msg.content) {
      summaryLines.push(`Assistant: ${String(msg.content).slice(0, 160)}`);
    } else if (msg.role === 'tool') {
      summaryLines.push(`Tool(${msg.name}): ${String(msg.content || '').slice(0, 100)}`);
    }
  }

  const compactedMsg = {
    role: 'user',
    content: `[Compacted Earlier Context (${older.length} turns)]\n${summaryLines.slice(-16).join('\n')}`
  };

  agent.history = [compactedMsg, ...recent];
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
  const maxMsgs = agent.config.maxHistoryMessages || 48;
  const modelLimit = getModelContextLimit(agent.config.provider, agent.config.model);
  const defaultTokenThreshold = Math.min(Math.floor(modelLimit * 0.75), 32000);
  const thresholdTokens = agent.config.compactionThresholdTokens
    || (agent.config.compactionThresholdChars ? Math.ceil(agent.config.compactionThresholdChars / 4) : defaultTokenThreshold);

  const { estimatedTokens: totalTokens } = estimateMessagesTokens(agent.history, '', agent.config.model);
  if (agent.history.length <= maxMsgs && totalTokens <= thresholdTokens) {
    return { compacted: false };
  }

  const keepRecent = 12;
  if (agent.history.length <= keepRecent) return { compacted: false };

  let cutIndex = agent.history.length - keepRecent;
  while (cutIndex > 0 && agent.history[cutIndex]?.role === 'tool') {
    cutIndex--;
  }
  if (cutIndex === 0) return { compacted: false };

  const older = agent.history.slice(0, cutIndex);
  const recent = agent.history.slice(cutIndex);
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
