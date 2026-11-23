import { byId, escapeHtml } from './utils.js';
import { renderStatusBadge, renderChip, renderActionBtn } from './components.js';

interface PersistentAgentItem {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  taskPrompt?: string;
  mode: 'manual' | 'interval' | 'cron' | 'continuous' | 'watch';
  intervalMs?: number | null;
  cron?: string | null;
  watchPath?: string | null;
  provider?: string | null;
  model?: string | null;
  maxSteps?: number;
  keepHistory?: boolean;
  workspaceMode?: 'shared' | 'worktree';
  worktreeBranch?: string | null;
  consecutiveFailures?: number;
  maxConsecutiveFailures?: number;
  dailyTokenBudget?: number | null;
  dailyTokensUsed?: number;
  dailyCostUsd?: number;
  enabled: boolean;
  status: 'idle' | 'running' | 'paused' | 'error';
  runCount: number;
  createdAt?: string;
  lastRunAt?: string | null;
  lastDurationMs?: number | null;
  lastAnswer?: string | null;
  lastError?: string | null;
}

interface AgentRunItem {
  runId: string;
  snapshotRunId?: string | null;
  agentId?: string | null;
  name: string;
  prompt: string;
  provider: string;
  model: string;
  requestedModel?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  liveStatus?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  stepsCount: number;
  tokensUsed?: number;
  estimatedCostUsd?: number;
  steps?: Array<{ step: number; thought?: string; toolCalls: Array<{ name: string; success: boolean }> }>;
  answer?: string | null;
  error?: string | null;
}

export function initAgents() {
  const runFormCard = byId('runAgentFormCard');
  const newPersistCard = byId('newPersistentAgentCard');
  const closeRunBtn = byId('closeRunAgentFormBtn');
  const closeNewPersistBtn = byId('closeNewPersistentAgentBtn');
  const agentsAddWrap = byId('agentsAddWrap');
  const agentsAddMenu = byId('agentsAddMenu');
  const menuNewOneOffBtn = byId('menuNewOneOffAgent');
  const menuNewPersistBtn = byId('menuNewPersistentAgent');

  const submitRunBtn = byId('submitRunAgentBtn') as HTMLButtonElement | null;
  const submitCreatePersistBtn = byId('submitCreatePersistentBtn') as HTMLButtonElement | null;
  const persistFormTitle = byId('persistFormTitle');
  const modeSelect = byId('persistAgentMode') as HTMLSelectElement | null;
  const intervalWrap = byId('persistIntervalWrap');
  const intervalLabel = byId('persistIntervalLabel');
  const cronWrap = byId('persistCronWrap');
  const watchWrap = byId('persistWatchWrap');

  const oneOffListEl = byId('oneOffAgentsList');
  const persistentListEl = byId('persistentAgentsList');
  const runsListEl = byId('agentRunsList');
  const oneOffCountEl = byId('oneOffAgentsCount');
  const persistentCountEl = byId('persistentAgentsCount');
  const runsCountEl = byId('agentRunsCount');
  const errorBannerEl = byId('agentsErrorBanner');

  const sidebarListEl = byId('agentsSidebarList');
  const sidebarSearchEl = byId('agentsSearchInput') as HTMLInputElement | null;
  const sidebarRefreshBtn = byId('refreshAgentsSidebarBtn');
  const sidebarNewBtn = byId('sidebarNewAgentBtn');
  const sidebarSummaryEl = byId('agentsSidebarSummary');
  const sidebarRunningEl = byId('agentsSidebarRunning');
  const sidebarDotEl = byId('agentsSidebarDot');

  let selectedSidebarAgentId: string | null = null;
  let sidebarSearchQuery = '';
  let lastStateData: { persistentAgents?: PersistentAgentItem[]; runs?: AgentRunItem[] } = {};

  let editingAgentId: string | null = null;
  let lastPersistentList: PersistentAgentItem[] = [];
  const openDiffs = new Map<string, string>();
  const expandedPrompts = new Set<string>();

  interface CatalogModelItem {
    id: string;
    provider: string;
    name?: string;
    target?: string;
  }

  let cachedModels: CatalogModelItem[] = [];

  const KNOWN_PROVIDERS: Array<{ id: string; label: string }> = [
    { id: 'gemini', label: 'Google Gemini' },
    { id: 'anthropic', label: 'Anthropic Claude' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'kimi', label: 'Kimi (Moonshot)' },
    { id: 'qwen', label: 'Qwen (Alibaba)' },
    { id: 'glm', label: 'GLM (Zhipu)' },
    { id: 'ollama', label: 'Ollama (Local)' },
    { id: 'lmstudio', label: 'LM Studio (Local)' },
    { id: 'vllm', label: 'vLLM (Local)' },
    { id: 'om', label: 'OM Built-in' }
  ];

  function populateModelSelect(
    providerSelectId: string,
    modelSelectId: string,
    customInputId: string,
    selectedModel?: string | null
  ) {
    const provSel = byId(providerSelectId) as HTMLSelectElement | null;
    const modSel = byId(modelSelectId) as HTMLSelectElement | null;
    const customInput = byId(customInputId) as HTMLInputElement | null;
    if (!modSel) return;

    const chosenProvider = (provSel?.value || '').toLowerCase();
    const filtered = chosenProvider
      ? cachedModels.filter((m) => (m.provider || '').toLowerCase() === chosenProvider)
      : cachedModels;

    const prevValue = selectedModel !== undefined ? (selectedModel || '') : modSel.value;

    const optionsHtml = [
      `<option value="">${chosenProvider ? `Default (${chosenProvider})` : 'Use Active Chat Model'}</option>`,
      ...filtered.map((m) => {
        const label = chosenProvider ? m.id : `${m.provider} / ${m.id}`;
        return `<option value="${escapeHtml(m.id)}">${escapeHtml(label)}</option>`;
      }),
      `<option value="__custom__">Custom model ID...</option>`
    ];
    modSel.innerHTML = optionsHtml.join('');

    if (prevValue && prevValue !== '__custom__') {
      const exists = Array.from(modSel.options).some((o) => o.value === prevValue);
      if (exists) {
        modSel.value = prevValue;
        if (customInput) customInput.style.display = 'none';
      } else {
        modSel.value = '__custom__';
        if (customInput) {
          customInput.value = prevValue;
          customInput.style.display = 'block';
        }
      }
    } else {
      modSel.value = '';
      if (customInput) {
        customInput.value = '';
        customInput.style.display = 'none';
      }
    }
  }

  function populateProviderSelect(providerSelectId: string, selectedProvider?: string | null) {
    const provSel = byId(providerSelectId) as HTMLSelectElement | null;
    if (!provSel) return;
    const prevValue = selectedProvider !== undefined ? (selectedProvider || '') : provSel.value;

    const dynamicProviders = new Set<string>(cachedModels.map((m) => (m.provider || '').toLowerCase()).filter(Boolean));
    const providerList = [...KNOWN_PROVIDERS];
    for (const dp of dynamicProviders) {
      if (!providerList.some((p) => p.id === dp)) {
        providerList.push({ id: dp, label: dp.toUpperCase() });
      }
    }

    provSel.innerHTML = [
      `<option value="">Use Active Chat Provider</option>`,
      ...providerList.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
    ].join('');

    if (prevValue) {
      provSel.value = prevValue.toLowerCase();
    }
  }

  function wireProviderModelPair(providerSelectId: string, modelSelectId: string, customInputId: string) {
    const provSel = byId(providerSelectId) as HTMLSelectElement | null;
    const modSel = byId(modelSelectId) as HTMLSelectElement | null;
    const customInput = byId(customInputId) as HTMLInputElement | null;

    if (provSel) {
      provSel.addEventListener('change', () => {
        populateModelSelect(providerSelectId, modelSelectId, customInputId, '');
      });
    }
    if (modSel && customInput) {
      modSel.addEventListener('change', () => {
        if (modSel.value === '__custom__') {
          customInput.style.display = 'block';
          customInput.focus();
        } else {
          customInput.style.display = 'none';
        }
      });
    }
  }

  function readSelectedModel(modelSelectId: string, customInputId: string): string | undefined {
    const modSel = byId(modelSelectId) as HTMLSelectElement | null;
    const customInput = byId(customInputId) as HTMLInputElement | null;
    const val = modSel?.value || '';
    if (val === '__custom__') {
      const custom = (customInput?.value || '').trim();
      return custom || undefined;
    }
    return val || undefined;
  }

  async function loadAvailableModels() {
    try {
      const res = await fetch('/api/models?provider=all');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.models)) {
        cachedModels = data.models;
        populateProviderSelect('oneOffAgentProvider');
        populateModelSelect('oneOffAgentProvider', 'oneOffAgentModelSelect', 'oneOffAgentModel');
        populateProviderSelect('persistAgentProvider');
        populateModelSelect('persistAgentProvider', 'persistAgentModelSelect', 'persistAgentModel');
      }
    } catch (_) {
      // keep fallback providers
      populateProviderSelect('oneOffAgentProvider');
      populateProviderSelect('persistAgentProvider');
    }
  }

  function formatPromptBullets(prompt: string): { headline: string; bullets: string[]; isCondensed: boolean } {
    const raw = String(prompt || '').trim();
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return { headline: 'No task prompt', bullets: [], isCondensed: false };
    }

    const cleanLine = (s: string) =>
      s
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-*•]\s*/, '')
        .replace(/^\d+\.\s*/, '')
        .trim();

    const first = cleanLine(lines[0]);
    const headline = first.length > 110 ? `${first.slice(0, 107)}...` : first;

    const candidates: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(#{1,6}|[-*•]|\d+\.)\s+/.test(line)) {
        const cleaned = cleanLine(line);
        if (cleaned && cleaned !== headline) {
          candidates.push(cleaned.length > 95 ? `${cleaned.slice(0, 92)}...` : cleaned);
        }
      }
      if (candidates.length >= 4) break;
    }

    const isCondensed = raw.length > 200 || lines.length > 5;
    return { headline, bullets: candidates, isCondensed };
  }

  function formatMinimalAnswer(text: string): string {
    const raw = String(text || '').trim();
    if (!raw) return '';

    const applyInline = (escapedLine: string) =>
      escapedLine
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '$1');

    const lines = raw.split(/\r?\n/);
    const out: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        out.push('<div class="agent-ans-gap"></div>');
        continue;
      }
      if (/^[-*_]{3,}$/.test(trimmed)) {
        continue;
      }
      const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        out.push(`<div class="agent-ans-topic">${applyInline(escapeHtml(headingMatch[1]))}</div>`);
        continue;
      }
      const bulletClean = trimmed.replace(/^[-*•]\s+/, '• ');
      out.push(`<div class="agent-ans-line">${applyInline(escapeHtml(bulletClean))}</div>`);
    }

    return out.join('');
  }

  function summarizeTools(steps: AgentRunItem['steps'] = []): Array<{ name: string; count: number; errors: number }> {
    const map = new Map<string, { name: string; count: number; errors: number }>();
    for (const s of steps || []) {
      for (const tc of s.toolCalls || []) {
        const cur = map.get(tc.name) || { name: tc.name, count: 0, errors: 0 };
        cur.count += 1;
        if (!tc.success) cur.errors += 1;
        map.set(tc.name, cur);
      }
    }
    return Array.from(map.values());
  }

  function showError(msg: string | null) {
    if (!errorBannerEl) return;
    if (!msg) {
      errorBannerEl.style.display = 'none';
      errorBannerEl.textContent = '';
      return;
    }
    errorBannerEl.textContent = msg;
    errorBannerEl.style.display = 'block';
  }

  async function readErrorMessage(res: Response, fallback: string): Promise<string> {
    if (res.status === 404) {
      return `${fallback} (HTTP 404). Restart the running OMega gateway server (node bin/om.js) so the updated /api/agents/reset route is loaded.`;
    }
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error) return `${parsed.error} (HTTP ${res.status})`;
        } catch {
          return `${fallback}: ${text} (HTTP ${res.status})`;
        }
      }
    } catch {
      // ignore read failure
    }
    return `${fallback} (HTTP ${res.status})`;
  }

  function formatSchedule(item: PersistentAgentItem): string {
    if (item.mode === 'interval') {
      const secs = Math.round((item.intervalMs || 60000) / 1000);
      return `Every ${secs}s`;
    }
    if (item.mode === 'continuous') {
      const secs = Math.round((item.intervalMs || 15000) / 1000);
      return `Continuous (${secs}s cooldown)`;
    }
    if (item.mode === 'cron') {
      return `Cron: ${item.cron || '*/5 * * * *'}`;
    }
    if (item.mode === 'watch') {
      return `Watch: ${item.watchPath || '.'}`;
    }
    return 'On-Demand';
  }

  function formatTime(iso?: string | null): string {
    if (!iso) return 'Never';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  function formatDuration(ms?: number | null): string {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }

  function syncModeVisibility() {
    const v = modeSelect?.value || 'manual';
    if (intervalWrap) intervalWrap.style.display = v === 'interval' || v === 'continuous' ? 'flex' : 'none';
    if (intervalLabel) {
      intervalLabel.textContent = v === 'continuous' ? 'Cooldown Between Runs (seconds)' : 'Interval (seconds)';
    }
    if (cronWrap) cronWrap.style.display = v === 'cron' ? 'flex' : 'none';
    if (watchWrap) watchWrap.style.display = v === 'watch' ? 'flex' : 'none';
  }

  function resetPersistForm() {
    editingAgentId = null;
    if (persistFormTitle) persistFormTitle.textContent = 'Persistent Agent';
    if (submitCreatePersistBtn) submitCreatePersistBtn.textContent = 'Launch';

    const setVal = (id: string, val: string) => {
      const el = byId(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (el) el.value = val;
    };
    setVal('persistAgentName', '');
    setVal('persistAgentDesc', '');
    populateProviderSelect('persistAgentProvider', '');
    populateModelSelect('persistAgentProvider', 'persistAgentModelSelect', 'persistAgentModel', '');
    setVal('persistAgentMaxSteps', '25');
    setVal('persistAgentSystem', '');
    setVal('persistAgentTask', '');
    setVal('persistAgentMode', 'manual');
    setVal('persistAgentInterval', '60');
    setVal('persistAgentCron', '*/5 * * * *');
    setVal('persistAgentWatchPath', 'src');
    setVal('persistAgentWorkspaceMode', 'shared');
    setVal('persistAgentTokenBudget', '');
    const keepEl = byId('persistAgentKeepHistory') as HTMLInputElement | null;
    if (keepEl) keepEl.checked = true;
    syncModeVisibility();
  }

  function openEditForm(ag: PersistentAgentItem) {
    editingAgentId = ag.id;
    if (persistFormTitle) persistFormTitle.textContent = `Edit Persistent Agent: ${ag.name}`;
    if (submitCreatePersistBtn) submitCreatePersistBtn.textContent = 'Save Changes';

    const setVal = (id: string, val: string) => {
      const el = byId(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (el) el.value = val;
    };
    setVal('persistAgentName', ag.name || '');
    setVal('persistAgentDesc', ag.description || '');
    populateProviderSelect('persistAgentProvider', ag.provider || '');
    populateModelSelect('persistAgentProvider', 'persistAgentModelSelect', 'persistAgentModel', ag.model || '');
    setVal('persistAgentMaxSteps', String(ag.maxSteps || 25));
    setVal('persistAgentSystem', ag.systemPrompt || '');
    setVal('persistAgentTask', ag.taskPrompt || '');
    setVal('persistAgentMode', ag.mode || 'manual');
    setVal('persistAgentInterval', String(Math.round((ag.intervalMs || 60000) / 1000)));
    setVal('persistAgentCron', ag.cron || '*/5 * * * *');
    setVal('persistAgentWatchPath', ag.watchPath || 'src');
    setVal('persistAgentWorkspaceMode', ag.workspaceMode || 'shared');
    setVal('persistAgentTokenBudget', ag.dailyTokenBudget ? String(ag.dailyTokenBudget) : '');
    const keepEl = byId('persistAgentKeepHistory') as HTMLInputElement | null;
    if (keepEl) keepEl.checked = ag.keepHistory !== false;

    syncModeVisibility();
    if (runFormCard) runFormCard.style.display = 'none';
    if (newPersistCard) newPersistCard.style.display = 'block';
  }

  function renderSidebar(persistent: PersistentAgentItem[], runs: AgentRunItem[]) {
    const workingCount = persistent.filter((a) => a.status === 'running').length + runs.filter((r) => r.status === 'running' && !r.agentId).length;
    const idleCount = persistent.filter((a) => a.status === 'idle').length;

    if (sidebarSummaryEl) sidebarSummaryEl.textContent = `${workingCount} active`;
    if (sidebarRunningEl) sidebarRunningEl.textContent = `${idleCount} idle`;
    if (sidebarDotEl) {
      sidebarDotEl.className = `routing-pill-dot ${workingCount > 0 ? 'warning' : 'healthy'}`;
    }

    if (!sidebarListEl) return;

    const q = sidebarSearchQuery.toLowerCase();
    const allOneOff = runs.filter((r) => !r.agentId);
    const filteredOneOff = q
      ? allOneOff.filter((r) => `${r.name || 'One-Off'} ${r.prompt || ''} ${r.model || ''} ${r.provider || ''}`.toLowerCase().includes(q))
      : allOneOff;
    const filteredPersistent = q
      ? persistent.filter((a) => `${a.name} ${a.description || ''} ${a.provider || ''} ${a.model || ''}`.toLowerCase().includes(q))
      : persistent;

    const latestRunTime = runs[0]?.startedAt ? formatTime(runs[0].startedAt) : 'No runs yet';
    const allActive = selectedSidebarAgentId === null ? 'active' : '';
    const totalAgentsCount = persistent.length + allOneOff.length;
    const allItemHtml = `
      <div class="session-item ${allActive}" data-sidebar-agent="__all__">
        <div class="session-item-left">
          <div class="session-title-row">
            <span class="session-name">All Agents</span>
            ${workingCount > 0 ? `<span class="session-active-pill agent-sidebar-badge-running">${workingCount} ACTIVE</span>` : ''}
          </div>
          <span class="session-date">${escapeHtml(latestRunTime)}</span>
        </div>
        <span class="session-badge-count">${totalAgentsCount}</span>
      </div>
    `;

    const oneOffItemsHtml = filteredOneOff
      .map((r) => {
        const key = `oneoff:${r.runId}`;
        const isActive = selectedSidebarAgentId === key ? 'active' : '';
        const statusLabel = r.status === 'running' ? 'ACTIVE' : r.status === 'failed' ? 'ERR' : '';
        const badgeClass = r.status === 'running' ? 'agent-sidebar-badge-running' : r.status === 'failed' ? 'agent-sidebar-badge-error' : '';
        const timeStr = formatTime(r.startedAt);
        return `
          <div class="session-item ${isActive}" data-sidebar-agent="${escapeHtml(key)}">
            <div class="session-item-left">
              <div class="session-title-row">
                <span class="session-name">${escapeHtml(r.name || 'One-Off')}</span>
                ${statusLabel ? `<span class="session-active-pill ${badgeClass}">${escapeHtml(statusLabel)}</span>` : ''}
              </div>
              <span class="session-date">${escapeHtml(timeStr)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    const persistentItemsHtml = filteredPersistent
      .map((ag) => {
        const isActive = selectedSidebarAgentId === ag.id ? 'active' : '';
        const statusLabel = ag.status === 'running' ? 'ACTIVE' : ag.status.toUpperCase();
        const badgeClass = ag.status === 'running' ? 'agent-sidebar-badge-running' : ag.status === 'error' ? 'agent-sidebar-badge-error' : '';
        const timeStr = ag.lastRunAt ? formatTime(ag.lastRunAt) : formatTime(ag.createdAt);
        return `
          <div class="session-item ${isActive}" data-sidebar-agent="${escapeHtml(ag.id)}">
            <div class="session-item-left">
              <div class="session-title-row">
                <span class="session-name">${escapeHtml(ag.name)}</span>
                <span class="session-active-pill ${badgeClass}">${escapeHtml(statusLabel)}</span>
              </div>
              <span class="session-date">${escapeHtml(timeStr)}</span>
            </div>
            <span class="session-badge-count">${ag.runCount}</span>
          </div>
        `;
      })
      .join('');

    const clearIconSvg = `
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
        <path d="M3 3v5h5"></path>
      </svg>
    `;

    const oneOffSection = filteredOneOff.length > 0
      ? `<div class="agent-sidebar-section-label"><span>One-off</span><button type="button" class="sessions-action-btn danger-hover" data-clear-group="oneoff" title="Clear One-off Agents">${clearIconSvg}</button></div>${oneOffItemsHtml}`
      : '';
    const persistentSection = filteredPersistent.length > 0
      ? `<div class="agent-sidebar-section-label"><span>Persistent</span><button type="button" class="sessions-action-btn danger-hover" data-clear-group="persistent" title="Clear Persistent Agents">${clearIconSvg}</button></div>${persistentItemsHtml}`
      : '';

    sidebarListEl.innerHTML = allItemHtml + oneOffSection + persistentSection;
  }

  function renderState(data: { persistentAgents?: PersistentAgentItem[]; runs?: AgentRunItem[] }) {
    lastStateData = data;
    const allPersistent = Array.isArray(data.persistentAgents) ? data.persistentAgents : [];
    const allRuns = Array.isArray(data.runs) ? data.runs : [];
    lastPersistentList = allPersistent;

    const isOneOffSelected = Boolean(selectedSidebarAgentId && selectedSidebarAgentId.startsWith('oneoff:'));
    const selectedRunId = isOneOffSelected ? selectedSidebarAgentId!.slice('oneoff:'.length) : null;
    if (selectedSidebarAgentId) {
      const exists = isOneOffSelected
        ? allRuns.some((r) => !r.agentId && r.runId === selectedRunId)
        : allPersistent.some((a) => a.id === selectedSidebarAgentId);
      if (!exists) selectedSidebarAgentId = null;
    }

    renderSidebar(allPersistent, allRuns);

    const oneOffRuns = selectedSidebarAgentId
      ? (isOneOffSelected ? allRuns.filter((r) => !r.agentId && r.runId === selectedRunId) : [])
      : allRuns.filter((r) => !r.agentId);
    const persistent = selectedSidebarAgentId
      ? (isOneOffSelected ? [] : allPersistent.filter((a) => a.id === selectedSidebarAgentId))
      : allPersistent;
    const runs = selectedSidebarAgentId
      ? (isOneOffSelected ? allRuns.filter((r) => r.runId === selectedRunId) : allRuns.filter((r) => r.agentId === selectedSidebarAgentId))
      : allRuns;

    const oneOffSectionWrap = oneOffListEl?.closest<HTMLElement>('.agents-section');
    const persistentSectionWrap = persistentListEl?.closest<HTMLElement>('.agents-section');
    if (oneOffSectionWrap) {
      oneOffSectionWrap.style.display = selectedSidebarAgentId && !isOneOffSelected ? 'none' : '';
    }
    if (persistentSectionWrap) {
      persistentSectionWrap.style.display = isOneOffSelected ? 'none' : '';
    }

    if (oneOffCountEl) oneOffCountEl.textContent = String(oneOffRuns.length);
    if (persistentCountEl) persistentCountEl.textContent = String(persistent.length);
    if (runsCountEl) runsCountEl.textContent = String(runs.length);

    if (oneOffListEl) {
      if (oneOffRuns.length === 0) {
        oneOffListEl.innerHTML = `
          <div class="agents-empty-state">
            No one-off agents yet.
          </div>
        `;
      } else {
        oneOffListEl.innerHTML = oneOffRuns
          .map((run) => {
            const statusClass = `agent-status-${run.status}`;
            const previewText = run.error
              ? `Error: ${run.error}`
              : run.answer
                ? run.answer.slice(0, 220)
                : run.status === 'running'
                  ? run.liveStatus || 'Executing autonomous loop...'
                  : 'No output';
            return `
              <div class="agent-card" data-run-id="${escapeHtml(run.runId)}">
                <div class="agent-card-header">
                  <div class="agent-card-title-row">
                    <span class="agent-card-name">${escapeHtml(run.name)}</span>
                    <span class="agent-status-badge ${statusClass}">${escapeHtml(run.status)}</span>
                  </div>
                  <div class="agent-card-badges">
                    <span class="agent-meta-pill">${escapeHtml(run.requestedModel || run.model || run.provider)}</span>
                  </div>
                </div>
                <p class="agent-card-desc">${escapeHtml(run.prompt.slice(0, 140))}${run.prompt.length > 140 ? '...' : ''}</p>
                <div class="agent-card-preview">${formatMinimalAnswer(previewText)}</div>
                ${run.requestedModel && run.model && run.requestedModel !== run.model ? `<div class="agent-model-attribution" style="margin-top:6px;font-size:0.72rem;color:var(--text-muted,#8b949e);font-family:var(--font-mono,monospace);opacity:0.85;">Requested: ${escapeHtml(run.requestedModel)} → Answered by: ${escapeHtml(run.model)}</div>` : ''}
                <div class="agent-card-meta">
                  <span class="agent-stat-item">Steps <strong>${run.stepsCount}</strong></span>
                  <span class="agent-stat-item">Time <strong>${escapeHtml(formatTime(run.startedAt))}</strong></span>
                  ${run.durationMs != null ? `<span class="agent-stat-item">Duration <strong>${escapeHtml(formatDuration(run.durationMs))}</strong></span>` : ''}
                  ${run.tokensUsed ? `<span class="agent-stat-item">Tokens <strong>${run.tokensUsed.toLocaleString()}</strong></span>` : ''}
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    if (persistentListEl) {
      if (persistent.length === 0) {
        persistentListEl.innerHTML = `
          <div class="agents-empty-state">
            No persistent agents yet.
          </div>
        `;
      } else {
        persistentListEl.innerHTML = persistent
          .map((ag) => {
            const statusClass = `agent-status-${ag.status}`;
            const isRunning = ag.status === 'running';
            const toggleLabel = ag.enabled ? 'Pause' : 'Start';
            const toggleAction = ag.enabled ? 'stop' : 'start';
            const previewText = ag.lastError
              ? `Error: ${ag.lastError}`
              : ag.lastAnswer
                ? ag.lastAnswer.slice(0, 220)
                : ag.taskPrompt
                  ? `Task: ${ag.taskPrompt.slice(0, 180)}`
                  : 'No default task prompt';

            const tokenStr = ag.dailyTokensUsed
              ? `${ag.dailyTokensUsed.toLocaleString()}${ag.dailyTokenBudget ? `/${ag.dailyTokenBudget.toLocaleString()}` : ''} tok`
              : '';

            return `
              <div class="agent-card" data-agent-id="${escapeHtml(ag.id)}">
                <div class="agent-card-header">
                  <div class="agent-card-title-row">
                    <span class="agent-card-name">${escapeHtml(ag.name)}</span>
                    <span class="agent-status-badge ${statusClass}">${escapeHtml(ag.status)}</span>
                  </div>
                  <div class="agent-card-badges">
                    <span class="agent-meta-pill">${escapeHtml(formatSchedule(ag))}</span>
                    ${ag.model || ag.provider ? `<span class="agent-meta-pill">${escapeHtml(ag.model || ag.provider || '')}</span>` : ''}
                    ${ag.workspaceMode === 'worktree' ? '<span class="agent-meta-pill">Worktree</span>' : ''}
                  </div>
                </div>
                ${ag.description ? `<p class="agent-card-desc">${escapeHtml(ag.description)}</p>` : ''}
                <div class="agent-card-preview">${formatMinimalAnswer(previewText)}</div>
                <div class="agent-card-meta">
                  <span class="agent-stat-item">Runs <strong>${ag.runCount}</strong></span>
                  <span class="agent-stat-item">Last <strong>${escapeHtml(formatTime(ag.lastRunAt))}</strong></span>
                  ${ag.lastDurationMs != null ? `<span class="agent-stat-item">Duration <strong>${escapeHtml(formatDuration(ag.lastDurationMs))}</strong></span>` : ''}
                  ${tokenStr ? `<span class="agent-stat-item">Today <strong>${escapeHtml(tokenStr)}</strong></span>` : ''}
                </div>
                <div class="agent-quick-dispatch">
                  <input type="text" class="param-input agent-dispatch-input" data-dispatch-input="${escapeHtml(ag.id)}" placeholder="Send custom task to ${escapeHtml(ag.name)}..." ${isRunning ? 'disabled' : ''} />
                  <button type="button" class="btn-xs ghost-xs" data-agent-act="dispatch" data-id="${escapeHtml(ag.id)}" ${isRunning ? 'disabled' : ''}>Send</button>
                </div>
                <div class="agent-card-actions">
                  <button type="button" class="btn-xs primary-xs" data-agent-act="run" data-id="${escapeHtml(ag.id)}" ${isRunning ? 'disabled' : ''}>Run</button>
                  <button type="button" class="btn-xs ghost-xs" data-agent-act="edit" data-id="${escapeHtml(ag.id)}">Edit</button>
                  <button type="button" class="btn-xs ghost-xs" data-agent-act="${toggleAction}" data-id="${escapeHtml(ag.id)}">${toggleLabel}</button>
                  <button type="button" class="btn-xs danger-xs agent-btn-right" data-agent-act="delete" data-id="${escapeHtml(ag.id)}">Delete</button>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    if (runsListEl) {
      if (runs.length === 0) {
        runsListEl.innerHTML = `
          <div class="agents-empty-state">
            No agent runs recorded yet.
          </div>
        `;
      } else {
        runsListEl.innerHTML = runs
          .map((run) => {
            const statusClass = `agent-status-${run.status}`;
            const outputText = run.error
              ? `Error: ${run.error}`
              : run.answer
                ? run.answer
                : run.status === 'running'
                  ? run.liveStatus || 'Executing autonomous loop...'
                  : 'No output';
            const toolsSummary = summarizeTools(run.steps);
            const diffText = openDiffs.get(run.runId);
            const promptInfo = formatPromptBullets(run.prompt);
            const isPromptExpanded = expandedPrompts.has(run.runId);

            return `
              <div class="agent-run-card" data-run-id="${escapeHtml(run.runId)}">
                <div class="agent-run-top">
                  <div class="agent-run-title-group">
                    <span class="agent-card-name">${escapeHtml(run.name)}</span>
                    <span class="agent-status-badge ${statusClass}">${escapeHtml(run.status)}</span>
                    <span class="agent-meta-pill" style="border-color: rgba(248, 81, 73, 0.55); color: #f85149; background: rgba(248, 81, 73, 0.12);">${escapeHtml(run.model || run.provider)}</span>
                    ${run.status === 'running' && run.liveStatus ? `<span class="agent-live-pill">${escapeHtml(run.liveStatus)}</span>` : ''}
                  </div>
                  <div class="agent-run-metrics">
                    ${run.agentId ? `<span class="agent-stat-item">Steps <strong>${run.stepsCount}</strong></span>` : ''}
                    ${run.status === 'running' ? `<button type="button" class="btn-xs danger-xs" data-run-abort="${escapeHtml(run.runId)}">Abort</button>` : ''}
                    ${run.snapshotRunId ? `<button type="button" class="btn-xs ghost-xs" data-run-diff="${escapeHtml(run.runId)}">${diffText ? 'Hide Diff' : 'Diff'}</button>` : ''}
                    ${run.snapshotRunId ? `<button type="button" class="btn-xs danger-xs" data-run-rollback="${escapeHtml(run.runId)}">Rollback</button>` : ''}
                  </div>
                </div>
                <div class="agent-run-prompt">
                  <div class="agent-run-prompt-head">
                    <span><strong>Task:</strong> ${escapeHtml(promptInfo.headline)}</span>
                    ${promptInfo.isCondensed ? `<button type="button" class="agent-prompt-toggle" data-toggle-prompt="${escapeHtml(run.runId)}">${isPromptExpanded ? 'Collapse' : 'Full prompt'}</button>` : ''}
                  </div>
                  ${!isPromptExpanded && promptInfo.bullets.length > 0 ? `<ul class="agent-run-bullets">${promptInfo.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
                  ${isPromptExpanded ? `<pre class="agent-run-full-prompt">${escapeHtml(run.prompt)}</pre>` : ''}
                </div>
                ${toolsSummary.length > 0 ? `<div class="agent-run-tools">Tools: ${toolsSummary.map((t) => `<code class="${t.errors > 0 ? 'tool-has-err' : ''}">${escapeHtml(t.name)}${t.count > 1 ? ` &times;${t.count}` : ''}${t.errors > 0 ? ` (${t.errors} err)` : ''}</code>`).join(' ')}</div>` : ''}
                ${diffText ? `<pre class="agent-run-diff">${escapeHtml(diffText)}</pre>` : ''}
                <div class="agent-run-output">${formatMinimalAnswer(outputText)}</div>
                ${run.requestedModel && run.model && run.requestedModel !== run.model ? `<div class="agent-model-attribution" style="margin-top:8px;font-size:0.72rem;color:var(--text-muted,#8b949e);font-family:var(--font-mono,monospace);opacity:0.85;">Requested: ${escapeHtml(run.requestedModel)} → Answered by: ${escapeHtml(run.model)}</div>` : ''}
              </div>
            `;
          })
          .join('');
      }
    }
  }

  async function loadAgents() {
    if (cachedModels.length === 0) {
      loadAvailableModels();
    }
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) {
        showError(await readErrorMessage(res, 'Failed to load agents'));
        return;
      }
      const data = await res.json();
      if (data?.success) {
        showError(null);
        renderState(data);
      }
      await loadDetachedSessions();
    } catch (e: any) {
      showError(e?.message || 'Failed to load agents');
    }
  }

  function handleAgentUpdate(payload: any) {
    if (payload?.state) {
      renderState(payload.state);
    } else {
      loadAgents();
    }
  }

  if (sidebarListEl) {
    sidebarListEl.addEventListener('click', async (ev) => {
      const clearBtn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-clear-group]');
      if (clearBtn) {
        ev.stopPropagation();
        const group = clearBtn.dataset.clearGroup;
        const endpoint = group === 'oneoff' ? '/api/agents/oneoff/clear' : '/api/agents/persistent/clear';
        clearBtn.disabled = true;
        showError(null);
        try {
          const res = await fetch(endpoint, { method: 'POST' });
          if (!res.ok) {
            showError(await readErrorMessage(res, `Failed to clear ${group} agents`));
            return;
          }
          const data = await res.json();
          if (selectedSidebarAgentId?.startsWith(group === 'oneoff' ? 'oneoff:' : '')) {
            selectedSidebarAgentId = null;
          }
          renderState(data);
        } catch (err: any) {
          showError(err?.message || `Failed to clear ${group} agents`);
        } finally {
          clearBtn.disabled = false;
        }
        return;
      }

      const item = (ev.target as HTMLElement).closest<HTMLElement>('[data-sidebar-agent]');
      if (!item) return;
      const val = item.dataset.sidebarAgent;
      selectedSidebarAgentId = !val || val === '__all__' ? null : val;
      renderState(lastStateData);
    });
  }

  if (sidebarSearchEl) {
    sidebarSearchEl.addEventListener('input', () => {
      sidebarSearchQuery = sidebarSearchEl.value.trim();
      renderState(lastStateData);
    });
  }

  if (sidebarRefreshBtn) {
    sidebarRefreshBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const confirmed = confirm('Clear all persistent agents and run history?\n\nThis will stop any active agents and remove all saved agent runs.');
      if (!confirmed) return;

      showError(null);
      try {
        const res = await fetch('/api/agents/reset', { method: 'POST' });
        if (!res.ok) {
          showError(await readErrorMessage(res, 'Failed to clear agents'));
          return;
        }
        selectedSidebarAgentId = null;
        openDiffs.clear();
        expandedPrompts.clear();
        await loadAgents();
      } catch (err: any) {
        showError(err?.message || 'Failed to clear agents');
      }
    });
  }

  if (sidebarNewBtn && agentsAddMenu) {
    sidebarNewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = agentsAddMenu.style.display !== 'none';
      agentsAddMenu.style.display = isOpen ? 'none' : 'flex';
    });
  }

  if (menuNewOneOffBtn && runFormCard) {
    menuNewOneOffBtn.addEventListener('click', () => {
      if (agentsAddMenu) agentsAddMenu.style.display = 'none';
      runFormCard.style.display = 'block';
      if (newPersistCard) newPersistCard.style.display = 'none';
    });
  }

  if (menuNewPersistBtn && newPersistCard) {
    menuNewPersistBtn.addEventListener('click', () => {
      if (agentsAddMenu) agentsAddMenu.style.display = 'none';
      resetPersistForm();
      newPersistCard.style.display = 'block';
      if (runFormCard) runFormCard.style.display = 'none';
    });
  }

  document.addEventListener('click', (ev) => {
    if (agentsAddMenu && agentsAddMenu.style.display !== 'none') {
      if (!agentsAddWrap || !agentsAddWrap.contains(ev.target as Node)) {
        agentsAddMenu.style.display = 'none';
      }
    }
  });

  if (closeRunBtn && runFormCard) {
    closeRunBtn.addEventListener('click', () => {
      runFormCard.style.display = 'none';
    });
  }

  if (closeNewPersistBtn && newPersistCard) {
    closeNewPersistBtn.addEventListener('click', () => {
      newPersistCard.style.display = 'none';
      resetPersistForm();
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener('change', syncModeVisibility);
  }

  wireProviderModelPair('oneOffAgentProvider', 'oneOffAgentModelSelect', 'oneOffAgentModel');
  wireProviderModelPair('persistAgentProvider', 'persistAgentModelSelect', 'persistAgentModel');
  populateProviderSelect('oneOffAgentProvider');
  populateProviderSelect('persistAgentProvider');

  if (submitRunBtn) {
    submitRunBtn.addEventListener('click', async () => {
      const nameEl = byId('oneOffAgentName') as HTMLInputElement | null;
      const provEl = byId('oneOffAgentProvider') as HTMLSelectElement | null;
      const sysEl = byId('oneOffAgentSystem') as HTMLInputElement | null;
      const promptEl = byId('oneOffAgentPrompt') as HTMLTextAreaElement | null;
      const stepsEl = byId('oneOffAgentMaxSteps') as HTMLInputElement | null;

      const prompt = (promptEl?.value || '').trim();
      if (!prompt) {
        promptEl?.focus();
        return;
      }

      const selectedProvider = (provEl?.value || '').trim() || undefined;
      const selectedModel = readSelectedModel('oneOffAgentModelSelect', 'oneOffAgentModel');

      submitRunBtn.disabled = true;
      showError(null);
      try {
        const res = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: nameEl?.value.trim() || undefined,
            provider: selectedProvider,
            model: selectedModel,
            systemPrompt: sysEl?.value.trim() || undefined,
            prompt,
            maxSteps: Number(stepsEl?.value) || 15
          })
        });
        if (res.ok) {
          if (promptEl) promptEl.value = '';
          if (runFormCard) runFormCard.style.display = 'none';
          await loadAgents();
        } else {
          showError(await readErrorMessage(res, 'Failed to launch agent'));
        }
      } catch (e: any) {
        showError(e?.message || 'Failed to launch agent');
      } finally {
        submitRunBtn.disabled = false;
      }
    });
  }

  if (submitCreatePersistBtn) {
    submitCreatePersistBtn.addEventListener('click', async () => {
      const nameEl = byId('persistAgentName') as HTMLInputElement | null;
      const descEl = byId('persistAgentDesc') as HTMLInputElement | null;
      const provEl = byId('persistAgentProvider') as HTMLSelectElement | null;
      const maxStepsEl = byId('persistAgentMaxSteps') as HTMLInputElement | null;
      const sysEl = byId('persistAgentSystem') as HTMLInputElement | null;
      const taskEl = byId('persistAgentTask') as HTMLTextAreaElement | null;
      const intervalEl = byId('persistAgentInterval') as HTMLInputElement | null;
      const cronEl = byId('persistAgentCron') as HTMLInputElement | null;
      const watchEl = byId('persistAgentWatchPath') as HTMLInputElement | null;
      const workspaceModeEl = byId('persistAgentWorkspaceMode') as HTMLSelectElement | null;
      const tokenBudgetEl = byId('persistAgentTokenBudget') as HTMLInputElement | null;
      const keepHistoryEl = byId('persistAgentKeepHistory') as HTMLInputElement | null;

      const name = (nameEl?.value || '').trim();
      if (!name) {
        nameEl?.focus();
        return;
      }

      const mode = (modeSelect?.value || 'manual') as PersistentAgentItem['mode'];
      const intervalSec = Number(intervalEl?.value) || 60;
      const selectedProvider = (provEl?.value || '').trim() || null;
      const selectedModel = readSelectedModel('persistAgentModelSelect', 'persistAgentModel') || null;
      const payload = {
        name,
        description: descEl?.value.trim() || '',
        provider: selectedProvider,
        model: selectedModel,
        maxSteps: Number(maxStepsEl?.value) || 25,
        systemPrompt: sysEl?.value.trim() || '',
        taskPrompt: taskEl?.value.trim() || '',
        mode,
        intervalMs: mode === 'interval' || mode === 'continuous' ? intervalSec * 1000 : null,
        cron: mode === 'cron' ? cronEl?.value.trim() || '*/5 * * * *' : null,
        watchPath: mode === 'watch' ? watchEl?.value.trim() || '.' : null,
        workspaceMode: workspaceModeEl?.value === 'worktree' ? 'worktree' : 'shared',
        dailyTokenBudget: tokenBudgetEl?.value.trim() ? Number(tokenBudgetEl.value) : null,
        keepHistory: keepHistoryEl ? keepHistoryEl.checked : true
      };

      submitCreatePersistBtn.disabled = true;
      showError(null);
      try {
        const endpoint = editingAgentId
          ? `/api/agents/persistent/${encodeURIComponent(editingAgentId)}`
          : '/api/agents/persistent';
        const method = editingAgentId ? 'PATCH' : 'POST';

        const res = await fetch(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          resetPersistForm();
          if (newPersistCard) newPersistCard.style.display = 'none';
          await loadAgents();
        } else {
          showError(await readErrorMessage(res, editingAgentId ? 'Failed to update agent' : 'Failed to create persistent agent'));
        }
      } catch (e: any) {
        showError(e?.message || 'Failed to save persistent agent');
      } finally {
        submitCreatePersistBtn.disabled = false;
      }
    });
  }

  const clearRunsBtn = document.getElementById('clearAgentRunsBtn') as HTMLButtonElement | null;
  if (clearRunsBtn) {
    clearRunsBtn.addEventListener('click', async () => {
      clearRunsBtn.disabled = true;
      showError(null);
      try {
        const res = await fetch('/api/agents/runs/clear', { method: 'POST' });
        if (!res.ok) {
          showError(await readErrorMessage(res, 'Failed to clear runs'));
          return;
        }
        const data = await res.json();
        renderState(data);
      } catch (err: any) {
        showError(err?.message || 'Failed to clear runs');
      } finally {
        clearRunsBtn.disabled = false;
      }
    });
  }

  if (persistentListEl) {
    persistentListEl.addEventListener('click', async (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-agent-act]');
      if (!btn) return;
      const act = btn.dataset.agentAct;
      const id = btn.dataset.id;
      if (!act || !id) return;

      if (act === 'edit') {
        const target = lastPersistentList.find((a) => a.id === id);
        if (target) openEditForm(target);
        return;
      }

      btn.disabled = true;
      showError(null);
      try {
        let res: Response | null = null;
        if (act === 'run' || act === 'dispatch') {
          const inputEl = persistentListEl.querySelector<HTMLInputElement>(`[data-dispatch-input="${CSS.escape(id)}"]`);
          const customPrompt = act === 'dispatch' ? (inputEl?.value || '').trim() : '';
          if (act === 'dispatch' && !customPrompt) {
            inputEl?.focus();
            return;
          }
          res = await fetch(`/api/agents/persistent/${encodeURIComponent(id)}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(customPrompt ? { prompt: customPrompt } : {})
          });
          if (res.ok && inputEl) inputEl.value = '';
        } else if (act === 'start' || act === 'stop') {
          res = await fetch(`/api/agents/persistent/${encodeURIComponent(id)}/${act}`, { method: 'POST' });
        } else if (act === 'delete') {
          res = await fetch(`/api/agents/persistent/${encodeURIComponent(id)}`, { method: 'DELETE' });
        }

        if (res && !res.ok) {
          showError(await readErrorMessage(res, `Action '${act}' failed`));
        } else {
          await loadAgents();
        }
      } catch (e: any) {
        showError(e?.message || `Action '${act}' failed`);
      } finally {
        btn.disabled = false;
      }
    });
  }

  if (runsListEl) {
    runsListEl.addEventListener('click', async (ev) => {
      const target = ev.target as HTMLElement;
      const togglePromptBtn = target.closest<HTMLButtonElement>('[data-toggle-prompt]');
      if (togglePromptBtn) {
        const runId = togglePromptBtn.dataset.togglePrompt;
        if (!runId) return;
        if (expandedPrompts.has(runId)) expandedPrompts.delete(runId);
        else expandedPrompts.add(runId);
        await loadAgents();
        return;
      }

      const abortBtn = target.closest<HTMLButtonElement>('[data-run-abort]');
      if (abortBtn) {
        const runId = abortBtn.dataset.runAbort;
        if (!runId) return;
        abortBtn.disabled = true;
        await fetch(`/api/agents/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' });
        await loadAgents();
        return;
      }

      const diffBtn = target.closest<HTMLButtonElement>('[data-run-diff]');
      if (diffBtn) {
        const runId = diffBtn.dataset.runDiff;
        if (!runId) return;
        if (openDiffs.has(runId)) {
          openDiffs.delete(runId);
          await loadAgents();
          return;
        }
        diffBtn.disabled = true;
        try {
          const res = await fetch(`/api/agents/runs/${encodeURIComponent(runId)}/diff`);
          if (res.ok) {
            const data = await res.json();
            const changes = Array.isArray(data.changes) ? data.changes : [];
            if (changes.length === 0) {
              openDiffs.set(runId, data.note || 'No file changes recorded.');
            } else {
              openDiffs.set(
                runId,
                changes
                  .map((c: any) => `[${String(c.status).toUpperCase()}] ${c.path}\n${c.afterPreview ? c.afterPreview.slice(0, 600) : '(deleted)'}`)
                  .join('\n\n---\n\n')
              );
            }
            await loadAgents();
          } else {
            showError(await readErrorMessage(res, 'Failed to load diff'));
          }
        } finally {
          diffBtn.disabled = false;
        }
        return;
      }

      const rollbackBtn = target.closest<HTMLButtonElement>('[data-run-rollback]');
      if (rollbackBtn) {
        const runId = rollbackBtn.dataset.runRollback;
        if (!runId) return;
        rollbackBtn.disabled = true;
        try {
          const res = await fetch(`/api/agents/runs/${encodeURIComponent(runId)}/rollback`, { method: 'POST' });
          if (res.ok) {
            const data = await res.json();
            openDiffs.set(runId, `Rolled back: restored ${(data.restored || []).length} file(s), deleted ${(data.deleted || []).length} file(s).`);
            await loadAgents();
          } else {
            showError(await readErrorMessage(res, 'Rollback failed'));
          }
        } finally {
          rollbackBtn.disabled = false;
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // DETACHED SWARMS & CHECKPOINTS
  // --------------------------------------------------------------------------
  const detachedSwarmsListEl = document.getElementById('detachedSwarmsList');
  const detachedSwarmsCountEl = document.getElementById('detachedSwarmsCount');
  const toggleChatCheckpointsBtn = document.getElementById('toggleChatCheckpointsBtn');
  const toggleDetachedSpawnBtn = document.getElementById('toggleDetachedSpawnBtn');
  const refreshDetachedBtn = document.getElementById('refreshDetachedBtn');
  const detachedSpawnFormCard = document.getElementById('detachedSpawnFormCard');
  const closeDetachedSpawnBtn = document.getElementById('closeDetachedSpawnBtn');
  const detachedPromptInput = document.getElementById('detachedPromptInput') as HTMLTextAreaElement | null;
  const detachedWorkspaceModeEl = document.getElementById('detachedWorkspaceMode') as HTMLSelectElement | null;
  const detachedMaxStepsEl = document.getElementById('detachedMaxSteps') as HTMLInputElement | null;
  const detachedMaxTokensEl = document.getElementById('detachedMaxTokens') as HTMLInputElement | null;
  const submitDetachedSpawnBtn = document.getElementById('submitDetachedSpawnBtn') as HTMLButtonElement | null;
  const detachedInspectPanel = document.getElementById('detachedInspectPanel');
  const detachedInspectTitle = document.getElementById('detachedInspectTitle');
  const detachedInspectMeta = document.getElementById('detachedInspectMeta');
  const detachedLogTail = document.getElementById('detachedLogTail');
  const detachedInspectRefreshBtn = document.getElementById('detachedInspectRefreshBtn');
  const detachedInspectCloseBtn = document.getElementById('detachedInspectCloseBtn');

  let inspectedDetachedId: string | null = null;
  let showChatCheckpoints = false;
  let cachedDetachedSessions: Array<Record<string, any>> = [];

  function renderDetachedSessions(sessions: Array<Record<string, any>>) {
    cachedDetachedSessions = sessions;
    if (!detachedSwarmsListEl) return;

    const visibleSessions = showChatCheckpoints
      ? sessions
      : sessions.filter((s) => Boolean(s.detached));
    const hiddenChatCount = sessions.length - visibleSessions.length;

    if (detachedSwarmsCountEl) detachedSwarmsCountEl.textContent = String(visibleSessions.length);

    if (visibleSessions.length === 0) {
      const hint = hiddenChatCount > 0
        ? ` (${hiddenChatCount} chat checkpoint${hiddenChatCount === 1 ? '' : 's'} hidden — click "Chat Checkpoints" to view)`
        : '';
      detachedSwarmsListEl.innerHTML =
        `<div class="agents-empty-state">No detached workers yet. Click "+ Spawn Detached" to launch a durable background worker.${escapeHtml(hint)}</div>`;
      return;
    }

    detachedSwarmsListEl.innerHTML = visibleSessions
      .map((s) => {
        const isDetached = Boolean(s.detached);
        const isAlive = isDetached && Boolean(s.pidAlive);
        const statusRaw = String(s.status || 'paused');
        const statusLabel = s.recoverable && statusRaw === 'paused' && !s.pauseReason
          ? 'CRASHED / RECOVERABLE'
          : statusRaw.toUpperCase();
        const statusClass = statusRaw === 'running' && isAlive
          ? 'running'
          : statusRaw === 'completed'
            ? 'completed'
            : statusRaw === 'failed' || statusRaw === 'aborted'
              ? 'error'
              : 'paused';
        const maxStepsLabel = !s.maxSteps || Number(s.maxSteps) <= 0 ? 'Unlimited' : String(s.maxSteps);
        const stepInfo = `Step ${s.currentStep ?? 0}/${maxStepsLabel}`;
        const tokInfo = `${s.usage?.totalTokens ?? 0} tok`;
        const wsMode = s.workspaceMode === 'worktree' ? 'worktree' : 'shared';
        const kindChip = isDetached ? 'Detached Worker' : 'Chat Checkpoint';
        const isActiveRunning = isAlive || statusRaw === 'running';

        return `
          <div class="agent-card">
            <div class="agent-card-header">
              <div class="agent-card-title">
                <strong>${escapeHtml(s.sessionId)}</strong>
                ${renderStatusBadge(statusClass, statusLabel)}
              </div>
              <span class="agent-card-meta">${escapeHtml(stepInfo)} · ${escapeHtml(tokInfo)}</span>
            </div>
            <p class="agent-card-desc">${escapeHtml((s.prompt || '').slice(0, 140))}</p>
            <div class="agent-card-chips">
              ${renderChip(kindChip)}
              ${renderChip(wsMode)}
              ${isDetached && s.pid ? renderChip(`PID ${s.pid}`) : ''}
              ${s.swarmId ? renderChip(s.swarmId, 'accent') : ''}
              ${s.pauseReason ? renderChip(s.pauseReason) : ''}
            </div>
            <div class="agent-card-actions">
              ${renderActionBtn('Logs', { 'data-detached-inspect': s.sessionId })}
              ${!isActiveRunning && statusRaw !== 'completed' ? renderActionBtn('Resume', { 'data-detached-resume': s.sessionId }, 'primary') : ''}
              ${renderActionBtn('Fork', { 'data-detached-fork': s.sessionId })}
              ${isActiveRunning ? renderActionBtn('Stop', { 'data-detached-stop': s.sessionId }, 'danger') : renderActionBtn('Delete', { 'data-detached-delete': s.sessionId })}
            </div>
          </div>
        `;
      })
      .join('');
  }

  toggleChatCheckpointsBtn?.addEventListener('click', () => {
    showChatCheckpoints = !showChatCheckpoints;
    toggleChatCheckpointsBtn.setAttribute('aria-pressed', showChatCheckpoints ? 'true' : 'false');
    toggleChatCheckpointsBtn.classList.toggle('primary-xs', showChatCheckpoints);
    toggleChatCheckpointsBtn.classList.toggle('ghost-xs', !showChatCheckpoints);
    renderDetachedSessions(cachedDetachedSessions);
  });

  async function loadDetachedSessions() {
    try {
      const res = await fetch('/api/agents/detached');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success && Array.isArray(data.sessions)) {
        renderDetachedSessions(data.sessions);
      }
    } catch (_) {
      // ignore transient polling errors
    }
  }

  async function inspectDetachedSession(sessionId: string) {
    inspectedDetachedId = sessionId;
    try {
      const res = await fetch(`/api/agents/detached/${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        showError(await readErrorMessage(res, 'Failed to inspect detached session'));
        return;
      }
      const data = await res.json();
      const s = data?.session;
      if (!s || !detachedInspectPanel) return;
      detachedInspectPanel.style.display = 'block';
      if (detachedInspectTitle) detachedInspectTitle.textContent = `Detached Session: ${s.sessionId}`;
      if (detachedInspectMeta) {
        detachedInspectMeta.textContent = `status=${s.status} | step=${s.currentStep}/${s.maxSteps} | mode=${s.workspaceMode || 'shared'} | workspace=${s.workspaceDir}`;
      }
      if (detachedLogTail) {
        detachedLogTail.textContent = s.logTail || '(no log output yet)';
        detachedLogTail.scrollTop = detachedLogTail.scrollHeight;
      }
    } catch (e: any) {
      showError(e?.message || 'Failed to inspect detached session');
    }
  }

  toggleDetachedSpawnBtn?.addEventListener('click', () => {
    if (!detachedSpawnFormCard) return;
    const isHidden = detachedSpawnFormCard.style.display === 'none';
    detachedSpawnFormCard.style.display = isHidden ? 'block' : 'none';
  });

  closeDetachedSpawnBtn?.addEventListener('click', () => {
    if (detachedSpawnFormCard) detachedSpawnFormCard.style.display = 'none';
  });

  refreshDetachedBtn?.addEventListener('click', () => {
    loadDetachedSessions();
  });

  detachedInspectCloseBtn?.addEventListener('click', () => {
    inspectedDetachedId = null;
    if (detachedInspectPanel) detachedInspectPanel.style.display = 'none';
  });

  detachedInspectRefreshBtn?.addEventListener('click', () => {
    if (inspectedDetachedId) inspectDetachedSession(inspectedDetachedId);
  });

  submitDetachedSpawnBtn?.addEventListener('click', async () => {
    const prompt = (detachedPromptInput?.value || '').trim();
    if (!prompt) {
      showError('Detached worker requires a task prompt.');
      return;
    }
    const maxSteps = Number(detachedMaxStepsEl?.value || 15) || 15;
    const maxTokensVal = Number(detachedMaxTokensEl?.value || 0);
    const workspaceMode = detachedWorkspaceModeEl?.value === 'worktree' ? 'worktree' : 'shared';
    const budgets = maxTokensVal > 0 ? { maxTokens: maxTokensVal } : undefined;

    submitDetachedSpawnBtn.disabled = true;
    try {
      const res = await fetch('/api/agents/detached/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, maxSteps, workspaceMode, budgets })
      });
      if (!res.ok) {
        showError(await readErrorMessage(res, 'Failed to spawn detached worker'));
        return;
      }
      if (detachedPromptInput) detachedPromptInput.value = '';
      if (detachedSpawnFormCard) detachedSpawnFormCard.style.display = 'none';
      showError(null);
      await loadDetachedSessions();
    } finally {
      submitDetachedSpawnBtn.disabled = false;
    }
  });

  detachedSwarmsListEl?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const inspectBtn = target.closest<HTMLButtonElement>('[data-detached-inspect]');
    if (inspectBtn) {
      const id = inspectBtn.dataset.detachedInspect;
      if (id) await inspectDetachedSession(id);
      return;
    }

    const resumeBtn = target.closest<HTMLButtonElement>('[data-detached-resume]');
    if (resumeBtn) {
      const id = resumeBtn.dataset.detachedResume;
      if (!id) return;
      resumeBtn.disabled = true;
      try {
        const res = await fetch(`/api/agents/detached/${encodeURIComponent(id)}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (!res.ok) showError(await readErrorMessage(res, 'Resume failed'));
        await loadDetachedSessions();
      } finally {
        resumeBtn.disabled = false;
      }
      return;
    }

    const forkBtn = target.closest<HTMLButtonElement>('[data-detached-fork]');
    if (forkBtn) {
      const id = forkBtn.dataset.detachedFork;
      if (!id) return;
      forkBtn.disabled = true;
      try {
        const res = await fetch(`/api/agents/detached/${encodeURIComponent(id)}/fork`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoStart: false })
        });
        if (!res.ok) showError(await readErrorMessage(res, 'Fork failed'));
        await loadDetachedSessions();
      } finally {
        forkBtn.disabled = false;
      }
      return;
    }

    const stopBtn = target.closest<HTMLButtonElement>('[data-detached-stop]');
    if (stopBtn) {
      const id = stopBtn.dataset.detachedStop;
      if (!id) return;
      stopBtn.disabled = true;
      try {
        await fetch(`/api/agents/detached/${encodeURIComponent(id)}/stop`, { method: 'POST' });
        await loadDetachedSessions();
      } finally {
        stopBtn.disabled = false;
      }
      return;
    }

    const delBtn = target.closest<HTMLButtonElement>('[data-detached-delete]');
    if (delBtn) {
      const id = delBtn.dataset.detachedDelete;
      if (!id) return;
      delBtn.disabled = true;
      try {
        await fetch(`/api/agents/detached/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (inspectedDetachedId === id && detachedInspectPanel) {
          inspectedDetachedId = null;
          detachedInspectPanel.style.display = 'none';
        }
        await loadDetachedSessions();
      } finally {
        delBtn.disabled = false;
      }
    }
  });

  return {
    loadAgents,
    handleAgentUpdate
  };
}
