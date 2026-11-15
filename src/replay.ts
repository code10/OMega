import { OMAgent } from './agent.js';

/**
 * Time-Travel Replay, Step Forking & Model Diffing ("Git for Agent Runs").
 */
export class SessionReplay {
  /**
   * Fork an existing session from a specific 1-based step index into a brand new session.
   * Preserves history up through that step (with optional tool result override) so execution can branch.
   */
  static forkFromStep(memory: any, sessionId: string, stepIndex: number, options: Record<string, any> = {}) {
    const source = memory.loadSession(sessionId);
    if (!source) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const steps = Array.isArray(source.steps) ? source.steps : [];
    const targetStep = Math.max(1, Math.min(Number(stepIndex) || 1, steps.length || 1));

    // Reconstruct clean message history up to targetStep
    const sourceHistory = Array.isArray(source.history) ? source.history : [];
    const forkedHistory = [];
    let assistantTurnsSeen = 0;

    for (const msg of sourceHistory) {
      forkedHistory.push(structuredClone(msg));
      if (msg.role === 'assistant') {
        assistantTurnsSeen++;
        if (assistantTurnsSeen >= targetStep && (!msg.toolCalls || msg.toolCalls.length === 0)) {
          break;
        }
      } else if (msg.role === 'tool' && assistantTurnsSeen >= targetStep) {
        // Continue until all tool messages for targetStep are included, then stop before next assistant
        const nextIdx = forkedHistory.length;
        const nextMsg = sourceHistory[nextIdx];
        if (!nextMsg || nextMsg.role !== 'tool') {
          break;
        }
      }
    }

    if (options.overrideToolResult && forkedHistory.length > 0) {
      for (let i = forkedHistory.length - 1; i >= 0; i--) {
        if (forkedHistory[i].role === 'tool') {
          forkedHistory[i].content = typeof options.overrideToolResult === 'string'
            ? options.overrideToolResult
            : JSON.stringify(options.overrideToolResult);
          break;
        }
      }
    }

    const newSessionId = options.newSessionId || memory.getNextSessionId();
    const forkedSession = {
      sessionId: newSessionId,
      forkedFrom: { sessionId, step: targetStep, timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
      provider: source.provider,
      model: source.model,
      target: source.target,
      answers: [],
      history: forkedHistory,
      steps: steps.slice(0, targetStep)
    };
    memory.saveSession(newSessionId, forkedSession);
    return forkedSession;
  }

  /**
   * Deterministically replay a saved session's prompt(s) using recorded tool outputs
   * instead of re-executing side-effecting tools.
   */
  static async deterministicReplay(agent: any, sessionId: string, options: Record<string, any> = {}) {
    const source = agent.memory.loadSession(sessionId);
    if (!source) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const recordedToolQueue: Array<{ name: string; args: any; result: any }> = [];
    for (const step of source.steps || []) {
      for (const tc of step.toolCalls || []) {
        recordedToolQueue.push({ name: tc.name, args: tc.args, result: tc.result });
      }
    }

    const originalExecute = agent.skills.execute.bind(agent.skills);
    let cursor = 0;

    if (options.mockTools !== false) {
      agent.skills.execute = async (name: string, args: any, ctx: any) => {
        const matchIdx = recordedToolQueue.findIndex((item, idx) => idx >= cursor && item.name === name);
        if (matchIdx !== -1) {
          cursor = matchIdx + 1;
          return structuredClone(recordedToolQueue[matchIdx].result);
        }
        return originalExecute(name, args, ctx);
      };
    }

    const prompts = (source.answers || []).map((a: any) => a.prompt).filter(Boolean);
    const results = [];
    try {
      agent.reset();
      for (const p of prompts) {
        results.push(await agent.run(p, { disableFailover: options.disableFailover }));
      }
    } finally {
      agent.skills.execute = originalExecute;
    }

    return {
      sourceSessionId: sessionId,
      replaySessionId: agent.sessionId,
      promptsReplayed: prompts.length,
      results
    };
  }

  /**
   * Run the same prompt across multiple provider/model pairs and return a structured comparison.
   */
  static async compareModels(baseOptions: Record<string, any>, prompt: string, targets: Array<Record<string, any>> = []) {
    const comparisons = [];
    for (const target of targets) {
      const start = Date.now();
      const agent = new OMAgent({
        ...baseOptions,
        provider: target.provider,
        model: target.model,
        providerInstance: target.providerInstance
      });
      await agent.init();
      try {
        const res = await agent.run(prompt, { disableFailover: true });
        comparisons.push({
          provider: target.provider,
          model: res.model || target.model,
          success: Boolean(res.success),
          latencyMs: Date.now() - start,
          totalSteps: res.totalSteps || res.steps?.length || 0,
          toolCalls: (res.steps || []).flatMap((s: any) => (s.toolCalls || []).map((t: any) => t.name)),
          usage: res.usage || {},
          answer: res.content
        });
      } catch (err: any) {
        comparisons.push({
          provider: target.provider,
          model: target.model,
          success: false,
          latencyMs: Date.now() - start,
          error: err.message
        });
      } finally {
        await agent.close();
      }
    }
    return { prompt, comparedAt: new Date().toISOString(), results: comparisons };
  }
}

