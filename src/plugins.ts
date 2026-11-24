import fs from 'node:fs';
import path from 'node:path';
import { MCPClient } from './mcp/client.js';
import { documentSkills } from './skills/documents.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('OMPlugins');

export interface PluginFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  defaultValue?: string;
}

export interface PluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: 'builtin' | 'developer' | 'design' | 'communication' | 'productivity';
  kind: 'builtin' | 'mcp';
  icon: string;
  accentColor: string;
  defaultTransport?: 'stdio' | 'http';
  defaultCommand?: string;
  defaultArgs?: string[];
  defaultUrl?: string;
  fields?: PluginFieldSpec[];
  docsHint?: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  kind: 'builtin' | 'mcp';
  category: string;
  icon: string;
  accentColor: string;
  enabled: boolean;
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  connectedAt: string;
}

export interface PluginViewItem {
  id: string;
  name: string;
  description: string;
  kind: 'builtin' | 'mcp';
  category: string;
  icon: string;
  accentColor: string;
  enabled: boolean;
  connected: boolean;
  status: 'connected' | 'disabled' | 'offline';
  toolCount: number;
  lastError?: string;
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  configuredFields?: Record<string, string>;
}

export const STARTER_PLUGIN_CATALOG: PluginCatalogEntry[] = [
  {
    id: 'documents',
    name: 'Document Processing',
    description: 'Read, extract, and generate PDF, DOCX, PPTX, XLSX, and CSV files locally.',
    category: 'builtin',
    kind: 'builtin',
    icon: 'file-text',
    accentColor: '#e5a93c'
  },
  {
    id: 'scheduled-tasks',
    name: 'Scheduled Tasks',
    description: 'Run recurring cron jobs, webhooks, and background automations via OMega Daemon.',
    category: 'builtin',
    kind: 'builtin',
    icon: 'clock',
    accentColor: '#38bfb1'
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Inspect repositories, issues, pull requests, and code via official GitHub MCP.',
    category: 'developer',
    kind: 'mcp',
    icon: 'github',
    accentColor: '#f5f2eb',
    defaultTransport: 'stdio',
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-github'],
    fields: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal Access Token',
        placeholder: 'ghp_... or github_pat_...',
        secret: true,
        required: true
      }
    ],
    docsHint: 'Requires Node/npx or a remote Streamable HTTP MCP URL.'
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Manage GitLab projects, merge requests, pipelines, and issues via MCP.',
    category: 'developer',
    kind: 'mcp',
    icon: 'gitlab',
    accentColor: '#fc6d26',
    defaultTransport: 'stdio',
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-gitlab'],
    fields: [
      {
        key: 'GITLAB_PERSONAL_ACCESS_TOKEN',
        label: 'Personal Access Token',
        placeholder: 'glpat-...',
        secret: true,
        required: true
      },
      {
        key: 'GITLAB_API_URL',
        label: 'GitLab API URL',
        placeholder: 'https://gitlab.com/api/v4',
        defaultValue: 'https://gitlab.com/api/v4'
      }
    ]
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Inspect Figma frames, design tokens, components, and layouts via MCP.',
    category: 'design',
    kind: 'mcp',
    icon: 'figma',
    accentColor: '#a259ff',
    defaultTransport: 'http',
    defaultUrl: 'https://mcp.figma.com/mcp',
    fields: [
      {
        key: 'FIGMA_API_KEY',
        label: 'Figma Access Token',
        placeholder: 'figd_...',
        secret: true
      }
    ],
    docsHint: 'Connects to Figma MCP server (remote HTTP or local desktop bridge).'
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Read channels, search threads, and post updates to Discord servers via MCP.',
    category: 'communication',
    kind: 'mcp',
    icon: 'discord',
    accentColor: '#5865f2',
    defaultTransport: 'stdio',
    defaultCommand: 'npx',
    defaultArgs: ['-y', 'mcp-discord'],
    fields: [
      {
        key: 'DISCORD_TOKEN',
        label: 'Bot Token',
        placeholder: 'Discord Bot Token',
        secret: true,
        required: true
      }
    ]
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Browse Slack channels, summarize discussions, and send messages via MCP.',
    category: 'communication',
    kind: 'mcp',
    icon: 'slack',
    accentColor: '#e01e5a',
    defaultTransport: 'stdio',
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-slack'],
    fields: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Bot User OAuth Token',
        placeholder: 'xoxb-...',
        secret: true,
        required: true
      },
      {
        key: 'SLACK_TEAM_ID',
        label: 'Workspace Team ID',
        placeholder: 'T01234567'
      }
    ]
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Connect Gmail, Google Calendar, and Google Drive through a Workspace MCP server.',
    category: 'productivity',
    kind: 'mcp',
    icon: 'google',
    accentColor: '#4285f4',
    defaultTransport: 'http',
    defaultUrl: 'http://127.0.0.1:8000/mcp',
    fields: [
      {
        key: 'GOOGLE_ACCESS_TOKEN',
        label: 'OAuth / API Token (optional)',
        placeholder: 'Bearer token if required by your MCP endpoint',
        secret: true
      }
    ],
    docsHint: 'Point to your local or hosted Google Workspace MCP server URL.'
  }
];

function maskSecret(val: string): string {
  const s = String(val || '');
  if (!s) return '';
  if (s.length <= 6) return '••••••';
  return `••••${s.slice(-4)}`;
}

export class PluginManager {
  private filePath: string;
  private installed: Map<string, InstalledPluginRecord>;
  private runtimeStatus: Map<string, { status: 'connected' | 'disabled' | 'offline'; toolNames: string[]; lastError?: string }>;

  constructor(memoryDir: string) {
    const dir = path.resolve(memoryDir || './memory');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'plugins.json');
    this.installed = new Map();
    this.runtimeStatus = new Map();
    this.load();
  }

  private load() {
    let loaded = false;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(raw?.plugins)) {
          for (const rec of raw.plugins) {
            if (rec && typeof rec.id === 'string') {
              this.installed.set(rec.id, rec);
            }
          }
          loaded = true;
        }
      }
    } catch (err: any) {
      log.warn(`Failed to read plugins store: ${err?.message || err}`);
    }

    // Seed built-in plugins on first run so users immediately see active capabilities
    if (!loaded && this.installed.size === 0) {
      const now = new Date().toISOString();
      for (const entry of STARTER_PLUGIN_CATALOG.filter((c) => c.kind === 'builtin')) {
        this.installed.set(entry.id, {
          id: entry.id,
          name: entry.name,
          kind: 'builtin',
          category: entry.category,
          icon: entry.icon,
          accentColor: entry.accentColor,
          enabled: true,
          connectedAt: now
        });
      }
      this.save();
    }
  }

  private save() {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ version: 1, plugins: Array.from(this.installed.values()) }, null, 2),
        'utf-8'
      );
    } catch (err: any) {
      log.warn(`Failed to persist plugins store: ${err?.message || err}`);
    }
  }

  private applyBuiltinState(agent: any, pluginId: string, enabled: boolean) {
    if (pluginId === 'documents' && agent?.skills) {
      const docNames = documentSkills.map((s) => s.name);
      if (enabled) {
        for (const skill of documentSkills) {
          agent.skills.register(skill, 'builtin');
        }
      } else {
        for (const name of docNames) {
          agent.skills.skills?.delete(name);
        }
      }
      agent._invalidateToolsCache?.();
      this.runtimeStatus.set(pluginId, {
        status: enabled ? 'connected' : 'disabled',
        toolNames: enabled ? docNames : []
      });
      return;
    }

    this.runtimeStatus.set(pluginId, {
      status: enabled ? 'connected' : 'disabled',
      toolNames: []
    });
  }

  private unregisterMcpTools(agent: any, pluginId: string) {
    const prefix = `mcp_${pluginId}_`;
    if (agent?.skills?.skills) {
      for (const name of Array.from(agent.skills.skills.keys()) as string[]) {
        if (name.startsWith(prefix)) {
          agent.skills.skills.delete(name);
        }
      }
    }
    const existingClient = agent?.mcpManager?.clients?.get(pluginId);
    if (existingClient) {
      try {
        existingClient.close();
      } catch (_) {}
      agent.mcpManager.clients.delete(pluginId);
    }
    agent?._invalidateToolsCache?.();
  }

  private async connectMcpPlugin(agent: any, rec: InstalledPluginRecord): Promise<{ ok: boolean; toolCount: number; warning?: string }> {
    this.unregisterMcpTools(agent, rec.id);
    if (!rec.enabled) {
      this.runtimeStatus.set(rec.id, { status: 'disabled', toolNames: [] });
      return { ok: true, toolCount: 0 };
    }

    const cfg: Record<string, any> =
      rec.transport === 'http'
        ? {
            url: rec.url,
            headers: rec.headers || {},
            timeoutMs: 8000
          }
        : {
            command: rec.command,
            args: rec.args || [],
            env: rec.env || {},
            timeoutMs: 8000
          };

    try {
      const client = new MCPClient(rec.id, cfg);
      await client.connect();
      agent?.mcpManager?.clients?.set(rec.id, client);
      const tools = await client.listTools();
      const toolNames: string[] = [];

      for (const tool of tools) {
        const skillName = `mcp_${rec.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (agent?.skills) {
          agent.skills.register({
            name: skillName,
            source: 'mcp',
            description: `[Plugin:${rec.name}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema || { type: 'object', properties: {} },
            execute: async (args: Record<string, any>) => {
              const res = await client.callTool(tool.name, args);
              return {
                success: !res?.isError,
                server: rec.id,
                tool: tool.name,
                content: res?.content || res
              };
            }
          });
        }
        toolNames.push(skillName);
      }
      agent?._invalidateToolsCache?.();
      this.runtimeStatus.set(rec.id, { status: 'connected', toolNames });
      return { ok: true, toolCount: toolNames.length };
    } catch (err: any) {
      const msg = err?.message || String(err);
      log.warn(`Plugin '${rec.id}' saved but offline: ${msg}`);
      this.runtimeStatus.set(rec.id, { status: 'offline', toolNames: [], lastError: msg });
      return { ok: false, toolCount: 0, warning: `Saved plugin configuration, but live MCP handshake failed: ${msg}` };
    }
  }

  /**
   * Synchronize persisted built-in plugin states on startup.
   */
  syncInitialState(agent: any) {
    for (const rec of this.installed.values()) {
      if (rec.kind === 'builtin') {
        this.applyBuiltinState(agent, rec.id, rec.enabled);
      } else if (!this.runtimeStatus.has(rec.id)) {
        const isLive = Boolean(agent?.mcpManager?.clients?.has(rec.id));
        this.runtimeStatus.set(rec.id, {
          status: !rec.enabled ? 'disabled' : isLive ? 'connected' : 'offline',
          toolNames: []
        });
      }
    }
  }

  list(agent?: any): { connected: PluginViewItem[]; catalog: PluginCatalogEntry[] } {
    if (agent) this.syncInitialState(agent);

    const catalogById = new Map(STARTER_PLUGIN_CATALOG.map((c) => [c.id, c]));
    const connected: PluginViewItem[] = [];

    for (const rec of this.installed.values()) {
      const cat = catalogById.get(rec.id);
      const rt = this.runtimeStatus.get(rec.id);
      const masked: Record<string, string> = {};
      if (rec.env) {
        for (const [k, v] of Object.entries(rec.env)) {
          masked[k] = maskSecret(v);
        }
      }
      connected.push({
        id: rec.id,
        name: rec.name,
        description: cat?.description || `Custom MCP plugin (${rec.transport || 'stdio'})`,
        kind: rec.kind,
        category: rec.category,
        icon: rec.icon,
        accentColor: rec.accentColor,
        enabled: rec.enabled,
        connected: true,
        status: rt?.status || (rec.enabled ? 'connected' : 'disabled'),
        toolCount: rt?.toolNames?.length ?? (rec.id === 'documents' && rec.enabled ? documentSkills.length : 0),
        lastError: rt?.lastError,
        transport: rec.transport,
        command: rec.command,
        args: rec.args,
        url: rec.url,
        configuredFields: masked
      });
    }

    return {
      connected,
      catalog: STARTER_PLUGIN_CATALOG
    };
  }

  async connect(agent: any, payload: Record<string, any>) {
    const rawId = String(payload.id || payload.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!rawId) {
      throw new Error('Plugin id or name is required');
    }

    const cat = STARTER_PLUGIN_CATALOG.find((c) => c.id === rawId);
    const kind: 'builtin' | 'mcp' = cat?.kind || 'mcp';
    const name = String(payload.name || cat?.name || rawId).trim();

    if (kind === 'builtin') {
      const rec: InstalledPluginRecord = {
        id: rawId,
        name,
        kind: 'builtin',
        category: cat?.category || 'builtin',
        icon: cat?.icon || 'plug',
        accentColor: cat?.accentColor || '#e5a93c',
        enabled: true,
        connectedAt: new Date().toISOString()
      };
      this.installed.set(rawId, rec);
      this.save();
      this.applyBuiltinState(agent, rawId, true);
      return { success: true, plugin: this.list(agent).connected.find((p) => p.id === rawId) };
    }

    const transport: 'stdio' | 'http' = payload.transport === 'http' || (!payload.command && payload.url) ? 'http' : 'stdio';
    const url = transport === 'http' ? String(payload.url || cat?.defaultUrl || '').trim() : undefined;
    const command = transport === 'stdio' ? String(payload.command || cat?.defaultCommand || '').trim() : undefined;
    const args =
      transport === 'stdio'
        ? Array.isArray(payload.args)
          ? payload.args.map(String)
          : typeof payload.args === 'string' && payload.args.trim()
            ? payload.args.trim().split(/\s+/)
            : cat?.defaultArgs || []
        : undefined;

    if (transport === 'http' && !url) {
      throw new Error('MCP Server URL is required for HTTP transport');
    }
    if (transport === 'stdio' && !command) {
      throw new Error('Command is required for stdio transport');
    }

    const env: Record<string, string> = {};
    if (payload.env && typeof payload.env === 'object') {
      for (const [k, v] of Object.entries(payload.env)) {
        if (typeof v === 'string' && v.trim()) env[k] = v.trim();
      }
    }
    const headers: Record<string, string> = {};
    if (payload.headers && typeof payload.headers === 'object') {
      for (const [k, v] of Object.entries(payload.headers)) {
        if (typeof v === 'string' && v.trim()) headers[k] = v.trim();
      }
    }
    // Map common token env keys into Authorization header when using HTTP transport
    if (transport === 'http' && !headers.Authorization) {
      const bearer = env.FIGMA_API_KEY || env.GOOGLE_ACCESS_TOKEN || env.API_KEY || env.TOKEN;
      if (bearer) {
        headers.Authorization = bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}`;
      }
    }

    const rec: InstalledPluginRecord = {
      id: rawId,
      name,
      kind: 'mcp',
      category: cat?.category || 'developer',
      icon: cat?.icon || 'plug',
      accentColor: cat?.accentColor || '#38bfb1',
      enabled: true,
      transport,
      command,
      args,
      url,
      env,
      headers,
      connectedAt: new Date().toISOString()
    };

    this.installed.set(rawId, rec);
    this.save();
    const res = await this.connectMcpPlugin(agent, rec);
    return {
      success: true,
      warning: res.warning,
      toolCount: res.toolCount,
      plugin: this.list(agent).connected.find((p) => p.id === rawId)
    };
  }

  async toggle(agent: any, pluginId: string, enabled: boolean) {
    const rec = this.installed.get(pluginId);
    if (!rec) throw new Error(`Plugin '${pluginId}' is not connected`);
    rec.enabled = Boolean(enabled);
    this.installed.set(pluginId, rec);
    this.save();

    if (rec.kind === 'builtin') {
      this.applyBuiltinState(agent, pluginId, rec.enabled);
      return { success: true, plugin: this.list(agent).connected.find((p) => p.id === pluginId) };
    }

    const res = await this.connectMcpPlugin(agent, rec);
    return {
      success: true,
      warning: res.warning,
      plugin: this.list(agent).connected.find((p) => p.id === pluginId)
    };
  }

  disconnect(agent: any, pluginId: string) {
    const rec = this.installed.get(pluginId);
    if (!rec) throw new Error(`Plugin '${pluginId}' is not connected`);

    if (rec.kind === 'builtin') {
      this.applyBuiltinState(agent, pluginId, false);
    } else {
      this.unregisterMcpTools(agent, pluginId);
    }
    this.installed.delete(pluginId);
    this.runtimeStatus.delete(pluginId);
    this.save();
    return { success: true, id: pluginId };
  }
}
