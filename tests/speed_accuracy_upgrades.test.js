import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OMAgent,
  OMSystemOne,
  SkillRegistry
} from '../dist/index.js';
import { AnthropicProvider } from '../dist/providers/anthropic.js';
import { GeminiProvider } from '../dist/providers/gemini.js';
import { compactHistoryIfNeeded } from '../dist/agent/compaction.js';
import {
  saveCheckpoint,
  loadCheckpoint,
  markPendingStep
} from '../dist/agent/checkpoint.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // ignore Windows cleanup race
  }
}

describe('OMega Speed & Accuracy Upgrades', () => {
  it('1. read_file always includes 1-based line numbers and patch_file rejects ambiguous matches unless replaceAll is true', async () => {
    const tmp = makeTempDir('om-fs-upgrades-');
    try {
      const reg = new SkillRegistry();
      const ctx = { config: { workspaceDir: tmp } };
      const file = path.join(tmp, 'sample.txt');
      fs.writeFileSync(file, 'alpha\nfoo bar\nbeta\nfoo bar\ngamma\n', 'utf8');

      // Whole-file read includes 1-based line numbers
      const readRes = await reg.execute('read_file', { path: file }, ctx);
      assert.equal(readRes.success, true);
      assert.equal(readRes.displayedLines, '1-6');
      assert.ok(readRes.content.startsWith('1: alpha\n2: foo bar\n3: beta\n4: foo bar'));

      // Ambiguous patch fails without mutating file
      const ambiguous = await reg.execute('patch_file', {
        path: file,
        targetText: 'foo bar',
        replacementText: 'baz qux'
      }, ctx);
      assert.equal(ambiguous.success, false);
      assert.match(ambiguous.error, /Ambiguous match.*matched 2 times/i);
      assert.equal(fs.readFileSync(file, 'utf8'), 'alpha\nfoo bar\nbeta\nfoo bar\ngamma\n');

      // replaceAll: true replaces both occurrences
      const replaceAllRes = await reg.execute('patch_file', {
        path: file,
        targetText: 'foo bar',
        replacementText: 'baz qux',
        replaceAll: true
      }, ctx);
      assert.equal(replaceAllRes.success, true);
      assert.equal(replaceAllRes.replacements, 2);
      assert.equal(fs.readFileSync(file, 'utf8'), 'alpha\nbaz qux\nbeta\nbaz qux\ngamma\n');
    } finally {
      safeRm(tmp);
    }
  });

  it('2. search_files uses fast native engine when available and falls back cleanly to JS walker', async () => {
    const tmp = makeTempDir('om-search-upgrades-');
    try {
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const MAGIC_TOKEN_123 = true;\n', 'utf8');
      const reg = new SkillRegistry();

      const res = await reg.execute('search_files', { query: 'MAGIC_TOKEN_123', dir: tmp }, { config: { workspaceDir: tmp } });
      assert.equal(res.success, true);
      assert.equal(res.matchCount, 1);
      assert.equal(res.results[0].line, 1);
      assert.ok(['rg', 'git-grep', 'js'].includes(res.engine));

      // Force JS fallback via custom backend without spawn
      const jsBackend = {
        name: 'mock-no-spawn',
        exists: (p) => fs.existsSync(p),
        stat: (p) => {
          const s = fs.statSync(p);
          return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
        },
        realpath: (p) => fs.realpathSync(p),
        readFile: (p, enc = 'utf8') => fs.readFileSync(p, enc),
        writeFile: (p, c, enc = 'utf8') => fs.writeFileSync(p, c, enc),
        mkdir: (p, o) => fs.mkdirSync(p, o),
        readdir: (p) => fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isFile: d.isFile(),
          isDirectory: d.isDirectory()
        })),
        exec: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false })
      };
      const fallbackRes = await reg.execute(
        'search_files',
        { query: 'MAGIC_TOKEN_123', dir: tmp },
        { config: { workspaceDir: tmp }, execution: jsBackend }
      );
      assert.equal(fallbackRes.success, true);
      assert.equal(fallbackRes.engine, 'js');
      assert.equal(fallbackRes.matchCount, 1);
    } finally {
      safeRm(tmp);
    }
  });

  it('3. Prompt caching splits staticSystemPrompt from dynamicContext and emits provider cache payloads', async () => {
    const tmp = makeTempDir('om-cache-upgrades-');
    const origFetch = globalThis.fetch;
    try {
      const agent = new OMAgent({
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp,
        provider: 'om',
        model: 'om-turbo'
      });
      agent.memory.appendFact('User prefers concise TypeScript');
      const parts = agent.buildPromptParts({ query: 'TypeScript' });
      assert.ok(parts.staticSystemPrompt.includes('Operating Directives'));
      assert.ok(!parts.staticSystemPrompt.includes('User prefers concise TypeScript'));
      assert.ok(parts.dynamicContext.includes('User prefers concise TypeScript'));

      // Verify Anthropic cache_control blocks
      let anthropicBody = null;
      globalThis.fetch = async (_url, init) => {
        anthropicBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };
      const anthropic = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-3-5-sonnet-20241022' });
      await anthropic.chat({
        systemPrompt: parts.staticSystemPrompt,
        dynamicContext: parts.dynamicContext,
        tools: [{ name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {} } }],
        messages: [
          { role: 'user', content: 'step 1' },
          { role: 'assistant', content: 'ack' },
          { role: 'user', content: 'step 2' }
        ]
      });
      assert.ok(Array.isArray(anthropicBody.system));
      assert.deepEqual(anthropicBody.system[0].cache_control, { type: 'ephemeral' });
      assert.equal(anthropicBody.system[1].cache_control, undefined);
      assert.deepEqual(anthropicBody.tools[0].cache_control, { type: 'ephemeral' });

      // Verify Gemini keeps systemInstruction static and places dynamicContext on latest user turn
      let geminiBody = null;
      globalThis.fetch = async (_url, init) => {
        geminiBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };
      const gemini = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-3.5-flash' });
      await gemini.chat({
        systemPrompt: parts.staticSystemPrompt,
        dynamicContext: parts.dynamicContext,
        messages: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'first reply' },
          { role: 'user', content: 'second turn' }
        ]
      });
      assert.equal(geminiBody.systemInstruction.parts[0].text, parts.staticSystemPrompt);
      assert.ok(geminiBody.contents[2].parts[0].text.includes('User prefers concise TypeScript'));
      await agent.close();
    } finally {
      globalThis.fetch = origFetch;
      safeRm(tmp);
    }
  });

  it('4. _compactToolOutput preserves valid JSON on truncation and compaction scales past 32K', async () => {
    const tmp = makeTempDir('om-compact-upgrades-');
    try {
      const agent = new OMAgent({
        memoryDir: path.join(tmp, 'mem'),
        workspaceDir: tmp,
        provider: 'gemini',
        model: 'gemini-3.5-flash'
      });

      const bigObj = {
        success: true,
        path: 'src/big.ts',
        content: 'x'.repeat(60000)
      };
      const compacted = agent._compactToolOutput(bigObj);
      assert.ok(compacted.length <= 48000);
      const parsed = JSON.parse(compacted);
      assert.equal(parsed.success, true);
      assert.equal(parsed.outputTruncated, true);
      assert.equal(parsed.path, 'src/big.ts');
      assert.ok(parsed.content.includes('[truncated'));

      // Compaction should NOT trigger at ~40K tokens on a 1M-context Gemini model (previously capped at 32K)
      agent.history = Array.from({ length: 24 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'a'.repeat(7000)
      }));
      compactHistoryIfNeeded(agent);
      assert.equal(agent.history.length, 24, 'Should not compact at ~42K tokens on 1M model');

      // When compaction does trigger, it preserves touched files and errors
      agent.config.compactionThresholdTokens = 1000;
      agent.history[1] = {
        role: 'assistant',
        content: 'Editing auth',
        toolCalls: [{ id: 'tc1', name: 'patch_file', args: { path: 'src/auth.ts' } }]
      };
      agent.history[2] = {
        role: 'tool',
        name: 'patch_file',
        toolCallId: 'tc1',
        content: JSON.stringify({ success: false, error: 'Error: ambiguous match' })
      };
      compactHistoryIfNeeded(agent);
      assert.ok(agent.history[0].content.includes('Touched files: src/auth.ts'));
      assert.ok(agent.history[0].content.includes('Key errors encountered:'));
      await agent.close();
    } finally {
      safeRm(tmp);
    }
  });

  it('5. Lightweight markPendingStep sidecar merges into loadCheckpoint and clears on saveCheckpoint', () => {
    const tmp = makeTempDir('om-cp-sidecar-');
    try {
      const baseRecord = {
        sessionId: 'sess_sidecar',
        runId: 'run_1',
        pid: process.pid,
        detached: false,
        status: 'running',
        prompt: 'test',
        provider: 'om',
        model: 'om-turbo',
        workspaceDir: tmp,
        currentStep: 1,
        maxSteps: 10,
        pendingStep: null,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        history: [],
        steps: [],
        answers: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      saveCheckpoint(tmp, baseRecord);
      markPendingStep(tmp, 'sess_sidecar', 2);

      const loaded = loadCheckpoint(tmp, 'sess_sidecar');
      assert.equal(loaded?.pendingStep, 2);

      saveCheckpoint(tmp, { ...baseRecord, currentStep: 2, pendingStep: null });
      const cleared = loadCheckpoint(tmp, 'sess_sidecar');
      assert.equal(cleared?.pendingStep, null);
    } finally {
      safeRm(tmp);
    }
  });

  it('6. OMSystemOne pins core coding tools and respects maxWaitMs without blocking on cold start', async () => {
    const mockEmbedder = async (text) => {
      // Score 'weird_tool' highest for every prompt to verify core coding tools still stay pinned
      return String(text).includes('weird_tool') ? [1, 0] : [0, 1];
    };
    const sysOne = new OMSystemOne({ enabled: true, toolShortlistK: 3 }, { embedder: mockEmbedder });
    const tools = [
      { name: 'weird_tool_1', description: 'weird_tool alpha' },
      { name: 'weird_tool_2', description: 'weird_tool beta' },
      { name: 'read_file', description: 'read disk file' },
      { name: 'patch_file', description: 'patch disk file' }
    ];
    const shortlisted = await sysOne.shortlistTools('weird_tool query', tools, 3);
    const names = shortlisted.map((t) => t.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('patch_file'));
    assert.equal(names.length, 3);

    // Cold-start non-blocking maxWaitMs: simulate slow hardwareDetector so getEmbedder takes >500ms
    let hwTimer = null;
    const coldSysOne = new OMSystemOne(
      { enabled: true, toolShortlistK: 2 },
      {
        hardwareDetector: () => new Promise((resolve) => {
          hwTimer = setTimeout(() => resolve({ hasCudaGpu: false, vramMb: 0, totalRamGb: 16 }), 600);
          hwTimer.unref?.();
        })
      }
    );
    const start = Date.now();
    const coldResult = await coldSysOne.shortlistTools('hello', tools, 2, { maxWaitMs: 30 });
    if (hwTimer) clearTimeout(hwTimer);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 300, `Expected non-blocking return, took ${elapsed}ms`);
    assert.equal(coldResult.length, tools.length, 'Should return full toolset when cold-start times out');
  });
});
