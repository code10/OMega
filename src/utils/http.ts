/**
 * Shared HTTP fetch helper with timeout and hardened WHATWG SSE stream parsing
 * for providers and http_request.
 */

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 60000,
  totalMaxTimeoutMs = 180000
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

  try {
    return await runFetch(timeoutMs);
  } catch (err: any) {
    const isTimeout = (err?.name === 'TimeoutError' || err?.name === 'AbortError') && !externalSignal?.aborted;
    const bodyBytes = typeof rest.body === 'string' ? Buffer.byteLength(rest.body, 'utf8') : 0;
    const remainingBudgetMs = totalMaxTimeoutMs - timeoutMs;
    if (isTimeout && bodyBytes >= 8192 && timeoutMs > 0 && remainingBudgetMs > 0) {
      return await runFetch(remainingBudgetMs);
    }
    throw err;
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
  onRetry?: (retryMs: number) => void;
}

/**
 * Iterate over Server-Sent Events (SSE) data payloads from a Fetch Response body.
 * Implements WHATWG SSE field rules (`event:`, `data:`, `id:`, `retry:`, comments)
 * with single-space stripping on `data:` and bounded buffer protection.
 */
export async function consumeSSEStream(
  res: Response,
  onEvent: (dataStr: string, eventName: string, id?: string) => void,
  options: ConsumeSSEOptions = {}
): Promise<void> {
  if (!res.body) return;
  const maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30000;
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lastEventId: string | undefined;

  const readWithIdleTimeout = async () => {
    if (idleTimeoutMs <= 0) return reader.read();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err: Error & { status?: number } = new Error(`SSE stream idle timeout after ${idleTimeoutMs}ms`);
            err.name = 'TimeoutError';
            err.status = 408;
            reject(err);
          }, idleTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
