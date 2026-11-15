import { BaseProvider } from './base.js';
import { ModelService } from '../modelService.js';
import { fetchWithTimeout, consumeSSEStream } from '../utils/http.js';

export class GeminiProvider extends BaseProvider {
  apiKey?: string;
  timeoutMs: number;

  constructor(options: Record<string, any> = {}) {
    super({
      name: 'gemini',
      model: options.model || process.env.OM_MODEL || 'gemini-3-flash-preview',
      baseUrl: options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
    });
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.timeoutMs = options.timeoutMs || 60000;
    if (!this.apiKey) {
      console.warn('[GeminiProvider] Warning: GEMINI_API_KEY not set.');
    }
  }

  async chat({ messages, tools, systemPrompt, temperature = 0.2, maxTokens, responseFormat, onToken, signal }: Record<string, any>): Promise<any> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is required for Gemini provider');
    }

    const contents = [];
    for (const msg of messages) {
      if (msg.role === 'tool') {
        let parsedOutput;
        try {
          parsedOutput = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        } catch (_) {
          parsedOutput = { output: msg.content };
        }
        const fnRespPart = {
          functionResponse: {
            name: msg.name,
            response: typeof parsedOutput === 'object' && parsedOutput !== null ? parsedOutput : { output: String(parsedOutput) }
          }
        };
        const prev = contents[contents.length - 1];
        if (prev && prev.role === 'user' && prev.parts?.[0]?.functionResponse) {
          prev.parts.push(fnRespPart);
        } else {
          contents.push({
            role: 'user',
            parts: [fnRespPart]
          });
        }
      } else if (msg.role === 'assistant') {
        if (msg.rawParts && Array.isArray(msg.rawParts) && msg.rawParts.length > 0) {
          contents.push({ role: 'model', parts: msg.rawParts });
        } else {
          const parts = [];
          if (msg.content) parts.push({ text: msg.content });
          if (msg.toolCalls) {
            for (const tc of msg.toolCalls) {
              const fcPart: Record<string, any> = {
                functionCall: {
                  name: tc.name,
                  args: tc.args
                }
              };
              if (tc.thoughtSignature) {
                fcPart.thoughtSignature = tc.thoughtSignature;
              }
              parts.push(fcPart);
            }
          }
          contents.push({ role: 'model', parts });
        }
      } else {
        const parts: Array<Record<string, any>> = [{ text: msg.content }];
        if (Array.isArray(msg.attachments)) {
          for (const att of msg.attachments) {
            if (att.data) {
              parts.push({ inlineData: { mimeType: att.mimeType || 'image/png', data: att.data } });
            }
          }
        }
        contents.push({ role: 'user', parts });
      }
    }

    const payload: Record<string, any> = {
      contents,
      generationConfig: {
        temperature,
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        ...(responseFormat?.type === 'json_object' ? { responseMimeType: 'application/json' } : {}),
        ...(responseFormat?.json_schema?.schema
          ? { responseMimeType: 'application/json', responseSchema: responseFormat.json_schema.schema }
          : {})
      }
    };

    if (systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: systemPrompt }]
      };
    }

    if (tools && tools.length > 0) {
      payload.tools = tools;
    }

    const useStream = typeof onToken === 'function';
    const sendRequest = async (modelName: string, timeoutMs = this.timeoutMs, stream = false) => {
      const cleanModel = (modelName || '').replace(/^models\//, '');
      const action = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
      const url = `${this.baseUrl}/models/${cleanModel}:${action}key=${this.apiKey}`;
      return fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          ...(signal ? { signal } : {})
        },
        timeoutMs
      );
    };

    let activeModel = this.model;
    let res: Response | null = null;
    let initialError: any = null;

    try {
      res = await sendRequest(activeModel, this.timeoutMs, useStream);
    } catch (err) {
      initialError = err;
    }

    if (!res) {
      const err: Error & { status?: number } = new Error(`Gemini error on '${activeModel}': ${initialError?.message || 'request timed out'}`);
      if (initialError?.name === 'TimeoutError' || initialError?.name === 'AbortError') {
        err.status = 408;
      }
      throw err;
    }

    const okRes = res;
    if (!okRes.ok) {
      const errText = await okRes.text();
      let cleanMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) cleanMsg = parsed.error.message;
      } catch (_) {}

      const retryAfterHeader = okRes.headers?.get?.('retry-after');
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined;

      const makeHttpError = (msg: string) => {
        const err: Error & { status?: number; retryAfterMs?: number } = new Error(msg);
        err.status = okRes.status;
        if (retryAfterMs) err.retryAfterMs = retryAfterMs;
        return err;
      };

      if (okRes.status === 429) {
        if (cleanMsg.includes('limit: 0')) {
          throw makeHttpError(`Model '${this.model}' is not available on the Free Tier (quota limit: 0). Switch to an active free-tier model with: /model gemini-3.5-flash`);
        }
        throw makeHttpError(`Gemini Free Tier rate limit reached on '${this.model}' (5 RPM limit). Switch to 'gemini-3.5-flash' (higher quota) using: /model gemini-3.5-flash or /model gemini-3.5-flash-lite`);
      }
      if (okRes.status === 404 && (cleanMsg.includes('no longer available') || cleanMsg.includes('NOT_FOUND') || this.model.includes('2.5') || this.model.includes('1.5'))) {
        throw makeHttpError(`Model '${this.model}' is no longer available from Google (404). Please switch to an active, up-to-date model with: /model gemini-3.5-flash or /model gemini-3.8-flash`);
      }
      if (okRes.status === 503) {
        throw makeHttpError(`Model '${this.model}' is temporarily experiencing high demand (Google 503). Switch to active model with: /model gemini-3.5-flash`);
      }
      throw makeHttpError(`Gemini API error (${this.model}) [${okRes.status}]: ${cleanMsg}`);
    }

    if (useStream) {
      let textContent = '';
      const toolCalls: any[] = [];
      const rawParts: any[] = [];
      let usage = null;

      await consumeSSEStream(okRes, (dataStr) => {
        let chunk;
        try {
          chunk = JSON.parse(dataStr);
        } catch (_) {
          return;
        }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          rawParts.push(part);
          if (part.text && !part.thought) {
            textContent += part.text;
            onToken(part.text);
          }
          if (part.functionCall) {
            toolCalls.push({
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: part.functionCall.name,
              args: part.functionCall.args || {},
              thoughtSignature: part.thoughtSignature || part.thought_signature
            });
          }
        }
      });

      return { content: textContent, toolCalls, rawParts, usage };
    }

    const data = await okRes.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error('No candidate returned by Gemini');
    }

    let textContent = '';
    const toolCalls = [];
    const rawParts = candidate.content?.parts || [];

    for (const part of rawParts) {
      if (part.text && !part.thought) {
        textContent += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
          thoughtSignature: part.thoughtSignature || part.thought_signature
        });
      }
    }

    return {
      content: textContent,
      toolCalls,
      rawParts,
      usage: data.usageMetadata
    };
  }

  /**
   * List available models using Gemini ModelService.ListModels endpoint
   */
  async listModels(options: Record<string, any> = {}) {
    return ModelService.listGeminiModels({
      apiKey: options.apiKey || this.apiKey,
      baseUrl: options.baseUrl || this.baseUrl,
      onlyGenerative: options.onlyGenerative
    });
  }

  async ListModels(options: Record<string, any> = {}) {
    return this.listModels(options);
  }
}
