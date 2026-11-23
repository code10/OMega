/**
 * Zero-dependency LSH & concept-expanded text embeddings + optional HTTP embedder.
 */

export const EMBEDDING_DIM = 256;

const SEMANTIC_CONCEPTS: Record<string, string[]> = {
  typescript: ['ts', 'javascript', 'js', 'typing', 'types', 'compiler', 'frontend', 'code', 'language'],
  javascript: ['js', 'node', 'nodejs', 'ecmascript', 'typescript', 'ts', 'code', 'language'],
  python: ['py', 'pip', 'script', 'coding', 'language'],
  database: ['db', 'sql', 'sqlite', 'postgres', 'mongodb', 'storage', 'query', 'schema', 'persistence'],
  memory: ['remember', 'knowledge', 'context', 'fact', 'preference', 'recall', 'history', 'journal', 'vector'],
  security: ['auth', 'authentication', 'token', 'key', 'password', 'secret', 'permission', 'firewall', 'safe'],
  network: ['http', 'api', 'fetch', 'request', 'url', 'endpoint', 'server', 'port', 'gateway', 'webhook'],
  performance: ['fast', 'speed', 'latency', 'optimize', 'cache', 'memory', 'cpu', 'benchmark', 'turbo'],
  error: ['bug', 'issue', 'fail', 'failure', 'crash', 'exception', 'debug', 'recovery', 'fallback', 'fix'],
  model: ['llm', 'provider', 'gemini', 'openai', 'gpt', 'claude', 'anthropic', 'vllm', 'lmstudio', 'local', 'cloud', 'ai'],
  prefer: ['preference', 'like', 'favorite', 'choice', 'setting', 'config', 'style', 'workflow'],
  deploy: ['ship', 'release', 'build', 'package', 'npm', 'cli', 'production', 'docker', 'container'],
  test: ['testing', 'benchmark', 'eval', 'evaluation', 'verify', 'assert', 'suite', 'quality']
};

export const WORD_TO_CONCEPTS = new Map<string, Set<string>>();
for (const [concept, related] of Object.entries(SEMANTIC_CONCEPTS)) {
  if (!WORD_TO_CONCEPTS.has(concept)) WORD_TO_CONCEPTS.set(concept, new Set());
  WORD_TO_CONCEPTS.get(concept)!.add(concept);
  for (const w of related) {
    if (!WORD_TO_CONCEPTS.has(w)) WORD_TO_CONCEPTS.set(w, new Set());
    WORD_TO_CONCEPTS.get(w)!.add(concept);
    WORD_TO_CONCEPTS.get(concept)!.add(w);
  }
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this', 'that', 'these', 'those',
  'as', 'from', 'into', 'during', 'including', 'until', 'against', 'among', 'throughout'
]);

/**
 * Simple English Porter-style suffix stemmer.
 */
export function stemWord(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ly') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

/**
 * Tokenize text into normalized words and stems.
 */
export function tokenize(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function hashFeature(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * Compute a normalized 256-dimensional float vector embedding for any text.
 */
export function embedText(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Float32Array(dim);
  if (!text || typeof text !== 'string') return Array.from(vec);

  const rawTokens = tokenize(text);
  if (rawTokens.length === 0) return Array.from(vec);

  const addFeature = (feature: string, weight: number) => {
    const h1 = hashFeature(feature, 2166136261);
    const h2 = hashFeature(feature, 374761393);
    const idx = h1 % dim;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    const stem = stemWord(tok);

    addFeature(`tok:${tok}`, 2.0);
    if (stem !== tok) {
      addFeature(`stem:${stem}`, 1.8);
    }

    if (i < rawTokens.length - 1) {
      const nextStem = stemWord(rawTokens[i + 1]);
      addFeature(`bi:${stem}_${nextStem}`, 1.4);
    }

    const padded = `^${tok}$`;
    for (let c = 0; c <= padded.length - 3; c++) {
      addFeature(`c3:${padded.slice(c, c + 3)}`, 0.45);
      if (c <= padded.length - 4) {
        addFeature(`c4:${padded.slice(c, c + 4)}`, 0.35);
      }
    }

    const concepts = WORD_TO_CONCEPTS.get(tok) || WORD_TO_CONCEPTS.get(stem);
    if (concepts) {
      for (const concept of concepts) {
        addFeature(`concept:${concept}`, 1.1);
      }
    }
  }

  let normSq = 0;
  for (let i = 0; i < dim; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    const invNorm = 1 / norm;
    for (let i = 0; i < dim; i++) {
      vec[i] = Math.round(vec[i] * invNorm * 1e6) / 1e6;
    }
  }

  return Array.from(vec);
}

/**
 * Compute cosine similarity between two equal-length vectors.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface HttpEmbedderOptions {
  url?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Create an HTTP embedder function compatible with VectorStore({ asyncEmbedder }).
 */
export function createHttpEmbedder(options: HttpEmbedderOptions = {}): (text: string) => Promise<number[]> {
  const url = options.url || 'https://api.openai.com/v1/embeddings';
  const model = options.model || 'text-embedding-3-small';
  const timeoutMs = options.timeoutMs ?? 15000;
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.headers
  };

  return async function httpEmbed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ model, input: text }),
        signal: controller.signal
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP embedder error ${res.status}: ${body.slice(0, 200)}`);
      }
      const data: any = await res.json();
      if (Array.isArray(data?.data) && Array.isArray(data.data[0]?.embedding)) {
        return data.data[0].embedding;
      }
      if (Array.isArray(data?.embeddings) && Array.isArray(data.embeddings[0])) {
        return data.embeddings[0];
      }
      if (Array.isArray(data?.embedding)) {
        return data.embedding;
      }
      throw new Error('Unexpected embedding response format');
    } finally {
      clearTimeout(timer);
    }
  };
}
