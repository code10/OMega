---
name: debug
description: Disciplined multi-phase code audit, fix, and optimization workflow. Use when debugging issues, refactoring, profiling, or auditing existing code. Use when the user asks "debug".
triggers: [user, model]
---

A disciplined multi-phase workflow over existing code. Order matters: **correctness first, speed second, style last**. Never optimize code that is not yet correct.

## Phase 0 — Understand Before Touching

1. Read the code fully to identify:
   - Language / runtime version & framework.
   - Inputs, outputs, and edge boundaries.
   - Expected "correct behavior" (defined by existing tests, specification, or user prompt).
2. Establish a baseline:
   - If tests exist, run them first to record current status.
   - If none exist, write a minimal test or check capturing current intended behavior before changing anything.
3. State your understanding in one sentence. If anything is ambiguous, ask the user before proceeding.

## Phase 1 — Audit (Find Issues, Do Not Fix Yet)

Scan and categorize findings by severity:
- **Correctness bugs**: Logic errors, off-by-one, invalid operators, unhandled edge cases (null/undefined, empty collections, negative numbers, unicode, timezones), race conditions, swallowed errors, resource leaks, security issues (injections, unsanitized input, secrets).
- **Performance issues**: Inefficient algorithmic complexity (e.g. O(N^2) loops that could use hash maps/sets), redundant loop calculations, N+1 queries, unnecessary allocations/copies, unbatched I/O.
- **Maintainability issues**: Dead code, duplication, misleading variable/function names, missing error handling, magic numbers, god functions.

**Rank findings:**
- **Critical**: Insecure or incorrect behavior.
- **High**: Fragile, leaky, or severe performance bottleneck.
- **Medium**: Duplication, clarity, readability.

> Present the audit summary to the user before applying non-trivial fixes unless instructed to proceed automatically.

## Phase 2 — Fix

1. Fix **Critical** issues first, then **High**.
2. Apply fixes incrementally—one change at a time—and run tests/checks after each fix.
3. Never alter public interfaces or behavior unless the behavior itself is the bug. Flag any intentional behavior change clearly.
4. Prefer minimal, surgical diffs over rewrites. Refactor only what the audit found broken.

## Phase 3 — Optimize

1. Optimize only measured or clearly identified hotspots—never optimize prematurely.
2. **Order of attack:**
   1. Better algorithm or data structure
   2. Eliminate redundant work / caching
   3. Batch I/O operations
   4. Concurrency / asynchronous execution
   5. Micro-tuning (last resort)
3. Provide evidence: Benchmark before and after with numbers if a runtime is available; otherwise, demonstrate algorithmic complexity gains (Big-O notation).
4. Never sacrifice readability for negligible gains (e.g., a 1% speedup that impairs readability is a net loss).

## Phase 4 — Report

Provide a concise final summary:
- **Fixed**: Bug description, severity, and one-line root cause.
- **Optimized**: What was modified and the measured/reasoned speedup.
- **Improved**: Readability and dead-code cleanups.
- **Left Alone**: Identified issues intentionally left unchanged (and why).
- **Verification**: Exact commands or tests executed to verify nothing broke.

## Golden Rules

- Correctness beats speed; speed beats elegance.
- Never report "optimized" without evidence (benchmark numbers or complexity analysis).
- Keep diffs minimal: fix what is there, do not reformat to personal stylistic taste.
