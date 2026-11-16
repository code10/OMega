import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import {
  EMBEDDING_DIM,
  WORD_TO_CONCEPTS,
  cosineSimilarity,
  embedText,
  stemWord,
  tokenize
} from './embeddings.js';

const log = createLogger('VectorStore');

export interface VectorDocument {
  id: string;
  text: string;
  source: string;
  metadata: Record<string, any>;
  hash: string;
  vector: number[];
  timestamp: string;
}

export interface VectorUpsertItem {
  id?: string;
  text: string;
  source?: string;
  metadata?: Record<string, any>;
  vector?: number[] | null;
}

export interface VectorSearchResult {
  id: string;
  source: string;
  file: string;
  line: number;
  type: string;
  text: string;
  score: number;
  vectorSimilarity: number;
  metadata: Record<string, any>;
  timestamp: string;
}

export class VectorStore {
  storePath: string;
  documents: VectorDocument[];
  _loaded: boolean;
  _saveTimer: NodeJS.Timeout | null;
  _dirty: boolean;
  _closed: boolean;
  _docCache: Map<string, { tokenSet: Set<string>; stems: Set<string>; lowerText: string }>;
  _hashIndex: Map<string, number>;
  _idIndex: Map<string, number>;
  asyncEmbedder: ((text: string) => Promise<number[]>) | null;

  constructor(storePath: string, options: Record<string, any> = {}) {
    this.storePath = storePath;
    this.documents = [];
    this._loaded = false;
    this._saveTimer = null;
    this._dirty = false;
    this._closed = false;
    this._docCache = new Map();
    this._hashIndex = new Map();
    this._idIndex = new Map();
    this.asyncEmbedder = typeof options.asyncEmbedder === 'function' ? options.asyncEmbedder : null;
  }

  setEmbedder(asyncEmbedder: ((text: string) => Promise<number[]>) | null) {
    this.asyncEmbedder = typeof asyncEmbedder === 'function' ? asyncEmbedder : null;
  }

  _primeDocCache(doc: VectorDocument) {
    if (!doc || !doc.id) return;
    const tokens = tokenize(doc.text);
    const stems = new Set(tokens.map(stemWord));
    this._docCache.set(doc.id, {
      tokenSet: new Set(tokens),
      stems,
      lowerText: (doc.text || '').toLowerCase()
    });
  }

  _rebuildIndexes() {
    this._hashIndex.clear();
    this._idIndex.clear();
    this._docCache.clear();
    for (let i = 0; i < this.documents.length; i++) {
      const doc = this.documents[i];
      if (doc.hash) this._hashIndex.set(doc.hash, i);
      if (doc.id) this._idIndex.set(doc.id, i);
      this._primeDocCache(doc);
    }
  }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (this.storePath && fs.existsSync(this.storePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        if (Array.isArray(raw.documents)) {
          this.documents = raw.documents;
          this._rebuildIndexes();
        }
      } catch (err: any) {
        log.warn(`Failed to load vector store at ${this.storePath}: ${err.message}`);
        this.documents = [];
      }
    }
  }

  _buildPayload(): string {
    return JSON.stringify({
      version: '1.1',
      dimension: this.documents[0]?.vector?.length || EMBEDDING_DIM,
      updatedAt: new Date().toISOString(),
      count: this.documents.length,
      documents: this.documents
    });
  }

  save() {
    if (!this.storePath) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._dirty = false;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storePath, this._buildPayload(), 'utf8');
    } catch (err: any) {
      log.warn(`Failed to save vector store: ${err.message}`);
    }
  }

  scheduleSave(delayMs = 250) {
    if (!this.storePath || this._closed) return;
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush().catch((err: any) => log.warn(`Async vector save failed: ${err.message}`));
    }, delayMs);
    this._saveTimer.unref?.();
  }

  close() {
    this._closed = true;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._closed || !this._dirty || !this.storePath) return;
    this._dirty = false;
    try {
      const dir = path.dirname(this.storePath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.storePath, this._buildPayload(), 'utf8');
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return;
      log.warn(`Failed to flush vector store: ${err.message}`);
    }
  }

  _hashContent(source: string, text: string): string {
    return crypto.createHash('sha1').update(`${source}::${text}`).digest('hex').slice(0, 16);
  }

  upsertDocument(
    { id = undefined, text, source = 'memory', metadata = {}, vector = null }: VectorUpsertItem,
    persist: boolean | 'sync' = true
  ): VectorDocument | null {
    this._ensureLoaded();
    const cleanText = (text || '').trim();
    if (!cleanText) return null;

    const hash = this._hashContent(source, cleanText);
    const existingIdx = this._hashIndex.get(hash) ?? (id ? this._idIndex.get(id) : undefined) ?? -1;

    const doc: VectorDocument = {
      id: id || `vec_${hash}`,
      text: cleanText,
      source,
      metadata,
      hash,
      vector: Array.isArray(vector) && vector.length > 0 ? vector : embedText(cleanText),
      timestamp: new Date().toISOString()
    };

    if (existingIdx !== -1) {
      this.documents[existingIdx] = doc;
      this._hashIndex.set(doc.hash, existingIdx);
      this._idIndex.set(doc.id, existingIdx);
    } else {
      const idx = this.documents.length;
      this.documents.push(doc);
      this._hashIndex.set(doc.hash, idx);
      this._idIndex.set(doc.id, idx);
    }
    this._primeDocCache(doc);

    if (persist === 'sync') {
      this.save();
    } else if (persist) {
      this.scheduleSave();
    }
    return doc;
  }

  async upsertDocumentAsync(item: VectorUpsertItem, persist: boolean | 'sync' = true): Promise<VectorDocument | null> {
    let vector = item.vector || null;
    if (!vector && this.asyncEmbedder && item.text) {
      try {
        vector = await this.asyncEmbedder(item.text);
      } catch (err: any) {
        log.warn(`Async embedder failed, falling back to LSH: ${err.message}`);
      }
    }
    return this.upsertDocument({ ...item, vector }, persist);
  }

  indexBatch(items: VectorUpsertItem[] = []): number {
    this._ensureLoaded();
    let added = 0;
    for (const item of items) {
      const res = this.upsertDocument(item, false);
      if (res) added++;
    }
    this.save();
    return added;
  }

  removeBySource(sourcePrefix: string) {
    this._ensureLoaded();
    const before = this.documents.length;
    this.documents = this.documents.filter((d) => !d.source.startsWith(sourcePrefix));
    if (this.documents.length !== before) {
      this._rebuildIndexes();
      this.save();
    }
  }

  prune({
    maxDocuments = 2000,
    maxAgeDays = 90,
    preserveSources = ['MEMORY.md']
  }: { maxDocuments?: number; maxAgeDays?: number; preserveSources?: string[] } = {}): { removed: number; remaining: number } {
    this._ensureLoaded();
    const before = this.documents.length;
    if (before === 0) return { removed: 0, remaining: 0 };

    const cutoffMs = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86400000 : 0;
    const isPreserved = (doc: VectorDocument) => preserveSources.some((p) => doc.source === p || doc.source.startsWith(p));

    let kept = this.documents.filter((doc) => {
      if (isPreserved(doc)) return true;
      if (!cutoffMs || !doc.timestamp) return true;
      const ts = Date.parse(doc.timestamp);
      return Number.isNaN(ts) || ts >= cutoffMs;
    });

    if (maxDocuments > 0 && kept.length > maxDocuments) {
      const preserved = kept.filter(isPreserved);
      const evictable = kept
        .filter((d) => !isPreserved(d))
        .sort((a, b) => Date.parse(b.timestamp || '0') - Date.parse(a.timestamp || '0'));
      const allowedEvictable = Math.max(0, maxDocuments - preserved.length);
      kept = [...preserved, ...evictable.slice(0, allowedEvictable)];
    }

    const removed = before - kept.length;
    if (removed > 0) {
      this.documents = kept;
      this._rebuildIndexes();
      this.scheduleSave();
    }
    return { removed, remaining: this.documents.length };
  }

  clear() {
    this.documents = [];
    this._docCache.clear();
    this._hashIndex.clear();
    this._idIndex.clear();
    this._loaded = true;
    this.save();
  }

  search(query: string, options: Record<string, any> = {}): VectorSearchResult[] {
    this._ensureLoaded();
    const q = (query || '').trim();
    if (!q || this.documents.length === 0) return [];

    const topK = options.topK || 8;
    const minScore = options.minScore ?? 0.08;
    const sourceFilter = options.sourceFilter || null;

    const queryVec: number[] = Array.isArray(options.queryVector) ? options.queryVector : embedText(q);
    const queryTokens = tokenize(q);
    const queryStems = new Set(queryTokens.map(stemWord));
    const lowerQuery = q.toLowerCase();

    const scored: VectorSearchResult[] = [];

    for (const doc of this.documents) {
      if (sourceFilter && !doc.source.startsWith(sourceFilter)) {
        continue;
      }

      const cosSim = doc.vector && doc.vector.length === queryVec.length
        ? Math.max(0, cosineSimilarity(queryVec, doc.vector))
        : 0;

      let cached = this._docCache.get(doc.id);
      if (!cached) {
        this._primeDocCache(doc);
        cached = this._docCache.get(doc.id)!;
      }
      const { tokenSet, stems: docStems, lowerText } = cached;

      let stemMatches = 0;
      for (const qs of queryStems) {
        if (docStems.has(qs)) {
          stemMatches++;
        } else {
          const related = WORD_TO_CONCEPTS.get(qs);
          if (related) {
            for (const r of related) {
              if (docStems.has(r) || tokenSet.has(r)) {
                stemMatches += 0.65;
                break;
              }
            }
          }
        }
      }

      const lexicalScore = queryStems.size > 0 ? stemMatches / queryStems.size : 0;
      const exactSubstringBoost = lowerText.includes(lowerQuery) ? 0.25 : 0;

      const hybridScore = Number(
        Math.min(1, cosSim * 0.6 + lexicalScore * 0.4 + exactSubstringBoost).toFixed(4)
      );

      if (hybridScore >= minScore) {
        scored.push({
          id: doc.id,
          source: doc.source,
          file: doc.metadata?.file || doc.source,
          line: doc.metadata?.line || 1,
          type: doc.metadata?.type || 'memory',
          text: doc.text,
          score: hybridScore,
          vectorSimilarity: Number(cosSim.toFixed(4)),
          metadata: doc.metadata,
          timestamp: doc.timestamp
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async searchAsync(query: string, options: Record<string, any> = {}): Promise<VectorSearchResult[]> {
    let queryVector = options.queryVector || null;
    if (!queryVector && this.asyncEmbedder && query) {
      try {
        queryVector = await this.asyncEmbedder(query);
      } catch (err: any) {
        log.warn(`Async query embedding failed, falling back to LSH: ${err.message}`);
      }
    }
    return this.search(query, { ...options, queryVector });
  }

  getStats() {
    this._ensureLoaded();
    const sources: Record<string, number> = {};
    for (const d of this.documents) {
      const cat = d.source.split('/')[0] || 'other';
      sources[cat] = (sources[cat] || 0) + 1;
    }
    return {
      totalVectors: this.documents.length,
      dimension: EMBEDDING_DIM,
      sources,
      storePath: this.storePath
    };
  }
}
