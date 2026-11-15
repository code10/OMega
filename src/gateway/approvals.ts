import type http from 'node:http';
import { readJsonBody, sendJson } from './httpUtils.js';

/**
 * Manages Human-in-the-Loop (HITL) tool/shell execution approvals over SSE + REST.
 */
export class ApprovalManager {
  broadcastSSE: (eventName: string, data: any) => void;
  pending: Map<string, { payload: any; resolve: (approved: boolean) => void }>;

  constructor(broadcastSSE: (eventName: string, data: any) => void) {
    this.broadcastSSE = broadcastSSE;
    /** @type {Map<string, { payload: any, resolve: (approved: boolean) => void }>} */
    this.pending = new Map();
  }

  /**
   * Create a confirmCommand handler compatible with OMAgent.
   * @returns {(info: any) => Promise<boolean>}
   */
  createConfirmHandler(): (info: Record<string, any>) => Promise<boolean> {
    return (info: Record<string, any>) => {
      const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const payload = {
        id,
        tool: info.tool || 'exec_command',
        args: info.args || null,
        command: info.command || null,
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
    entry.resolve(approved);
    this.broadcastSSE('approval_resolved', { id, approved });
    sendJson(res, 200, { success: true, id, approved });
  }
}
