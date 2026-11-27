/**
 * Slash control command handler for OMAgent (/cloud, /local, /clear, /new).
 * @param {any} agent
 * @param {string} trimmedPrompt
 * @returns {{ content: string, answer?: string, provider?: string, model?: string, sessionId?: string, steps: Array<any>, success: boolean } | null}
 */
export function handleSlashControl(agent: any, trimmedPrompt: string) {
  const modeMatch = trimmedPrompt.match(/^\/(cloud|local)(?:\s+([\s\S]*))?$/i);
  if (modeMatch) {
    const targetMode = modeMatch[1].toLowerCase();
    const modelArg = (modeMatch[2] || '').trim();
    let targetProvider = targetMode === 'cloud'
      ? (agent.config.providers?.gemini?.apiKey || process.env.GEMINI_API_KEY
        ? 'gemini'
        : (agent.config.providers?.openai?.apiKey || process.env.OPENAI_API_KEY ? 'openai' : 'gemini'))
      : 'om';
    const targetModel = modelArg || (targetMode === 'local' ? (agent.config.providers?.om?.model || agent.config.providers?.mock?.model || 'om-turbo') : undefined);

    if (modelArg) {
      if (targetMode === 'local') {
        if (/^(om-|om-v1|om-turbo|om-reasoning)/i.test(modelArg)) {
          targetProvider = 'om';
        } else if (agent.config.provider === 'vllm' || agent.config.provider === 'lmstudio') {
          targetProvider = agent.config.provider;
        } else {
          targetProvider = 'local';
        }
      } else {
        if (/^gemini/i.test(modelArg)) targetProvider = 'gemini';
        else if (/^(gpt|o1|o3|chatgpt)/i.test(modelArg)) targetProvider = 'openai';
        else if (/^claude/i.test(modelArg)) targetProvider = 'anthropic';
        else if (/^deepseek/i.test(modelArg)) targetProvider = 'deepseek';
        else if (/^(kimi|moonshot)/i.test(modelArg)) targetProvider = 'kimi';
        else if (/^(qwen|qwq)/i.test(modelArg)) targetProvider = 'qwen';
        else if (/^glm/i.test(modelArg)) targetProvider = 'glm';
        else if (/^(om-|om-v1|om-turbo|om-reasoning)/i.test(modelArg)) targetProvider = 'om';
      }
    }

    try {
      agent.setProvider(targetProvider, targetModel);
      const modeLabel = targetMode === 'cloud' ? 'Cloud' : 'Local';
      return {
        content: `Switched to **${modeLabel}** inference using provider \`${agent.config.provider}\` [**${agent.config.model}**].`,
        steps: [],
        success: true
      };
    } catch (err: any) {
      return {
        content: `Could not switch to **${targetMode.toUpperCase()}**: ${err.message}`,
        steps: [],
        success: false
      };
    }
  }

  if (trimmedPrompt === '/clear') {
    agent.clearCurrentSession();
    const completion = {
      content: 'Page cleared.',
      answer: 'Page cleared.',
      provider: agent.config.provider,
      model: agent.config.model,
      sessionId: agent.sessionId,
      steps: [],
      success: true
    };
    agent.emit('done', completion);
    return completion;
  }

  if (trimmedPrompt === '/new') {
    agent.reset();
    const msg = `Started new session: ${agent.sessionId}.`;
    const completion = {
      content: msg,
      answer: msg,
      provider: agent.config.provider,
      model: agent.config.model,
      sessionId: agent.sessionId,
      steps: [],
      success: true
    };
    agent.emit('done', completion);
    return completion;
  }

  const planMatch = trimmedPrompt.match(/^\/plan(?:\s+(on|off))?$/i);
  if (planMatch || trimmedPrompt.toLowerCase() === '/execute') {
    const nextPlan = trimmedPrompt.toLowerCase() === '/execute'
      ? false
      : planMatch?.[1]
        ? planMatch[1].toLowerCase() === 'on'
        : !agent.config.planMode;
    agent.config.planMode = nextPlan;
    const msg = nextPlan
      ? '**Plan Mode ON** (read-only exploration; no file mutations will be executed). Run `/execute` or `/plan off` when ready to implement.'
      : '**Plan Mode OFF** — execution mode active. Tools can now edit files and run commands.';
    const completion = {
      content: msg,
      answer: msg,
      provider: agent.config.provider,
      model: agent.config.model,
      sessionId: agent.sessionId,
      planMode: nextPlan,
      steps: [],
      success: true
    };
    agent.emit('done', completion);
    return completion;
  }

  return null;
}
