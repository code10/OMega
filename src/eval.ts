import fs from 'node:fs';
import path from 'node:path';
import { OMAgent } from './agent.js';
import { estimateCostUsd } from './audit.js';
import { SessionReplay, type SessionTape } from './replay.js';

export interface EvalRegressionThresholds {
  maxPassRateDrop?: number;
  maxAvgStepIncrease?: number;
  maxCostIncreaseUsd?: number;
}

export interface EvalBaselineComparison {
  passed: boolean;
  regressions: Array<{ target: string; caseId?: string; kind: string; detail: string }>;
  improvements: Array<{ target: string; caseId?: string; kind: string; detail: string }>;
  summary: {
    targetsCompared: number;
    regressionCount: number;
    improvementCount: number;
  };
}

/**
 * First-Class Skill, Prompt & Deterministic Replay Eval Runner (`npx omega-agent eval <suite.json>`).
 */
export class OMEvalRunner {
  static loadSuite(suitePath: string) {
    const abs = path.resolve(suitePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Eval suite not found: ${abs}`);
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.cases)) {
      throw new Error('Eval suite JSON must contain a "cases" array');
    }
    return parsed;
  }

  static saveReport(report: Record<string, any>, outPath: string): string {
    const abs = path.resolve(outPath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(report, null, 2) + '\n', 'utf8');
    return abs;
  }

  static loadReport(reportPath: string): Record<string, any> {
    const abs = path.resolve(reportPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Eval report not found: ${abs}`);
    }
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }

  /**
   * Compare a current eval report against a saved baseline to flag regressions.
   */
  static compareBaseline(
    baseline: Record<string, any>,
    current: Record<string, any>,
    thresholds: EvalRegressionThresholds = {}
  ): EvalBaselineComparison {
    const maxPassRateDrop = thresholds.maxPassRateDrop ?? 0;
    const maxAvgStepIncrease = thresholds.maxAvgStepIncrease ?? Infinity;
    const maxCostIncreaseUsd = thresholds.maxCostIncreaseUsd ?? Infinity;

    const regressions: EvalBaselineComparison['regressions'] = [];
    const improvements: EvalBaselineComparison['improvements'] = [];

    const baseTargets: any[] = Array.isArray(baseline?.targets) ? baseline.targets : [];
    const curTargets: any[] = Array.isArray(current?.targets) ? current.targets : [];
    let targetsCompared = 0;

    for (const curT of curTargets) {
      const targetKey = `${curT.provider}/${curT.model}`;
      const baseT = baseTargets.find((t) => `${t.provider}/${t.model}` === targetKey) || baseTargets[0];
      if (!baseT) continue;
      targetsCompared++;

      const passRateDrop = Number(baseT.passRate || 0) - Number(curT.passRate || 0);
      if (passRateDrop > maxPassRateDrop) {
        regressions.push({
          target: targetKey,
          kind: 'pass_rate_drop',
          detail: `Pass rate dropped from ${baseT.passRate}% to ${curT.passRate}% (-${passRateDrop.toFixed(1)}%)`
        });
      } else if (passRateDrop < 0) {
        improvements.push({
          target: targetKey,
          kind: 'pass_rate_gain',
          detail: `Pass rate improved from ${baseT.passRate}% to ${curT.passRate}% (+${Math.abs(passRateDrop).toFixed(1)}%)`
        });
      }

      const stepDiff = Number(curT.avgSteps || 0) - Number(baseT.avgSteps || 0);
      if (stepDiff > maxAvgStepIncrease) {
        regressions.push({
          target: targetKey,
          kind: 'step_bloat',
          detail: `Average steps increased from ${baseT.avgSteps} to ${curT.avgSteps} (+${stepDiff.toFixed(2)})`
        });
      }

      const costDiff = Number(curT.totalCostUsd || 0) - Number(baseT.totalCostUsd || 0);
      if (costDiff > maxCostIncreaseUsd) {
        regressions.push({
          target: targetKey,
          kind: 'cost_increase',
          detail: `Total cost increased from $${baseT.totalCostUsd || 0} to $${curT.totalCostUsd || 0}`
        });
      }

      const baseCasesById = new Map<string, any>();
      for (const c of baseT.cases || []) {
        baseCasesById.set(String(c.id), c);
      }

      for (const curC of curT.cases || []) {
        const prevC = baseCasesById.get(String(curC.id));
        if (!prevC) continue;
        if (prevC.passed && !curC.passed) {
          regressions.push({
            target: targetKey,
            caseId: String(curC.id),
            kind: 'case_regressed',
            detail: `Case '${curC.id}' previously passed and now fails`
          });
        } else if (!prevC.passed && curC.passed) {
          improvements.push({
            target: targetKey,
            caseId: String(curC.id),
            kind: 'case_fixed',
            detail: `Case '${curC.id}' previously failed and now passes`
          });
        }
      }
    }

    return {
      passed: regressions.length === 0,
      regressions,
      improvements,
      summary: {
        targetsCompared,
        regressionCount: regressions.length,
        improvementCount: improvements.length
      }
    };
  }

  static async runSuite(suite: Record<string, any>, options: Record<string, any> = {}) {
    const targets = Array.isArray(options.targets) && options.targets.length > 0
      ? options.targets
      : [{ provider: options.provider || suite.provider || 'om', model: options.model || suite.model || 'om-turbo' }];

    const report: { name: string; executedAt: string; targets: any[] } = {
      name: suite.name || 'OMega Eval Suite',
      executedAt: new Date().toISOString(),
      targets: []
    };

    for (const target of targets) {
      const caseResults = [];
      let passed = 0;

      for (const tc of suite.cases) {
        const start = Date.now();

        // Deterministic offline replay case (inline SessionTape or tapePath)
        if (tc.tape || tc.tapePath) {
          try {
            const tape: SessionTape = tc.tape || SessionReplay.loadTape(tc.tapePath);
            const diff = await SessionReplay.replayTape(tape, {
              agentOptions: options.agentOptions,
              providerInstance: tc.useTargetProvider ? target.providerInstance : undefined,
              liveTools: Boolean(tc.liveTools)
            });
            const latencyMs = Date.now() - start;
            const checks = [
              { type: 'toolSequenceMatch', expected: diff.expectedTools, ok: diff.toolSequenceMatch },
              { type: 'answersMatch', expected: diff.expectedAnswers, ok: diff.answersMatch }
            ];
            if (tc.maxStepsExpected) {
              checks.push({
                type: 'maxStepsExpected',
                expected: tc.maxStepsExpected,
                ok: diff.actualSteps <= tc.maxStepsExpected
              });
            }
            const casePassed = diff.passed && checks.every((c) => c.ok);
            if (casePassed) passed++;
            caseResults.push({
              id: tc.id || `replay:${tape.sourceSessionId}`,
              mode: 'replay',
              passed: casePassed,
              latencyMs,
              steps: diff.actualSteps,
              usedTools: diff.actualTools,
              usage: {},
              estimatedCostUsd: 0,
              replayDiff: {
                toolSequenceMatch: diff.toolSequenceMatch,
                answersMatch: diff.answersMatch,
                stepDelta: diff.stepDelta
              },
              checks
            });
          } catch (err: any) {
            caseResults.push({
              id: tc.id || tc.tapePath || 'replay_case',
              mode: 'replay',
              passed: false,
              latencyMs: Date.now() - start,
              estimatedCostUsd: 0,
              error: err.message
            });
          }
          continue;
        }

        const agent = new OMAgent({
          ...options.agentOptions,
          provider: target.provider,
          model: target.model,
          providerInstance: target.providerInstance
        });
        await agent.init();

        try {
          const res = await agent.run(tc.prompt, {
            maxSteps: tc.maxSteps || suite.maxSteps || 10,
            disableFailover: true
          });
          const latencyMs = Date.now() - start;
          const usedTools = (res.steps || []).flatMap((s: any) => (s.toolCalls || []).map((t: any) => t.name));
          const answerText = String(res.content || '');
          const estimatedCostUsd = estimateCostUsd(target.provider, res.model || target.model, res.usage);

          const checks = [];
          if (Array.isArray(tc.expectedTools)) {
            for (const expectedTool of tc.expectedTools) {
              checks.push({
                type: 'expectedTool',
                expected: expectedTool,
                ok: usedTools.includes(expectedTool)
              });
            }
          }
          if (Array.isArray(tc.mustContain)) {
            for (const substr of tc.mustContain) {
              checks.push({
                type: 'mustContain',
                expected: substr,
                ok: answerText.toLowerCase().includes(String(substr).toLowerCase())
              });
            }
          }
          const semanticAssertions = tc.semanticAssertions || tc.layaAssertions;
          if (Array.isArray(semanticAssertions) && agent.systemOne?.isConfigured()) {
            for (const assertion of semanticAssertions) {
              const evalRes = await agent.systemOne.evaluateAssertion(tc.prompt, answerText, String(assertion));
              if (evalRes) {
                checks.push({
                  type: 'semanticAssertion',
                  expected: assertion,
                  score: evalRes.score,
                  ok: evalRes.ok
                });
              }
            }
          }
          if (tc.maxStepsExpected) {
            checks.push({
              type: 'maxStepsExpected',
              expected: tc.maxStepsExpected,
              ok: (res.totalSteps || 0) <= tc.maxStepsExpected
            });
          }

          const casePassed = Boolean(res.success) && checks.every((c) => c.ok);
          if (casePassed) passed++;

          caseResults.push({
            id: tc.id || tc.prompt.slice(0, 40),
            mode: 'live',
            passed: casePassed,
            latencyMs,
            steps: res.totalSteps || 0,
            usedTools,
            usage: res.usage || {},
            estimatedCostUsd,
            checks
          });
        } catch (err: any) {
          caseResults.push({
            id: tc.id || tc.prompt.slice(0, 40),
            mode: 'live',
            passed: false,
            latencyMs: Date.now() - start,
            estimatedCostUsd: 0,
            error: err.message
          });
        } finally {
          await agent.close();
        }
      }

      const total = caseResults.length;
      const avgLatencyMs = total ? Math.round(caseResults.reduce((s, c) => s + (c.latencyMs || 0), 0) / total) : 0;
      const avgSteps = total ? Number((caseResults.reduce((s, c) => s + (c.steps || 0), 0) / total).toFixed(2)) : 0;
      const totalCostUsd = Math.round(
        caseResults.reduce((s, c) => s + Number(c.estimatedCostUsd || 0), 0) * 1_000_000
      ) / 1_000_000;

      report.targets.push({
        provider: target.provider,
        model: target.model,
        total,
        passed,
        passRate: total ? Number(((passed / total) * 100).toFixed(1)) : 0,
        avgLatencyMs,
        avgSteps,
        totalCostUsd,
        cases: caseResults
      });
    }

    return report;
  }
}
