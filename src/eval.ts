import fs from 'node:fs';
import path from 'node:path';
import { OMAgent } from './agent.js';

/**
 * First-Class Skill & Prompt Eval Runner (`npx omega-agent eval <suite.json>`).
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
            passed: casePassed,
            latencyMs,
            steps: res.totalSteps || 0,
            usedTools,
            usage: res.usage || {},
            checks
          });
        } catch (err: any) {
          caseResults.push({
            id: tc.id || tc.prompt.slice(0, 40),
            passed: false,
            latencyMs: Date.now() - start,
            error: err.message
          });
        } finally {
          await agent.close();
        }
      }

      const total = caseResults.length;
      const avgLatencyMs = total ? Math.round(caseResults.reduce((s, c) => s + (c.latencyMs || 0), 0) / total) : 0;
      const avgSteps = total ? Number((caseResults.reduce((s, c) => s + (c.steps || 0), 0) / total).toFixed(2)) : 0;

      report.targets.push({
        provider: target.provider,
        model: target.model,
        total,
        passed,
        passRate: total ? Number(((passed / total) * 100).toFixed(1)) : 0,
        avgLatencyMs,
        avgSteps,
        cases: caseResults
      });
    }

    return report;
  }
}

