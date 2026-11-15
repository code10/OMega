import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { VectorStore } from './jsonStore.js';

const log = createLogger('SQLiteVectorStore');

interface SQLiteVectorRow {
  id: string;
  text: string;
  source: string;
  metadata: string | null;
  hash: string;
  vector: string;
  timestamp: string;
}

/**
 * Optional SQLite-backed VectorStore using Node's built-in `node:sqlite`.
 * Falls back gracefully to JSON VectorStore when `node:sqlite` is unavailable.
 */
export class SQLiteVectorStore extends VectorStore {
  dbPath: string;
  _db: any;
  _sqliteUnavailable: boolean;

  constructor(dbPath: string, options: Record<string, any> = {}) {
    super(dbPath, options);
    this.dbPath = dbPath;
    this._db = null;
    this._sqliteUnavailable = false;
  }

  async init() {
    if (this._db || this._sqliteUnavailable) return this;
    let DatabaseSync: any;
    const origEmitWarning = process.emitWarning;
    try {
      process.emitWarning = ((warning: any, ...args: any[]) => {
        const msg = typeof warning === 'string' ? warning : warning?.message || '';
        const type = typeof args[0] === 'string' ? args[0] : warning?.name || '';
        if (type === 'ExperimentalWarning' && msg.includes('SQLite')) {
          return;
        }
        return (origEmitWarning as any).call(process, warning, ...args);
      }) as typeof process.emitWarning;
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch (err: any) {
      log.warn(`node:sqlite unavailable (${err.message}); falling back to JSON VectorStore`);
      this._sqliteUnavailable = true;
      this._ensureLoaded();
      return this;
    } finally {
      process.emitWarning = origEmitWarning;
    }
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._db = new DatabaseSync(this.dbPath);
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        metadata TEXT,
        hash TEXT NOT NULL,
        vector TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_source ON vectors(source);
    `);
    const rows = this._db.prepare('SELECT id, text, source, metadata, hash, vector, timestamp FROM vectors').all() as SQLiteVectorRow[];
    this.documents = rows.map((r) => ({
      id: r.id,
      text: r.text,
      source: r.source,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      hash: r.hash,
      vector: JSON.parse(r.vector),
      timestamp: r.timestamp
    }));
    this._loaded = true;
    for (const doc of this.documents) {
      this._primeDocCache(doc);
    }
    return this;
  }

  save() {
    if (this._sqliteUnavailable) {
      this.scheduleSave();
      return;
    }
    if (!this._db) return;
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO vectors (id, text, source, metadata, hash, vector, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const doc of this.documents) {
      stmt.run(
        doc.id,
        doc.text,
        doc.source,
        JSON.stringify(doc.metadata || {}),
        doc.hash,
        JSON.stringify(doc.vector),
        doc.timestamp
      );
    }
  }

  async flush() {
    this.save();
  }

  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}
