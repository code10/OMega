import os from 'node:os';
import { createLogger } from '../utils/logger.js';

const log = createLogger('OMAgent:Prompt');
const STATIC_HOST_INFO = `Host: ${os.platform()} (${os.arch()}), CPUs: ${os.cpus().length}`;

/**
 * Retrieve semantic memory recall context for a query.
 * @param {any} agent
 * @param {string} query
 * @param {number} [topK=4]
 * @returns {string}
 */
export function buildRecallContext(agent: any, query: string, topK = 4): string {
  if (!query || typeof query !== 'string' || query.trim().length < 3) return '';
  if (typeof agent.memory?.semanticSearch !== 'function') return '';
  try {
    const hits = agent.memory.semanticSearch(query, { topK, minScore: 0.22 });
    if (!hits || hits.length === 0) return '';
    const lines = hits.map((h: any) => `- [${h.type || h.metadata?.type || 'memory'} | score ${h.score}] ${String(h.text).slice(0, 240)}`);
    return `\n<RELEVANT_MEMORY_RECALL>\n${lines.join('\n')}\n</RELEVANT_MEMORY_RECALL>\n`;
  } catch (err: any) {
    log.debug(`Semantic recall error: ${err.message}`);
    return '';
  }
}

/**
 * Build cache-friendly prompt parts: a stable static system prompt prefix
 * (eligible for provider prompt caching) and a separate dynamic memory/recall block.
 */
export function buildPromptParts(
  agent: any,
  options: Record<string, any> = {}
): { staticSystemPrompt: string; dynamicContext: string } {
  const memoryContext = agent.memory.getPromptContext({
    maxDailyLines: options.maxDailyLines || agent.config.maxDailyLogLines || 30
  });
  const recallContext = agent._buildRecallContext(options.query);
  const systemInfo = `${STATIC_HOST_INFO}, CWD: ${agent.config.workspaceDir || process.cwd()}, Project Root: ${agent.config.rootDir || process.cwd()}`;

  const allSkills = agent.skills.list();
  const tools = [];
  const workflows = [];
  for (const s of allSkills) {
    if (s.type === 'workflow') workflows.push(s);
    else tools.push(s);
  }

  const availableSkills = tools.length > 0
    ? tools.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : '- (No executable tool skills loaded)';

  const availableWorkflows = workflows.length > 0
    ? `\nWorkflow & Playbook Directives (SKILL.md):\n` +
      workflows.map((s) => `- ${s.name}: ${s.description}${s.triggers?.length ? ` [Triggers: ${s.triggers.join(', ')}]` : ''}`).join('\n')
    : '';

  const staticSystemPrompt = `${agent.config.systemPrompt}

Current System Environment:
${systemInfo}

Registered Capabilities & Tools:
${availableSkills}${availableWorkflows}

Operating Directives (Intelligence, Speed, Concision):
1. High-Precision Execution: Select the minimum set of tools needed, batch independent tool calls in a single turn when possible, and verify outcomes before concluding.
2. Concise Communication: Lead with the answer or result. Omit conversational filler, preambles, and repetition. Keep intermediate tool intent notes to one short sentence.
3. Adaptive Recovery: Never repeat an identical failing tool call; inspect the error, pivot strategy immediately, or report the root cause.
4. Persistent Knowledge: Use 'save_memory' to store high-value user preferences, architecture decisions, and key facts.
5. Runtime Identity: Active provider '${agent.config.provider}', model '${agent.config.model}'. Never claim to switch providers/models via 'save_memory' (handled exclusively by '/provider', '/model', '/cloud', '/local').`;

  const dynamicContext = `${memoryContext}${recallContext}`.trim();
  return { staticSystemPrompt, dynamicContext };
}

/**
 * Build the complete dynamic system prompt with memory, semantic recall, and environment context.
 * @param {any} agent
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
export function buildSystemPrompt(agent: any, options: Record<string, any> = {}): string {
  const { staticSystemPrompt, dynamicContext } = buildPromptParts(agent, options);
  return dynamicContext ? `${staticSystemPrompt}\n\n${dynamicContext}` : staticSystemPrompt;
}
