import { BaseProvider } from './base.js';
import { ModelService } from '../modelService.js';
import { fetchWithTimeout, consumeSSEStream, parseRetryAfterMs } from '../utils/http.js';

export class AnthropicProvider extends BaseProvider {
  apiKey?: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  maxTokens: number;

  constructor(options: Record<string, any> = {}) {
    super({
      name: 'anthropic',
      model: options.model || process.env.OM_MODEL || 'claude-3-5-sonnet-20241022',
      baseUrl: options.baseUrl || 'https://api.anthropic.com/v1'
    });
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    this.timeoutMs = options.timeoutMs || 30000;
    this.idleTimeoutMs = options.idleTimeoutMs || 25000;
    this.maxTokens = options.maxTokens || 4096;
    if (!this.apiKey) {
      console.warn('[AnthropicProvider] Warning: ANTHROPIC_API_KEY not set.');
    }
  }

  async chat({ messages, tools, systemPrompt, dynamicContext, promptCache = true, temperature = 0.2, effort, maxTokens, onToken, signal }: Record<string, any>) {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for Anthropic provider');
    }

    const formattedMessages = [];
    for (const msg of messages) {
      if (msg.role === 'tool') {
        const toolBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId || msg.name,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        };
        const prev = formattedMessages[formattedMessages.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') {
          prev.content.push(toolBlock);
        } else {
          formattedMessages.push({
            role: 'user',
            content: [toolBlock]
          });
        }
      } else if (msg.role === 'assistant') {
        const contentBlocks = [];
        if (msg.content) {
          contentBlocks.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.args
            });
          }
        }
        formattedMessages.push({ role: 'assistant', content: contentBlocks.length ? contentBlocks : '' });
      } else if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        const blocks: Array<Record<string, any>> = [{ type: 'text', text: msg.content || '' }];
        for (const att of msg.attachments) {
          if (att.data) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: att.mimeType || 'image/png',
                data: att.data
              }
            });
          }
        }
        formattedMessages.push({ role: msg.role, content: blocks });
      } else {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    }

    // Prompt caching: mark static system prompt, last tool definition, and penultimate turn with ephemeral cache_control
    let systemPayload: any = undefined;
    if (systemPrompt || dynamicContext) {
      if (promptCache) {
        const blocks: Array<Record<string, any>> = [];
        if (systemPrompt) {
          blocks.push({ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } });
        }
        if (dynamicContext) {
          blocks.push({ type: 'text', text: dynamicContext });
        }
        systemPayload = blocks;
      } else {
        systemPayload = [systemPrompt, dynamicContext].filter(Boolean).join('\n\n');
      }
    }

    let cachedTools = tools;
    if (promptCache && Array.isArray(tools) && tools.length > 0) {
      cachedTools = tools.map((t: any, idx: number) =>
        idx === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
      );
    }

    if (promptCache && formattedMessages.length >= 2) {
      const targetMsg = formattedMessages[formattedMessages.length - 2];
      if (typeof targetMsg.content === 'string' && targetMsg.content.length > 0) {
        targetMsg.content = [{ type: 'text', text: targetMsg.content, cache_control: { type: 'ephemeral' } }];
      } else if (Array.isArray(targetMsg.content) && targetMsg.content.length > 0) {
        const lastIdx = targetMsg.content.length - 1;
        targetMsg.content[lastIdx] = { ...targetMsg.content[lastIdx], cache_control: { type: 'ephemeral' } };
      }
    }

    const useStream = typeof onToken === 'function';
    const supportsThinking = /claude-(3-7|sonnet-4|opus-4|haiku-4|4)/i.test(this.model);
    const thinkingBudget = effort === 'low' ? 1024 : effort === 'high' ? 10240 : 4096;
    const enableThinking = Boolean(supportsThinking && effort);
    const resolvedMaxTokens = maxTokens || this.maxTokens || (enableThinking ? Math.max(4096, thinkingBudget + 2048) : 4096);
    const payload: Record<string, any> = {
      model: this.model,
      max_tokens: resolvedMaxTokens,
      messages: formattedMessages,
      ...(enableThinking ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : { temperature }),
      ...(useStream ? { stream: true } : {}),
      ...(systemPayload ? { system: systemPayload } : {}),
      ...(cachedTools && cachedTools.length > 0 ? { tools: cachedTools } : {})
    };

    const res = await fetchWithTimeout(
      `${this.baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {})
      },
      this.timeoutMs
    );

    if (!res.ok) {
      const errText = await res.text();
      const err: Error & { status?: number; retryAfterMs?: number } = new Error(`Anthropic API error [${res.status}]: ${errText}`);
      err.status = res.status;
      const retryAfterMs = parseRetryAfterMs(res.headers);
      if (retryAfterMs) err.retryAfterMs = retryAfterMs;
      throw err;
    }

    if (useStream) {
      let textContent = '';
      const toolCalls: any[] = [];
      const activeTools = new Map();
      const usage = {};

      await consumeSSEStream(res, (dataStr, eventName) => {
        let evt;
        try {
          evt = JSON.parse(dataStr);
        } catch (_) {
          return;
        }
        if (eventName === 'message_start' && evt.message?.usage) {
          Object.assign(usage, evt.message.usage);
        } else if (eventName === 'message_delta' && evt.usage) {
          Object.assign(usage, evt.usage);
        } else if (eventName === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          activeTools.set(evt.index, {
            id: evt.content_block.id,
            name: evt.content_block.name,
            jsonStr: ''
          });
        } else if (eventName === 'content_block_delta') {
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            textContent += evt.delta.text;
            onToken(evt.delta.text);
          } else if (evt.delta?.type === 'input_json_delta' && activeTools.has(evt.index)) {
            activeTools.get(evt.index).jsonStr += evt.delta.partial_json || '';
          }
        } else if (eventName === 'content_block_stop' && activeTools.has(evt.index)) {
          const tool = activeTools.get(evt.index);
          let parsedInput = {};
          try {
            parsedInput = tool.jsonStr ? JSON.parse(tool.jsonStr) : {};
          } catch (_) {
            parsedInput = { raw: tool.jsonStr };
          }
          toolCalls.push({ id: tool.id, name: tool.name, args: parsedInput });
          activeTools.delete(evt.index);
        }
      }, { idleTimeoutMs: this.idleTimeoutMs, signal });

      return { content: textContent, toolCalls, usage };
    }

    const data = await res.json();
    let textContent = '';
    const toolCalls = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input
        });
      }
    }

    return {
      content: textContent,
      toolCalls,
      usage: data.usage
    };
  }

  async listModels(options: Record<string, any> = {}) {
    return ModelService.listAnthropicModels({
      apiKey: options.apiKey || this.apiKey,
      baseUrl: options.baseUrl || this.baseUrl
    });
  }
}
