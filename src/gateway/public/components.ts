import { escapeHtml } from './utils.js';

export type StoreListener<T> = (state: T, prevState: T) => void;

export interface ReactiveStore<T> {
  get: () => T;
  set: (updater: Partial<T> | ((prev: T) => T)) => void;
  subscribe: (listener: StoreListener<T>, emitImmediately?: boolean) => () => void;
}

/**
 * Minimal reactive state container for Gateway UI modules.
 */
export function createStore<T extends Record<string, any>>(initialState: T): ReactiveStore<T> {
  let state: T = { ...initialState };
  const listeners = new Set<StoreListener<T>>();

  return {
    get: () => state,
    set: (updater) => {
      const prev = state;
      const next = typeof updater === 'function'
        ? (updater as (p: T) => T)(prev)
        : { ...prev, ...updater };
      state = next;
      for (const listener of listeners) {
        listener(state, prev);
      }
    },
    subscribe: (listener, emitImmediately = false) => {
      listeners.add(listener);
      if (emitImmediately) listener(state, state);
      return () => listeners.delete(listener);
    }
  };
}

const STATUS_CLASS_MAP: Record<string, string> = {
  running: 'running',
  active: 'running',
  completed: 'completed',
  succeeded: 'completed',
  ok: 'completed',
  passed: 'completed',
  paused: 'paused',
  aborted: 'paused',
  idle: 'idle',
  failed: 'error',
  error: 'error'
};

export function renderStatusBadge(status: string, label?: string): string {
  const key = String(status || 'paused').toLowerCase();
  const mapped = STATUS_CLASS_MAP[key] || 'paused';
  const text = label || status.toUpperCase();
  return `<span class="agent-status-badge agent-status-${mapped}">${escapeHtml(text)}</span>`;
}

export function renderChip(
  text: string,
  variant: 'default' | 'accent' | 'teal' | 'error' = 'default'
): string {
  const cls = variant === 'default' ? 'agent-chip' : `agent-chip agent-chip-${variant}`;
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

export function renderEmptyState(htmlMessage: string): string {
  return `<div class="agents-empty-state">${htmlMessage}</div>`;
}

export function renderActionBtn(
  label: string,
  attrs: Record<string, string>,
  variant: 'default' | 'primary' | 'danger' = 'default'
): string {
  const variantCls = variant === 'primary' ? 'primary-xs' : variant === 'danger' ? 'danger-xs' : 'ghost-xs';
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
    .join(' ');
  return `<button type="button" class="btn-xs ${variantCls}" ${attrStr}>${escapeHtml(label)}</button>`;
}

export function renderErrorMessage(prefix: string, err: unknown, className = 'activity-empty'): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<div class="${escapeHtml(className)}" style="color:var(--accent-red);">${escapeHtml(prefix)}: ${escapeHtml(msg)}</div>`;
}

export interface SkillCardViewModel {
  name: string;
  type?: string;
  source?: string;
  description?: string;
  references?: string[];
  parameters?: Record<string, unknown>;
}

export function renderSkillCardHtml(skill: SkillCardViewModel): string {
  const isWorkflow = skill.type === 'workflow';
  const isMcp = skill.type === 'mcp' || skill.source === 'mcp';
  const isUserJs = !isWorkflow && !isMcp && skill.source && skill.source !== 'builtin';
  const tagClass = isWorkflow ? 'workflow-tag' : isMcp ? 'mcp-tag' : isUserJs ? 'user-tag' : '';
  const tagLabel = isWorkflow ? 'SKILL.md' : isMcp ? 'MCP' : isUserJs ? 'JS Skill' : 'Built-in';

  let refsHtml = '';
  if (skill.references && skill.references.length > 0) {
    const pillBtns = skill.references.map((ref) => (
      `<button class="ref-pill-btn" type="button" data-skill="${escapeHtml(skill.name)}" data-ref="${escapeHtml(ref)}" title="Read ${escapeHtml(ref)} runbook">` +
      `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>` +
      `<span>${escapeHtml(ref)}</span>` +
      `</button>`
    )).join('');
    refsHtml = `<div class="skill-refs"><span class="skill-refs-title">References:</span> ${pillBtns}</div>`;
  }

  return `
    <div class="skill-card-top">
      <span class="skill-title"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px;"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polyline></svg>${escapeHtml(skill.name)}</span>
      <span class="skill-tag ${tagClass}">${tagLabel}</span>
    </div>
    <div class="skill-desc">${escapeHtml(skill.description || '')}</div>
    ${refsHtml}
    <div class="skill-params">
      <pre><code>${escapeHtml(JSON.stringify(skill.parameters || {}, null, 2))}</code></pre>
    </div>
  `;
}

export interface VectorHitViewModel {
  file?: string;
  source?: string;
  score?: number;
  matchType?: string;
  text?: string;
}

export function renderVectorHitHtml(r: VectorHitViewModel): string {
  const pct = Math.round((r.score || 0) * 100);
  return `
    <div class="vector-hit-item">
      <div class="vector-hit-top">
        <span class="vector-hit-source">${escapeHtml(r.file || r.source || 'memory')}</span>
        <span class="vector-hit-score">${pct}% match (${escapeHtml(r.matchType || 'vector')})</span>
      </div>
      <div class="vector-hit-text">${escapeHtml(r.text || '')}</div>
    </div>
  `;
}

export function renderStatusNotice(message: string, className = 'activity-empty'): string {
  return `<div class="${escapeHtml(className)}">${escapeHtml(message)}</div>`;
}

export function renderConfigRowsHtml(rows: Array<[string, string]>): string {
  return rows
    .map(([k, v]) => `<div class="config-row"><span class="config-key">${escapeHtml(k)}</span><span class="config-val">${escapeHtml(v)}</span></div>`)
    .join('');
}

export interface ModelCardViewModel {
  id: string;
  displayName?: string;
  provider?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export function renderModelCardHtml(m: ModelCardViewModel, isCurrent: boolean): string {
  let limits = '';
  if (m.inputTokenLimit || m.outputTokenLimit) {
    const inTok = m.inputTokenLimit ? `${Math.round(m.inputTokenLimit / 1000)}k Context` : '';
    const outTok = m.outputTokenLimit ? `${Math.round(m.outputTokenLimit / 1000)}k Max Out` : '';
    limits = [inTok, outTok].filter(Boolean).map((t) => `<span class="model-tag">${escapeHtml(t)}</span>`).join('');
  }

  const p = (m.provider || 'gemini').toLowerCase();
  let provBadge = p.toUpperCase();
  if (p === 'gemini' || p === 'google') provBadge = 'GEMINI';
  else if (p === 'om' || p === 'mock' || p === 'omega') provBadge = 'OMEGA';
  else if (p === 'openai') provBadge = 'GPT';
  else if (p === 'anthropic') provBadge = 'CLAUDE';
  else if (p === 'vllm') provBadge = 'LOCAL';

  return `
    <div class="model-card-top">
      <div class="model-card-title">${escapeHtml(m.displayName || m.id)}</div>
      <span class="model-card-provider">${escapeHtml(provBadge)}</span>
    </div>
    <div class="model-card-tags">
      <span class="model-tag" style="color:var(--accent-primary); font-weight:600;">${escapeHtml(m.id)}</span>
      ${limits}
    </div>
    <div class="model-card-desc">${escapeHtml(m.description || 'General-purpose reasoning language model.')}</div>
    <div class="model-card-actions">
      <button class="btn-load-model ${isCurrent ? 'loaded' : ''}">
        ${isCurrent ? '● Active' : 'Load Model'}
      </button>
    </div>
  `;
}
