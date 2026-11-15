import fs from 'node:fs';
import path from 'node:path';
import type { VectorStore } from '../vectorStore.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('OMMemory:Sessions');

function isLocalProvider(provider: string): boolean {
  return provider === 'vllm' || provider === 'lmstudio' || provider === 'om' || provider === 'mock';
}

function backfillAnswers(history: any[] | undefined, provider: string, model: string, target: string, fallbackTimestamp: string) {
  const answers: any[] = [];
  if (!Array.isArray(history)) return answers;
  let lastPrompt = '';
  for (const msg of history) {
    if (msg.role === 'user') {
      lastPrompt = msg.content || '';
    } else if (msg.role === 'assistant' && msg.content && (!msg.toolCalls || msg.toolCalls.length === 0)) {
      answers.push({
        prompt: lastPrompt,
        answer: msg.content,
        provider: msg.provider || provider,
        model: msg.model || model,
        target: msg.target || target,
        timestamp: msg.timestamp || fallbackTimestamp
      });
    }
  }
  return answers;
}

export function getNextSessionId(sessionsDir: string): string {
  if (!fs.existsSync(sessionsDir)) return 'session_1';
  try {
    const files = fs.readdirSync(sessionsDir);
    let max = 0;
    for (const f of files) {
      const match = f.match(/^session_(\d+)\.json$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return `session_${max + 1}`;
  } catch {
    return 'session_1';
  }
}

export function saveSessionFile(
  sessionsDir: string,
  vectorStore: VectorStore,
  sessionId: string,
  sessionData: Record<string, any>
) {
  const safeId = path.basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(sessionsDir, `${safeId}.json`);

  const provider = sessionData.provider || 'unknown';
  const model = sessionData.model || 'unknown';
  const target = sessionData.target || (isLocalProvider(provider) ? 'local' : 'cloud');
  const fallbackTs = sessionData.timestamp || new Date().toISOString();

  let answers = Array.isArray(sessionData.answers) ? [...sessionData.answers] : [];
  if (answers.length === 0 && Array.isArray(sessionData.history)) {
    answers = backfillAnswers(sessionData.history, provider, model, target, fallbackTs);
  }

  const payload = {
    sessionId: sessionData.sessionId || safeId,
    timestamp: fallbackTs,
    provider,
    model,
    target,
    answers,
    history: sessionData.history || [],
    steps: sessionData.steps || []
  };

  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');

  if (answers.length > 0) {
    const latest = answers[answers.length - 1];
    if (latest && (latest.prompt || latest.answer)) {
      vectorStore.upsertDocument({
        id: `session_${safeId}_turn_${answers.length}`,
        text: `Q: ${latest.prompt || ''} | A: ${(latest.answer || '').slice(0, 500)}`,
        source: `sessions/${safeId}.json`,
        metadata: {
          file: `sessions/${safeId}.json`,
          sessionId: safeId,
          provider,
          model,
          type: 'session'
        }
      });
    }
  }
}

export function loadSessionFile(sessionsDir: string, sessionId: string): Record<string, any> | null {
  const safeId = path.basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(sessionsDir, `${safeId}.json`);
  if (!fs.existsSync(file)) return null;

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.answers)) {
    const provider = data.provider || 'unknown';
    const model = data.model || 'unknown';
    const target = data.target || (isLocalProvider(provider) ? 'local' : 'cloud');
    data.answers = backfillAnswers(data.history, provider, model, target, data.timestamp || new Date().toISOString());
  }
  return data;
}

export function listSessionFiles(sessionsDir: string): Array<Record<string, any>> {
  if (!fs.existsSync(sessionsDir)) return [];
  try {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    const sessions: Array<Record<string, any>> = [];
    for (const file of files) {
      try {
        const fullPath = path.join(sessionsDir, file);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const match = file.match(/^session_(\d+)\.json$/);
        const sessionNum = match ? parseInt(match[1], 10) : Infinity;
        const answers = Array.isArray(data.answers) ? data.answers : [];
        sessions.push({
          file,
          sessionId: data.sessionId || file.replace('.json', ''),
          sessionNumber: sessionNum,
          timestamp: data.timestamp,
          provider: data.provider,
          model: data.model,
          target: data.target || (isLocalProvider(data.provider) ? 'local' : 'cloud'),
          historyLength: Array.isArray(data.history) ? data.history.length : 0,
          answersCount: answers.length,
          firstTask: data.history?.find((m: any) => m.role === 'user')?.content || '(no prompt)',
          latestAnswer: answers.slice(-1)[0]?.answer || data.history?.filter((m: any) => m.role === 'assistant')?.slice(-1)[0]?.content || ''
        });
      } catch (err: any) {
        log.debug(`Failed to parse session ${file}: ${err.message}`);
      }
    }
    sessions.sort((a, b) => a.sessionNumber - b.sessionNumber);
    return sessions;
  } catch (err: any) {
    log.warn(`Failed to list sessions: ${err.message}`);
    return [];
  }
}

export function clearSessionFiles(sessionsDir: string, vectorStore: VectorStore) {
  if (!fs.existsSync(sessionsDir)) return;
  try {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(sessionsDir, file));
        } catch (err: any) {
          log.warn(`Failed to delete session ${file}: ${err.message}`);
        }
      }
    }
    vectorStore.removeBySource('sessions/');
  } catch (err: any) {
    log.warn(`Failed to clear sessions directory: ${err.message}`);
  }
}
