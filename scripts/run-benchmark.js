#!/usr/bin/env node
/**
 * OMega Real-Repo / SWE-Style Coding Benchmark & Regression Gate Runner
 *
 * Usage:
 *   node scripts/run-benchmark.js                                    # Deterministic offline harness check
 *   node scripts/run-benchmark.js --live                             # Live LLM benchmark (uses configured provider/keys)
 *   node scripts/run-benchmark.js --live --provider=gemini --model=gemini-3.5-flash
 *   node scripts/run-benchmark.js --suite=benchmarks/swe-suite.json --task=lru-cache-eviction-bug
 *   node scripts/run-benchmark.js --baseline=benchmarks/baseline.json --markdown=benchmark-summary.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { OMAgent, OMEvalRunner, estimateCostUsd } from '../dist/index.js';

function parseArgs(argv) {
  const opts = {
    live: argv.includes('--live'),
    suite: path.resolve('./benchmarks/swe-suite.json'),
    task: null,
    provider: null,
    model: null,
    baseline: null,
    saveBaseline: null,
    markdown: null,
    reportPath: path.resolve('./memory/benchmark-report.json')
  };
  for (const arg of argv) {
    if (arg.startsWith('--suite=')) opts.suite = path.resolve(arg.slice('--suite='.length));
    else if (arg.startsWith('--task=')) opts.task = arg.slice('--task='.length);
    else if (arg.startsWith('--provider=')) opts.provider = arg.slice('--provider='.length);
    else if (arg.startsWith('--model=')) opts.model = arg.slice('--model='.length);
    else if (arg.startsWith('--baseline=')) opts.baseline = path.resolve(arg.slice('--baseline='.length));
    else if (arg.startsWith('--save-baseline=')) opts.saveBaseline = path.resolve(arg.slice('--save-baseline='.length));
    else if (arg.startsWith('--markdown=')) opts.markdown = path.resolve(arg.slice('--markdown='.length));
    else if (arg.startsWith('--report=')) opts.reportPath = path.resolve(arg.slice('--report='.length));
  }
  return opts;
}

function hasLiveKey() {
  return Boolean(
    process.env.GEMINI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.GLM_API_KEY ||
    process.env.VLLM_BASE_URL ||
    process.env.OLLAMA_BASE_URL
  );
}

/**
 * Built-in deterministic reference solutions used ONLY in offline/CI smoke mode
 * (when --live is not passed) to validate the benchmark runner, hidden holdout grader,
 * git repo setup, and baseline regression comparison with zero API cost.
 */
const DETERMINISTIC_SOLUTIONS = {
  'multi-file-auth-refactor': [
    {
      path: 'src/auth.js',
      content: "export function verifyToken(token, now = Date.now()) {\n  if (!token || typeof token !== 'object') return { valid: false, reason: 'missing' };\n  if (typeof token.exp === 'number' && token.exp <= now) return { valid: false, reason: 'expired' };\n  return { valid: true, user: token.user, role: token.role || 'viewer' };\n}\n"
    },
    {
      path: 'src/middleware.js',
      content: "import { verifyToken } from './auth.js';\n\nexport function authorize(token, requiredRole, now = Date.now()) {\n  const res = verifyToken(token, now);\n  if (!res.valid) return { allowed: false, status: 401, reason: res.reason };\n  if (requiredRole && String(res.role).toLowerCase() !== String(requiredRole).toLowerCase()) {\n    return { allowed: false, status: 403, reason: 'forbidden' };\n  }\n  return { allowed: true, status: 200, user: res.user };\n}\n"
    }
  ],
  'lru-cache-eviction-bug': [
    {
      path: 'src/lru.js',
      content: "export class LRUCache {\n  constructor(capacity = 2) {\n    this.capacity = capacity;\n    this.map = new Map();\n  }\n  _purgeExpired(now) {\n    for (const [k, v] of this.map.entries()) {\n      if (v.expiresAt > 0 && v.expiresAt <= now) this.map.delete(k);\n    }\n  }\n  get(key, now = Date.now()) {\n    const entry = this.map.get(key);\n    if (!entry) return undefined;\n    if (entry.expiresAt > 0 && entry.expiresAt <= now) {\n      this.map.delete(key);\n      return undefined;\n    }\n    this.map.delete(key);\n    this.map.set(key, entry);\n    return entry.value;\n  }\n  set(key, value, ttlMs = 0, now = Date.now()) {\n    this._purgeExpired(now);\n    if (this.map.has(key)) this.map.delete(key);\n    this.map.set(key, { value, expiresAt: ttlMs > 0 ? now + ttlMs : 0 });\n    if (this.map.size > this.capacity) {\n      const oldestKey = this.map.keys().next().value;\n      this.map.delete(oldestKey);\n    }\n  }\n}\n"
    }
  ],
  'async-queue-concurrency': [
    {
      path: 'src/pool.js',
      content: "export async function mapPool(items, concurrency, worker) {\n  if (!items.length) return [];\n  const limit = Math.max(1, Math.min(concurrency, items.length));\n  const results = new Array(items.length);\n  let nextIndex = 0;\n  async function runWorker() {\n    while (nextIndex < items.length) {\n      const idx = nextIndex++;\n      results[idx] = await worker(items[idx], idx);\n    }\n  }\n  await Promise.all(Array.from({ length: limit }, () => runWorker()));\n  return results;\n}\n"
    }
  ],
  'csv-parser-quoted-fields': [
    {
      path: 'src/csv.js',
      content: "export function parseCsv(input) {\n  if (!input) return [];\n  const rows = [];\n  let row = [];\n  let field = '';\n  let inQuotes = false;\n  for (let i = 0; i < input.length; i++) {\n    const ch = input[i];\n    if (inQuotes) {\n      if (ch === '\"') {\n        if (input[i + 1] === '\"') { field += '\"'; i++; }\n        else { inQuotes = false; }\n      } else {\n        field += ch;\n      }\n    } else if (ch === '\"') {\n      inQuotes = true;\n    } else if (ch === ',') {\n      row.push(field); field = '';\n    } else if (ch === '\\r') {\n      if (input[i + 1] === '\\n') i++;\n      row.push(field); rows.push(row); row = []; field = '';\n    } else if (ch === '\\n') {\n      row.push(field); rows.push(row); row = []; field = '';\n    } else {\n      field += ch;\n    }\n  }\n  if (field.length > 0 || row.length > 0) {\n    row.push(field);\n    rows.push(row);\n  }\n  return rows;\n}\n"
    }
  ],
  'deep-merge-prototype-pollution': [
    {
      path: 'src/merge.js',
      content: "const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);\nexport function deepMerge(target, source) {\n  const out = { ...target };\n  for (const key of Object.keys(source || {})) {\n    if (BLOCKED.has(key)) continue;\n    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {\n      out[key] = deepMerge(out[key] || {}, source[key]);\n    } else {\n      out[key] = source[key];\n    }\n  }\n  return out;\n}\n"
    }
  ],
  'semver-comparator-prerelease': [
    {
      path: 'src/parse.js',
      content: "export function parseSemver(v) {\n  const noBuild = String(v).replace(/^v/, '').split('+')[0];\n  const dashIdx = noBuild.indexOf('-');\n  const core = dashIdx >= 0 ? noBuild.slice(0, dashIdx) : noBuild;\n  const pre = dashIdx >= 0 ? noBuild.slice(dashIdx + 1).split('.') : [];\n  const [major, minor, patch] = core.split('.').map(Number);\n  return { major, minor, patch, prerelease: pre };\n}\n"
    },
    {
      path: 'src/compare.js',
      content: "import { parseSemver } from './parse.js';\n\nexport function compareSemver(a, b) {\n  const pa = parseSemver(a);\n  const pb = parseSemver(b);\n  for (const k of ['major', 'minor', 'patch']) {\n    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;\n  }\n  const la = pa.prerelease.length;\n  const lb = pb.prerelease.length;\n  if (la === 0 && lb === 0) return 0;\n  if (la === 0) return 1;\n  if (lb === 0) return -1;\n  for (let i = 0; i < Math.max(la, lb); i++) {\n    if (i >= la) return -1;\n    if (i >= lb) return 1;\n    const ia = pa.prerelease[i];\n    const ib = pb.prerelease[i];\n    if (ia === ib) continue;\n    const na = /^\\d+$/.test(ia);\n    const nb = /^\\d+$/.test(ib);\n    if (na && nb) return Number(ia) > Number(ib) ? 1 : -1;\n    if (na) return -1;\n    if (nb) return 1;\n    return ia > ib ? 1 : -1;\n  }\n  return 0;\n}\n"
    }
  ]
};

function createDeterministicProvider(taskId) {
  let step = 0;
  const edits = DETERMINISTIC_SOLUTIONS[taskId] || [];
  return {
    name: 'eval-mock',
    model: 'deterministic-harness',
    async chat() {
      step += 1;
      if (step === 1 && edits.length > 0) {
        return {
          content: `Applying reference fix for ${taskId}.`,
          toolCalls: edits.map((e, i) => ({
            id: `call_${i + 1}`,
            name: 'write_file',
            args: { path: e.path, content: e.content }
          })),
          usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 }
        };
      }
      return {
        content: `Completed ${taskId}.`,
        toolCalls: [],
        usage: { promptTokens: 150, completionTokens: 20, totalTokens: 170 }
      };
    }
  };
}

function initTaskRepo(taskDir, task) {
  if (task.repoUrl) {
    execFileSync('git', ['clone', '--depth', '50', task.repoUrl, taskDir], { stdio: 'pipe' });
    if (task.baseCommit) {
      execFileSync('git', ['checkout', task.baseCommit], { cwd: taskDir, stdio: 'pipe' });
    }
    return;
  }

  for (const [relPath, content] of Object.entries(task.files || {})) {
    const abs = path.join(taskDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  try {
    execFileSync('git', ['init'], { cwd: taskDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'bench@omega.local'], { cwd: taskDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'OMega Benchmark'], { cwd: taskDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: taskDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: taskDir, stdio: 'ignore' });
  } catch {
    // Non-fatal if git is unavailable
  }
}

function runShellCheck(cmd, cwd) {
  try {
    execSync(cmd, { cwd, stdio: 'pipe', timeout: 60000 });
    return { ok: true, output: '' };
  } catch (err) {
    const out = [err?.stdout?.toString?.(), err?.stderr?.toString?.(), err?.message].filter(Boolean).join('\n').trim();
    return { ok: false, output: out.slice(0, 1200) };
  }
}

function buildMarkdownSummary(report, baselineDiff) {
  const t = report.targets[0];
  const lines = [
    `## OMega SWE-Style Coding Benchmark (${report.mode})`,
    '',
    `- **Target:** \`${t.provider}/${t.model}\``,
    `- **Pass Rate:** **${t.passRate}%** (${t.passed}/${t.total})`,
    `- **Avg Steps:** ${t.avgSteps} | **Avg Latency:** ${t.avgLatencyMs}ms | **Total Cost:** $${t.totalCostUsd}`,
    '',
    '| Task | Category | Public | Hidden | Steps | Latency | Tokens | Cost | Status |',
    '| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |'
  ];
  for (const c of t.cases) {
    lines.push(
      `| \`${c.id}\` | ${c.category || '-'} | ${c.publicPassed ? '✅' : '❌'} | ${c.hiddenPassed ? '✅' : '❌'} | ${c.steps} | ${c.latencyMs}ms | ${c.usage?.totalTokens || 0} | $${c.estimatedCostUsd} | ${c.passed ? 'PASS' : c.failureCategory} |`
    );
  }
  if (baselineDiff) {
    lines.push('', `### Baseline Comparison: ${baselineDiff.passed ? '✅ No Regressions' : '❌ Regressions Detected'}`);
    for (const r of baselineDiff.regressions) lines.push(`- ❌ **${r.kind}**: ${r.detail}`);
    for (const imp of baselineDiff.improvements) lines.push(`- ✅ **${imp.kind}**: ${imp.detail}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.live && !hasLiveKey()) {
    console.error('Error: --live requires an LLM provider API key (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GLM_API_KEY) or local endpoint.');
    process.exit(1);
  }

  const suite = JSON.parse(fs.readFileSync(opts.suite, 'utf8'));
  const tasks = opts.task
    ? (suite.tasks || []).filter((t) => t.id === opts.task)
    : (suite.tasks || []);

  if (tasks.length === 0) {
    console.error(`No benchmark tasks matched in ${opts.suite}`);
    process.exit(1);
  }

  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-swe-bench-'));
  const cases = [];
  let activeProvider = opts.provider || (opts.live ? undefined : 'eval-mock');
  let activeModel = opts.model || (opts.live ? undefined : 'deterministic-harness');

  try {
    for (const task of tasks) {
      const taskDir = path.join(benchRoot, task.id);
      const memDir = path.join(benchRoot, `${task.id}_mem`);
      fs.mkdirSync(taskDir, { recursive: true });
      initTaskRepo(taskDir, task);

      const startedAt = Date.now();
      const agent = new OMAgent({
        workspaceDir: taskDir,
        memoryDir: memDir,
        maxSteps: task.maxSteps || 12,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.live ? {} : { providerInstance: createDeterministicProvider(task.id) }),
        security: {
          allowAllCommands: true,
          requireConfirmationForShell: false,
          requireConfirmationForTools: []
        },
        ...(task.publicTestCommand
          ? { verification: { enabled: true, onCodeEdit: [task.publicTestCommand], maxRetries: 2 } }
          : {})
      });
      await agent.init();

      let res = null;
      let runError = null;
      try {
        res = await agent.run(task.prompt, { maxSteps: task.maxSteps || 12 });
        activeProvider = res?.provider || agent.config.provider;
        activeModel = res?.model || agent.config.model;
      } catch (err) {
        runError = err?.message || String(err);
      } finally {
        await agent.close?.();
      }

      // Grade 1: Public tests
      const pubRes = task.publicTestCommand ? runShellCheck(task.publicTestCommand, taskDir) : { ok: true, output: '' };

      // Grade 2: Write hidden holdout tests AFTER agent completes, then run them
      for (const [relPath, content] of Object.entries(task.hiddenFiles || {})) {
        const abs = path.join(taskDir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      }
      const hidRes = task.hiddenTestCommand ? runShellCheck(task.hiddenTestCommand, taskDir) : { ok: true, output: '' };

      const passed = !runError && pubRes.ok && hidRes.ok;
      const failureCategory = passed
        ? 'passed'
        : runError
          ? 'runtime_error'
          : !pubRes.ok
            ? 'public_test_failure'
            : 'hidden_test_failure';

      const latencyMs = Date.now() - startedAt;
      const usage = res?.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const costUsd = opts.live ? estimateCostUsd(activeProvider, activeModel, usage) : 0;
      const usedTools = (res?.steps || []).flatMap((s) => (s.toolCalls || []).map((tc) => tc.name));

      cases.push({
        id: task.id,
        title: task.title,
        category: task.category || 'coding',
        mode: opts.live ? 'live' : 'deterministic',
        passed,
        publicPassed: pubRes.ok,
        hiddenPassed: hidRes.ok,
        failureCategory,
        latencyMs,
        steps: res?.totalSteps ?? res?.steps?.length ?? 0,
        usedTools,
        usage,
        estimatedCostUsd: costUsd,
        error: runError || (!pubRes.ok ? pubRes.output : !hidRes.ok ? hidRes.output : null)
      });
    }
  } finally {
    try {
      fs.rmSync(benchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore Windows cleanup race
    }
  }

  const passedCount = cases.filter((c) => c.passed).length;
  const totalSteps = cases.reduce((acc, c) => acc + c.steps, 0);
  const totalLatency = cases.reduce((acc, c) => acc + c.latencyMs, 0);
  const totalCostUsd = Number(cases.reduce((acc, c) => acc + c.estimatedCostUsd, 0).toFixed(6));

  const report = {
    name: suite.name || 'OMega SWE-Style Coding Benchmark',
    executedAt: new Date().toISOString(),
    mode: opts.live ? 'live' : 'deterministic',
    targets: [
      {
        provider: activeProvider || 'unknown',
        model: activeModel || 'unknown',
        total: cases.length,
        passed: passedCount,
        passRate: Number(((passedCount / cases.length) * 100).toFixed(1)),
        avgSteps: Number((totalSteps / cases.length).toFixed(2)),
        avgLatencyMs: Math.round(totalLatency / cases.length),
        totalCostUsd,
        cases
      }
    ]
  };

  OMEvalRunner.saveReport(report, opts.reportPath);
  if (opts.saveBaseline) {
    OMEvalRunner.saveReport(report, opts.saveBaseline);
  }

  let baselineDiff = null;
  if (opts.baseline && fs.existsSync(opts.baseline)) {
    const baseline = OMEvalRunner.loadReport(opts.baseline);
    baselineDiff = OMEvalRunner.compareBaseline(baseline, report, {
      maxPassRateDrop: 0,
      maxAvgStepIncrease: 2
    });
  }

  const md = buildMarkdownSummary(report, baselineDiff);
  if (opts.markdown) {
    fs.mkdirSync(path.dirname(opts.markdown), { recursive: true });
    fs.writeFileSync(opts.markdown, md, 'utf8');
  }

  console.log(`\n${md}`);
  if (baselineDiff && !baselineDiff.passed) {
    console.error('Benchmark regression gate FAILED against baseline.');
    process.exit(1);
  }
  if (!opts.live && passedCount !== cases.length) {
    process.exit(1);
  }
}

main();
