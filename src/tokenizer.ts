/**
 * Zero-Dependency Byte-Level BPE Subword Tokenizer & Model-Aware Context Window Registry.
 * Combines cl100k-style Unicode regex pre-tokenization with deterministic byte-pair merges
 * over UTF-8 bytes, providing accurate subword token counts without external dependencies.
 */

import type { ChatMessage } from './types.js';

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-5': 400000,
  'gpt-4.1': 1047576,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'o4': 200000,
  'o3-mini': 200000,
  'o3': 200000,
  'o1': 200000,
  'claude-4': 200000,
  'claude-3-7': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-opus': 200000,
  'claude-': 200000,
  'gemini-1.5-pro': 2000000,
  'gemini-3.8-flash': 1000000,
  'gemini-3.5-flash-lite': 1000000,
  'gemini-3.5-flash': 1000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.0-flash': 1000000,
  'gemini-1.5-flash': 1000000,
  'gemini-3-flash': 1000000,
  'gemini-4-hydrogen': 1000000,
  'gemini-': 1000000,
  'qwen': 32768,
  'llama': 32768,
  'mistral': 32768,
  'deepseek': 65536,
  'om-v1': 128000,
  'om-turbo': 32768,
  'om-reasoning': 65536
};

// cl100k-style pre-tokenization pattern (contractions, words, numbers, punctuation runs, whitespace)
const PRE_TOKENIZE_RE =
  /'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/**
 * Ordered list of high-frequency English, code, and JSON subword merges.
 * Earlier entries receive lower rank (merged first) during BPE reduction.
 */
const DEFAULT_MERGE_WORDS: string[] = [
  // Top English bigrams & common subwords
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd',
  'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al', 'ar',
  'st', 'to', 'nt', 'ng', 'se', 'ha', 'as', 'ou', 'io', 'le',
  've', 'co', 'me', 'de', 'hi', 'ri', 'ro', 'ic', 'ne', 'ea',
  'ra', 'ce', 'li', 'ch', 'll', 'be', 'ma', 'si', 'om', 'ur',
  // Common space-prefixed words & trigrams
  ' t', ' a', ' i', ' s', ' o', ' c', ' p', ' r', ' m', ' f',
  'the', ' the', 'and', ' and', 'ing', 'ion', 'tion', 'ation',
  'for', ' for', 'that', ' that', 'with', ' with', 'this', ' this',
  'from', ' from', 'have', ' have', 'not', ' not', 'are', ' are',
  'was', 'you', 'all', 'can', 'her', 'one', 'our', 'out', 'use',
  'ment', 'ness', 'able', 'ible', 'less', 'ful', 'ity', 'ous',
  'pre', 'pro', 'con', 'com', 'dis', 'un', 're', 'over', 'sub',
  // Common code, TypeScript, JSON & HTTP tokens
  '  ', '    ', '        ', '\r\n', '":', '",', '": ', '{"', '"}', '[{', '}]',
  '()', '[]', '{}', '=>', '===', '!==', '==', '!=', '<=', '>=', '&&', '||',
  '/*', '*/', '//', '```', '---',
  'const', ' const', 'let', ' let', 'var', 'function', ' function',
  'return', ' return', 'async', ' async', 'await', ' await',
  'import', ' import', 'export', ' export', 'from', 'default',
  'class', ' class', 'interface', 'type', 'extends', 'implements',
  'true', 'false', 'null', 'undefined', 'void', 'string', 'number',
  'boolean', 'object', 'Promise', 'Record', 'Array', 'Error',
  'console', 'process', 'Buffer', 'JSON', 'Math', 'Object',
  'http', 'https', 'application', 'json', 'content', 'type',
  'data', 'error', 'message', 'status', 'result', 'response',
  'request', 'config', 'options', 'context', 'model', 'token',
  'tokens', 'system', 'user', 'assistant', 'tool', 'tools'
];

const textEncoder = new TextEncoder();

/**
 * Build progressive BPE merge ranks from a list of target subword strings.
 * Every adjacent pair along the binary tree of each subword is assigned a rank.
 */
function buildMergeRanks(words: string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  let nextRank = 0;

  const addPair = (left: string, right: string): string => {
    const key = `${left}\u0000${right}`;
    if (!ranks.has(key)) {
      ranks.set(key, nextRank++);
    }
    return `${left}${right}`;
  };

  for (const word of words) {
    const bytes = textEncoder.encode(word);
    if (bytes.length < 2) continue;
    let parts = Array.from(bytes, (b) => String.fromCharCode(b));
    while (parts.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        if (i + 1 < parts.length) {
          next.push(addPair(parts[i], parts[i + 1]));
        } else {
          next.push(parts[i]);
        }
      }
      parts = next;
    }
  }

  return ranks;
}

export class BPETokenizer {
  private ranks: Map<string, number>;
  private tokenToId: Map<string, number>;
  private cache: Map<string, number[]>;
  private maxCacheEntries: number;

  constructor(mergeWords: string[] = DEFAULT_MERGE_WORDS, maxCacheEntries = 8192) {
    this.ranks = buildMergeRanks(mergeWords);
    this.tokenToId = new Map<string, number>();
    this.cache = new Map<string, number[]>();
    this.maxCacheEntries = maxCacheEntries;

    // Seed single-byte token IDs (0..255)
    for (let b = 0; b < 256; b++) {
      this.tokenToId.set(String.fromCharCode(b), b);
    }
  }

  private getId(piece: string): number {
    let id = this.tokenToId.get(piece);
    if (id === undefined) {
      id = this.tokenToId.size;
      this.tokenToId.set(piece, id);
    }
    return id;
  }

  private encodePiece(piece: string): number[] {
    const cached = this.cache.get(piece);
    if (cached) return cached;

    const bytes = textEncoder.encode(piece);
    let symbols = Array.from(bytes, (b) => String.fromCharCode(b));

    if (symbols.length > 1) {
      while (symbols.length > 1) {
        let bestRank = Infinity;
        let bestPairIdx = -1;

        for (let i = 0; i < symbols.length - 1; i++) {
          const rank = this.ranks.get(`${symbols[i]}\u0000${symbols[i + 1]}`);
          if (rank !== undefined && rank < bestRank) {
            bestRank = rank;
            bestPairIdx = i;
          }
        }

        if (bestPairIdx === -1) break;

        const left = symbols[bestPairIdx];
        const right = symbols[bestPairIdx + 1];
        const merged = `${left}${right}`;
        const nextSymbols: string[] = [];

        for (let i = 0; i < symbols.length; i++) {
          if (i < symbols.length - 1 && symbols[i] === left && symbols[i + 1] === right) {
            nextSymbols.push(merged);
            i++;
          } else {
            nextSymbols.push(symbols[i]);
          }
        }
        symbols = nextSymbols;
      }
    }

    const ids = symbols.map((sym) => this.getId(sym));
    if (this.cache.size >= this.maxCacheEntries) {
      this.cache.clear();
    }
    this.cache.set(piece, ids);
    return ids;
  }

  encode(text: string): number[] {
    if (!text) return [];
    const tokens: number[] = [];
    PRE_TOKENIZE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PRE_TOKENIZE_RE.exec(text)) !== null) {
      const pieceIds = this.encodePiece(match[0]);
      for (let i = 0; i < pieceIds.length; i++) {
        tokens.push(pieceIds[i]);
      }
    }
    return tokens;
  }

  count(text: string): number {
    if (!text) return 0;
    let total = 0;
    PRE_TOKENIZE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PRE_TOKENIZE_RE.exec(text)) !== null) {
      total += this.encodePiece(match[0]).length;
    }
    return total;
  }
}

const defaultTokenizer = new BPETokenizer();

/**
 * Look up the default context window (in tokens) for a provider/model pair.
 */
export function getModelContextLimit(provider = '', model = ''): number {
  const m = String(model || '').toLowerCase();
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (m.includes(prefix)) return limit;
  }
  const p = String(provider || '').toLowerCase();
  if (['lmstudio', 'vllm', 'ollama', 'om'].includes(p)) return 16384;
  return 128000;
}

/**
 * Encode text into integer BPE token IDs using the built-in zero-dependency tokenizer.
 */
export function encodeTokens(text: unknown): number[] {
  if (!text) return [];
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return defaultTokenizer.encode(str);
}

/**
 * Count BPE tokens for a string or JSON-serializable value, with optional model factor.
 */
export function countTokens(text: unknown, model = ''): number {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (str.length === 0) return 0;
  const baseCount = defaultTokenizer.count(str);
  const m = String(model || '').toLowerCase();
  const modelFactor = m.includes('claude') ? 1.04 : 1.0;
  return Math.ceil(baseCount * modelFactor);
}

/**
 * Estimate total tokens across a chat message array and optional system prompt.
 */
export function estimateMessagesTokens(
  messages: ChatMessage[] = [],
  systemPrompt = '',
  model = ''
): { chars: number; estimatedTokens: number } {
  let tokens = systemPrompt ? countTokens(systemPrompt, model) + 4 : 0;
  let chars = (systemPrompt || '').length;

  for (const m of messages) {
    tokens += 4; // per-message framing overhead
    if (typeof m.content === 'string') {
      chars += m.content.length;
      tokens += countTokens(m.content, model);
    } else if (m.content) {
      const s = JSON.stringify(m.content);
      chars += s.length;
      tokens += countTokens(s, model);
    }
    if (m.toolCalls) {
      const tc = JSON.stringify(m.toolCalls);
      chars += tc.length;
      tokens += countTokens(tc, model);
    }
  }

  return { chars, estimatedTokens: tokens };
}
