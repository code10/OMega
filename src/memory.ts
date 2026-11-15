import fs from 'node:fs';
import path from 'node:path';
import { VectorStore } from './vectorStore.js';
import { createLogger } from './utils/logger.js';
import { recursiveChunkText } from './memory/chunker.js';
import {
  clearSessionFiles,
  getNextSessionId as getNextSessionIdFromDir,
  listSessionFiles,
  loadSessionFile,
  saveSessionFile
} from './memory/sessions.js';

export { recursiveChunkText };

const log = createLogger('OMMemory');

/**
 * Markdown-based & Local Vector Semantic Memory System for OM Agent.
 * Stores long-term memory in MEMORY.md, daily journals in daily/YYYY-MM-DD.md,
 * conversation session logs in sessions/<id>.json, and semantic vector embeddings
 * in vectors.json.
 */
export class OMMemory {
  baseDir: string;
  memoryFile: string;
  dailyDir: string;
  sessionsDir: string;
  vectorFile: string;
  _longTermCache: string | null;
  _writeQueue: Promise<any>;
  vectorStore: VectorStore;

  constructor(baseDir: string, options: Record<string, any> = {}) {
    this.baseDir = path.resolve(baseDir);
    this.memoryFile = path.join(this.baseDir, 'MEMORY.md');
    this.dailyDir = path.join(this.baseDir, 'daily');
    this.sessionsDir = path.join(this.baseDir, 'sessions');
    this.vectorFile = path.join(this.baseDir, 'vectors.json');
    this._longTermCache = null;
    this._writeQueue = Promise.resolve();
    this.vectorStore = new VectorStore(this.vectorFile, {
      asyncEmbedder: options.asyncEmbedder
    });
    this._ensureDirectories();
    this._syncInitialVectors();
  }

  _enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    this._writeQueue = this._writeQueue.then(fn).catch((err) => {
      log.warn(`Async memory write failed: ${err.message}`);
    });
    return this._writeQueue;
  }

  async flush() {
    await this._writeQueue;
    if (this.vectorStore?.flush) {
      await this.vectorStore.flush();
    }
  }

  close() {
    this.vectorStore?.close?.();
  }

  _ensureDirectories() {
    for (const dir of [this.baseDir, this.dailyDir, this.sessionsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    if (!fs.existsSync(this.memoryFile)) {
      const initialTemplate = `# OM Long-Term Memory
This file stores persistent facts, user preferences, and important context across sessions.

## User & Environment
- Agent: OM (AI Agent Framework)
- Workspace initialized: ${new Date().toISOString()}

## Learned Facts & Notes
*(OM appends new facts here as it works)*
`;
      fs.writeFileSync(this.memoryFile, initialTemplate, 'utf8');
    }
  }

  getTodayFilename() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}.md`;
  }

  /**
   * Read long-term memory (cached in memory until written)
   */
  readLongTermMemory() {
    if (this._longTermCache !== null) {
      return this._longTermCache;
    }
    try {
      if (fs.existsSync(this.memoryFile)) {
        this._longTermCache = fs.readFileSync(this.memoryFile, 'utf8');
        return this._longTermCache;
      }
    } catch (e: any) {
      console.error('[Memory] Error reading MEMORY.md:', e.message);
    }
    return '';
  }

  /**
   * Overwrite long-term memory and re-index its vector embeddings
   */
  writeLongTermMemory(content: string) {
    this._longTermCache = content;
    fs.writeFileSync(this.memoryFile, content, 'utf8');
    this._indexMemoryMarkdown(content);
  }

  async writeLongTermMemoryAsync(content: string) {
    this._longTermCache = content;
    await this._enqueueWrite(async () => {
      await fs.promises.mkdir(this.baseDir, { recursive: true });
      await fs.promises.writeFile(this.memoryFile, content, 'utf8');
    });
    this._indexMemoryMarkdown(content);
  }

  /**
   * Append a key fact or preference to long-term memory and index vector embedding
   */
  appendFact(fact: string, category = 'Learned Facts & Notes') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `\n- [${timestamp}] ${fact}`;
    let content = this.readLongTermMemory();

    if (content.includes(`## ${category}`)) {
      content = content.replace(`## ${category}`, `## ${category}${entry}`);
    } else {
      content += `\n\n## ${category}${entry}\n`;
    }

    this.writeLongTermMemory(content);
    this.vectorStore.upsertDocument({
      text: `${category}: ${fact}`,
      source: 'MEMORY.md',
      metadata: { file: 'MEMORY.md', category, type: 'fact' }
    });
    this.logDaily(`Stored memory fact: "${fact}"`);
    return true;
  }

  async appendFactAsync(fact: string, category = 'Learned Facts & Notes') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `\n- [${timestamp}] ${fact}`;
    let content = this.readLongTermMemory();

    if (content.includes(`## ${category}`)) {
      content = content.replace(`## ${category}`, `## ${category}${entry}`);
    } else {
      content += `\n\n## ${category}${entry}\n`;
    }

    await this.writeLongTermMemoryAsync(content);
    await this.vectorStore.upsertDocumentAsync({
      text: `${category}: ${fact}`,
      source: 'MEMORY.md',
      metadata: { file: 'MEMORY.md', category, type: 'fact' }
    });
    await this.logDailyAsync(`Stored memory fact: "${fact}"`);
    return true;
  }

  /**
   * Log an event or note to today's daily journal (synchronous) and index in vector store
   */
  logDaily(entry: string) {
    const todayFile = this.getTodayFilename();
    const file = path.join(this.dailyDir, todayFile);
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${entry}\n`;

    if (!fs.existsSync(file)) {
      const header = `# Daily Journal - ${todayFile.replace('.md', '')}\n\n`;
      fs.writeFileSync(file, header + formatted, 'utf8');
    } else {
      fs.appendFileSync(file, formatted, 'utf8');
    }

    if (entry && entry.length > 8) {
      this.vectorStore.upsertDocument({
        text: entry,
        source: `daily/${todayFile}`,
        metadata: { file: `daily/${todayFile}`, type: 'journal', date: todayFile.replace('.md', '') }
      });
    }
  }

  /**
   * Log an event or note to today's daily journal asynchronously (non-blocking fs.promises)
   */
  async logDailyAsync(entry: string) {
    const todayFile = this.getTodayFilename();
    const file = path.join(this.dailyDir, todayFile);
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${entry}\n`;

    await this._enqueueWrite(async () => {
      await fs.promises.mkdir(this.dailyDir, { recursive: true });
      if (!fs.existsSync(file)) {
        const header = `# Daily Journal - ${todayFile.replace('.md', '')}\n\n`;
        await fs.promises.writeFile(file, header + formatted, 'utf8');
      } else {
        await fs.promises.appendFile(file, formatted, 'utf8');
      }
    });

    if (entry && entry.length > 8) {
      this.vectorStore.upsertDocument({
        text: entry,
        source: `daily/${todayFile}`,
        metadata: { file: `daily/${todayFile}`, type: 'journal', date: todayFile.replace('.md', '') }
      });
    }
  }

  /**
   * Read today's daily journal
   */
  readDailyJournal(dateStr = null) {
    const filename = dateStr ? `${dateStr}.md` : this.getTodayFilename();
    const file = path.join(this.dailyDir, filename);
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8');
    }
    return '';
  }

  /**
   * Search through memory files (MEMORY.md + daily logs + sessions + knowledge)
   * Combines exact keyword search with semantic vector similarity search.
   */
  search(query: string, options: Record<string, any> = {}) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];
    const results = [];
    const seenTexts = new Set();

    // 1. Exact substring matches in MEMORY.md
    const longTerm = this.readLongTermMemory();
    const lines = longTerm.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      const trimmed = lines[idx].trim();
      if (trimmed && trimmed.toLowerCase().includes(q)) {
        seenTexts.add(trimmed);
        results.push({
          file: 'MEMORY.md',
          source: 'MEMORY.md',
          line: idx + 1,
          text: trimmed,
          score: 1.0,
          matchType: 'exact'
        });
      }
    }

    // 2. Exact substring matches in daily logs
    try {
      const dailyFiles = fs.readdirSync(this.dailyDir).filter((f) => f.endsWith('.md'));
      for (const df of dailyFiles) {
        const content = fs.readFileSync(path.join(this.dailyDir, df), 'utf8');
        const dLines = content.split('\n');
        for (let idx = 0; idx < dLines.length; idx++) {
          const trimmed = dLines[idx].trim();
          if (trimmed && trimmed.toLowerCase().includes(q)) {
            seenTexts.add(trimmed);
            results.push({
              file: `daily/${df}`,
              source: `daily/${df}`,
              line: idx + 1,
              text: trimmed,
              score: 0.95,
              matchType: 'exact'
            });
          }
        }
      }
    } catch (_: any) { }

    // 3. Semantic vector search across all indexed memory, sessions, and knowledge
    if (options.semantic !== false) {
      const semanticHits = this.semanticSearch(query, {
        topK: options.topK || 10,
        minScore: options.minScore ?? 0.12,
        sourceFilter: options.sourceFilter
      });
      for (const hit of semanticHits) {
        if (!seenTexts.has(hit.text)) {
          seenTexts.add(hit.text);
          results.push({
            file: hit.file || hit.source,
            source: hit.source,
            line: hit.line || 1,
            text: hit.text,
            score: hit.score,
            vectorSimilarity: hit.vectorSimilarity,
            matchType: 'semantic'
          });
        }
      }
    }

    return results;
  }

  /**
   * Perform pure semantic vector search across MEMORY.md, daily journals, past sessions, and project knowledge
   */
  semanticSearch(query: string, options: Record<string, any> = {}) {
    return this.vectorStore.search(query, options);
  }

  /**
   * Index custom project knowledge base documents or markdown files into vector store
   * using recursive semantic/character chunking with overlap for large sections.
   */
  indexKnowledge(titleOrSource: string, content: string, metadata: Record<string, any> = {}) {
    if (!content || typeof content !== 'string') return 0;
    const chunkSize = metadata.chunkSize || 800;
    const chunkOverlap = metadata.chunkOverlap ?? 120;
    const paragraphs = content
      .split(/\n{2,}/)
      .map((c) => c.trim())
      .filter((c) => c.length >= 10);

    const chunks = [];
    for (const para of paragraphs) {
      if (para.length <= chunkSize) {
        chunks.push(para);
      } else {
        chunks.push(...recursiveChunkText(para, { chunkSize, chunkOverlap }));
      }
    }

    const batch = chunks.map((chunk, idx) => ({
      text: chunk,
      source: `knowledge/${titleOrSource}`,
      metadata: {
        file: titleOrSource,
        chunkIndex: idx + 1,
        type: 'knowledge',
        ...metadata
      }
    }));

    return this.vectorStore.indexBatch(batch);
  }

  /**
   * Prune old or excess memories from the vector store while preserving MEMORY.md facts.
   */
  pruneMemories(options: Record<string, any> = {}) {
    return this.vectorStore.prune(options);
  }

  /**
   * Rebuild or synchronize the entire vector index from MEMORY.md, daily logs, and sessions
   */
  rebuildVectorIndex() {
    this.vectorStore.clear();
    this._syncInitialVectors(true);
    return this.vectorStore.getStats();
  }

  _indexMemoryMarkdown(content: string) {
    if (!content) return;
    const lines = content.split('\n');
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('*(')) continue;
      const cleaned = line.replace(/^-\s*(\[[^\]]+\]\s*)?/, '').trim();
      if (cleaned.length >= 5) {
        items.push({
          text: line,
          source: 'MEMORY.md',
          metadata: { file: 'MEMORY.md', line: i + 1, type: 'memory' }
        });
      }
    }
    if (items.length > 0) {
      this.vectorStore.indexBatch(items);
    }
  }

  _syncInitialVectors(forceAll = false) {
    try {
      this.vectorStore._ensureLoaded();
      if (this.vectorStore.documents.length > 0 && !forceAll) {
        return;
      }

      const batch = [];

      // 1. Index MEMORY.md lines
      const memContent = this.readLongTermMemory();
      const memLines = memContent.split('\n');
      for (let i = 0; i < memLines.length; i++) {
        const line = memLines[i].trim();
        if (line && !line.startsWith('#') && !line.startsWith('*(') && line.length >= 6) {
          batch.push({
            text: line,
            source: 'MEMORY.md',
            metadata: { file: 'MEMORY.md', line: i + 1, type: 'memory' }
          });
        }
      }

      // 2. Index Daily Journals
      if (fs.existsSync(this.dailyDir)) {
        const dailyFiles = fs.readdirSync(this.dailyDir).filter((f) => f.endsWith('.md'));
        for (const df of dailyFiles) {
          const dContent = fs.readFileSync(path.join(this.dailyDir, df), 'utf8');
          const dLines = dContent.split('\n');
          for (let i = 0; i < dLines.length; i++) {
            const line = dLines[i].trim();
            if (line && !line.startsWith('#') && line.length >= 10) {
              batch.push({
                text: line,
                source: `daily/${df}`,
                metadata: { file: `daily/${df}`, line: i + 1, type: 'journal' }
              });
            }
          }
        }
      }

      // 3. Index Saved Sessions
      if (fs.existsSync(this.sessionsDir)) {
        const sessionFiles = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'));
        for (const sf of sessionFiles) {
          try {
            const sData = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, sf), 'utf8'));
            const sId = sData.sessionId || sf.replace('.json', '');
            for (const ans of sData.answers || []) {
              if (ans.prompt || ans.answer) {
                batch.push({
                  text: `Q: ${ans.prompt || ''} | A: ${(ans.answer || '').slice(0, 500)}`,
                  source: `sessions/${sf}`,
                  metadata: { file: `sessions/${sf}`, sessionId: sId, type: 'session' }
                });
              }
            }
          } catch (err: any) {
            log.debug(`Skipped unreadable session file ${sf}: ${err.message}`);
          }
        }
      }

      if (batch.length > 0) {
        this.vectorStore.indexBatch(batch);
      }
    } catch (err: any) {
      log.warn(`Initial vector sync error: ${err.message}`);
    }
  }

  getVectorStats() {
    return this.vectorStore.getStats();
  }

  /**
   * Determine the next sequential session ID (e.g. session_1, session_2, etc.)
   */
  getNextSessionId() {
    return getNextSessionIdFromDir(this.sessionsDir);
  }

  /**
   * Save a complete conversation session log with model answers and sanitized filename
   */
  saveSession(sessionId: string, sessionData: Record<string, any>) {
    saveSessionFile(this.sessionsDir, this.vectorStore, sessionId, sessionData);
  }

  /**
   * Retrieve session log with sanitized filename and auto-backfilled model answers
   */
  loadSession(sessionId: string) {
    return loadSessionFile(this.sessionsDir, sessionId);
  }

  /**
   * List all saved sessions sorted ascendingly by session number
   */
  listSessions() {
    return listSessionFiles(this.sessionsDir);
  }

  /**
   * Delete all saved session files to reset session history
   */
  clearAllSessions() {
    clearSessionFiles(this.sessionsDir, this.vectorStore);
  }

  /**
   * Render memory context for system prompt injection.
   * Daily activity logs are automatically trimmed to recent lines to optimize context length.
   */
  getPromptContext(options: Record<string, any> = {}) {
    const maxDailyLines = options.maxDailyLines || 50;
    const longTerm = this.readLongTermMemory().trim();
    let daily = this.readDailyJournal().trim();

    if (daily) {
      const dailyLines = daily.split('\n');
      if (dailyLines.length > maxDailyLines) {
        const headerLines = dailyLines.slice(0, 3).join('\n');
        const recentLines = dailyLines.slice(-(maxDailyLines - 3)).join('\n');
        daily = `${headerLines}\n... [${dailyLines.length - maxDailyLines} older log lines trimmed for token efficiency] ...\n${recentLines}`;
      }
    }

    let output = '';
    if (longTerm) {
      output += `\n<PERSISTENT_MEMORY>\n${longTerm}\n</PERSISTENT_MEMORY>\n`;
    }
    if (daily) {
      output += `\n<TODAYS_ACTIVITY_LOG>\n${daily}\n</TODAYS_ACTIVITY_LOG>\n`;
    }
    return output;
  }
}
