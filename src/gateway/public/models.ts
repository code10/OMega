import { escapeHtml, formatTokens, isLocalProviderName, MODEL_LIMITS_MAP } from './utils.js';
import { renderModelCardHtml } from './components.js';

export interface ContextUsageSnapshot {
  usedTokens: number;
  contextLimit?: number;
  historyTokens?: number;
  systemTokens?: number;
  toolsTokens?: number;
  overheadTokens?: number;
  lastPromptTokens?: number;
  lastCompletionTokens?: number;
  sessionTotalTokens?: number;
  messageCount?: number;
  source?: 'provider' | 'bpe' | 'idle';
}

export interface ModelsDeps {
  modelDropdownMenu: HTMLElement;
  dropdownCloseBtn: HTMLButtonElement;
  topLoadedModel: HTMLElement;
  modelQuickSearchInput: HTMLInputElement;
  modelQuickList: HTMLElement;
  inputModelTag: HTMLElement;
  inputModelSelectorBtn: HTMLButtonElement | null;
  chatModeCloudBtn: HTMLButtonElement | null;
  chatModeLocalBtn: HTMLButtonElement | null;
  inputModelTargetPill: HTMLElement | null;
  dropdownScopeTabs: HTMLElement | null;
  modelUsageBar: HTMLElement | null;
  usageModelLabel: HTMLElement | null;
  usageTokensCounter: HTMLElement | null;
  usagePctBadge: HTMLElement | null;
  usageLimitLabel: HTMLElement | null;
  usageProgressFill: HTMLElement | null;
  messagesContainer: HTMLElement | null;
  promptInput: HTMLTextAreaElement | null;
  fullModelsGrid: HTMLElement | null;
  modelsTable: HTMLElement | null;
  modelsFilterInput: HTMLInputElement | null;
  providerFilterPills: NodeListOf<HTMLElement>;
  getActiveTab: () => string;
  getAttachedFiles: () => any[];
  applyStatusToUI: (data: any) => void;
  closePlusMenu: () => void;
  closeInlineSuggestions: () => void;
}

export function initModels(deps: ModelsDeps) {
  const {
    modelDropdownMenu,
    dropdownCloseBtn,
    topLoadedModel,
    modelQuickSearchInput,
    modelQuickList,
    inputModelTag,
    inputModelSelectorBtn,
    chatModeCloudBtn,
    chatModeLocalBtn,
    inputModelTargetPill,
    dropdownScopeTabs,
    modelUsageBar,
    usageModelLabel,
    usageTokensCounter,
    usagePctBadge,
    usageLimitLabel,
    usageProgressFill,
    messagesContainer,
    promptInput,
    fullModelsGrid,
    modelsTable,
    modelsFilterInput,
    providerFilterPills,
    getActiveTab,
    getAttachedFiles,
    applyStatusToUI,
    closePlusMenu,
    closeInlineSuggestions
  } = deps;

  let cachedModels: any[] = [];
  let cachedHardware: any = null;
  let activeModelScope = 'all';
  let currentProviderFilter = 'all';
  let serverContextUsage: ContextUsageSnapshot | null = null;

  const modelsHardwareBanner = document.getElementById('modelsHardwareBanner');

  const usageStatusDot = document.getElementById('usageStatusDot');
  const usageDraftBadge = document.getElementById('usageDraftBadge');
  const usageSourceBadge = document.getElementById('usageSourceBadge');
  const usagePopoverRows = document.getElementById('usagePopoverRows');
  const usageRingArc = document.getElementById('usageRingArc') as SVGCircleElement | null;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 7.5;

  function setServerContextUsage(usage: ContextUsageSnapshot | null | undefined) {
    if (usage && typeof usage === 'object' && typeof usage.usedTokens === 'number') {
      serverContextUsage = usage;
    } else if (usage === null) {
      serverContextUsage = null;
    }
    updateModelUsageBar();
  }

  function toggleModelDropdown() {
    const isShowing = modelDropdownMenu.classList.contains('show');
    if (isShowing) {
      closeModelDropdown();
    } else {
      closePlusMenu();
      closeInlineSuggestions();
      modelDropdownMenu.classList.add('show');
      if (inputModelSelectorBtn) inputModelSelectorBtn.classList.add('active');
      modelQuickSearchInput.focus();
      void populateQuickModelDropdown();
    }
  }

  function closeModelDropdown() {
    modelDropdownMenu.classList.remove('show');
    if (inputModelSelectorBtn) inputModelSelectorBtn.classList.remove('active');
  }

  function setDropdownScope(scope: string) {
    activeModelScope = scope;
    if (dropdownScopeTabs) {
      dropdownScopeTabs.querySelectorAll<HTMLElement>('.dropdown-scope-btn').forEach((btn) => {
        if (btn.dataset.scope === scope) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }
    renderQuickModelList(cachedModels);
  }

  async function populateQuickModelDropdown() {
    if (cachedModels.length === 0) {
      await fetchModels();
    }
    renderQuickModelList(cachedModels);
  }

  function renderQuickModelList(models: any[]) {
    const query = (modelQuickSearchInput.value || '').trim().toLowerCase();
    const currentModel = (topLoadedModel.textContent || '').trim().toLowerCase();

    const filtered = models.filter((m: any) => {
      if (activeModelScope !== 'all') {
        const target = m.target || (isLocalProviderName(m.provider) ? 'local' : 'cloud');
        if (target !== activeModelScope) return false;
      }
      if (!query) return true;
      return (
        m.id.toLowerCase().includes(query) ||
        (m.displayName && m.displayName.toLowerCase().includes(query)) ||
        (m.provider && m.provider.toLowerCase().includes(query)) ||
        (m.target && m.target.toLowerCase().includes(query))
      );
    });

    if (filtered.length === 0) {
      const scopeLabel = activeModelScope !== 'all' ? ` ${activeModelScope}` : '';
      modelQuickList.innerHTML = `<div class="dropdown-loading-item">No${scopeLabel} models matching query</div>`;
      return;
    }

    modelQuickList.innerHTML = '';
    for (const m of filtered) {
      const isCurrent = m.id.toLowerCase() === currentModel;
      const target = m.target || (isLocalProviderName(m.provider) ? 'local' : 'cloud');
      const provUpper = (m.provider && (m.provider.toLowerCase() === 'gemini' || m.provider.toLowerCase() === 'google')) ? 'GEMINI' : (m.provider === 'mock' || m.provider === 'omega' ? 'OMEGA' : (m.provider || '').toUpperCase());
      const fitMeta = m.hardwareFit && m.hardwareFit.mode !== 'simulator'
        ? ` • ${m.hardwareFit.status.toUpperCase()}${m.hardwareFit.estimatedVramGb && m.hardwareFit.mode !== 'cpu' ? ` (~${m.hardwareFit.estimatedVramGb}GB VRAM)` : m.hardwareFit.estimatedRamGb ? ` (~${m.hardwareFit.estimatedRamGb}GB RAM)` : ''}`
        : '';
      const item = document.createElement('div');
      item.className = `dropdown-model-item ${isCurrent ? 'current' : ''}`;
      item.innerHTML = `
        <div class="dropdown-item-info">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="dropdown-item-title">${escapeHtml(m.id)}</span>
            <span class="model-item-target ${target}">${target.toUpperCase()}</span>
          </div>
          <span class="dropdown-item-sub">${escapeHtml(m.displayName || provUpper)} • ${escapeHtml(provUpper)}${escapeHtml(fitMeta)}</span>
        </div>
        ${isCurrent ? '<span class="dropdown-item-pill">ACTIVE</span>' : ''}
      `;

      item.addEventListener('click', async () => {
        closeModelDropdown();
        await switchActiveModel(m.provider || 'google', m.id);
      });

      modelQuickList.appendChild(item);
    }
  }

  function formatCompactTokens(count: number): string {
    if (count >= 1000000) return `${(count / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return count.toLocaleString();
  }

  function updateModelUsageBar() {
    if (!modelUsageBar) return;

    const currentModelId = ((inputModelTag && inputModelTag.textContent) || (topLoadedModel && topLoadedModel.textContent) || 'local').trim();
    const modelLower = currentModelId.toLowerCase();
    const modelMeta =
      (cachedModels || []).find((m: any) => m.id && m.id.toLowerCase() === modelLower) ||
      (MODEL_LIMITS_MAP as Record<string, any>)[modelLower] ||
      {};

    const inputLimit =
      modelMeta.inputTokenLimit ||
      modelMeta.input ||
      serverContextUsage?.contextLimit ||
      128000;
    const modelDisplayName = modelMeta.displayName || modelMeta.name || currentModelId;

    // Live draft & staged attachments token estimate
    let draftChars = 0;
    if (promptInput) {
      draftChars += (promptInput.value || '').length;
    }
    const attachedFiles = getAttachedFiles();
    let imageAttachmentTokens = 0;
    if (Array.isArray(attachedFiles)) {
      attachedFiles.forEach((f) => {
        if (f.isImage) {
          imageAttachmentTokens += 258;
        } else {
          draftChars += (f.content || '').length;
        }
      });
    }
    const draftTokens = (draftChars > 0 ? Math.ceil(draftChars / 4) : 0) + imageAttachmentTokens;

    // Prefer accurate backend context telemetry (provider API usage or BPE tokenizer over system + tools + history).
    // Fall back to clean message text only when backend telemetry has not arrived yet.
    let baseTokens = 0;
    let sourceLabel = 'Estimate';
    let isLiveProvider = false;

    if (serverContextUsage) {
      baseTokens = Math.max(0, Math.round(serverContextUsage.usedTokens || 0));
      if (serverContextUsage.source === 'provider') {
        sourceLabel = 'Provider API';
        isLiveProvider = true;
      } else if (serverContextUsage.source === 'bpe') {
        sourceLabel = 'BPE Tokenizer';
      } else {
        sourceLabel = 'Ready';
      }
    } else if (messagesContainer) {
      let domChars = 0;
      const agentAnswers = messagesContainer.querySelectorAll('.message-row.agent-msg .final-markdown-response');
      agentAnswers.forEach((el) => {
        domChars += (el.textContent || '').length;
      });
      const userBubbles = messagesContainer.querySelectorAll('.message-row.user-msg .msg-bubble > div:not(.msg-attachments-wrap)');
      userBubbles.forEach((el) => {
        domChars += (el.textContent || '').length;
      });
      baseTokens = domChars > 0 ? Math.ceil(domChars / 4) : 0;
    }

    const usedTokens = baseTokens + draftTokens;
    const pct = inputLimit > 0 ? Math.min(100, (usedTokens / inputLimit) * 100) : 0;
    const remainingTokens = Math.max(0, inputLimit - usedTokens);
    const stateClass = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : usedTokens === 0 ? 'idle' : 'healthy';

    if (usageModelLabel) {
      usageModelLabel.textContent = modelDisplayName;
    }

    if (usageTokensCounter) {
      const formattedUsed = formatCompactTokens(usedTokens);
      const formattedLimit = formatTokens(inputLimit);
      usageTokensCounter.innerHTML = `<span class="usage-tokens-used">${escapeHtml(formattedUsed)}</span><span class="usage-tokens-sep">/</span><span>${escapeHtml(formattedLimit)} tokens</span>`;
    }

    if (usageDraftBadge) {
      if (draftTokens > 0) {
        usageDraftBadge.textContent = `+${formatCompactTokens(draftTokens)} draft`;
        usageDraftBadge.hidden = false;
      } else {
        usageDraftBadge.hidden = true;
      }
    }

    if (usageSourceBadge) {
      if (usedTokens > 0 && serverContextUsage && serverContextUsage.source !== 'idle') {
        usageSourceBadge.textContent = isLiveProvider ? 'LIVE' : 'BPE';
        usageSourceBadge.classList.toggle('live', isLiveProvider);
        usageSourceBadge.hidden = false;
      } else {
        usageSourceBadge.hidden = true;
      }
    }

    if (usageStatusDot) {
      usageStatusDot.classList.remove('idle', 'warning', 'danger');
      if (stateClass !== 'healthy') {
        usageStatusDot.classList.add(stateClass);
      }
    }

    if (usagePctBadge) {
      usagePctBadge.textContent = (pct < 0.1 && usedTokens > 0) ? '<0.1%' : `${pct.toFixed(1)}%`;
      usagePctBadge.classList.remove('warning', 'danger');
      if (stateClass === 'warning' || stateClass === 'danger') {
        usagePctBadge.classList.add(stateClass);
      }
    }

    if (usageLimitLabel) {
      usageLimitLabel.textContent = `${formatTokens(inputLimit)} window`;
    }

    if (usageRingArc) {
      const ringPct = usedTokens > 0 ? Math.max(pct, 2.5) : 0;
      const offset = RING_CIRCUMFERENCE * (1 - ringPct / 100);
      usageRingArc.setAttribute('stroke-dashoffset', offset.toFixed(2));
      usageRingArc.classList.remove('idle', 'warning', 'danger');
      if (stateClass !== 'healthy') {
        usageRingArc.classList.add(stateClass);
      }
    }

    if (usageProgressFill) {
      const fillPct = usedTokens > 0 ? Math.max(pct, 1) : 0;
      usageProgressFill.style.width = `${fillPct}%`;

      usageProgressFill.classList.remove('warning', 'danger');
      if (stateClass === 'danger') {
        usageProgressFill.classList.add('danger');
      } else if (stateClass === 'warning') {
        usageProgressFill.classList.add('warning');
      }
    }

    if (usagePopoverRows) {
      const historyTok = serverContextUsage?.historyTokens ?? baseTokens;
      const overheadTok = serverContextUsage?.overheadTokens ?? 0;
      const sessionTotal = serverContextUsage?.sessionTotalTokens ?? 0;
      const rows: string[] = [
        `<div class="usage-popover-row"><span>Model</span><span class="val">${escapeHtml(modelDisplayName)}</span></div>`,
        `<div class="usage-popover-row"><span>Conversation history</span><span class="val">${historyTok.toLocaleString()} tok</span></div>`
      ];
      if (overheadTok > 0) {
        rows.push(`<div class="usage-popover-row"><span>System prompt &amp; tools</span><span class="val">${overheadTok.toLocaleString()} tok</span></div>`);
      }
      if (draftTokens > 0) {
        rows.push(`<div class="usage-popover-row"><span>Pending draft &amp; files</span><span class="val">+${draftTokens.toLocaleString()} tok</span></div>`);
      }
      rows.push(`<div class="usage-popover-row"><span>Remaining headroom</span><span class="val">${remainingTokens.toLocaleString()} tok</span></div>`);
      rows.push(`<div class="usage-popover-row subtle"><span>Source</span><span class="val">${escapeHtml(sourceLabel)}</span></div>`);
      if (sessionTotal > 0) {
        rows.push(`<div class="usage-popover-row"><span>Session cumulative</span><span class="val">${sessionTotal.toLocaleString()} tok</span></div>`);
      }
      usagePopoverRows.innerHTML = rows.join('');
    }
  }

  async function fetchModels() {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.hardware) {
        cachedHardware = data.hardware;
      }
      if (data.success && Array.isArray(data.models)) {
        cachedModels = data.models
          .filter((m: any) => {
            const p = String(m.provider || '').toLowerCase();
            const id = String(m.id || '').toLowerCase();
            return !['om', 'mock', 'omega'].includes(p) && !/^om-(?:mock-)?(?:v1|turbo|reasoning)$/.test(id);
          })
          .map((m: any) => {
            const id = m.id;
            const displayName = m.displayName || id;
            let provider = m.provider || data.provider || 'gemini';
            if (provider.toLowerCase() === 'google') provider = 'gemini';
            const target = m.target || (isLocalProviderName(provider) ? 'local' : 'cloud');
            return {
              ...m,
              id,
              displayName,
              provider,
              target
            };
          });
      }
    } catch (_) { }
    updateModelUsageBar();
    return cachedModels;
  }

  async function switchActiveModel(provider: string, model: string) {
    try {
      const res = await fetch('/api/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model })
      });
      if (res.ok) {
        const data = await res.json();
        if (isLocalProviderName(data.provider || provider) && (data.model || model)) {
          try {
            localStorage.setItem('omega.lastLocalModel', JSON.stringify({
              provider: data.provider || provider,
              id: data.model || model
            }));
          } catch (_) { }
        }
        applyStatusToUI(data);
        if (getActiveTab() === 'models') renderFullModelsGrid();
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || `Failed to switch model to ${model}`);
      }
    } catch (e: any) {
      alert(`Failed to switch model: ${e?.message || e}`);
    }
  }

  async function loadModels() {
    await fetchModels();
    renderFullModelsGrid();
    renderLegacyModelsTable();
  }

  function renderHardwareBanner() {
    if (!modelsHardwareBanner) return;
    if (!cachedHardware) {
      modelsHardwareBanner.hidden = true;
      return;
    }
    const hw = cachedHardware;
    const badgeClass = hw.hasGpu ? 'hw-gpu' : 'hw-cpu';
    const badgeText = hw.hasGpu
      ? (hw.unifiedMemory ? `UNIFIED ${hw.totalVramGb} GB` : `GPU · ${hw.totalVramGb} GB VRAM`)
      : `CPU ONLY · ${hw.totalRamGb} GB RAM`;
    modelsHardwareBanner.hidden = false;
    modelsHardwareBanner.innerHTML = `
      <div class="models-hw-left">
        <span class="models-hw-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
        <span class="models-hw-summary">${escapeHtml(hw.summary || hw.tierLabel || '')}</span>
      </div>
      <div class="models-hw-right">
        <span class="models-hw-meta">Recommended local max: <b>~${escapeHtml(String(hw.recommendedMaxParamsB))}B</b></span>
      </div>
    `;
  }

  function renderFullModelsGrid() {
    if (!fullModelsGrid) return;
    renderHardwareBanner();
    const query = (modelsFilterInput?.value || '').trim().toLowerCase();
    const activeModel = (topLoadedModel.textContent || '').trim().toLowerCase();

    const filtered = cachedModels.filter((m) => {
      const p = (m.provider || 'gemini').toLowerCase();
      const target = m.target || (isLocalProviderName(p) ? 'local' : 'cloud');
      const provMatch = currentProviderFilter === 'all' || (
        (currentProviderFilter === 'local' && target === 'local') ||
        p === currentProviderFilter.toLowerCase() ||
        ((currentProviderFilter === 'gemini' || currentProviderFilter === 'google') && (p === 'gemini' || p === 'google')) ||
        ((currentProviderFilter === 'om' || currentProviderFilter === 'mock' || currentProviderFilter === 'omega') && (p === 'om' || p === 'mock' || p === 'omega'))
      );
      if (!provMatch) return false;
      if (!query) return true;
      return (
        m.id.toLowerCase().includes(query) ||
        (m.displayName && m.displayName.toLowerCase().includes(query)) ||
        (m.description && m.description.toLowerCase().includes(query))
      );
    });

    if (filtered.length === 0) {
      fullModelsGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
          No models matching your search filter.
        </div>
      `;
      return;
    }

    fullModelsGrid.innerHTML = '';
    for (const m of filtered) {
      const isCurrent = m.id.toLowerCase() === activeModel;
      const card = document.createElement('div');
      card.className = `model-card-lm ${isCurrent ? 'is-active-model' : ''}`;
      card.innerHTML = renderModelCardHtml(m, isCurrent);

      const btn = card.querySelector('.btn-load-model');
      if (!isCurrent && btn) {
        btn.addEventListener('click', async () => {
          btn.textContent = 'Loading...';
          await switchActiveModel(m.provider || 'google', m.id);
        });
      }

      fullModelsGrid.appendChild(card);
    }
  }

  function renderLegacyModelsTable() {
    if (!modelsTable) return;
    const activeModel = (topLoadedModel.textContent || '').trim().toLowerCase();
    modelsTable.innerHTML = '';
    for (const m of cachedModels) {
      const isCurrent = m.id.toLowerCase() === activeModel;
      const row = document.createElement('div');
      row.className = 'config-row';
      row.style.cursor = 'pointer';
      row.title = `Click to load: ${m.id}`;
      row.innerHTML = `
        <span class="config-key" style="color: var(--accent-amber); font-weight: 600;">
          ${escapeHtml(m.id)} ${isCurrent ? '<span style="color:var(--accent-green);">[ACTIVE]</span>' : ''}
        </span>
        <span class="config-val" style="font-size: 0.85rem; color: var(--text-secondary);">
          ${escapeHtml(m.displayName || m.id)}
        </span>
      `;
      row.addEventListener('click', () => switchActiveModel(m.provider || 'google', m.id));
      modelsTable.appendChild(row);
    }
  }

  // Event listeners
  if (chatModeCloudBtn) {
    chatModeCloudBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      setDropdownScope('cloud');
      const currentTarget = inputModelTargetPill?.dataset.target || 'local';
      if (currentTarget !== 'cloud') {
        const cloudModels = cachedModels.filter((m) => m.target === 'cloud');
        const targetModel = cloudModels[0] || { provider: 'gemini', id: 'gemini-3.5-flash' };
        await switchActiveModel(targetModel.provider, targetModel.id);
      }
      toggleModelDropdown();
    });
  }

  if (chatModeLocalBtn) {
    chatModeLocalBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      setDropdownScope('local');
      const currentTarget = inputModelTargetPill?.dataset.target || 'local';
      if (currentTarget !== 'local') {
        const localModels = cachedModels.filter((m) => m.target === 'local');
        let lastLocal: { provider: string; id: string } | null = null;
        try {
          const saved = JSON.parse(localStorage.getItem('omega.lastLocalModel') || 'null');
          if (saved && saved.id && localModels.some((m) => m.id.toLowerCase() === String(saved.id).toLowerCase())) {
            lastLocal = saved;
          }
        } catch (_) { }
        const targetModel = lastLocal || localModels[0] || { provider: 'local', id: 'auto' };
        await switchActiveModel(targetModel.provider, targetModel.id);
      }
      toggleModelDropdown();
    });
  }

  if (dropdownScopeTabs) {
    dropdownScopeTabs.querySelectorAll<HTMLElement>('.dropdown-scope-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setDropdownScope(btn.dataset.scope || 'all');
      });
    });
  }

  if (inputModelSelectorBtn) {
    inputModelSelectorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelDropdown();
    });
  }

  dropdownCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeModelDropdown();
  });

  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (!modelDropdownMenu.contains(target) && (!inputModelSelectorBtn || !inputModelSelectorBtn.contains(target))) {
      closeModelDropdown();
    }
  });

  modelQuickSearchInput.addEventListener('input', () => {
    renderQuickModelList(cachedModels);
  });

  if (usageModelLabel) {
    usageModelLabel.addEventListener('click', () => {
      toggleModelDropdown();
    });
  }

  if (modelsFilterInput) {
    modelsFilterInput.addEventListener('input', renderFullModelsGrid);
  }

  providerFilterPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      providerFilterPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentProviderFilter = pill.dataset.provider || 'all';
      renderFullModelsGrid();
    });
  });

  return {
    toggleModelDropdown,
    closeModelDropdown,
    loadModels,
    renderFullModelsGrid,
    updateModelUsageBar,
    setServerContextUsage
  };
}
