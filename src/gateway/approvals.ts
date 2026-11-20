import type http from 'node:http';
import { readJsonBody, sendJson } from './httpUtils.js';

const MULTI_SUBCOMMAND_CLIS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'cargo', 'docker', 'kubectl', 'pip', 'python', 'node'
]);
const SHELL_CHAIN_PATTERN = /[;&|`\n\r<>]|\$\(/;

/**
 * Extract a sensible default command prefix for scoped "Always Allow" rules
 * (e.g. "npm test -- --watch" -> "npm test", "git status -s" -> "git status").
 */
export function extractCommandPrefix(command: string): string {
  const tokens = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const first = tokens[0].toLowerCase();
  if (
    MULTI_SUBCOMMAND_CLIS.has(first) &&
    tokens.length >= 2 &&
    !tokens[1].startsWith('-') &&
    !SHELL_CHAIN_PATTERN.test(tokens[1])
  ) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0];
}

/**
 * Check whether a shell command safely matches any prefix in a rule list.
 * Rejects commands containing shell chaining/redirection operators so
 * "git status && rm -rf /" never matches a "git status" rule.
 */
export function matchesCommandRule(command: string, rules: string[]): boolean {
  const normalized = String(command || '').trim().replace(/\s+/g, ' ');
  if (!normalized || SHELL_CHAIN_PATTERN.test(normalized)) {
    return false;
  }
  const lowerCmd = normalized.toLowerCase();
  for (const rawRule of rules || []) {
    const rule = String(rawRule || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!rule) continue;
    if (lowerCmd === rule || lowerCmd.startsWith(`${rule} `)) {
      return true;
    }
  }
  return false;
}

export interface CommandRulesConfig {
  allow?: string[];
  deny?: string[];
}

/**
 * Manages Human-in-the-Loop (HITL) tool/shell execution approvals over SSE + REST.
 */
export class ApprovalManager {
  broadcastSSE: (eventName: string, data: any) => void;
  pending: Map<string, { payload: any; resolve: (approved: boolean) => void }>;
  sessionApprovedTools: Set<string>;
  sessionApprovedCommandPrefixes: Set<string>;
  onAlwaysAllow?: (tool: string, rule?: { commandPrefix?: string }) => void;
  getCommandRules?: () => CommandRulesConfig;

  constructor(
    broadcastSSE: (eventName: string, data: any) => void,
    onAlwaysAllow?: (tool: string, rule?: { commandPrefix?: string }) => void,
    getCommandRules?: () => CommandRulesConfig
  ) {
    this.broadcastSSE = broadcastSSE;
    this.pending = new Map();
    this.sessionApprovedTools = new Set();
    this.sessionApprovedCommandPrefixes = new Set();
    this.onAlwaysAllow = onAlwaysAllow;
    this.getCommandRules = getCommandRules;
  }

  /**
   * Create a confirmCommand handler compatible with OMAgent.
   * @returns {(info: any) => Promise<boolean>}
   */
  createConfirmHandler(): (info: Record<string, any>) => Promise<boolean> {
    return (info: Record<string, any>) => {
      const toolName = String(info.tool || 'exec_command');
      const commandText = info.command ? String(info.command) : '';

      if (toolName === 'exec_command' && commandText) {
        const rules = this.getCommandRules ? this.getCommandRules() : {};
        if (Array.isArray(rules.deny) && matchesCommandRule(commandText, rules.deny)) {
          return Promise.resolve(false);
        }
        const allowRules = [
          ...this.sessionApprovedCommandPrefixes,
          ...(Array.isArray(rules.allow) ? rules.allow : [])
        ];
        if (this.sessionApprovedTools.has(toolName) || matchesCommandRule(commandText, allowRules)) {
          return Promise.resolve(true);
        }
      } else if (this.sessionApprovedTools.has(toolName)) {
        return Promise.resolve(true);
      }

      const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const payload = {
        id,
        tool: toolName,
        args: info.args || null,
        command: commandText || null,
        suggestedPrefix: toolName === 'exec_command' && commandText ? extractCommandPrefix(commandText) : null,
        timestamp: new Date().toISOString()
      };
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(false);
        }, 120000);
        timer.unref?.();
        this.pending.set(id, {
          payload,
          resolve: (approved) => {
            clearTimeout(timer);
            this.pending.delete(id);
            resolve(Boolean(approved));
          }
        });
        this.broadcastSSE('approval_required', payload);
      });
    };
  }

  /**
   * Handle POST /api/approvals/:id
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} id
   */
  async handleResolve(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return;
    const entry = this.pending.get(id);
    if (!entry) {
      sendJson(res, 404, { success: false, error: `Approval '${id}' not found or expired` });
      return;
    }
    const approved = Boolean(data.approved);
    const scope = data.scope === 'always' ? 'always' : data.scope === 'session' ? 'session' : 'once';
    const commandPrefix = typeof data.commandPrefix === 'string' ? data.commandPrefix.trim() : '';

    if (approved && (scope === 'session' || scope === 'always')) {
      if (entry.payload.tool === 'exec_command' && commandPrefix) {
        this.sessionApprovedCommandPrefixes.add(commandPrefix);
        if (scope === 'always' && this.onAlwaysAllow) {
          this.onAlwaysAllow(entry.payload.tool, { commandPrefix });
        }
      } else {
        this.sessionApprovedTools.add(entry.payload.tool);
        if (scope === 'always' && this.onAlwaysAllow) {
          this.onAlwaysAllow(entry.payload.tool);
        }
      }
    }
    entry.resolve(approved);
    this.broadcastSSE('approval_resolved', { id, approved, scope, commandPrefix: commandPrefix || undefined });
    sendJson(res, 200, { success: true, id, approved, scope, commandPrefix: commandPrefix || undefined });
  }
}
