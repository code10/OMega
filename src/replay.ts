import fs from 'node:fs';
import path from 'node:path';
import { OMAgent } from './agent.js';
import { BaseProvider } from './providers/base.js';
import type { ProviderChatOptions, ProviderChatResult, ToolCall } from './types.js';

export interface SessionTapeTurn {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface SessionTapeToolResult {
  name: string;
  args?: Record<string, unknown>;
  result: unknown;
}

export interface SessionTape {
  version: 1;
  sourceSessionId: string;
  recordedAt: string;
  provider: string;
  model: string;
  prompts: string[];
  turns: SessionTapeTurn[];
  toolResults: SessionTapeToolResult[];
  expectedAnswers: string[];
  expectedTools: string[];
}

export interface ReplayDiffResult {
  sourceSessionId: string;
  replaySessionId: string;
  passed: boolean;
  promptsReplayed: number;
  expectedTools: string[];
  actualTools: string[];
  toolSequenceMatch: boolean;
  expectedAnswers: string[];
  actualAnswers: string[];
  answersMatch: boolean;
  expectedSteps: number;
  actualSteps: number;
  stepDelta: number;
  results: any[];
}

/**
 * Deterministic offline LLM provider that replays recorded assistant turns
 * (content + toolCalls + usage) with zero network calls.
 */
export class ReplayProvider extends BaseProvider {
  readonly turns: SessionTapeTurn[];
  cursor: number;

  constructor(turns: SessionTapeTurn[], options: { name?: string; model?: string } = {}) {
    super({
      name: options.name || 'replay',
      model: options.model || 'replay-deterministic'
    });
    this.turns = Array.isArray(turns) ? turns.map((t) => structuredClone(t)) : [];
    this.cursor = 0;
  }

  reset() {
    this.cursor = 0;
  }

  async chat(_params: ProviderChatOptions): Promise<ProviderChatResult> {
    if (this.cursor >= this.turns.length) {
      return {
        content: '[ReplayProvider] End of recorded tape reached.',
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      };
    }
    const turn = this.turns[this.cursor++];
    return {
      content: String(turn.content || ''),
      toolCalls: Array.isArray(turn.toolCalls) ? structuredClone(turn.toolCalls) : [],
      usage: turn.usage
        ? {
            promptTokens: Number(turn.usage.promptTokens || 0),
            completionTokens: Number(turn.usage.completionTokens || 0),
            totalTokens: Number(
              turn.usage.totalTokens ||
                (Number(turn.usage.promptTokens || 0) + Number(turn.usage.completionTokens || 0))
            )
          }
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }
}

/**
 * Time-Travel Replay, Step Forking, Deterministic Session Tapes & Model Diffing ("Git for Agent Runs").
 */
export class SessionReplay {
  /**
   * Export a saved session into a portable, deterministic SessionTape (LLM turns + tool outputs).
   */
  static exportTape(memory: any, sessionId: string): SessionTape {
    const source = memory.loadSession(sessionId);
    if (!source) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const history = Array.isArray(source.history) ? source.history : [];
    const steps = Array.isArray(source.steps) ? source.steps : [];
    const answers = Array.isArray(source.answers) ? source.answers : [];

    const turns: SessionTapeTurn[] = [];
    for (const msg of history) {
      if (msg.role === 'assistant') {
        turns.push({
          content: String(msg.content || ''),
          toolCalls: Array.isArray(msg.toolCalls) ? structuredClone(msg.toolCalls) : []
        });
      }
    }

    const toolResults: SessionTapeToolResult[] = [];
    const expectedTools: string[] = [];
    for (const step of steps) {
      for (const tc of step.toolCalls || []) {
        expectedTools.push(String(tc.name));
        toolResults.push({
          name: String(tc.name),
          args: tc.args ? structuredClone(tc.args) : {},
          result: structuredClone(tc.result)
        });
      }
    }

    const prompts = answers.map((a: any) => String(a.prompt || '')).filter(Boolean);
    const expectedAnswers = answers.map((a: any) => String(a.answer || ''));

    return {
      version: 1,
      sourceSessionId: sessionId,
      recordedAt: source.timestamp || new Date().toISOString(),
      provider: String(source.provider || 'om'),
      model: String(source.model || 'om-turbo'),
      prompts,
      turns,
      toolResults,
      expectedAnswers,
      expectedTools
    };
  }

  static saveTape(tape: SessionTape, filePath: string): string {
    const abs = path.resolve(filePath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(tape, null, 2) + '\n', 'utf8');
    return abs;
  }

  static loadTape(filePath: string): SessionTape {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Session tape not found: ${abs}`);
    }
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as SessionTape;
    if (!Array.isArray(parsed.prompts) || !Array.isArray(parsed.turns)) {
      throw new Error('Invalid session tape: missing "prompts" or "turns" arrays');
    }
    return parsed;
  }

  /**
   * Deterministically replay a recorded SessionTape offline through OMAgent
   * (using ReplayProvider + recorded tool outputs by default) and diff against the baseline.
   */
  static async replayTape(
    tape: SessionTape,
    options: {
      agentOptions?: Record<string, any>;
      providerInstance?: any;
      liveTools?: boolean;
      disableFailover?: boolean;
    } = {}
  ): Promise<ReplayDiffResult> {
    const providerInstance =
      options.providerInstance ||
      new ReplayProvider(tape.turns, { name: 'replay', model: tape.model || 'replay-deterministic' });

    const agent = new OMAgent({
      ...options.agentOptions,
      provider: providerInstance.name || 'om',
      model: providerInstance.model || tape.model || 'om-turbo',
      providerInstance
    });
    await agent.init();

    const originalExecute = agent.skills.execute.bind(agent.skills);
    const queue = Array.isArray(tape.toolResults) ? tape.toolResults : [];
    let cursor = 0;

    if (!options.liveTools) {
      agent.skills.execute = async (name: string, args: any, ctx: any) => {
        const matchIdx = queue.findIndex((item, idx) => idx >= cursor && item.name === name);
        if (matchIdx !== -1) {
          cursor = matchIdx + 1;
          return structuredClone(queue[matchIdx].result) as any;
        }
        return originalExecute(name, args, ctx);
      };
    }

    const results: any[] = [];
    try {
      for (const prompt of tape.prompts) {
        results.push(
          await agent.run(prompt, {
            disableFailover: options.disableFailover ?? true,
            stream: false
          })
        );
      }
    } finally {
      agent.skills.execute = originalExecute;
      await agent.close();
    }

    const actualTools = results.flatMap((r) =>
      (r.steps || []).flatMap((s: any) => (s.toolCalls || []).map((t: any) => String(t.name)))
    );
    const actualAnswers = results.map((r) => String(r.content || ''));
    const actualSteps = results.reduce((sum, r) => sum + Number(r.totalSteps || 0), 0);
    const expectedSteps = tape.turns.length;

    const toolSequenceMatch =
      tape.expectedTools.length === actualTools.length &&
      tape.expectedTools.every((t, i) => t === actualTools[i]);
    const answersMatch =
      tape.expectedAnswers.length === actualAnswers.length &&
      tape.expectedAnswers.every((a, i) => a.trim() === actualAnswers[i].trim());

    return {
      sourceSessionId: tape.sourceSessionId,
      replaySessionId: agent.sessionId,
      passed: results.every((r) => Boolean(r.success)) && toolSequenceMatch && answersMatch,
      promptsReplayed: tape.prompts.length,
      expectedTools: tape.expectedTools,
      actualTools,
      toolSequenceMatch,
      expectedAnswers: tape.expectedAnswers,
      actualAnswers,
      answersMatch,
      expectedSteps,
      actualSteps,
      stepDelta: actualSteps - expectedSteps,
      results
    };
  }

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
