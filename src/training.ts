import fs from 'node:fs';
import path from 'node:path';
import { OMEvalRunner } from './eval.js';

/**
 * Tier 2: Continuous Fine-Tuning Data Pipeline (SFT + DPO) & Eval-Gated Adapter Promotion.
 */
export class OMTrainingPipeline {
  /**
   * Convert an internal OMega history array into OpenAI-compatible chat+tool training messages.
   */
  static toTrainingMessages(history: any[] = [], systemPrompt = '') {
    const msgs: any[] = [];
    if (systemPrompt) {
      msgs.push({ role: 'system', content: systemPrompt });
    }
    for (const m of history) {
      if (m.role === 'user') {
        msgs.push({ role: 'user', content: String(m.content || '') });
      } else if (m.role === 'assistant') {
        const entry: Record<string, any> = { role: 'assistant', content: String(m.content || '') };
        if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          entry.tool_calls = m.toolCalls.map((tc: any) => ({
            id: tc.id || `call_${tc.name}`,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {})
            }
          }));
        }
        msgs.push(entry);
      } else if (m.role === 'tool') {
        msgs.push({
          role: 'tool',
          tool_call_id: m.toolCallId || m.name,
          name: m.name,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        });
      }
    }
    return msgs;
  }

  /**
   * Record a DPO preference pair (chosen vs rejected) into memory/preferences.jsonl.
   */
  static recordPreference(memoryDir: string, { prompt, chosen, rejected, metadata = {} }: Record<string, any>) {
    fs.mkdirSync(memoryDir, { recursive: true });
    const filePath = path.join(memoryDir, 'preferences.jsonl');
    const record = {
      timestamp: new Date().toISOString(),
      prompt,
      chosen,
      rejected,
      metadata
    };
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    return { success: true, path: filePath };
  }

  /**
   * Harvest SFT (sft.jsonl) and DPO (dpo.jsonl) datasets from saved session traces & preference logs.
   */
  static exportDataset(memoryDir: string, outputDir?: string, options: Record<string, any> = {}) {
    const sessionsDir = path.join(memoryDir, 'sessions');
    const outDir = path.resolve(outputDir || path.join(memoryDir, 'training'));
    fs.mkdirSync(outDir, { recursive: true });

    const sftRecords = [];
    const dpoRecords = [];
    const byPrompt = new Map();

    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        let sess;
        try {
          sess = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        } catch (_) {
          continue;
        }

        const history = Array.isArray(sess.history) ? sess.history : [];
        const steps = Array.isArray(sess.steps) ? sess.steps : [];
        const answers = Array.isArray(sess.answers) ? sess.answers : [];
        if (history.length < 2) continue;

        const hadToolError = steps.some((s: any) => (s.toolCalls || []).some((t: any) => t.result?.success === false));
        const lastAnswer = answers[answers.length - 1];
        const finalText = lastAnswer?.answer || '';
        const isCleanSuccess = !hadToolError && !String(finalText).includes('[OM Notice]');

        if (isCleanSuccess) {
          const messages = OMTrainingPipeline.toTrainingMessages(history, options.systemPrompt);
          sftRecords.push({
            messages,
            metadata: {
              sessionId: sess.sessionId || file,
              provider: sess.provider,
              model: sess.model,
              target: sess.target,
              stepsCount: steps.length
            }
          });
        }

        if (lastAnswer?.prompt) {
          const key = String(lastAnswer.prompt).trim();
          if (!byPrompt.has(key)) byPrompt.set(key, []);
          byPrompt.get(key).push({ sess, isCleanSuccess, stepsCount: steps.length, answer: finalText });
        }
      }
    }

    // Build automatic DPO pairs whenever same prompt has a clean/cloud success vs failed/longer local attempt
    for (const [prompt, attempts] of byPrompt.entries()) {
      const winners = attempts.filter((a: any) => a.isCleanSuccess);
      const losers = attempts.filter((a: any) => !a.isCleanSuccess);
      if (winners.length > 0 && losers.length > 0) {
        dpoRecords.push({
          prompt,
          chosen: winners[0].answer,
          rejected: losers[0].answer,
          metadata: { source: 'session_contrast' }
        });
      }
    }

    // Include explicit preferences.jsonl if present
    const prefPath = path.join(memoryDir, 'preferences.jsonl');
    if (fs.existsSync(prefPath)) {
      for (const line of fs.readFileSync(prefPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          dpoRecords.push(JSON.parse(line));
        } catch (_) {}
      }
    }

    const sftPath = path.join(outDir, 'sft.jsonl');
    const dpoPath = path.join(outDir, 'dpo.jsonl');
    fs.writeFileSync(sftPath, sftRecords.map((r) => JSON.stringify(r)).join('\n') + (sftRecords.length ? '\n' : ''), 'utf8');
    fs.writeFileSync(dpoPath, dpoRecords.map((r) => JSON.stringify(r)).join('\n') + (dpoRecords.length ? '\n' : ''), 'utf8');

    return {
      success: true,
      outputDir: outDir,
      sftCount: sftRecords.length,
      dpoCount: dpoRecords.length,
      sftPath,
      dpoPath
    };
  }

  /**
   * Gate adapter promotion using OMEvalRunner: only promote if candidate >= baseline.
   */
  static async evaluateForPromotion(suite: Record<string, any>, { baselineTarget, candidateTarget, agentOptions = {} }: Record<string, any>) {
    const report = await OMEvalRunner.runSuite(suite, {
      targets: [baselineTarget, candidateTarget],
      agentOptions
    });
    const [baseline, candidate] = report.targets;
    const improvedOrEqual =
      candidate.passRate > baseline.passRate ||
      (candidate.passRate === baseline.passRate && candidate.avgSteps <= baseline.avgSteps);

    return {
      promote: Boolean(improvedOrEqual),
      baseline,
      candidate,
      report
    };
  }
}
