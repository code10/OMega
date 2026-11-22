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
