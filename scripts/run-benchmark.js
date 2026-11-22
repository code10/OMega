#!/usr/bin/env node
/**
 * Real-world Coding Task Benchmark & Eval Runner
 * Usage:
 *   node scripts/run-benchmark.js            # Uses configured/available provider or deterministic mock if no API key
 *   node scripts/run-benchmark.js --live     # Requires live API key (GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { OMAgent } from '../dist/index.js';

const LIVE_MODE = process.argv.includes('--live');
const BENCH_ROOT = path.resolve('./tests/tmp_real_eval');
const REPORT_PATH = path.resolve('./memory/benchmark-report.json');

function hasLiveKey() {
  return Boolean(
    process.env.GEMINI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY
  );
}

function createDeterministicCodingProvider(taskId) {
  let step = 0;
  return {
    name: 'eval-mock',
    model: 'deterministic-eval',
    async chat() {
      step += 1;
      if (taskId === 'fix-failing-test') {
        if (step === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'call_1',
              name: 'write_file',
              args: {
                path: 'math.js',
                content: 'export function add(a, b) {\n  return a + b;\n}\n'
              }
            }]
          };
        }
        return { content: 'Fixed add(a, b) in math.js.', toolCalls: [] };
      }
      if (taskId === 'implement-slugify') {
        if (step === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'call_1',
              name: 'write_file',
              args: {
                path: 'slug.js',
                content: 'export function slugify(str) {\n  return String(str).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n'
              }
            }]
          };
        }
        return { content: 'Implemented slugify in slug.js.', toolCalls: [] };
      }
      return { content: 'Done', toolCalls: [] };
    }
  };
}

const TASKS = [
  {
    id: 'fix-failing-test',
    title: 'Fix failing unit test in math.js',
    setup(dir) {
      fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'math.test.mjs'),
        "import assert from 'node:assert/strict';\nimport { add } from './math.js';\nassert.equal(add(2, 3), 5);\n",
        'utf8'
      );
    },
    prompt: 'math.test.mjs is failing because add(2, 3) does not return 5. Fix math.js so `node math.test.mjs` passes.',
    verify(dir) {
      execSync('node math.test.mjs', { cwd: dir, stdio: 'pipe' });
    }
  },
  {
    id: 'implement-slugify',
    title: 'Implement slugify() in slug.js and pass test',
    setup(dir) {
      fs.writeFileSync(path.join(dir, 'slug.js'), 'export function slugify(str) {\n  return "";\n}\n', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'slug.test.mjs'),
        "import assert from 'node:assert/strict';\nimport { slugify } from './slug.js';\nassert.equal(slugify('Hello World!'), 'hello-world');\n",
        'utf8'
      );
    },
    prompt: 'Implement slugify(str) in slug.js so `node slug.test.mjs` passes.',
    verify(dir) {
      execSync('node slug.test.mjs', { cwd: dir, stdio: 'pipe' });
    }
  }
];

async function main() {
  const useLive = LIVE_MODE || hasLiveKey();
  if (LIVE_MODE && !hasLiveKey()) {
    console.error('Error: --live requires GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  fs.rmSync(BENCH_ROOT, { recursive: true, force: true });
  fs.mkdirSync(BENCH_ROOT, { recursive: true });

  const results = [];
  for (const task of TASKS) {
    const taskDir = path.join(BENCH_ROOT, task.id);
    const memDir = path.join(BENCH_ROOT, `${task.id}_mem`);
    fs.mkdirSync(taskDir, { recursive: true });
    task.setup(taskDir);

    const startedAt = Date.now();
    const agent = new OMAgent({
      workspaceDir: taskDir,
      memoryDir: memDir,
      maxSteps: 10,
      ...(useLive ? {} : { providerInstance: createDeterministicCodingProvider(task.id) })
    });
    await agent.init();

    let passed = false;
    let error = null;
    let res = null;
    try {
      res = await agent.run(task.prompt, { maxSteps: 10 });
      task.verify(taskDir);
      passed = true;
    } catch (err) {
      error = err?.message || String(err);
    } finally {
      await agent.close?.();
    }

    const durationMs = Date.now() - startedAt;
    results.push({
      id: task.id,
      title: task.title,
      mode: useLive ? 'live' : 'deterministic-harness',
      passed,
      durationMs,
      steps: res?.steps ?? 0,
      tokens: res?.usage?.totalTokens ?? 0,
      error
    });
  }

  fs.rmSync(BENCH_ROOT, { recursive: true, force: true });

  const passedCount = results.filter((r) => r.passed).length;
  const report = {
    executedAt: new Date().toISOString(),
    mode: useLive ? 'live' : 'deterministic-harness',
    total: results.length,
    passed: passedCount,
    passRate: Number(((passedCount / results.length) * 100).toFixed(1)),
    results
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\nOMega Coding Benchmark (${report.mode}): ${report.passed}/${report.total} passed (${report.passRate}%)`);
  for (const r of results) {
    console.log(`  ${r.passed ? '✔' : '✘'} ${r.id} (${r.durationMs}ms, ${r.tokens} tok)${r.error ? ` — ${r.error}` : ''}`);
  }
  if (passedCount !== results.length) process.exit(1);
}

main();
