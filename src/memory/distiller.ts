import fs from 'node:fs';
import path from 'node:path';
import { embedText, cosineSimilarity } from '../vectorStore/embeddings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MemoryDistiller');

export interface DistillOptions {
  date?: string;
  useLLM?: boolean;
  prune?: boolean;
  compressDaily?: boolean;
  retainDailyDays?: number;
  maxRetainedTurns?: number;
  dedupThreshold?: number;
  maxVectorDocs?: number;
  force?: boolean;
  model?: string;
}

export interface DistillState {
  lastDistilledAt: string | null;
  totalRuns: number;
  totalFactsAdded: number;
  totalTurnsPruned: number;
  totalSessionsCompressed: number;
  totalJournalsCompressed: number;
  totalBytesSaved: number;
  distilledDates: string[];
  lastReport: Record<string, any> | null;
}

export interface ExtractedHeuristic {
  text: string;
  category: string;
  score: number;
}

const DEFAULT_STATE: DistillState = {
  lastDistilledAt: null,
  totalRuns: 0,
  totalFactsAdded: 0,
  totalTurnsPruned: 0,
  totalSessionsCompressed: 0,
  totalJournalsCompressed: 0,
  totalBytesSaved: 0,
  distilledDates: [],
  lastReport: null
};

const CATEGORY_RULES: Array<{ category: string; pattern: RegExp; weight: number }> = [
  {
    category: 'Resolved Fixes',
    pattern: /\b(fixed|resolved|root cause|bug|workaround|patch|patched|fallback|recovered|regression|crash|timeout|race condition)\b/gi,
    weight: 3.2
  },
  {
    category: 'Decisions & Constraints',
    pattern: /\b(decided|always|never|must|prefer|preference|convention|standard|rule|policy|configured|requirement|constraint)\b/gi,
    weight: 3.1
  },
  {
    category: 'Architectural Insights',
    pattern: /\b(architecture|architectural|module|schema|pipeline|vector|embedding|routing|failover|daemon|gateway|interface|refactor|concurrency|cache|index|hybrid|sqlite|compaction|distill|protocol|design)\b/gi,
    weight: 3.0
  }
];

const NOISE_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|sure|got it|done)\.?$/i,
  /^Stored memory fact:/i,
  /^Session \S+ saved/i,
  /^\.\.\.\s*\[.*trimmed/i
];

export function readDistillState(memoryDir: string): DistillState {
  const statePath = path.join(memoryDir, 'distill_state.json');
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch (err: any) {
    log.debug(`Failed to read distill_state.json: ${err.message}`);
  }
  return { ...DEFAULT_STATE };
}

function saveDistillState(memoryDir: string, state: DistillState): void {
  const statePath = path.join(memoryDir, 'distill_state.json');
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err: any) {
    log.warn(`Failed to save distill_state.json: ${err.message}`);
  }
}

/**
 * Clean a raw journal or log line into a concise heuristic string.
 */
function normalizeHeuristicLine(rawLine: string): string {
  return rawLine
    .replace(/^[-*]\s*/, '')
    .replace(/^\[\d{1,2}:\d{2}(:\d{2})?(\s*[AP]\.?M\.?)?\]\s*/i, '')
    .replace(/^Stored memory fact:\s*"?(.*?)"?$/i, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Algorithmically extract and score high-signal heuristics from raw text lines (zero LLM tokens).
 */
function extractHeuristicsFromLines(lines: string[]): ExtractedHeuristic[] {
  const results: ExtractedHeuristic[] = [];
  for (const raw of lines) {
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--') || trimmed.startsWith('*(')) {
      continue;
    }
    const withoutTs = trimmed
      .replace(/^[-*]\s*/, '')
      .replace(/^\[\d{1,2}:\d{2}(:\d{2})?(\s*[AP]\.?M\.?)?\]\s*/i, '')
      .trim();
    if (NOISE_PATTERNS.some((re) => re.test(withoutTs))) continue;
    const cleaned = normalizeHeuristicLine(trimmed);
    if (cleaned.length < 16 || cleaned.length > 360) continue;

    let bestCategory = '';
    let bestScore = 0;
    for (const rule of CATEGORY_RULES) {
      rule.pattern.lastIndex = 0;
      const matches = cleaned.match(rule.pattern);
      if (matches && matches.length > 0) {
        const score = rule.weight + Math.min(matches.length - 1, 3) * 0.5;
        if (score > bestScore) {
          bestScore = score;
          bestCategory = rule.category;
        }
      }
    }

    if (bestCategory && bestScore >= 2) {
      results.push({ text: cleaned, category: bestCategory, score: bestScore });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Check if a candidate fact is semantically or lexically redundant against existing vectors.
 */
function isSemanticallyDuplicate(
  candidateText: string,
  existingVectors: Array<{ text: string; vector: number[] }>,
  threshold: number
): boolean {
  const lower = candidateText.toLowerCase();
  for (const item of existingVectors) {
    if (item.text.toLowerCase().includes(lower) || lower.includes(item.text.toLowerCase())) {
      return true;
    }
  }
  const candVec = embedText(candidateText);
  for (const item of existingVectors) {
    if (cosineSimilarity(candVec, item.vector) >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * Prune redundant intermediate turns from a session JSON object while retaining
 * architectural insights, final answers, and a concise distilled summary.
 */
function pruneSessionTurns(
  sess: Record<string, any>,
  maxRetainedTurns = 6
): { changed: boolean; turnsPruned: number; summary: string | null } {
  const steps = Array.isArray(sess.steps) ? sess.steps : [];
  if (sess.distilled && steps.length <= maxRetainedTurns) {
    return { changed: false, turnsPruned: 0, summary: sess.distilledSummary || null };
  }

  const toolsUsed = steps.flatMap((s: any) => (Array.isArray(s.toolCalls) ? s.toolCalls.map((t: any) => t.name) : []));
  const hadErrors = steps.some((s: any) =>
    Array.isArray(s.toolCalls) && s.toolCalls.some((t: any) => t.result?.success === false)
  );
  const lastAnswer = Array.isArray(sess.answers) && sess.answers.length > 0
    ? sess.answers[sess.answers.length - 1]
    : null;

  let summary: string | null = sess.distilledSummary || null;
  if (!summary && lastAnswer?.prompt) {
    const uniqueTools = [...new Set(toolsUsed)].filter(Boolean);
    const toolChain = uniqueTools.length > 0 ? ` via [${uniqueTools.join(' -> ')}]` : '';
    const status = hadErrors ? ' (recovered from tool error)' : '';
    summary = `Task "${String(lastAnswer.prompt).slice(0, 100)}"${toolChain}${status}`;
  }

  let turnsPruned = 0;
  if (steps.length > maxRetainedTurns) {
    // Keep only milestone steps: steps with failures/recoveries, file-modifying tools, or final steps
    const keepIndices = new Set<number>();
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const calls = Array.isArray(s.toolCalls) ? s.toolCalls : [];
      const isMilestone = calls.some((t: any) =>
        t.result?.success === false ||
        /write|patch|edit|save_memory|exec_command|git/i.test(String(t.name || ''))
      );
      if (isMilestone || i >= steps.length - 2) {
        keepIndices.add(i);
      }
    }

    const retained = steps.filter((_, idx) => keepIndices.has(idx)).slice(-maxRetainedTurns);
    turnsPruned = steps.length - retained.length;
    if (turnsPruned > 0) {
      sess.steps = retained.map((s: any) => ({
        ...s,
        // Compact oversized tool output payloads in retained steps
        toolCalls: Array.isArray(s.toolCalls)
          ? s.toolCalls.map((tc: any) => ({
              ...tc,
              result: tc.result && typeof tc.result === 'object'
                ? {
                    success: tc.result.success,
                    summary: typeof tc.result.content === 'string'
                      ? tc.result.content.slice(0, 200)
                      : tc.result.error || tc.result.message || undefined
                  }
                : tc.result
            }))
          : s.toolCalls
      }));
    }
  }

  sess.distilled = true;
  sess.distilledAt = new Date().toISOString();
  if (summary) sess.distilledSummary = summary;

  return { changed: true, turnsPruned, summary };
}

/**
 * Compress an older daily journal file by replacing verbose raw lines with
 * distilled heuristics while preserving the date header.
 */
function compactDailyJournal(filePath: string, heuristics: ExtractedHeuristic[]): { compressed: boolean; bytesSaved: number } {
  if (!fs.existsSync(filePath)) return { compressed: false, bytesSaved: 0 };
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.includes('<!-- DISTILLED -->')) {
    return { compressed: false, bytesSaved: 0 };
  }

  const lines = raw.split(/\r?\n/);
  const header = lines.find((l) => l.startsWith('# ')) || `# Daily Journal - ${path.basename(filePath, '.md')}`;
  const bullets = heuristics.slice(0, 20).map((h) => `- [${h.category}] ${h.text}`);
  const compacted = [
    header,
    '<!-- DISTILLED -->',
    '',
    '## Distilled Heuristics',
    ...(bullets.length > 0 ? bullets : ['- (No durable architectural insights recorded; redundant turns pruned)']),
    ''
  ].join('\n');

  if (compacted.length >= raw.length) {
    return { compressed: false, bytesSaved: 0 };
  }

  fs.writeFileSync(filePath, compacted, 'utf8');
  return { compressed: true, bytesSaved: raw.length - compacted.length };
}

/**
 * Zero-Token Autonomous Memory Distillation & Pruning Pipeline.
 * Compresses daily journals and session logs into concise algorithmic heuristics,
 * deduplicates via local vector embeddings, and prunes redundant turns.
 */
export async function distillMemory(
  memory: any,
  options: DistillOptions = {},
  agent: any = null
): Promise<Record<string, any>> {
  const memoryDir = memory.baseDir || agent?.config?.memoryDir;
  const dedupThreshold = options.dedupThreshold ?? 0.86;
  const shouldPrune = options.prune !== false;
  const compressDaily = options.compressDaily !== false;
  const retainDailyDays = options.retainDailyDays ?? 1;
  const maxRetainedTurns = options.maxRetainedTurns ?? 6;
  const state = readDistillState(memoryDir);

  const existingMemory = memory.readLongTermMemory() || '';
  const existingLines = existingMemory
    .split(/\r?\n/)
    .map((l: string) => normalizeHeuristicLine(l))
    .filter((l: string) => l.length >= 10 && !l.startsWith('#') && !l.startsWith('*('));

  const existingVectors = existingLines.map((text: string) => ({
    text,
    vector: embedText(text)
  }));

  const addedFacts: string[] = [];
  let usedLLM = false;
  let journalsCompressed = 0;
  let sessionsScanned = 0;
  let sessionsCompressed = 0;
  let turnsPruned = 0;
  let bytesSaved = 0;

  // 1. Collect daily journal files to process
  const dailyDir = memory.dailyDir || path.join(memoryDir, 'daily');
  const todayFile = memory.getTodayFilename ? memory.getTodayFilename() : `${new Date().toISOString().slice(0, 10)}.md`;
  const targetFiles: string[] = [];

  if (options.date) {
    const f = options.date.endsWith('.md') ? options.date : `${options.date}.md`;
    if (fs.existsSync(path.join(dailyDir, f))) targetFiles.push(f);
  } else if (fs.existsSync(dailyDir)) {
    const allDaily = fs.readdirSync(dailyDir).filter((f) => f.endsWith('.md')).sort();
    for (const f of allDaily) {
      if (options.force || f === todayFile || !state.distilledDates.includes(f)) {
        targetFiles.push(f);
      }
    }
  }

  // Optional LLM distillation if explicitly requested
  if (options.useLLM && targetFiles.length > 0 && agent?.router?.chat) {
    const combinedDaily = targetFiles
      .map((f) => fs.readFileSync(path.join(dailyDir, f), 'utf8'))
      .join('\n')
      .slice(0, 12000);

    if (combinedDaily.trim()) {
      try {
        const res = await agent.router.chat(agent.provider, {
          model: options.model || agent.config?.model || agent.model,
          systemPrompt: 'Extract only durable, reusable facts, user preferences, architectural decisions, or resolved fixes from the daily log. Return ONLY a JSON array of concise strings (max 15 items). Return [] if none.',
          messages: [{ role: 'user', content: combinedDaily }],
          temperature: 0.1
        });
        const raw = String(res?.content || '').trim();
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          usedLLM = true;
          for (const item of parsed) {
            const fact = normalizeHeuristicLine(String(item || ''));
            if (fact && !isSemanticallyDuplicate(fact, existingVectors, dedupThreshold)) {
              memory.appendFact(fact, 'Distilled Insights');
              existingVectors.push({ text: fact, vector: embedText(fact) });
              addedFacts.push(fact);
            }
          }
        }
      } catch (_) {
        // Fall back to zero-token algorithmic extractor below
      }
    }
  }

  // Zero-token algorithmic extraction & daily journal compression
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retainDailyDays);
  const cutoffName = `${cutoffDate.toISOString().slice(0, 10)}.md`;

  for (const df of targetFiles) {
    const fullPath = path.join(dailyDir, df);
    const content = fs.readFileSync(fullPath, 'utf8');
    const heuristics = extractHeuristicsFromLines(content.split(/\r?\n/));

    if (!usedLLM) {
      for (const h of heuristics) {
        if (!isSemanticallyDuplicate(h.text, existingVectors, dedupThreshold)) {
          memory.appendFact(h.text, h.category);
          existingVectors.push({ text: h.text, vector: embedText(h.text) });
          addedFacts.push(h.text);
        }
      }
    }

    // Compress older daily journals (or explicit date if requested with compressDaily)
    const isOldJournal = df < cutoffName || (Boolean(options.date) && options.compressDaily === true);
    if (shouldPrune && compressDaily && isOldJournal && df !== todayFile) {
      const comp = compactDailyJournal(fullPath, heuristics);
      if (comp.compressed) {
        journalsCompressed++;
        bytesSaved += comp.bytesSaved;
      }
    }

    if (df !== todayFile && !state.distilledDates.includes(df)) {
      state.distilledDates.push(df);
    }
  }

  // 2. Scan and prune sessions for workflow heuristics and architectural insights
  const sessionsDir = memory.sessionsDir || path.join(memoryDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).sort().slice(-50);
    for (const file of files) {
      const sessPath = path.join(sessionsDir, file);
      try {
        const raw = fs.readFileSync(sessPath, 'utf8');
        const sess = JSON.parse(raw);
        if (sess.distilled && !options.force) continue;

        sessionsScanned++;
        // Extract heuristics from session answers
        const answerTexts = (Array.isArray(sess.answers) ? sess.answers : [])
          .flatMap((a: any) => String(a.answer || '').split(/\r?\n/));
        const sessHeuristics = extractHeuristicsFromLines(answerTexts).slice(0, 3);
        for (const h of sessHeuristics) {
          if (!isSemanticallyDuplicate(h.text, existingVectors, dedupThreshold)) {
            memory.appendFact(h.text, h.category);
            existingVectors.push({ text: h.text, vector: embedText(h.text) });
            addedFacts.push(h.text);
          }
        }

        if (shouldPrune) {
          const pruned = pruneSessionTurns(sess, maxRetainedTurns);
          if (pruned.summary && !isSemanticallyDuplicate(pruned.summary, existingVectors, 0.9)) {
            memory.indexKnowledge(`distilled_${sess.sessionId || file.replace('.json', '')}`, pruned.summary);
          }
          if (pruned.changed) {
            const updatedRaw = JSON.stringify(sess, null, 2);
            fs.writeFileSync(sessPath, updatedRaw, 'utf8');
            if (pruned.turnsPruned > 0) {
              sessionsCompressed++;
              turnsPruned += pruned.turnsPruned;
            }
            if (raw.length > updatedRaw.length) {
              bytesSaved += raw.length - updatedRaw.length;
            }
          }
        }
      } catch (err: any) {
        log.debug(`Skipped unreadable session ${file}: ${err.message}`);
      }
    }
  }

  // 3. Prune excess vector documents while preserving MEMORY.md & distilled knowledge
  let vectorsPruned = 0;
  if (shouldPrune && typeof memory.pruneMemories === 'function') {
    const maxDocs = options.maxVectorDocs ?? 2000;
    const stats = memory.getVectorStats?.();
    const totalVectors = stats?.totalVectors ?? stats?.totalDocuments ?? 0;
    if (totalVectors > maxDocs) {
      const res = memory.pruneMemories({ maxDocuments: maxDocs });
      vectorsPruned = res?.removed || 0;
    }
  }

  const report = {
    success: true,
    mode: usedLLM ? 'llm' : 'heuristic',
    tokenCost: usedLLM ? 'llm' : 0,
    sessionsScanned,
    sessionsCompressed,
    journalsCompressed,
    turnsPruned,
    vectorsPruned,
    bytesSaved,
    factsAdded: addedFacts.length,
    addedFacts
  };

  state.lastDistilledAt = new Date().toISOString();
  state.totalRuns += 1;
  state.totalFactsAdded += addedFacts.length;
  state.totalTurnsPruned += turnsPruned;
  state.totalSessionsCompressed += sessionsCompressed;
  state.totalJournalsCompressed += journalsCompressed;
  state.totalBytesSaved += bytesSaved;
  state.lastReport = report;
  saveDistillState(memoryDir, state);

  return report;
}
