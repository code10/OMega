/**
 * Shared HTTP fetch helper with timeout and hardened WHATWG SSE stream parsing
 * for providers and http_request.
 */

/**
 * Parse Retry-After and provider-specific rate-limit reset headers into milliseconds.
 * Supports numeric seconds, RFC 9110 HTTP-date, and Go/OpenAI duration strings (e.g. "1m30s", "450ms").
 */
export function parseRetryAfterMs(headers?: Headers | { get?: (name: string) => string | null } | null): number | undefined {
  if (!headers || typeof headers.get !== 'function') return undefined;

  const parseDurationStr = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    // Pure numeric seconds (e.g. "12" or "1.5")
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const sec = Number(trimmed);
      return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : undefined;
    }
    // Duration tokens like "1h2m3s", "15s", "450ms"
    let totalMs = 0;
    let matched = false;
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed)) !== null) {
      matched = true;
      const val = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (unit === 'ms') totalMs += val;
      else if (unit === 's') totalMs += val * 1000;
      else if (unit === 'm') totalMs += val * 60_000;
      else if (unit === 'h') totalMs += val * 3_600_000;
    }
    if (matched && totalMs > 0) return Math.round(totalMs);
    // RFC 9110 HTTP-date / ISO-8601 timestamp
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) {
      const delta = parsedDate - Date.now();
      return delta > 0 ? delta : undefined;
    }
    return undefined;
  };

  const candidates = [
    headers.get('retry-after-ms'),
    headers.get('retry-after'),
    headers.get('x-ratelimit-reset-requests'),
    headers.get('x-ratelimit-reset-tokens'),
    headers.get('anthropic-ratelimit-requests-reset')
  ];

  // retry-after-ms is explicitly milliseconds when numeric
  const rawMs = candidates[0];
  if (rawMs && /^\d+(?:\.\d+)?$/.test(rawMs.trim())) {
    const ms = Number(rawMs.trim());
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
  }

  for (let i = 1; i < candidates.length; i++) {
    const val = candidates[i];
    if (!val) continue;
    const ms = parseDurationStr(val);
    if (ms && ms > 0) return ms;
  }
  return undefined;
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
  totalMaxTimeoutMs = 90000
): Promise<Response> {
  const { signal: externalSignal, ...rest } = options;
  const runFetch = async (ms: number) => {
    const controller = new AbortController();
    const timer = ms > 0 ? setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms) : null;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(url, { ...rest, signal: controller.signal });
      // Headers received: clear header timeout so active SSE streams are governed by idle-token timeout
      if (timer) clearTimeout(timer);
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      throw err;
    } finally {
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };

  const attachTimeoutStatus = (err: any) => {
    if (err && typeof err === 'object' && (err.name === 'TimeoutError' || err.name === 'AbortError') && !externalSignal?.aborted) {
      err.status = err.status || 408;
    }
    return err;
  };

  try {
    return await runFetch(timeoutMs);
  } catch (err: any) {
    const isTimeout = (err?.name === 'TimeoutError' || err?.name === 'AbortError') && !externalSignal?.aborted;
    const bodyBytes = typeof rest.body === 'string' ? Buffer.byteLength(rest.body, 'utf8') : 0;
    const remainingBudgetMs = totalMaxTimeoutMs - timeoutMs;
    // Only extend once for very large prompts (>= 32KB) and cap the retry window so failover stays responsive
    if (isTimeout && bodyBytes >= 32768 && timeoutMs > 0 && remainingBudgetMs > 0) {
      try {
        return await runFetch(Math.min(remainingBudgetMs, timeoutMs));
      } catch (retryErr: any) {
        throw attachTimeoutStatus(retryErr);
      }
    }
    throw attachTimeoutStatus(err);
  }
}

/**
 * Extract an LLM token delta (OpenAI, Anthropic, Gemini) from a raw SSE `data:` payload.
 */
export function extractSSEToken(dataStr: string): { token?: string; json?: any } {
  if (!dataStr || dataStr === '[DONE]') return {};
  try {
    const json = JSON.parse(dataStr);
    const token =
      json?.choices?.[0]?.delta?.content ??
      json?.delta?.text ??
      json?.candidates?.[0]?.content?.parts?.[0]?.text ??
      json?.token ??
      json?.content;
    return {
      json,
      ...(typeof token === 'string' && token.length > 0 ? { token } : {})
    };
  } catch (_) {
    return {};
  }
}

export interface ConsumeSSEOptions {
  maxBufferBytes?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onRetry?: (retryMs: number) => void;
}

/**
 * Iterate over Server-Sent Events (SSE) data payloads from a Fetch Response body.
 * Implements WHATWG SSE field rules (`event:`, `data:`, `id:`, `retry:`, comments)
 * with single-space stripping on `data:`, bounded buffer protection, AbortSignal cancellation,
 * and clean reader cancellation on idle timeout to prevent TCP socket leaks.
 */
export async function consumeSSEStream(
  res: Response,
  onEvent: (dataStr: string, eventName: string, id?: string) => void,
  options: ConsumeSSEOptions = {}
): Promise<void> {
  if (!res.body) return;
  const maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024;
  const idleTimeoutMs = options.idleTimeoutMs ?? 25000;
  const signal = options.signal;
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lastEventId: string | undefined;
  let cancelled = false;

  const cancelReaderSafely = async (reason?: unknown) => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel(reason);
    } catch (_) {}
  };

  const makeAbortError = () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
  };

  const readWithIdleTimeout = async () => {
    if (signal?.aborted) {
      await cancelReaderSafely(signal.reason);
      throw makeAbortError();
    }
    if (idleTimeoutMs <= 0 && !signal) return reader.read();

    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    try {
      const racers: Array<Promise<ReadableStreamReadResult<Uint8Array>>> = [reader.read()];
      if (idleTimeoutMs > 0) {
        racers.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err: Error & { status?: number } = new Error(`SSE stream idle timeout after ${idleTimeoutMs}ms`);
              err.name = 'TimeoutError';
              err.status = 408;
              reject(err);
              void cancelReaderSafely(err);
            }, idleTimeoutMs);
          })
        );
      }
      if (signal) {
        racers.push(
          new Promise<never>((_, reject) => {
            onAbort = () => {
              const err = makeAbortError();
              reject(err);
              void cancelReaderSafely(err);
            };
            signal.addEventListener('abort', onAbort, { once: true });
          })
        );
      }
      return await Promise.race(racers);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  const processBlock = (block: string) => {
    const lines = block.split(/\r\n|\r|\n/);
    const dataLines: string[] = [];
    let eventName = 'message';
    let hasEventData = false;

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') {
        eventName = value || 'message';
      } else if (field === 'data') {
        dataLines.push(value);
        hasEventData = true;
      } else if (field === 'id') {
        if (!value.includes('\0')) {
          lastEventId = value;
        }
      } else if (field === 'retry') {
        if (/^\d+$/.test(value)) {
          options.onRetry?.(Number(value));
        }
      }
    }

    if (hasEventData) {
      onEvent(dataLines.join('\n'), eventName, lastEventId);
    }
  };

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      if (buffer.length * 3 > maxBufferBytes && Buffer.byteLength(buffer, 'utf8') > maxBufferBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`SSE stream buffer exceeded ${maxBufferBytes} bytes`);
      }

      let match: RegExpExecArray | null;
      const blockSepRe = /\r\n\r\n|\n\n|\r\r/;
      while ((match = blockSepRe.exec(buffer)) !== null) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (block.trim()) {
          processBlock(block);
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      processBlock(buffer);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {}
  }
}
