import { escapeHtml } from './utils.js';
import {
  createStore,
  renderStatusBadge,
  renderChip,
  renderEmptyState,
  renderActionBtn
} from './components.js';

interface DaemonTrigger {
  id: string;
  name?: string;
  type: string;
  cron?: string | null;
  everyMs?: number | null;
  watchPath?: string | null;
  checkCommand?: string | null;
  isolatedWorktree?: boolean;
  maxSteps?: number;
  maxTokens?: number;
  prompt?: string;
  enabled?: boolean;
  lastRunAt?: string | null;
  runCount?: number;
}

interface DaemonRun {
  runId: string;
  triggerId: string;
  triggerName?: string;
  type: string;
  startedAt: string;
  finishedAt?: string;
  success: boolean;
  zeroToken?: boolean;
  checkCommand?: string;
  checkPassed?: boolean;
  checkExitCode?: number;
  checkOutput?: string;
  answer?: string;
  error?: string;
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number };
  worktree?: {
    worktreePath: string;
    branch: string;
    clean: boolean;
    files?: Array<{ status: string; path: string }>;
    diff?: string;
    diffTruncated?: boolean;
    status: 'pending' | 'merged' | 'discarded';
  };
}

interface AutomationsState {
  running: boolean;
  triggers: DaemonTrigger[];
  recentRuns: DaemonRun[];
  expandedDiffs: string[];
  runningTriggerIds: string[];
  error: string | null;
}

const STARTER_TEMPLATES: Record<string, Record<string, any>> = {
  'nightly-watchdog': {
    id: 'nightly-test-watchdog',
    name: 'Nightly Test & Typecheck Watchdog',
    type: 'cron',
    cron: '0 2 * * *',
    checkCommand: 'npm test && npm run check:types',
    isolatedWorktree: true,
    maxSteps: 25,
    maxTokens: 50000,
    prompt: 'Diagnose the failing test or type error, apply a minimal fix in the isolated worktree, and re-run the check to verify.',
    enabled: true
  },
  'dependency-audit': {
    id: 'weekly-dependency-audit',
    name: 'Dependency Security Audit',
    type: 'cron',
    cron: '0 3 * * 1',
    checkCommand: 'npm audit --audit-level=high',
    isolatedWorktree: false,
    maxSteps: 10,
    maxTokens: 15000,
    prompt: 'Summarize the high/critical npm audit findings and recommend safe upgrade steps.',
    enabled: true
  },
  'watch-typecheck': {
    id: 'watch-typecheck',
    name: 'File-Watch Typecheck',
    type: 'watch',
    watchPath: 'src',
    checkCommand: 'npm run check:types',
    isolatedWorktree: true,
    maxSteps: 15,
    maxTokens: 25000,
    prompt: 'Fix the TypeScript compiler error in src/ without breaking existing behavior.',
    enabled: true
  }
};

export function initAutomations() {
  const statusBadge = document.getElementById('daemonStatusBadge');
  const toggleDaemonBtn = document.getElementById('toggleDaemonBtn') as HTMLButtonElement | null;
  const openNewTriggerBtn = document.getElementById('openNewTriggerBtn') as HTMLButtonElement | null;
  const closeNewTriggerBtn = document.getElementById('closeNewTriggerBtn') as HTMLButtonElement | null;
  const refreshAutomationsBtn = document.getElementById('refreshAutomationsBtn') as HTMLButtonElement | null;
  const templatesBar = document.getElementById('automationsTemplatesBar');
  const errorBanner = document.getElementById('automationsErrorBanner');

  const formCard = document.getElementById('newTriggerFormCard');
  const triggerIdInput = document.getElementById('triggerIdInput') as HTMLInputElement | null;
  const triggerTypeSelect = document.getElementById('triggerTypeSelect') as HTMLSelectElement | null;
  const triggerScheduleField = document.getElementById('triggerScheduleField');
  const triggerScheduleLabel = document.getElementById('triggerScheduleLabel');
  const triggerScheduleInput = document.getElementById('triggerScheduleInput') as HTMLInputElement | null;
  const triggerCheckCmdInput = document.getElementById('triggerCheckCmdInput') as HTMLInputElement | null;
  const triggerMaxStepsInput = document.getElementById('triggerMaxStepsInput') as HTMLInputElement | null;
  const triggerMaxTokensInput = document.getElementById('triggerMaxTokensInput') as HTMLInputElement | null;
  const triggerIsolatedWorktree = document.getElementById('triggerIsolatedWorktree') as HTMLInputElement | null;
  const triggerPromptInput = document.getElementById('triggerPromptInput') as HTMLTextAreaElement | null;
  const saveTriggerBtn = document.getElementById('saveTriggerBtn') as HTMLButtonElement | null;

  const triggersListEl = document.getElementById('automationsTriggersList');
  const runsListEl = document.getElementById('automationsRunsList');
  const triggersCountBadge = document.getElementById('triggersCountBadge');
  const runsCountBadge = document.getElementById('runsCountBadge');

  const store = createStore<AutomationsState>({
    running: false,
    triggers: [],
    recentRuns: [],
    expandedDiffs: [],
    runningTriggerIds: [],
    error: null
  });

  function syncScheduleField() {
    if (!triggerTypeSelect || !triggerScheduleField || !triggerScheduleLabel || !triggerScheduleInput) return;
    const t = triggerTypeSelect.value;
    if (t === 'webhook') {
      triggerScheduleField.style.display = 'none';
    } else {
      triggerScheduleField.style.display = '';
      if (t === 'cron') {
        triggerScheduleLabel.textContent = 'Cron Expression (5-field)';
        triggerScheduleInput.placeholder = '0 2 * * *';
        if (!triggerScheduleInput.value) triggerScheduleInput.value = '0 2 * * *';
      } else if (t === 'interval') {
        triggerScheduleLabel.textContent = 'Interval (ms)';
        triggerScheduleInput.placeholder = '3600000';
        triggerScheduleInput.value = '3600000';
      } else if (t === 'watch') {
        triggerScheduleLabel.textContent = 'Watch Path (relative to workspace)';
        triggerScheduleInput.placeholder = 'src';
        triggerScheduleInput.value = 'src';
      }
    }
  }

  store.subscribe((state) => {
    if (errorBanner) {
      errorBanner.style.display = state.error ? 'block' : 'none';
      errorBanner.textContent = state.error || '';
    }

    if (statusBadge) {
      statusBadge.textContent = state.running ? 'Running' : 'Stopped';
      statusBadge.classList.toggle('running', state.running);
      statusBadge.classList.toggle('stopped', !state.running);
    }
    if (toggleDaemonBtn) {
      toggleDaemonBtn.textContent = state.running ? 'Stop Daemon' : 'Start Daemon';
    }

    const triggers = state.triggers;
    const runs = [...state.recentRuns].reverse();
    if (triggersCountBadge) triggersCountBadge.textContent = String(triggers.length);
    if (runsCountBadge) runsCountBadge.textContent = String(runs.length);

    if (triggersListEl) {
      if (triggers.length === 0) {
        triggersListEl.innerHTML = renderEmptyState(
          'No triggers configured yet. Pick a <strong>Quick Template</strong> above or click <strong>+ New Trigger</strong>.'
        );
      } else {
        triggersListEl.innerHTML = triggers.map((t) => {
          const scheduleDesc =
            t.type === 'cron' ? `cron: ${t.cron || '*'}` :
            t.type === 'interval' ? `every ${t.everyMs || 0}ms` :
            t.type === 'watch' ? `watch: ${t.watchPath || '.'}` :
            `webhook: POST /api/webhooks/${t.id}`;
          return `
            <div class="agent-card ${t.enabled === false ? 'disabled' : ''}">
              <div class="agent-card-header">
                <div class="agent-card-title-row">
                  <span class="agent-card-name">${escapeHtml(t.name || t.id)}</span>
                  ${renderChip(t.type)}
                  ${t.checkCommand ? renderChip('0-token check', 'teal') : ''}
                  ${t.isolatedWorktree ? renderChip('isolated', 'accent') : ''}
                  ${t.enabled === false ? renderChip('disabled') : ''}
                </div>
                <div class="automation-card-actions">
                  ${state.runningTriggerIds.includes(t.id)
                    ? `<button type="button" class="btn-xs primary-xs" disabled>Running...</button>`
                    : renderActionBtn('Run', { 'data-action': 'run-trigger', 'data-id': t.id }, 'primary')}
                  ${renderActionBtn(t.enabled === false ? 'Enable' : 'Disable', { 'data-action': 'toggle-trigger', 'data-id': t.id })}
                  ${renderActionBtn('Delete', { 'data-action': 'delete-trigger', 'data-id': t.id }, 'danger')}
                </div>
              </div>
              <div class="automation-card-meta">
                <span><code>${escapeHtml(scheduleDesc)}</code></span>
                ${t.checkCommand ? `<span>Check: <code>${escapeHtml(t.checkCommand)}</code></span>` : ''}
                <span>Guardrails: ${t.maxSteps ?? 25} steps${t.maxTokens ? ` · ${t.maxTokens} tok` : ''}</span>
                <span>Runs: ${t.runCount || 0}${t.lastRunAt ? ` · Last: ${escapeHtml(new Date(t.lastRunAt).toLocaleString())}` : ''}</span>
              </div>
              ${t.prompt ? `<div class="automation-card-prompt">${escapeHtml(t.prompt)}</div>` : ''}
            </div>
          `;
        }).join('');
      }
    }

    if (runsListEl) {
      if (runs.length === 0) {
        runsListEl.innerHTML = renderEmptyState('No background runs recorded yet.');
      } else {
        runsListEl.innerHTML = runs.map((r) => {
          const statusKey = r.success ? 'completed' : 'failed';
          const statusLabel = r.success ? (r.zeroToken ? 'PASSED (0 TOKENS)' : 'SUCCEEDED') : 'FAILED';
          const wt = r.worktree;
          const isDiffOpen = state.expandedDiffs.includes(r.runId);
          return `
            <div class="agent-run-card">
              <div class="agent-run-top">
                <div class="agent-run-title-group">
                  <span class="agent-card-name">${escapeHtml(r.triggerName || r.triggerId)}</span>
                  ${renderStatusBadge(statusKey, statusLabel)}
                  ${r.usage?.totalTokens ? renderChip(`${r.usage.totalTokens} tokens`) : ''}
                  ${wt ? renderChip(`${wt.branch} (${wt.status})`, 'accent') : ''}
                </div>
                <div class="automation-card-actions">
                  ${wt && wt.diff ? renderActionBtn(isDiffOpen ? 'Hide Diff' : 'Inspect Diff', { 'data-action': 'toggle-diff', 'data-run-id': r.runId }) : ''}
                  ${wt && wt.status === 'pending' ? `
                    ${renderActionBtn('Approve & Merge', { 'data-action': 'merge-run', 'data-run-id': r.runId }, 'primary')}
                    ${renderActionBtn('Discard', { 'data-action': 'discard-run', 'data-run-id': r.runId }, 'danger')}
                  ` : ''}
                </div>
              </div>
              <div class="automation-card-meta">
                <span>Run: <code>${escapeHtml(r.runId)}</code></span>
                <span>Started: ${escapeHtml(new Date(r.startedAt).toLocaleString())}</span>
                ${r.checkCommand ? `<span>Check: <code>${escapeHtml(r.checkCommand)}</code> (exit ${r.checkExitCode ?? 0})</span>` : ''}
              </div>
              ${r.answer ? `<div class="automation-card-prompt">${escapeHtml(r.answer)}</div>` : ''}
              ${r.error ? `<div class="automation-card-error">${escapeHtml(r.error)}</div>` : ''}
              ${wt && wt.diff && isDiffOpen ? `<pre class="agent-run-diff">${escapeHtml(wt.diff)}</pre>` : ''}
            </div>
          `;
        }).join('');
      }
    }
  });

  function applyDaemonPayload(data: { running?: boolean; triggers?: DaemonTrigger[]; recentRuns?: DaemonRun[] }) {
    store.set({
      running: Boolean(data.running),
      triggers: Array.isArray(data.triggers) ? data.triggers : [],
      recentRuns: Array.isArray(data.recentRuns) ? data.recentRuns : [],
      error: null
    });
  }

  async function loadAutomations() {
    try {
      const res = await fetch('/api/daemon/status');
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load daemon status');
      applyDaemonPayload(data);
    } catch (err: any) {
      store.set({ error: err?.message || String(err) });
    }
  }

  async function saveTriggerPayload(payload: Record<string, any>) {
    const res = await fetch('/api/daemon/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save trigger');
    applyDaemonPayload(data);
  }

  toggleDaemonBtn?.addEventListener('click', async () => {
    try {
      const endpoint = store.get().running ? '/api/daemon/stop' : '/api/daemon/start';
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to toggle daemon');
      applyDaemonPayload(data);
    } catch (err: any) {
      store.set({ error: err?.message || String(err) });
    }
  });

  templatesBar?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-template]') as HTMLButtonElement | null;
    if (!btn) return;
    const tpl = STARTER_TEMPLATES[btn.dataset.template || ''];
    if (!tpl) return;
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding...';
    try {
      await saveTriggerPayload(tpl);
    } catch (err: any) {
      store.set({ error: err?.message || String(err) });
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  });

  openNewTriggerBtn?.addEventListener('click', () => {
    if (formCard) formCard.style.display = 'block';
    syncScheduleField();
    triggerIdInput?.focus();
  });

  closeNewTriggerBtn?.addEventListener('click', () => {
    if (formCard) formCard.style.display = 'none';
  });

  refreshAutomationsBtn?.addEventListener('click', loadAutomations);
  triggerTypeSelect?.addEventListener('change', syncScheduleField);

  saveTriggerBtn?.addEventListener('click', async () => {
    const id = triggerIdInput?.value.trim() || '';
    if (!id) {
      store.set({ error: 'Trigger ID is required.' });
      return;
    }
    const type = triggerTypeSelect?.value || 'cron';
    const sched = triggerScheduleInput?.value.trim() || '';
    const payload: Record<string, any> = {
      id,
      name: id,
      type,
      checkCommand: triggerCheckCmdInput?.value.trim() || null,
      isolatedWorktree: Boolean(triggerIsolatedWorktree?.checked),
      maxSteps: Number(triggerMaxStepsInput?.value || 25),
      maxTokens: Number(triggerMaxTokensInput?.value || 0),
      prompt: triggerPromptInput?.value.trim() || '',
      enabled: true
    };
    if (type === 'cron') payload.cron = sched || '0 2 * * *';
    if (type === 'interval') payload.everyMs = Math.max(1000, Number(sched) || 3600_000);
    if (type === 'watch') payload.watchPath = sched || 'src';

    try {
      await saveTriggerPayload(payload);
      if (formCard) formCard.style.display = 'none';
      if (triggerIdInput) triggerIdInput.value = '';
    } catch (err: any) {
      store.set({ error: err?.message || String(err) });
    }
  });

  triggersListEl?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (!id) return;
    try {
      if (action === 'run-trigger') {
        store.set((prev) => ({
          ...prev,
          runningTriggerIds: prev.runningTriggerIds.includes(id)
            ? prev.runningTriggerIds
            : [...prev.runningTriggerIds, id]
        }));
        const res = await fetch(`/api/daemon/triggers/${encodeURIComponent(id)}/run?async=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          store.set((prev) => ({
            ...prev,
            runningTriggerIds: prev.runningTriggerIds.filter((x) => x !== id)
          }));
          throw new Error(data.error || 'Failed to run trigger');
        }
      } else if (action === 'toggle-trigger') {
        const res = await fetch(`/api/daemon/triggers/${encodeURIComponent(id)}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to toggle trigger');
        applyDaemonPayload(data);
      } else if (action === 'delete-trigger') {
        const res = await fetch(`/api/daemon/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete trigger');
        applyDaemonPayload(data);
      }
    } catch (err: any) {
      store.set({ error: err?.message || String(err) });
      loadAutomations();
    }
  });

  runsListEl?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    const runId = btn.dataset.runId;
    if (!runId) return;
    try {
      if (action === 'toggle-diff') {
        store.set((prev) => {
          const exists = prev.expandedDiffs.includes(runId);
          return {
            ...prev,
            expandedDiffs: exists
              ? prev.expandedDiffs.filter((id) => id !== runId)
              : [...prev.expandedDiffs, runId]
          };
        });
      } else if (action === 'merge-run') {
        const res = await fetch(`/api/daemon/runs/${encodeURIComponent(runId)}/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Merge failed');
        applyDaemonPayload(data);
      } else if (action === 'discard-run') {
        const res = await fetch(`/api/daemon/runs/${encodeURIComponent(runId)}/discard`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Discard failed');
        applyDaemonPayload(data);
      }
    } catch (err: any) {
      store.set({ error: err?.message || String(err) });
    }
  });

  function handleDaemonUpdate(payload: any) {
    const finishedTriggerId =
      payload?.eventType === 'trigger_run' || payload?.eventType === 'trigger_error'
        ? payload?.payload?.triggerId
        : null;
    if (finishedTriggerId) {
      store.set((prev) => ({
        ...prev,
        runningTriggerIds: prev.runningTriggerIds.filter((x) => x !== finishedTriggerId)
      }));
    }
    if (payload && (Array.isArray(payload.triggers) || Array.isArray(payload.recentRuns))) {
      applyDaemonPayload(payload);
    } else {
      loadAutomations();
    }
  }

  return { loadAutomations, handleDaemonUpdate };
}
