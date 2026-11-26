import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../dist/providers/router.js';
import { GeminiProvider } from '../dist/providers/gemini.js';
import { parseRetryAfterMs, consumeSSEStream } from '../dist/utils/http.js';

describe('Routing Resilience, Load Balancing & Streaming Stability', () => {
  it('1. parseRetryAfterMs parses numeric seconds, retry-after-ms, HTTP-date, and Go duration reset headers', () => {
    assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': '12' })), 12000);
    assert.equal(parseRetryAfterMs(new Headers({ 'retry-after-ms': '750' })), 750);
    assert.equal(parseRetryAfterMs(new Headers({ 'x-ratelimit-reset-requests': '1m30s' })), 90000);
    assert.equal(parseRetryAfterMs(new Headers({ 'x-ratelimit-reset-tokens': '450ms' })), 450);

    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const parsedDateMs = parseRetryAfterMs(new Headers({ 'retry-after': futureDate }));
    assert.ok(parsedDateMs && parsedDateMs > 2000 && parsedDateMs <= 6000);
  });

  it('2. consumeSSEStream cancels underlying reader on idleTimeoutMs and AbortSignal without leaking lock', async () => {
    let cancelCount = 0;
    const hangingStream = new ReadableStream({
      start() {},
      cancel() {
        cancelCount++;
      }
    });
    const res = new Response(hangingStream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });

    await assert.rejects(
      () => consumeSSEStream(res, () => {}, { idleTimeoutMs: 40 }),
      (err) => err?.name === 'TimeoutError' && err?.status === 408
    );
    assert.equal(cancelCount, 1, 'Underlying SSE reader must be cancelled on idle timeout');

    let abortCancelCount = 0;
    const hangingStream2 = new ReadableStream({
      start() {},
      cancel() {
        abortCancelCount++;
      }
    });
    const res2 = new Response(hangingStream2, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user cancel')), 25);

    await assert.rejects(
      () => consumeSSEStream(res2, () => {}, { idleTimeoutMs: 5000, signal: ac.signal }),
      (err) => err?.name === 'AbortError'
    );
    assert.equal(abortCancelCount, 1, 'Underlying SSE reader must be cancelled on AbortSignal');
  });

  it('3. GeminiProvider preserves AbortError on user abort and optimizes thinkingBudget for flash-lite / minimal effort', async () => {
    const origFetch = globalThis.fetch;
    try {
      let capturedPayload = null;
      globalThis.fetch = async (_url, init) => {
        capturedPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fast' }] } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const lite = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-3.5-flash-lite' });
      await lite.chat({ messages: [{ role: 'user', content: 'hi' }], effort: 'none' });
      assert.equal(capturedPayload.generationConfig.thinkingConfig.thinkingBudget, 0);

      await lite.chat({ messages: [{ role: 'user', content: 'hi' }], effort: 'medium' });
      assert.equal(capturedPayload.generationConfig.thinkingConfig.thinkingBudget, 1024);

      // User abort must propagate as AbortError, never status 408
      const ac = new AbortController();
      ac.abort(new Error('stopped'));
      globalThis.fetch = async (_url, init) => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        if (init.signal?.aborted) throw err;
        throw err;
      };
      await assert.rejects(
        () => lite.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ac.signal }),
        (err) => err?.name === 'AbortError' && err?.status !== 408
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('4. ModelRouter tracks EWMA TTFT/latency and ranks latency-strategy fallbacks by lowest latency', async () => {
    const slowFallback = {
      name: 'openai',
      model: 'slow-model',
      async chat() {
        await new Promise((r) => setTimeout(r, 45));
        return { content: 'slow', usage: { total_tokens: 10 } };
      }
    };
    const fastFallback = {
      name: 'anthropic',
      model: 'fast-model',
      async chat({ onToken }) {
        await new Promise((r) => setTimeout(r, 5));
        onToken?.('f');
        return { content: 'fast', usage: { total_tokens: 10 } };
      }
    };

    const router = new ModelRouter({
      routing: {
        enabled: true,
        strategy: 'latency',
        fallbackChain: [
          { provider: 'openai', model: 'slow-model', providerInstance: slowFallback },
          { provider: 'anthropic', model: 'fast-model', providerInstance: fastFallback }
        ]
      }
    });

    // Seed metrics directly via telemetry helper
    router._recordTelemetry('openai', 'slow-model', 1200, 900);
    router._recordTelemetry('anthropic', 'fast-model', 180, 95);

    const candidates = router.getFallbackCandidates('gemini', 'gemini-3.5-flash-lite');
    assert.equal(candidates[0].provider, 'anthropic');
    assert.equal(candidates[0].model, 'fast-model');
    assert.equal(candidates[1].provider, 'openai');

    const stats = router.getStats();
    assert.equal(stats.strategy, 'latency');
    assert.equal(stats.providerMetrics['anthropic/fast-model'].ewmaTtftMs, 95);
  });

  it('5. ModelRouter round_robin distributes requests across healthy pool and fast-fails over on 503/529 overload', async () => {
    const calls = [];
    const makeProv = (name, model) => ({
      name,
      model,
      async chat() {
        calls.push(`${name}/${model}`);
        return { content: `from ${name}`, usage: { total_tokens: 5 } };
      }
    });

    const p1 = makeProv('gemini', 'm1');
    const p2 = makeProv('openai', 'm2');
    const router = new ModelRouter({
      routing: {
        enabled: true,
        strategy: 'round_robin',
        fallbackChain: [{ provider: 'openai', model: 'm2', providerInstance: p2 }]
      }
    });

    await router.chat(p1, { messages: [{ role: 'user', content: 'a' }] });
    await router.chat(p1, { messages: [{ role: 'user', content: 'b' }] });
    assert.ok(calls.includes('gemini/m1') && calls.includes('openai/m2'), `Expected both targets used, got ${calls}`);

    // Overload 529 should fail over immediately without burning retries
    let overloadAttempts = 0;
    const overloadedPrimary = {
      name: 'anthropic',
      model: 'claude-overloaded',
      async chat() {
        overloadAttempts++;
        const err = new Error('Anthropic API error [529]: overloaded_error');
        err.status = 529;
        throw err;
      }
    };
    const healthyBackup = makeProv('gemini', 'm-healthy');
    const overloadRouter = new ModelRouter({
      routing: {
        enabled: true,
        maxRetries: 3,
        overloadCooldownMs: 5000,
        fallbackChain: [{ provider: 'gemini', model: 'm-healthy', providerInstance: healthyBackup }]
      }
    });
    const res = await overloadRouter.chat(overloadedPrimary, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(overloadAttempts, 1, 'Should not burn retries on 529 overload');
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.routedProvider, 'gemini');
    assert.equal(overloadRouter.isInCooldown('anthropic', 'claude-overloaded'), true);
  });

  it('6. Half-open circuit breaker re-opens immediately with exponential backoff on failed probe', async () => {
    const router = new ModelRouter({
      routing: {
        circuitBreakerThreshold: 2,
        circuitBreakerCooldownMs: 40,
        maxCircuitBreakerCooldownMs: 500
      }
    });

    router.recordFailure('openai', 'm1');
    assert.equal(router.isInCooldown('openai', 'm1'), false);
    router.recordFailure('openai', 'm1');
    assert.equal(router.isInCooldown('openai', 'm1'), true);

    await new Promise((r) => setTimeout(r, 55));
    // Cooldown expired -> enters half-open state
    assert.equal(router.isInCooldown('openai', 'm1'), false);
    assert.equal(router.getStats().providerMetrics['openai/m1'].halfOpen, true);

    // A single failure during half-open must immediately re-open the breaker
    router.recordFailure('openai', 'm1');
    assert.equal(router.isInCooldown('openai', 'm1'), true);
    assert.equal(router.getStats().providerMetrics['openai/m1'].openCount, 2);
  });

  it('7. Speculative hedging launches fallback after delayMs, cancels slow primary, and emits zero duplicate tokens', async () => {
    let primaryAborted = false;
    const slowPrimary = {
      name: 'gemini',
      model: 'slow-primary',
      async chat({ signal, onToken }) {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            onToken?.('PRIMARY_LATE');
            resolve({ content: 'PRIMARY_LATE', usage: {} });
          }, 300);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            primaryAborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
      }
    };
    const fastHedge = {
      name: 'openai',
      model: 'fast-hedge',
      async chat({ onToken }) {
        await new Promise((r) => setTimeout(r, 15));
        onToken?.('HEDGE_');
        onToken?.('WIN');
        return { content: 'HEDGE_WIN', usage: { total_tokens: 12 } };
      }
    };

    const events = [];
    const router = new ModelRouter({
      onEvent: (evt, payload) => events.push({ evt, payload }),
      routing: {
        enabled: true,
        hedging: { enabled: true, delayMs: 50 },
        fallbackChain: [{ provider: 'openai', model: 'fast-hedge', providerInstance: fastHedge }]
      }
    });

    const streamed = [];
    const res = await router.chat(slowPrimary, {
      messages: [{ role: 'user', content: 'hello' }],
      onToken: (t) => streamed.push(t)
    });

    assert.equal(res.content, 'HEDGE_WIN');
    assert.equal(res.hedged, true);
    assert.equal(res.routedProvider, 'openai');
    assert.equal(primaryAborted, true, 'Losing primary request must be aborted');
    assert.deepEqual(streamed, ['HEDGE_', 'WIN'], 'Must not leak tokens from losing racer');
    assert.ok(events.some((e) => e.evt === 'hedge_won'));
  });

  it('8. adaptiveEffort downgrades medium effort to low on simple turns for faster TTFT', async () => {
    let seenEffort = null;
    const prov = {
      name: 'gemini',
      model: 'gemini-3.5-flash-lite',
      async chat({ effort }) {
        seenEffort = effort;
        return { content: 'hi', usage: {} };
      }
    };
    const router = new ModelRouter({
      routing: { enabled: true, adaptiveEffort: true }
    });
    await router.chat(prov, {
      messages: [{ role: 'user', content: 'Hello!' }],
      effort: 'medium'
    });
    assert.equal(seenEffort, 'low');
  });

  it('9. rpmGuard proactively spills concurrent bursts and high RPM onto healthy fallbacks before hitting 429', async () => {
    const routed = [];
    const primary = {
      name: 'gemini',
      model: 'gemini-3.5-flash-lite',
      async chat() {
        routed.push('gemini/gemini-3.5-flash-lite');
        await new Promise((r) => setTimeout(r, 40));
        return { content: 'p', usage: { total_tokens: 5 } };
      }
    };
    const backup = {
      name: 'openai',
      model: 'gpt-5-mini-2025-08-07',
      async chat() {
        routed.push('openai/gpt-5-mini-2025-08-07');
        await new Promise((r) => setTimeout(r, 10));
        return { content: 'b', usage: { total_tokens: 5 } };
      }
    };

    // Test concurrency spillover (maxInFlightPerModel: 1)
    const router = new ModelRouter({
      routing: {
        enabled: true,
        strategy: 'latency',
        balancePrimary: false,
        rpmGuard: { enabled: true, maxInFlightPerModel: 1, softRpmPerModel: 2 }
      }
    });
    router.routingConfig.fallbackChain = [
      { provider: 'openai', model: 'gpt-5-mini-2025-08-07', providerInstance: backup }
    ];

    const [r1, r2] = await Promise.all([
      router.chat(primary, { messages: [{ role: 'user', content: 'req 1' }] }),
      router.chat(primary, { messages: [{ role: 'user', content: 'req 2' }] })
    ]);
    assert.equal(r1.routedProvider, 'gemini');
    assert.equal(r2.routedProvider, 'openai', '2nd concurrent request should spill over when primary hits maxInFlightPerModel');

    // Test rolling 60s softRpmPerModel spillover (primary has 1 call so far; 1 more hits cap of 2, then 3rd spills)
    const r3 = await router.chat(primary, { messages: [{ role: 'user', content: 'req 3' }] });
    assert.equal(r3.routedProvider, 'gemini');
    const r4 = await router.chat(primary, { messages: [{ role: 'user', content: 'req 4' }] });
    assert.equal(r4.routedProvider, 'openai', 'Request after softRpmPerModel reached should spill over proactively');
    assert.ok(router.getStats().rpmSpillovers >= 2);
  });

  it('10. Router deep-merges nested hedging/rpmGuard defaults, deduplicates fallbacks, and avoids double-attempting primary on fast hedge fail', async () => {
    const router = new ModelRouter({
      routing: {
        hedging: { enabled: true },
        rpmGuard: { enabled: true },
        fallbackChain: [
          { provider: 'openai', model: 'gpt-5-mini-2025-08-07', apiKey: 'k' },
          { provider: 'openai', model: 'gpt-5-mini-2025-08-07', apiKey: 'k' }
        ]
      }
    });
    assert.equal(router.routingConfig.hedging.delayMs, 3500);
    assert.equal(router.routingConfig.rpmGuard.softRpmPerModel, 25);
    assert.equal(router.routingConfig.rpmGuard.maxInFlightPerModel, 4);

    const cands = router.getFallbackCandidates('gemini', 'gemini-3.5-flash-lite');
    assert.equal(cands.length, 1, 'Duplicate fallback entries should be deduplicated');

    // Fast transient failure during hedged call should count as attempt 0, so maxRetries: 1 calls primary only 2 times total
    let primaryCalls = 0;
    const flakyPrimary = {
      name: 'gemini',
      model: 'flaky',
      async chat() {
        primaryCalls++;
        if (primaryCalls === 1) throw new Error('ECONNRESET transient');
        return { content: 'recovered on retry 1', usage: {} };
      }
    };
    const hedgeRouter = new ModelRouter({
      routing: {
        enabled: true,
        maxRetries: 1,
        retryDelayMs: 5,
        hedging: { enabled: true, delayMs: 200 },
        fallbackChain: [{ provider: 'openai', model: 'backup', providerInstance: { name: 'openai', model: 'backup', async chat() { return { content: 'backup', usage: {} }; } } }]
      }
    });
    const res = await hedgeRouter.chat(flakyPrimary, { messages: [{ role: 'user', content: 'test' }] });
    assert.equal(res.content, 'recovered on retry 1');
    assert.equal(primaryCalls, 2, 'Primary should be attempted exactly twice (attempt 0 + 1 retry), not 3 times');
  });
});
