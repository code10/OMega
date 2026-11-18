import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { fetchWithTimeout } from '../utils/http.js';
import { buildSafeChildEnv } from '../utils/redact.js';

const log = createLogger('MCPClient');

/**
 * Lightweight zero-dependency Model Context Protocol (MCP) JSON-RPC 2.0 client.
 * Supports both stdio and Streamable HTTP transports, tools, resources, prompts,
 * and automatic reconnection for stdio processes.
 */
export class MCPClient {
  name: string;
  transport: string;
  url: string;
  headers: Record<string, string>;
  command?: string;
  args: string[];
  env: Record<string, string>;
  inheritSensitiveEnv: boolean;
  cwd: string;
  timeoutMs: number;
  autoReconnect: boolean;
  proc: any;
  _nextId: number;
  _pending: Map<number, any>;
  _buffer: string;
  _connected: boolean;
  _closing: boolean;
  _sessionHeader: string | null;

  constructor(name: string, serverConfig: Record<string, any> = {}) {
    this.name = name;
    this.transport = serverConfig.transport || (serverConfig.url ? 'http' : 'stdio');
    this.url = serverConfig.url || '';
    this.headers = serverConfig.headers || {};
    this.command = serverConfig.command;
    this.args = Array.isArray(serverConfig.args) ? serverConfig.args : [];
    this.env = serverConfig.env || {};
    this.inheritSensitiveEnv = Boolean(serverConfig.inheritSensitiveEnv);
    this.cwd = serverConfig.cwd || process.cwd();
    this.timeoutMs = serverConfig.timeoutMs || 15000;
    this.autoReconnect = serverConfig.autoReconnect !== false;
    this.proc = null;
    this._nextId = 1;
    this._pending = new Map();
    this._buffer = '';
    this._connected = false;
    this._closing = false;
    this._sessionHeader = null;
  }

  async connect() {
    if (this._connected) return;
    this._closing = false;

    if (this.transport === 'http') {
      if (!this.url) {
        throw new Error(`HTTP MCP server '${this.name}' requires a 'url'`);
      }
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'OMega', version: '1.1.0' }
      });
      await this.notify('notifications/initialized', {});
      this._connected = true;
      return;
    }

    if (!this.command) {
      throw new Error(`MCP server '${this.name}' requires a 'command'`);
    }

    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: buildSafeChildEnv(process.env, this.env, this.inheritSensitiveEnv),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      log.debug(`[${this.name} stderr] ${chunk.trim()}`);
    });
    this.proc.on('exit', (code: number | null) => {
      this._connected = false;
      for (const [, pending] of this._pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server '${this.name}' exited with code ${code}`));
      }
      this._pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'OMega', version: '1.1.0' }
    });
    this.notify('notifications/initialized', {});
    this._connected = true;
  }

  _onData(chunk: string) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const { resolve, reject, timer } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      } catch (err: any) {
        log.warn(`Malformed JSON-RPC message from MCP '${this.name}': ${err.message}`);
      }
    }
  }

  async notify(method: string, params: Record<string, any> = {}) {
    if (this.transport === 'http') {
      try {
        await fetchWithTimeout(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.headers,
            ...(this._sessionHeader ? { 'Mcp-Session-Id': this._sessionHeader } : {})
          },
          body: JSON.stringify({ jsonrpc: '2.0', method, params })
        }, this.timeoutMs);
      } catch (err: any) {
        log.debug(`HTTP MCP notify '${method}' error: ${err.message}`);
      }
      return;
    }
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async request(method: string, params: Record<string, any> = {}) {
    const id = this._nextId++;
    if (this.transport === 'http') {
      const res = await fetchWithTimeout(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
          ...(this._sessionHeader ? { 'Mcp-Session-Id': this._sessionHeader } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      }, this.timeoutMs);
      const sid = res.headers?.get?.('mcp-session-id');
      if (sid) this._sessionHeader = sid;
      if (!res.ok) {
        throw new Error(`HTTP MCP '${this.name}' error [${res.status}]: ${await res.text()}`);
      }
      const ctype = res.headers?.get?.('content-type') || '';
      if (ctype.includes('text/event-stream')) {
        const text = await res.text();
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith('data:')) {
            const payload = JSON.parse(line.slice(5).trim());
            if (payload.id === id) {
              if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
              return payload.result;
            }
          }
        }
        throw new Error(`HTTP MCP '${this.name}' SSE stream returned no matching response`);
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      return data.result;
    }

    if (!this.proc || !this.proc.stdin.writable) {
      if (this.autoReconnect && !this._closing && method !== 'initialize') {
        await this.connect();
      } else {
        throw new Error(`MCP server '${this.name}' is not running`);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request '${method}' to '${this.name}' timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this._pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async listTools() {
    const res = await this.request('tools/list', {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(toolName: string, args: Record<string, any> = {}) {
    return this.request('tools/call', { name: toolName, arguments: args });
  }

  async listResources() {
    const res = await this.request('resources/list', {});
    return Array.isArray(res?.resources) ? res.resources : [];
  }

  async readResource(uri: string) {
    return this.request('resources/read', { uri });
  }

  async listPrompts() {
    const res = await this.request('prompts/list', {});
    return Array.isArray(res?.prompts) ? res.prompts : [];
  }

  async getPrompt(name: string, args: Record<string, any> = {}) {
    return this.request('prompts/get', { name, arguments: args });
  }

  close() {
    this._closing = true;
    this._connected = false;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (err: any) {
        log.debug(`Error killing MCP process '${this.name}': ${err.message}`);
      }
      this.proc = null;
    }
  }
}

export class MCPManager {
  clients: Map<string, MCPClient>;

  constructor() {
    this.clients = new Map();
  }

  async connectAll(mcpServers: Record<string, any> = {}, skillRegistry: any = null) {
    const registered = [];
    for (const [serverName, cfg] of Object.entries(mcpServers || {}) as Array<[string, any]>) {
      if (!cfg || cfg.disabled) continue;
      try {
        const client = new MCPClient(serverName, cfg);
        await client.connect();
        this.clients.set(serverName, client);

        const tools = await client.listTools();
        for (const tool of tools) {
          const skillName = `mcp_${serverName}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
          if (skillRegistry) {
            skillRegistry.register({
              name: skillName,
              source: 'mcp',
              description: `[MCP:${serverName}] ${tool.description || tool.name}`,
              parameters: tool.inputSchema || { type: 'object', properties: {} },
              execute: async (args: Record<string, any>) => {
                const res = await client.callTool(tool.name, args);
                return {
                  success: !res?.isError,
                  server: serverName,
                  tool: tool.name,
                  content: res?.content || res
                };
              }
            });
          }
          registered.push(skillName);
        }
      } catch (err: any) {
        log.warn(`Failed to connect MCP server '${serverName}': ${err.message}`);
      }
    }
    return registered;
  }

  closeAll() {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }
}

