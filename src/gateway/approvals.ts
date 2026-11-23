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
  broadcastSSE: (eventName: string, data: any, ownerId?: string) => void;
  pending: Map<string, { ownerId: string; payload: any; resolve: (approved: boolean) => void }>;
  sessionApprovedToolsByOwner: Map<string, Set<string>>;
  sessionApprovedCommandPrefixesByOwner: Map<string, Set<string>>;
  onAlwaysAllow?: (tool: string, rule?: { commandPrefix?: string }) => void;
  getCommandRules?: () => CommandRulesConfig;

  constructor(
    broadcastSSE: (eventName: string, data: any, ownerId?: string) => void,
    onAlwaysAllow?: (tool: string, rule?: { commandPrefix?: string }) => void,
    getCommandRules?: () => CommandRulesConfig
  ) {
    this.broadcastSSE = broadcastSSE;
    this.pending = new Map();
    this.sessionApprovedToolsByOwner = new Map();
    this.sessionApprovedCommandPrefixesByOwner = new Map();
    this.onAlwaysAllow = onAlwaysAllow;
    this.getCommandRules = getCommandRules;
  }

  private _getOwnerTools(ownerId: string): Set<string> {
    let set = this.sessionApprovedToolsByOwner.get(ownerId);
    if (!set) {
      set = new Set();
      this.sessionApprovedToolsByOwner.set(ownerId, set);
    }
    return set;
  }

  private _getOwnerPrefixes(ownerId: string): Set<string> {
    let set = this.sessionApprovedCommandPrefixesByOwner.get(ownerId);
    if (!set) {
      set = new Set();
      this.sessionApprovedCommandPrefixesByOwner.set(ownerId, set);
    }
    return set;
  }

  /**
   * Create a confirmCommand handler compatible with OMAgent, scoped to ownerId.
   */
  createConfirmHandler(ownerId = 'local'): (info: Record<string, any>) => Promise<boolean> {
    return (info: Record<string, any>) => {
      const toolName = String(info.tool || 'exec_command');
      const commandText = info.command ? String(info.command) : '';
      const ownerTools = this._getOwnerTools(ownerId);
      const ownerPrefixes = this._getOwnerPrefixes(ownerId);

      if (toolName === 'exec_command' && commandText) {
        const rules = this.getCommandRules ? this.getCommandRules() : {};
        if (Array.isArray(rules.deny) && matchesCommandRule(commandText, rules.deny)) {
          return Promise.resolve(false);
        }
        const allowRules = [
          ...ownerPrefixes,
          ...(Array.isArray(rules.allow) ? rules.allow : [])
        ];
        if (ownerTools.has(toolName) || matchesCommandRule(commandText, allowRules)) {
          return Promise.resolve(true);
        }
      } else if (ownerTools.has(toolName)) {
        return Promise.resolve(true);
      }

      const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const payload = {
        id,
        ownerId,
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
          ownerId,
          payload,
          resolve: (approved) => {
            clearTimeout(timer);
            this.pending.delete(id);
            resolve(Boolean(approved));
          }
        });
        this.broadcastSSE('approval_required', payload, ownerId);
      });
    };
  }

  /**
   * Handle POST /api/approvals/:id with strict tenant ownership check.
   */
  async handleResolve(req: http.IncomingMessage, res: http.ServerResponse, id: string, callerId = 'local') {
    const data: Record<string, any> | null = await readJsonBody(req, res);
    if (!data) return;
    const entry = this.pending.get(id);
    if (!entry) {
      sendJson(res, 404, { success: false, error: `Approval '${id}' not found or expired` });
      return;
    }
    if (entry.ownerId !== callerId) {
      sendJson(res, 403, { success: false, error: `Forbidden: approval '${id}' belongs to another user.` });
      return;
    }
    const approved = Boolean(data.approved);
    const scope = data.scope === 'always' ? 'always' : data.scope === 'session' ? 'session' : 'once';
    const commandPrefix = typeof data.commandPrefix === 'string' ? data.commandPrefix.trim() : '';
    const ownerTools = this._getOwnerTools(entry.ownerId);
    const ownerPrefixes = this._getOwnerPrefixes(entry.ownerId);

    if (approved && (scope === 'session' || scope === 'always')) {
      const canPersistGlobal = scope === 'always' && entry.ownerId === 'local' && Boolean(this.onAlwaysAllow);
      if (entry.payload.tool === 'exec_command' && commandPrefix) {
        ownerPrefixes.add(commandPrefix);
        if (canPersistGlobal && this.onAlwaysAllow) {
          this.onAlwaysAllow(entry.payload.tool, { commandPrefix });
        }
      } else {
        ownerTools.add(entry.payload.tool);
        if (canPersistGlobal && this.onAlwaysAllow) {
          this.onAlwaysAllow(entry.payload.tool);
        }
      }
    }
    entry.resolve(approved);
    this.broadcastSSE('approval_resolved', { id, approved, scope, commandPrefix: commandPrefix || undefined }, entry.ownerId);
    sendJson(res, 200, { success: true, id, approved, scope, commandPrefix: commandPrefix || undefined });
  }
}
