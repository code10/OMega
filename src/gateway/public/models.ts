import { escapeHtml, formatTokens, isLocalProviderName, MODEL_LIMITS_MAP } from './utils.js';
import { renderModelCardHtml } from './components.js';

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
  let activeModelScope = 'all';
  let currentProviderFilter = 'all';

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
      const item = document.createElement('div');
      item.className = `dropdown-model-item ${isCurrent ? 'current' : ''}`;
      item.innerHTML = `
        <div class="dropdown-item-info">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="dropdown-item-title">${escapeHtml(m.id)}</span>
            <span class="model-item-target ${target}">${target.toUpperCase()}</span>
          </div>
          <span class="dropdown-item-sub">${escapeHtml(m.displayName || provUpper)} • ${escapeHtml(provUpper)}</span>
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

  function updateModelUsageBar() {
    if (!modelUsageBar) return;

    const currentModelId = ((inputModelTag && inputModelTag.textContent) || (topLoadedModel && topLoadedModel.textContent) || 'om-v1').trim();
    const modelMeta = (cachedModels || []).find((m: any) => m.id && m.id.toLowerCase() === currentModelId.toLowerCase()) || (MODEL_LIMITS_MAP as Record<string, any>)[currentModelId.toLowerCase()] || {};

    const inputLimit = modelMeta.inputTokenLimit || modelMeta.input || 128000;
    const modelDisplayName = modelMeta.displayName || modelMeta.name || currentModelId;

    let totalChars = 0;
    if (messagesContainer) {
      const bubbles = messagesContainer.querySelectorAll('.msg-bubble');
      bubbles.forEach((b) => {
        totalChars += (b.textContent || '').length;
      });
    }

    if (promptInput) {
      totalChars += (promptInput.value || '').length;
    }

    const attachedFiles = getAttachedFiles();
    if (Array.isArray(attachedFiles)) {
      attachedFiles.forEach((f) => {
        totalChars += (f.content || '').length || (f.size || 0);
      });
    }

    const usedTokens = Math.max(0, Math.ceil(totalChars / 4));
    const pct = Math.min(100, (usedTokens / inputLimit) * 100);

    if (usageModelLabel) {
      usageModelLabel.textContent = modelDisplayName;
    }

    if (usageTokensCounter) {
      const formattedUsed = usedTokens >= 1000 ? (usedTokens / 1000).toFixed(1) + 'k' : usedTokens.toLocaleString();
      const formattedLimit = formatTokens(inputLimit);
      usageTokensCounter.textContent = `${formattedUsed} / ${formattedLimit} tokens`;
    }

    if (usagePctBadge) {
      usagePctBadge.textContent = (pct < 0.1 && usedTokens > 0) ? '<0.1%' : `${pct.toFixed(1)}%`;
    }

    if (usageLimitLabel) {
      usageLimitLabel.textContent = `${formatTokens(inputLimit)} context`;
    }

    if (usageProgressFill) {
      const fillPct = usedTokens > 0 ? Math.max(pct, 0.6) : 0;
      usageProgressFill.style.width = `${fillPct}%`;

      usageProgressFill.classList.remove('warning', 'danger');
      if (pct >= 90) {
        usageProgressFill.classList.add('danger');
      } else if (pct >= 70) {
        usageProgressFill.classList.add('warning');
      }
    }
  }

  async function fetchModels() {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.success && Array.isArray(data.models)) {
        cachedModels = data.models.map((m: any) => {
          let id = m.id;
          if (id && id.startsWith('om-mock-')) id = id.replace('om-mock-', 'om-');
          let displayName = m.displayName || id;
          if (displayName.toLowerCase().includes('mock')) {
            displayName = displayName.replace(/\s*Mock\s*/gi, ' ').replace(/\s+/g, ' ').trim();
          }
          if (displayName.includes('Simulator')) {
            displayName = displayName.replace(/\s*Simulator\s*/g, ' ').replace(/\s+/g, ' ').trim();
          }
          if (id === 'om-v1') displayName = 'OM v1';
          if (id === 'om-turbo') displayName = 'OM Turbo';
          if (id === 'om-reasoning') displayName = 'OM Reasoning';
          let provider = m.provider || data.provider || 'gemini';
          if (provider.toLowerCase() === 'google') provider = 'gemini';
          if (provider.toLowerCase() === 'omega' || provider.toLowerCase() === 'mock') provider = 'om';
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

  function renderFullModelsGrid() {
    if (!fullModelsGrid) return;
    const query = (modelsFilterInput?.value || '').trim().toLowerCase();
    const activeModel = (topLoadedModel.textContent || '').trim().toLowerCase();

    const filtered = cachedModels.filter((m) => {
      const p = (m.provider || 'gemini').toLowerCase();
      const provMatch = currentProviderFilter === 'all' || (
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
        const targetModel = localModels[0] || { provider: 'om', id: 'om-v1' };
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
    updateModelUsageBar
  };
}
