import { BaseProvider } from './base.js';
import { ModelService } from '../modelService.js';
import { fetchWithTimeout, consumeSSEStream } from '../utils/http.js';

export class OpenAIProvider extends BaseProvider {
  apiKey?: string;
  apiKeyEnv: string;
  timeoutMs: number;

  constructor(options: Record<string, any> = {}) {
    const providerName = options.name || 'openai';
    const apiKeyEnv = options.apiKeyEnv || 'OPENAI_API_KEY';
    super({
      name: providerName,
      model: options.model || process.env.OM_MODEL || 'gpt-4o',
      baseUrl: options.baseUrl || 'https://api.openai.com/v1'
    });
    this.apiKeyEnv = apiKeyEnv;
    this.apiKey = options.apiKey || process.env[apiKeyEnv] || (apiKeyEnv === 'OPENAI_API_KEY' ? process.env.OPENAI_API_KEY : undefined);
    this.timeoutMs = options.timeoutMs || 60000;
    if (!this.apiKey) {
      console.warn(`[${providerName}] Warning: ${apiKeyEnv} not set.`);
    }
  }

  async chat({ messages, tools, systemPrompt, temperature = 0.2, effort, maxTokens, responseFormat, onToken, signal }: Record<string, any>) {
    if (!this.apiKey) {
      throw new Error(`${this.apiKeyEnv} environment variable is required for ${this.name} provider`);
    }

    const formattedMessages = [];
    if (systemPrompt) {
      formattedMessages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'tool') {
        formattedMessages.push({
          role: 'tool',
          tool_call_id: msg.toolCallId || msg.name,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      } else if (msg.role === 'assistant') {
        const assistantMsg: Record<string, any> = { role: 'assistant', content: msg.content || '' };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantMsg.tool_calls = msg.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)
            }
          }));
        }
        formattedMessages.push(assistantMsg);
      } else if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        const parts: Array<Record<string, any>> = [{ type: 'text', text: msg.content || '' }];
        for (const att of msg.attachments) {
          const url = att.url || (att.data ? `data:${att.mimeType || 'image/png'};base64,${att.data}` : null);
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
        formattedMessages.push({ role: msg.role, content: parts });
      } else {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const useStream = typeof onToken === 'function';
    const isReasoningModel = /^(o\d|gpt-5)/i.test(this.model);
    const supportsEffort = isReasoningModel || /reason/i.test(this.model);
    const payload: Record<string, any> = {
      model: this.model,
      messages: formattedMessages,
      ...(isReasoningModel ? {} : { temperature }),
      ...(supportsEffort && effort ? { reasoning_effort: effort } : isReasoningModel ? { reasoning_effort: 'medium' } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(useStream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
    };

    const res = await fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {})
      },
      this.timeoutMs
    );

    if (!res.ok) {
      const errText = await res.text();
      const err: Error & { status?: number; retryAfterMs?: number } = new Error(`${this.name} API error [${res.status}]: ${errText}`);
      err.status = res.status;
      const retrySec = Number(res.headers?.get?.('retry-after'));
      if (Number.isFinite(retrySec) && retrySec > 0) err.retryAfterMs = retrySec * 1000;
      throw err;
    }

    if (useStream) {
      let content = '';
      let usage = null;
      const toolCallMap = new Map();

      await consumeSSEStream(res, (dataStr) => {
        if (dataStr === '[DONE]') return;
        let chunk;
        try {
          chunk = JSON.parse(dataStr);
        } catch (_) {
          return;
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return;
        if (delta.content) {
          content += delta.content;
          onToken(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: tc.id || `call_${idx}`, name: '', argStr: '' });
            }
            const entry = toolCallMap.get(idx);
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.argStr += tc.function.arguments;
          }
        }
      });

      const toolCalls = [];
      for (const [, tc] of Array.from(toolCallMap.entries()).sort((a, b) => a[0] - b[0])) {
        let parsedArgs = {};
        try {
          parsedArgs = tc.argStr ? JSON.parse(tc.argStr) : {};
        } catch (_) {
          parsedArgs = { raw: tc.argStr };
        }
        toolCalls.push({ id: tc.id, name: tc.name, args: parsedArgs });
      }
      return { content, toolCalls, usage };
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('No completion choice returned from OpenAI');
    }

    const message = choice.message;
    const toolCalls = [];

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch (_) {
          parsedArgs = { raw: tc.function.arguments };
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args: parsedArgs
        });
      }
    }

    return {
      content: message.content || '',
      toolCalls,
      usage: data.usage
    };
  }

  async listModels(options: Record<string, any> = {}) {
    return ModelService.listOpenAIModels({
      provider: this.name,
      apiKeyEnv: this.apiKeyEnv,
      apiKey: options.apiKey || this.apiKey,
      baseUrl: options.baseUrl || this.baseUrl,
      onlyGenerative: options.onlyGenerative
    });
  }
}
