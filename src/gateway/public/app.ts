// OM Gateway — LM Studio Style Dashboard Client
import {
  byId,
  escapeHtml,
  formatBytes,
  isLocalProviderName
} from './utils.js';
import { initModals, initRoutingModal } from './modals.js';
import { initTelemetry } from './telemetry.js';
import { initParametersPanel } from './parameters.js';
import { initModels } from './models.js';
import { initSessions } from './sessions.js';
import { initTraceRenderer } from './traceRenderer.js';
import { initAgents } from './agents.js';
import { initDeviceSpecs } from './device.js';

function resolveGatewayToken(): string {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    sessionStorage.setItem('om_gateway_token', urlToken);
    params.delete('token');
    const cleanSearch = params.toString();
    const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
    return urlToken;
  }
  const metaToken = document.querySelector<HTMLMetaElement>('meta[name="om-gateway-token"]')?.content?.trim();
  if (metaToken) {
    sessionStorage.setItem('om_gateway_token', metaToken);
    return metaToken;
  }
  return sessionStorage.getItem('om_gateway_token') || '';
}

let gatewayToken = resolveGatewayToken();
let authPrompted = false;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const isApi = urlStr.startsWith('/api/') || urlStr.startsWith(`${window.location.origin}/api/`);
  if (!isApi) return originalFetch(input, init);

  const buildHeaders = (tok: string) => {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (tok && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${tok}`);
    }
    return headers;
  };

  let res = await originalFetch(input, { ...init, headers: buildHeaders(gatewayToken) });
  if (res.status === 401 && !authPrompted) {
    authPrompted = true;
    const entered = window.prompt('Enter OMega Bearer token / API key:');
    if (entered && entered.trim()) {
      gatewayToken = entered.trim();
      sessionStorage.setItem('om_gateway_token', gatewayToken);
      res = await originalFetch(input, { ...init, headers: buildHeaders(gatewayToken) });
    }
  }
  return res;
};

document.addEventListener('DOMContentLoaded', () => {
  const { appendActivityLogEntry, loadActivityHistory, loadMemory } = initTelemetry();
  const { openRefViewer, closeRefViewer, closeSkillCreator } = initModals({ loadSkills: () => loadSkills() });
  const { refreshRouting } = initRoutingModal();
  const { loadAgents, handleAgentUpdate } = initAgents();
  const { loadDeviceSpecs } = initDeviceSpecs();

  function autoResizePromptInput() {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
    updateSendBtnState();
    updateModelUsageBar();
  }

  // Navigation elements
  const railItems = document.querySelectorAll<HTMLElement>('.rail-item');
  const tabPanes = document.querySelectorAll<HTMLElement>('.tab-pane');
  const viewTitle = byId('viewTitle');
  const topbarSessionTag = byId('topbarSessionTag');

  // Top Bar elements
  const modelDropdownMenu = byId('modelDropdownMenu');
  const dropdownCloseBtn = byId<HTMLButtonElement>('dropdownCloseBtn');
  const topLoadedModel = byId('topLoadedModel');
  const topLoadedProvider = byId('topLoadedProvider');
  const modelQuickSearchInput = byId<HTMLInputElement>('modelQuickSearchInput');
  const modelQuickList = byId('modelQuickList');
  const gotoModelsTabBtn = byId<HTMLButtonElement>('gotoModelsTabBtn');
  const toggleParamsBtn = byId<HTMLButtonElement>('toggleParamsBtn');
  const skillsCountBadge = byId('skillsCountBadge');

  // Chat layout elements
  const sessionsSidebar = byId('sessionsSidebar');
  const agentsSidebar = document.getElementById('agentsSidebar');
  const toggleSessionsBtn = byId<HTMLButtonElement>('toggleSessionsBtn');
  const resetSessionsCounterBtn = byId<HTMLButtonElement>('resetSessionsCounterBtn');
  const sessionsListContainer = byId('sessionsListContainer');
  const sessionSearchInput = byId<HTMLInputElement>('sessionSearchInput');
  const createChatBtn = byId<HTMLButtonElement>('createChatBtn');
  const messagesContainer = byId('messagesContainer');
  const promptInput = byId<HTMLTextAreaElement>('promptInput');
  const voiceBtn = byId<HTMLButtonElement>('voiceBtn');
  const sendBtn = byId<HTMLButtonElement>('sendBtn');
  const inputModelTag = byId('inputModelTag');
  const inputModelSelectorBtn = byId<HTMLButtonElement>('inputModelSelectorBtn');

  // Cloud / Local Mode Toggle in input bar
  const chatModeCloudBtn = byId<HTMLButtonElement>('chatModeCloudBtn');
  const chatModeLocalBtn = byId<HTMLButtonElement>('chatModeLocalBtn');
  const inputModelTargetPill = byId('inputModelTargetPill');
  const dropdownScopeTabs = byId('dropdownScopeTabs');

  // Reasoning Effort Toggle in input bar
  const chatEffortToggle = byId('chatEffortToggle');
  const effortTriggerBtn = byId<HTMLButtonElement>('effortTriggerBtn');
  const chatEffortOptions = byId('chatEffortOptions');
  const effortButtons = chatEffortToggle
    ? Array.from(chatEffortToggle.querySelectorAll<HTMLButtonElement>('.chat-effort-btn'))
    : [];
  const worktreeToggleBtn = byId<HTMLButtonElement>('worktreeToggleBtn');

  // Model Usage Bar elements
  const modelUsageBar = byId('modelUsageBar');
  const usageModelLabel = byId('usageModelLabel');
  const usageModeTag = byId('usageModeTag');
  const usageTokensCounter = byId('usageTokensCounter');
  const usagePctBadge = byId('usagePctBadge');
  const usageLimitLabel = byId('usageLimitLabel');
  const usageProgressFill = byId('usageProgressFill');

  // Input bar plus menu & attachments elements
  const inputPlusBtn = byId<HTMLButtonElement>('inputPlusBtn');
  const plusMenuWrap = byId('plusMenuWrap');
  const plusPopoverMenu = byId('plusPopoverMenu');
  const menuAddFile = byId('menuAddFile');
  const menuAddFolder = byId('menuAddFolder');
  const menuMentions = byId('menuMentions');
  const menuActions = byId('menuActions');
  const menuBrowser = byId('menuBrowser');
  const attachFileInput = byId<HTMLInputElement>('attachFileInput');
  const attachFolderInput = byId<HTMLInputElement>('attachFolderInput');
  const attachedChipsRow = byId('attachedChipsRow');
  const inlineSuggestionsPopover = byId('inlineSuggestionsPopover');
  const suggestionsList = byId('suggestionsList');
  const suggestionsHeader = byId('suggestionsHeader');
  const closeSuggestionsBtn = byId<HTMLButtonElement>('closeSuggestionsBtn');

  // Parameters sidebar elements
  const paramsSidebar = byId('paramsSidebar');
  const closeParamsBtn = byId<HTMLButtonElement>('closeParamsBtn');
  const systemPromptInput = byId<HTMLTextAreaElement>('systemPromptInput');
  const saveSystemPromptBtn = byId<HTMLButtonElement>('saveSystemPromptBtn');
  const tempSlider = byId<HTMLInputElement>('tempSlider');
  const tempValBadge = byId('tempValBadge');
  const metaProvider = byId('metaProvider');
  const metaModel = byId('metaModel');
  const specMemoryDir = byId('specMemoryDir');
  const specWorkspaceDir = byId('specWorkspaceDir');

  function setSpecDirValue(el: HTMLElement | null, dirPath: string) {
    if (!el) return;
    el.dataset.copyPath = dirPath;
    el.title = `Click to copy: ${dirPath}`;
    const labelEl = el.querySelector<HTMLElement>('.spec-ellipsis');
    if (labelEl) {
      labelEl.textContent = dirPath;
    } else {
      el.textContent = dirPath;
    }
  }

  function wireSpecDirCopy(el: HTMLElement | null) {
    if (!el) return;
    let resetTimer: number | undefined;
    el.addEventListener('click', async () => {
      const labelEl = el.querySelector<HTMLElement>('.spec-ellipsis');
      const rawPath = el.dataset.copyPath || labelEl?.textContent || '';
      if (!rawPath) return;
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(rawPath);
          copied = true;
        }
      } catch (_) { }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = rawPath;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          copied = document.execCommand('copy');
        } catch (_) { }
        document.body.removeChild(ta);
      }
      if (!copied) return;
      if (resetTimer) window.clearTimeout(resetTimer);
      el.classList.add('copied');
      if (labelEl) labelEl.textContent = 'Copied!';
      resetTimer = window.setTimeout(() => {
        el.classList.remove('copied');
        if (labelEl) labelEl.textContent = el.dataset.copyPath || rawPath;
      }, 1400);
    });
  }

  wireSpecDirCopy(specMemoryDir);
  wireSpecDirCopy(specWorkspaceDir);

  // Models tab elements
  const modelsFilterInput = byId<HTMLInputElement>('modelsFilterInput');
  const fullModelsGrid = byId('fullModelsGrid');
  const providerFilterPills = document.querySelectorAll<HTMLElement>('.filter-pill');

  // Skills & Telemetry elements
  const skillsList = byId('skillsList');
  const sysProvider = byId('sysProvider');
  const sysModel = byId('sysModel');
  const sysSkillsCount = byId('sysSkillsCount');
  const configTable = byId('configTable');
  const modelsTable = byId('modelsTable');

  let isStreaming = false;
  let activeTab = 'chat';
  let attachedFiles: any[] = [];

  const TAB_NAMES: Record<string, string> = {
    chat: 'Chat',
    agents: 'Agents',
    models: 'Models',
    skills: 'Skills',
    memory: 'Memory',
    system: 'Developer & Server',
    device: 'Device'
  };

  // --------------------------------------------------------------------------
  // 1. TAB NAVIGATION
  // --------------------------------------------------------------------------
  const TAB_PANE_IDS: Record<string, string> = {
    chat: 'paneChat',
    agents: 'paneAgents',
    models: 'paneModels',
    skills: 'paneSkills',
    memory: 'paneMemory',
    system: 'paneSystem',
    device: 'paneDevice'
  };

  function switchTab(tab: string) {
    activeTab = tab;
    railItems.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    tabPanes.forEach((p) => p.classList.remove('active'));

    const paneId = TAB_PANE_IDS[tab];
    const targetPane = paneId ? document.getElementById(paneId) : null;

    if (targetPane) targetPane.classList.add('active');
    if (viewTitle) viewTitle.textContent = TAB_NAMES[tab] || 'OM Agent Studio';

    const tabLoaders: Record<string, () => void> = {
      chat: loadSessions,
      agents: loadAgents,
      models: loadModels,
      skills: loadSkills,
      memory: loadMemory,
      system: () => { loadStatus(); loadModels(); loadActivityHistory(); },
      device: loadDeviceSpecs
    };
    tabLoaders[tab]?.();
    syncLeftSidebarToggle();
  }

  function syncLeftSidebarToggle() {
    if (!toggleSessionsBtn) return;
    const sidebar = activeTab === 'agents' ? agentsSidebar : sessionsSidebar;
    if (!sidebar) return;
    toggleSessionsBtn.classList.toggle('active', !sidebar.classList.contains('hidden'));
    toggleSessionsBtn.title = activeTab === 'agents' ? 'Toggle Agents Sidebar' : 'Toggle Sessions Sidebar';
  }

  railItems.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab || 'chat'));
  });

  if (gotoModelsTabBtn) {
    gotoModelsTabBtn.addEventListener('click', () => {
      closeModelDropdown();
      switchTab('models');
    });
  }

  // --------------------------------------------------------------------------
  // 2. MODEL SELECTOR DROPDOWN & TOPBAR
  // --------------------------------------------------------------------------
  const {
    closeModelDropdown,
    loadModels,
    updateModelUsageBar
  } = initModels({
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
    getActiveTab: () => activeTab,
    getAttachedFiles: () => attachedFiles,
    applyStatusToUI,
    closePlusMenu: () => { if (typeof closePlusMenu === 'function') closePlusMenu(); },
    closeInlineSuggestions: () => { if (typeof closeInlineSuggestions === 'function') closeInlineSuggestions(); }
  });

  createChatBtn.addEventListener('click', async () => {
    await resetSession();
  });

  // Toggle Left Sidebar (Sessions in Chat, Runtime in Agents)
  if (toggleSessionsBtn) {
    toggleSessionsBtn.addEventListener('click', () => {
      const sidebar = activeTab === 'agents' ? agentsSidebar : sessionsSidebar;
      if (!sidebar) return;
      sidebar.classList.toggle('hidden');
      syncLeftSidebarToggle();
    });
  }

  // Toggle Parameters Panel from Topbar
  if (toggleParamsBtn && paramsSidebar) {
    toggleParamsBtn.addEventListener('click', () => {
      paramsSidebar.classList.toggle('hidden');
      toggleParamsBtn.classList.toggle('active', !paramsSidebar.classList.contains('hidden'));
    });
  }

  if (closeParamsBtn && paramsSidebar) {
    closeParamsBtn.addEventListener('click', () => {
      paramsSidebar.classList.add('hidden');
      if (toggleParamsBtn) toggleParamsBtn.classList.remove('active');
    });
  }

  // --------------------------------------------------------------------------
  // 3. STATUS & LIVE SSE SYNCHRONIZATION
  // --------------------------------------------------------------------------
  function applyStatusToUI(data: any) {
    const rawProv = (data.provider || 'gemini').toLowerCase();
    let prov = 'GEMINI';
    if (rawProv === 'gemini' || rawProv === 'google') prov = 'GEMINI';
    else if (rawProv === 'om' || rawProv === 'mock' || rawProv === 'omega') prov = 'OMEGA';
    else prov = rawProv.toUpperCase();

    let mod = data.model || 'gemini-3.5-flash';
    if (mod === 'om-mock-turbo') mod = 'om-turbo';
    if (mod === 'om-mock-v1') mod = 'om-v1';
    if (mod === 'om-mock-reasoning') mod = 'om-reasoning';
    if (mod.startsWith('om-mock-')) mod = mod.replace('om-mock-', 'om-');
    const target = data.target || (isLocalProviderName(rawProv) ? 'local' : 'cloud');

    topLoadedModel.textContent = mod;
    topLoadedProvider.textContent = prov;
    inputModelTag.textContent = mod;

    const statusChipLive = document.getElementById('statusChipLive');
    if (statusChipLive && window.location.origin) {
      statusChipLive.textContent = `● Live on ${window.location.origin}`;
    }

    if (chatModeCloudBtn && chatModeLocalBtn) {
      if (target === 'cloud') {
        chatModeCloudBtn.classList.add('active');
        chatModeLocalBtn.classList.remove('active');
      } else {
        chatModeLocalBtn.classList.add('active');
        chatModeCloudBtn.classList.remove('active');
      }
    }
    if (inputModelTargetPill) {
      inputModelTargetPill.textContent = target.toUpperCase();
      inputModelTargetPill.className = `input-model-target-pill ${target}`;
      inputModelTargetPill.dataset.target = target;
    }
    if (usageModeTag) {
      usageModeTag.textContent = target.toUpperCase();
      usageModeTag.className = `usage-mode-tag ${target}`;
    }

    if (topbarSessionTag && data.sessionId !== undefined) topbarSessionTag.textContent = data.sessionId;
    if (skillsCountBadge && data.skillsCount !== undefined) skillsCountBadge.textContent = String(data.skillsCount);
    void refreshRouting();

    let displayProvName = rawProv;
    if (rawProv === 'gemini' || rawProv === 'google') displayProvName = 'gemini';
    else if (rawProv === 'om' || rawProv === 'mock' || rawProv === 'omega') displayProvName = 'OMega';

    if (metaProvider) metaProvider.textContent = displayProvName;
    if (metaModel) metaModel.textContent = mod;
    if (sysProvider) sysProvider.textContent = prov;
    if (sysModel) sysModel.textContent = mod;
    if (sysSkillsCount && data.skillsCount !== undefined) sysSkillsCount.textContent = String(data.skillsCount);

    if (data.memoryDir !== undefined) setSpecDirValue(specMemoryDir, data.memoryDir);
    if (data.workspaceDir !== undefined) setSpecDirValue(specWorkspaceDir, data.workspaceDir);

    if (configTable) {
      configTable.innerHTML = `
        <div class="config-row"><span class="config-key">Agent Name</span><span class="config-val">${escapeHtml(data.name || 'OMega')}</span></div>
        <div class="config-row"><span class="config-key">Active Provider</span><span class="config-val">${displayProvName}</span></div>
        <div class="config-row"><span class="config-key">Active Model</span><span class="config-val">${mod}</span></div>
        <div class="config-row"><span class="config-key">Active Session ID</span><span class="config-val">${data.sessionId || 'session_1'}</span></div>
        <div class="config-row"><span class="config-key">Memory Directory</span><span class="config-val">${data.memoryDir || './memory'}</span></div>
        <div class="config-row"><span class="config-key">Workspace Directory</span><span class="config-val">${data.workspaceDir || '.'}</span></div>
      `;
    }

    updateModelUsageBar();
  }

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();
      applyStatusToUI(data);
    } catch (e) {
      console.warn('Failed to load status', e);
    }
  }

  function connectLiveEvents() {
    try {
      const eventsUrl = gatewayToken ? `/api/events?token=${encodeURIComponent(gatewayToken)}` : '/api/events';
      const es = new EventSource(eventsUrl);
      es.addEventListener('config_updated', (ev) => {
        try {
          const data = JSON.parse(ev.data);
          applyStatusToUI(data);
          if (activeTab === 'skills') loadSkills();
          if (activeTab === 'models') loadModels();
        } catch (_) { }
      });
      es.addEventListener('activity', (ev) => {
        try {
          const entry = JSON.parse(ev.data);
          appendActivityLogEntry(entry);
        } catch (_) { }
      });
      es.addEventListener('agent_update', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          handleAgentUpdate(payload);
        } catch (_) { }
      });
      es.addEventListener('approval_required', (ev) => {
        try {
          const reqData = JSON.parse(ev.data);
          showApprovalPrompt(reqData);
        } catch (_) { }
      });
      es.addEventListener('approval_resolved', (ev) => {
        try {
          const { id } = JSON.parse(ev.data);
          const el = document.getElementById(`approval-${id}`);
          if (el) el.remove();
        } catch (_) { }
      });
    } catch (_) { }
  }

  function showApprovalPrompt(reqData: any) {
    let container = document.getElementById('omApprovalContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'omApprovalContainer';
      container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;max-width:420px;';
      document.body.appendChild(container);
    }
    const card = document.createElement('div');
    card.id = `approval-${reqData.id}`;
    card.style.cssText = 'background:#18181b;border:1px solid #f59e0b;border-radius:10px;padding:14px;color:#f4f4f5;box-shadow:0 10px 25px rgba(0,0,0,0.45);font-size:13px;';
    const detail = reqData.command ? reqData.command : JSON.stringify(reqData.args || {});
    const suggestedPrefix = reqData.tool === 'exec_command' && reqData.suggestedPrefix ? String(reqData.suggestedPrefix) : '';
    const alwaysLabel = suggestedPrefix ? `Always Allow "${suggestedPrefix}"` : 'Always Allow';
    const alwaysTitle = suggestedPrefix
      ? `Grant permanent permission for commands starting with "${suggestedPrefix}"`
      : 'Grant permanent permission for this tool';
    card.innerHTML = `
      <div style="font-weight:600;color:#fbbf24;margin-bottom:6px;">Approval Required: ${escapeHtml(reqData.tool)}</div>
      <pre style="background:#09090b;padding:8px;border-radius:6px;overflow:auto;max-height:120px;font-size:12px;margin:0 0 10px 0;">${escapeHtml(detail)}</pre>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <button data-act="deny" style="padding:6px 12px;border-radius:6px;border:1px solid #3f3f46;background:#27272a;color:#f4f4f5;cursor:pointer;">Deny</button>
        <button data-act="approve-once" style="padding:6px 12px;border-radius:6px;border:none;background:#10b981;color:#09090b;font-weight:600;cursor:pointer;">Allow Once</button>
        <button data-act="approve-always" style="padding:6px 12px;border-radius:6px;border:1px solid rgba(59,130,246,0.45);background:rgba(59,130,246,0.18);color:#93c5fd;font-weight:600;cursor:pointer;" title="${escapeHtml(alwaysTitle)}">${escapeHtml(alwaysLabel)}</button>
      </div>
    `;
    const respond = async (approved: boolean, scope: 'once' | 'always' = 'once') => {
      const bodyPayload: Record<string, any> = { approved, scope };
      if (scope === 'always' && suggestedPrefix) {
        bodyPayload.commandPrefix = suggestedPrefix;
      }
      await fetch(`/api/approvals/${encodeURIComponent(reqData.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });
      card.remove();
    };
    card.querySelector('[data-act="approve-once"]')?.addEventListener('click', () => respond(true, 'once'));
    card.querySelector('[data-act="approve-always"]')?.addEventListener('click', () => respond(true, 'always'));
    card.querySelector('[data-act="deny"]')?.addEventListener('click', () => respond(false, 'once'));
    container.appendChild(card);
  }

  // --------------------------------------------------------------------------
  // 4. TRACE RENDERER & CHAT SESSIONS MANAGEMENT
  // --------------------------------------------------------------------------
  const {
    scrollToBottom,
    appendCopyAction,
    appendUserMessage,
    createAgentMessageContainer,
    handleAgentEvent
  } = initTraceRenderer({
    messagesContainer,
    topLoadedModel,
    inputModelTag,
    updateModelUsageBar
  });

  const {
    loadSessions,
    clearChatPage,
    resetSession
  } = initSessions({
    sessionsListContainer,
    sessionSearchInput,
    topbarSessionTag,
    messagesContainer,
    resetSessionsCounterBtn,
    appendUserMessage,
    createAgentMessageContainer,
    appendCopyAction,
    scrollToBottom,
    updateModelUsageBar,
    clearAttachments: () => {
      attachedFiles = [];
      renderAttachedChips();
    }
  });

  // --------------------------------------------------------------------------
  // 6. PARAMETERS SIDEBAR CONTROLS & EFFORT MEASURE
  // --------------------------------------------------------------------------
  type EffortLevel = 'low' | 'medium' | 'high';
  const storedEffort = localStorage.getItem('om_chat_effort');
  let currentEffort: EffortLevel =
    storedEffort === 'low' || storedEffort === 'medium' || storedEffort === 'high' ? storedEffort : 'medium';

  function setEffortDrawerOpen(isOpen: boolean) {
    if (!chatEffortToggle) return;
    chatEffortToggle.classList.toggle('open', isOpen);
    if (effortTriggerBtn) effortTriggerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (chatEffortOptions) chatEffortOptions.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  }

  function setActiveEffort(effort: EffortLevel, persist = false) {
    currentEffort = effort;
    localStorage.setItem('om_chat_effort', effort);
    if (effortTriggerBtn) {
      effortTriggerBtn.title = `Reasoning effort: ${effort} (click to adjust)`;
    }
    for (const btn of effortButtons) {
      const isSelected = btn.dataset.effort === effort;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
    if (persist) {
      fetch('/api/system-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ effort })
      }).catch(() => {});
    }
  }

  setActiveEffort(currentEffort, false);
  if (effortTriggerBtn) {
    effortTriggerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const nextOpen = !chatEffortToggle?.classList.contains('open');
      setEffortDrawerOpen(nextOpen);
    });
  }
  for (const btn of effortButtons) {
    btn.addEventListener('click', () => {
      const val = btn.dataset.effort;
      if (val === 'low' || val === 'medium' || val === 'high') {
        setActiveEffort(val, true);
        setEffortDrawerOpen(false);
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (chatEffortToggle && !chatEffortToggle.contains(e.target as Node)) {
      setEffortDrawerOpen(false);
    }
  });

  let currentWorktree = localStorage.getItem('om_chat_worktree') === 'true';
  function setWorktreeActive(active: boolean) {
    currentWorktree = active;
    localStorage.setItem('om_chat_worktree', active ? 'true' : 'false');
    if (worktreeToggleBtn) {
      worktreeToggleBtn.classList.toggle('active', active);
      worktreeToggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
  setWorktreeActive(currentWorktree);
  if (worktreeToggleBtn) {
    worktreeToggleBtn.addEventListener('click', () => {
      setWorktreeActive(!currentWorktree);
    });
  }

  const { loadParameters } = initParametersPanel({
    systemPromptInput,
    saveSystemPromptBtn,
    tempSlider,
    tempValBadge,
    onEffortLoaded: (effort) => setActiveEffort(effort, false)
  });

  // --------------------------------------------------------------------------
  // 7. ATTACHMENTS, PLUS MENU & CHAT EXECUTION
  // --------------------------------------------------------------------------

  function updateSendBtnState() {
    const hasText = promptInput && promptInput.value.trim().length > 0;
    const hasFiles = attachedFiles.length > 0;
    if (sendBtn) {
      if (hasText || hasFiles) {
        sendBtn.classList.add('active');
      } else {
        sendBtn.classList.remove('active');
      }
    }
  }

  function renderAttachedChips() {
    if (!attachedChipsRow) return;
    if (attachedFiles.length === 0) {
      attachedChipsRow.style.display = 'none';
      attachedChipsRow.innerHTML = '';
      updateSendBtnState();
      updateModelUsageBar();
      return;
    }

    attachedChipsRow.style.display = 'flex';
    attachedChipsRow.innerHTML = '';

    attachedFiles.forEach((fileItem) => {
      const chip = document.createElement('div');
      chip.className = 'attached-chip';

      const icon = document.createElement('span');
      icon.className = 'attached-chip-icon';
      icon.innerHTML = fileItem.isFolder
        ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`
        : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;

      const name = document.createElement('span');
      name.className = 'attached-chip-name';
      name.textContent = fileItem.name;
      name.title = fileItem.name;

      const size = document.createElement('span');
      size.className = 'attached-chip-size';
      size.textContent = fileItem.isFolder
        ? `${fileItem.filesCount || 1} file(s)`
        : formatBytes(fileItem.size);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'attached-chip-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachedFiles = attachedFiles.filter((f) => f.id !== fileItem.id);
        renderAttachedChips();
      });

      chip.appendChild(icon);
      chip.appendChild(name);
      chip.appendChild(size);
      chip.appendChild(removeBtn);
      attachedChipsRow.appendChild(chip);
    });

    updateSendBtnState();
    updateModelUsageBar();
  }

  // Toggle plus menu
  if (inputPlusBtn && plusPopoverMenu) {
    inputPlusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = plusPopoverMenu.classList.contains('open');
      if (isOpen) {
        closePlusMenu();
      } else {
        openPlusMenu();
      }
    });
  }

  function openPlusMenu() {
    if (!plusPopoverMenu) return;
    closeModelDropdown();
    plusPopoverMenu.classList.add('open');
    if (inputPlusBtn) {
      inputPlusBtn.classList.add('active');
      inputPlusBtn.setAttribute('aria-expanded', 'true');
    }
    closeInlineSuggestions();
  }

  function closePlusMenu() {
    if (!plusPopoverMenu) return;
    plusPopoverMenu.classList.remove('open');
    if (inputPlusBtn) {
      inputPlusBtn.classList.remove('active');
      inputPlusBtn.setAttribute('aria-expanded', 'false');
    }
  }

  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (plusMenuWrap && !plusMenuWrap.contains(target)) {
      closePlusMenu();
    }
    if (inlineSuggestionsPopover && !inlineSuggestionsPopover.contains(target) && promptInput !== target) {
      closeInlineSuggestions();
    }
  });

  // Add file action
  if (menuAddFile && attachFileInput) {
    menuAddFile.addEventListener('click', () => {
      closePlusMenu();
      attachFileInput.click();
    });
  }

  if (attachFileInput) {
    attachFileInput.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files || []);
      for (const file of files) {
        let content = '';
        if (file.size < 2 * 1024 * 1024) {
          try {
            content = await file.text();
          } catch (_) { }
        }
        attachedFiles.push({
          id: Math.random().toString(36).slice(2, 9),
          name: file.name,
          size: file.size,
          type: file.type,
          isFolder: false,
          content
        });
      }
      attachFileInput.value = '';
      renderAttachedChips();
    });
  }

  // Add folder action
  if (menuAddFolder && attachFolderInput) {
    menuAddFolder.addEventListener('click', () => {
      closePlusMenu();
      attachFolderInput.click();
    });
  }

  if (attachFolderInput) {
    attachFolderInput.addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files || []);
      if (files.length === 0) return;

      const firstPath = files[0].webkitRelativePath || '';
      const folderName = firstPath.split('/')[0] || 'folder';
      let totalSize = 0;
      let textFilesSummary: string[] = [];

      for (const file of files) {
        totalSize += file.size;
        if (textFilesSummary.length < 25 && file.size < 256 * 1024) {
          try {
            const txt = await file.text();
            textFilesSummary.push(`File: ${file.webkitRelativePath}\n${txt}`);
          } catch (_) { }
        }
      }

      attachedFiles.push({
        id: Math.random().toString(36).slice(2, 9),
        name: folderName,
        size: totalSize,
        isFolder: true,
        filesCount: files.length,
        content: textFilesSummary.join('\n\n')
      });

      attachFolderInput.value = '';
      renderAttachedChips();
    });
  }

  // Mentions action
  if (menuMentions) {
    menuMentions.addEventListener('click', () => {
      closePlusMenu();
      insertTextAtCursor('@');
      showSuggestions('mentions');
    });
  }

  // Actions command
  if (menuActions) {
    menuActions.addEventListener('click', () => {
      closePlusMenu();
      insertTextAtCursor('/');
      showSuggestions('actions');
    });
  }

  // Browser action
  if (menuBrowser) {
    menuBrowser.addEventListener('click', () => {
      closePlusMenu();
      if (!promptInput.value.trim()) {
        promptInput.value = 'Browse ';
      } else {
        insertTextAtCursor(' Browse ');
      }
      promptInput.focus();
      updateSendBtnState();
    });
  }

  // Helper to insert text at cursor in promptInput
  function insertTextAtCursor(textToInsert: string) {
    promptInput.focus();
    const start = promptInput.selectionStart || 0;
    const end = promptInput.selectionEnd || 0;
    const val = promptInput.value;
    promptInput.value = val.substring(0, start) + textToInsert + val.substring(end);
    promptInput.selectionStart = promptInput.selectionEnd = start + textToInsert.length;
    autoResizePromptInput();
  }

  // Suggestions for @ mentions and / actions
  const MENTION_ITEMS = [
    { label: '@workspace', desc: 'Current files and repository structure' },
    { label: '@memory', desc: 'Agent persistent long-term memory' },
    { label: '@skills', desc: 'Available tools and execution skills' },
    { label: '@system', desc: 'System specifications, CPU, and OS' }
  ];

  const ACTION_ITEMS = [
    { label: '/clear', desc: 'Clear page clean as new (keeps current session)' },
    { label: '/new', desc: 'Start a new conversation session' },
    { label: '/cloud', desc: 'Switch inference mode to Cloud (Gemini, GPT, Claude)' },
    { label: '/local', desc: 'Switch inference mode to Local (vLLM, LM Studio, OM)' },
    { label: '/browse', desc: 'Search the web or inspect a webpage URL' },
    { label: '/skills', desc: 'List loaded agent skills' },
    { label: '/models', desc: 'Browse and switch AI models' },
    { label: '/help', desc: 'Show available commands and usage' }
  ];

  let activeSuggestionType: string | null = null;
  let activeSuggestionItems: any[] = [];
  let selectedSuggestionIndex = 0;

  function insertSelectedSuggestion(item: any, type?: string | null) {
    if (!item) return;
    const val = promptInput.value;
    const cursorPos = promptInput.selectionStart || val.length;
    const textBeforeCursor = val.slice(0, cursorPos);
    const textAfterCursor = val.slice(cursorPos);
    const trigger = (type || activeSuggestionType) === 'mentions' ? '@' : '/';
    const lastTriggerIdx = textBeforeCursor.lastIndexOf(trigger);

    let newBefore;
    if (lastTriggerIdx !== -1) {
      newBefore = textBeforeCursor.substring(0, lastTriggerIdx) + item.label + ' ';
    } else {
      newBefore = textBeforeCursor + item.label + ' ';
    }

    promptInput.value = newBefore + textAfterCursor;
    const newCursor = newBefore.length;
    promptInput.setSelectionRange(newCursor, newCursor);
    promptInput.focus();
    closeInlineSuggestions();
    autoResizePromptInput();
  }

  function updateSelectedSuggestionDOM() {
    if (!suggestionsList) return;
    const items = suggestionsList.querySelectorAll('.suggestion-item');
    items.forEach((itemEl, idx) => {
      if (idx === selectedSuggestionIndex) {
        itemEl.classList.add('selected');
        itemEl.scrollIntoView({ block: 'nearest' });
      } else {
        itemEl.classList.remove('selected');
      }
    });
  }

  function showSuggestions(type: string, query = '') {
    if (!inlineSuggestionsPopover || !suggestionsList || !suggestionsHeader) return;
    if (typeof closeModelDropdown === 'function') closeModelDropdown();
    if (typeof closePlusMenu === 'function') closePlusMenu();

    activeSuggestionType = type;
    const allItems = type === 'mentions' ? MENTION_ITEMS : ACTION_ITEMS;
    suggestionsHeader.textContent = type === 'mentions' ? 'Mention Context (@)' : 'Actions & Commands (/)';

    const cleanQuery = (query || '').trim().toLowerCase();
    activeSuggestionItems = allItems.filter((item) => {
      if (!cleanQuery) return true;
      const labelWithoutPrefix = item.label.slice(1).toLowerCase();
      return (
        item.label.toLowerCase().includes(cleanQuery) ||
        labelWithoutPrefix.includes(cleanQuery) ||
        item.desc.toLowerCase().includes(cleanQuery)
      );
    });

    selectedSuggestionIndex = 0;
    suggestionsList.innerHTML = '';

    if (activeSuggestionItems.length === 0) {
      suggestionsList.innerHTML = '<div class="dropdown-loading-item">No matching suggestions</div>';
    } else {
      activeSuggestionItems.forEach((item, idx) => {
        const itemEl = document.createElement('div');
        itemEl.className = `dropdown-model-item suggestion-item ${idx === 0 ? 'selected' : ''}`;
        itemEl.dataset.index = String(idx);
        itemEl.innerHTML = `
          <div class="dropdown-item-info">
            <div class="suggestion-title-row">
              <span class="suggestion-tag-pill">${type === 'mentions' ? 'CONTEXT' : 'ACTION'}</span>
              <span class="dropdown-item-title">${escapeHtml(item.label)}</span>
            </div>
            <span class="dropdown-item-sub">${escapeHtml(item.desc)}</span>
          </div>
        `;

        itemEl.addEventListener('mouseenter', () => {
          selectedSuggestionIndex = idx;
          updateSelectedSuggestionDOM();
        });

        itemEl.addEventListener('click', (e) => {
          e.stopPropagation();
          insertSelectedSuggestion(item, type);
        });

        suggestionsList.appendChild(itemEl);
      });
    }

    inlineSuggestionsPopover.classList.add('show');
    inlineSuggestionsPopover.style.display = 'flex';
  }

  function closeInlineSuggestions() {
    if (inlineSuggestionsPopover) {
      inlineSuggestionsPopover.classList.remove('show');
      inlineSuggestionsPopover.style.display = 'none';
      selectedSuggestionIndex = 0;
      activeSuggestionItems = [];
      activeSuggestionType = null;
    }
  }

  if (closeSuggestionsBtn) {
    closeSuggestionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeInlineSuggestions();
      promptInput.focus();
    });
  }

  // Prompt textarea auto-resize & key handling
  promptInput.addEventListener('input', () => {
    autoResizePromptInput();

    const val = promptInput.value;
    const cursorPos = promptInput.selectionStart || val.length;
    const textBeforeCursor = val.slice(0, cursorPos);
    const lastWord = textBeforeCursor.split(/\s/).pop() || '';

    if (lastWord.startsWith('@')) {
      showSuggestions('mentions', lastWord.slice(1));
    } else if (lastWord.startsWith('/')) {
      showSuggestions('actions', lastWord.slice(1));
    } else {
      closeInlineSuggestions();
    }
  });

  promptInput.addEventListener('keydown', (e) => {
    const isSuggestionsOpen = inlineSuggestionsPopover && (inlineSuggestionsPopover.classList.contains('show') || inlineSuggestionsPopover.style.display === 'flex');

    if (isSuggestionsOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (activeSuggestionItems.length > 0) {
          selectedSuggestionIndex = (selectedSuggestionIndex + 1) % activeSuggestionItems.length;
          updateSelectedSuggestionDOM();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (activeSuggestionItems.length > 0) {
          selectedSuggestionIndex = (selectedSuggestionIndex - 1 + activeSuggestionItems.length) % activeSuggestionItems.length;
          updateSelectedSuggestionDOM();
        }
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (activeSuggestionItems.length > 0 && selectedSuggestionIndex >= 0 && selectedSuggestionIndex < activeSuggestionItems.length) {
          e.preventDefault();
          insertSelectedSuggestion(activeSuggestionItems[selectedSuggestionIndex], activeSuggestionType);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeInlineSuggestions();
        return;
      }
    }

    if (e.key === 'Escape') {
      closeInlineSuggestions();
      closePlusMenu();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      closeInlineSuggestions();
      closePlusMenu();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // Voice Input (Speech-to-Text via Web Speech API)
  let voiceRecognition: any = null;
  let isVoiceRecording = false;
  let stopVoiceRecordingFn = () => {};
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  if (voiceBtn) {
    if (!SpeechRecognition) {
      voiceBtn.title = 'Speech recognition not supported in this browser';
      voiceBtn.style.opacity = '0.35';
      voiceBtn.addEventListener('click', () => {
        alert('Voice input is not supported in this browser. Please use Chrome, Edge, or Brave for Web Speech recognition.');
      });
    } else {
      voiceRecognition = new SpeechRecognition();
      voiceRecognition.continuous = true;
      voiceRecognition.interimResults = true;
      voiceRecognition.lang = navigator.language || 'en-US';

      let basePromptText = '';

      voiceRecognition.onstart = () => {
        isVoiceRecording = true;
        voiceBtn.classList.add('recording');
        voiceBtn.title = 'Listening... Speak now (Click to stop)';
        basePromptText = promptInput.value;
        if (basePromptText && !basePromptText.endsWith(' ')) {
          basePromptText += ' ';
        }
      };

      voiceRecognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript + ' ';
          } else {
            interimTranscript += transcript;
          }
        }

        if (finalTranscript) {
          basePromptText += finalTranscript;
        }

        promptInput.value = basePromptText + interimTranscript;
        autoResizePromptInput();
      };

      voiceRecognition.onerror = (event: any) => {
        if (event.error !== 'no-speech') {
          console.warn('Speech recognition error:', event.error);
        }
        stopVoiceRecording();
      };

      voiceRecognition.onend = () => {
        stopVoiceRecording();
      };

      function stopVoiceRecording() {
        isVoiceRecording = false;
        voiceBtn.classList.remove('recording');
        voiceBtn.title = 'Voice Input (Speech-to-Text)';
        updateSendBtnState();
        promptInput.focus();
      }
      stopVoiceRecordingFn = stopVoiceRecording;

      voiceBtn.addEventListener('click', () => {
        if (isVoiceRecording) {
          try { voiceRecognition.stop(); } catch (_) {}
          stopVoiceRecording();
        } else {
          try {
            voiceRecognition.start();
          } catch (err) {
            console.warn('Failed to start voice recognition:', err);
          }
        }
      });
    }
  }

  document.querySelectorAll<HTMLElement>('.prompt-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      promptInput.value = chip.dataset.prompt || '';
      updateSendBtnState();
      sendMessage();
    });
  });

  async function sendMessage() {
    if (isVoiceRecording) {
      if (voiceRecognition) {
        try { voiceRecognition.stop(); } catch (_) {}
      }
      stopVoiceRecordingFn();
    }

    const text = promptInput.value.trim();
    if ((!text && attachedFiles.length === 0) || isStreaming) return;

    if (text === '/clear') {
      promptInput.value = '';
      promptInput.style.height = 'auto';
      updateSendBtnState();
      await clearChatPage();
      return;
    }
    if (text === '/new') {
      promptInput.value = '';
      promptInput.style.height = 'auto';
      updateSendBtnState();
      await resetSession();
      return;
    }
    if (text === '/models') {
      promptInput.value = '';
      promptInput.style.height = 'auto';
      updateSendBtnState();
      switchTab('models');
      return;
    }
    if (text === '/skills') {
      promptInput.value = '';
      promptInput.style.height = 'auto';
      updateSendBtnState();
      switchTab('skills');
      return;
    }

    const currentAttachments = [...attachedFiles];
    promptInput.value = '';
    promptInput.style.height = 'auto';
    attachedFiles = [];
    renderAttachedChips();
    updateSendBtnState();

    isStreaming = true;
    sendBtn.disabled = true;

    // Append user message with attached chips
    appendUserMessage(text || (currentAttachments.length ? 'Attached file(s)' : ''), currentAttachments);

    // Create assistant message container
    const { row, bubble } = createAgentMessageContainer();
    messagesContainer.appendChild(row);
    scrollToBottom();

    // Running badge
    const runningBadge = document.createElement('div');
    runningBadge.className = 'running-badge';
    runningBadge.innerHTML = `<div class="spinner"></div><span class="running-status-text">Thinking...</span>`;
    bubble.appendChild(runningBadge);

    const streamState: { thoughts: any[]; tools: any[]; fallbacks: any[] } = {
      thoughts: [],
      tools: [],
      fallbacks: []
    };

    // Format prompt with attachments
    let fullPrompt = text;
    if (currentAttachments.length > 0) {
      let attText = 'Attached file(s) and context:\n';
      currentAttachments.forEach((att) => {
        if (att.content) {
          attText += `\n--- [FILE: ${att.name}] ---\n${att.content}\n--- [END OF ${att.name}] ---\n`;
        } else {
          attText += `\n- ${att.name} (${formatBytes(att.size)})\n`;
        }
      });
      fullPrompt = (attText + '\n' + (text || 'Please inspect the attached files.')).trim();
    }

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: fullPrompt, effort: currentEffort, worktree: currentWorktree })
      });

      if (!response.ok || !response.body) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      const processSSEBlock = (block: string) => {
        if (!block.trim()) return;
        const matchEvent = block.match(/^event:\s*(\w+)/m);
        const dataLines = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => (l.startsWith('data: ') ? l.slice(6) : l.slice(5)));

        if (matchEvent && dataLines.length > 0) {
          const eventName = matchEvent[1];
          const rawData = dataLines.join('\n');
          let payload: any;
          try {
            payload = JSON.parse(rawData);
          } catch (_) {
            payload = rawData;
          }
          handleAgentEvent(eventName, payload, bubble, runningBadge, streamState);
          if (eventName === 'done' && payload?.worktree?.hasChanges) {
            const wt = payload.worktree;
            const wtCard = document.createElement('div');
            wtCard.className = 'worktree-card';
            const fileCount = Array.isArray(wt.files) ? wt.files.length : 0;

            const renderDiffPanelHtml = (diffText: string, wtFiles: any[]): string => {
              const raw = String(diffText || '').trim();
              if (!raw) {
                if (!Array.isArray(wtFiles) || wtFiles.length === 0) {
                  return '<div class="worktree-diff-line diff-meta">No diff output available.</div>';
                }
                return wtFiles
                  .map((f: any) => `<div class="worktree-diff-line diff-meta">${escapeHtml(String(f.status || 'M'))} ${escapeHtml(String(f.path || f))}</div>`)
                  .join('');
              }
              const sections = raw.split(/^diff --git /m).filter((s) => s.trim().length > 0);
              return sections
                .map((sec, idx) => {
                  const lines = sec.split(/\r?\n/);
                  const headerMatch = lines[0]?.match(/^a\/(.+?)\s+b\/(.+)$/);
                  const fileName = headerMatch ? headerMatch[2] : (lines.find((l) => l.startsWith('+++ b/'))?.slice(6) || `file-${idx + 1}`);
                  let adds = 0;
                  let dels = 0;
                  const bodyHtml = lines
                    .slice(1)
                    .map((line) => {
                      let cls = 'worktree-diff-line';
                      if (line.startsWith('+') && !line.startsWith('+++')) {
                        cls += ' diff-add';
                        adds++;
                      } else if (line.startsWith('-') && !line.startsWith('---')) {
                        cls += ' diff-del';
                        dels++;
                      } else if (line.startsWith('@@')) {
                        cls += ' diff-hunk';
                      } else if (
                        line.startsWith('index ') ||
                        line.startsWith('--- ') ||
                        line.startsWith('+++ ') ||
                        line.startsWith('new file') ||
                        line.startsWith('deleted file')
                      ) {
                        cls += ' diff-meta';
                      }
                      return `<span class="${cls}">${escapeHtml(line)}</span>`;
                    })
                    .join('');
                  const openAttr = idx < 3 ? ' open' : '';
                  return `
                    <details class="worktree-diff-file"${openAttr}>
                      <summary class="worktree-diff-file-header">
                        <span>${escapeHtml(fileName)}</span>
                        <span class="worktree-diff-stats">
                          <span class="stat-add">+${adds}</span>
                          <span class="stat-del">-${dels}</span>
                        </span>
                      </summary>
                      <pre class="worktree-diff-code">${bodyHtml}</pre>
                    </details>
                  `;
                })
                .join('');
            };

            wtCard.innerHTML = `
              <div class="worktree-card-header">
                <div>
                  <strong>Isolated Worktree:</strong> <code>${escapeHtml(wt.branch || '')}</code>
                  (${fileCount} file${fileCount === 1 ? '' : 's'} changed)
                </div>
                <div class="worktree-card-actions">
                  <button type="button" class="btn-xs" data-wt-act="toggle-diff">Review Diff</button>
                  <button type="button" class="btn-xs" data-wt-act="discard">Discard</button>
                  <button type="button" class="btn-xs primary" data-wt-act="merge">Merge &amp; Apply</button>
                </div>
              </div>
              <div class="worktree-diff-panel" hidden></div>
            `;

            const diffPanel = wtCard.querySelector('.worktree-diff-panel') as HTMLElement | null;
            const toggleDiffBtn = wtCard.querySelector('[data-wt-act="toggle-diff"]') as HTMLButtonElement | null;
            let diffRendered = false;

            toggleDiffBtn?.addEventListener('click', async () => {
              if (!diffPanel) return;
              const willShow = diffPanel.hasAttribute('hidden');
              if (willShow) {
                if (!diffRendered) {
                  let diffText = wt.diff;
                  let wtFiles = wt.files;
                  if (diffText === undefined && wt.worktreePath) {
                    try {
                      const res = await fetch(`/api/git/worktree/diff?worktreePath=${encodeURIComponent(wt.worktreePath)}`);
                      if (res.ok) {
                        const data = await res.json();
                        diffText = data.diff;
                        wtFiles = data.files || wtFiles;
                      }
                    } catch (_) {
                      // Fall back to file list
                    }
                  }
                  diffPanel.innerHTML = renderDiffPanelHtml(diffText || '', wtFiles || []);
                  diffRendered = true;
                }
                diffPanel.removeAttribute('hidden');
                if (toggleDiffBtn) toggleDiffBtn.textContent = 'Hide Diff';
              } else {
                diffPanel.setAttribute('hidden', '');
                if (toggleDiffBtn) toggleDiffBtn.textContent = 'Review Diff';
              }
            });

            wtCard.querySelector('[data-wt-act="merge"]')?.addEventListener('click', async () => {
              const res = await fetch('/api/git/worktree/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ worktreePath: wt.worktreePath, branch: wt.branch })
              });
              if (res.ok) {
                wtCard.innerHTML = `<span>Merged <code>${escapeHtml(wt.branch || '')}</code> into workspace and cleaned up worktree.</span>`;
              } else {
                const err = await res.json().catch(() => ({}));
                wtCard.insertAdjacentHTML('beforeend', `<div style="color:#f87171;">Merge failed: ${escapeHtml(err.error || res.statusText)}</div>`);
              }
            });
            wtCard.querySelector('[data-wt-act="discard"]')?.addEventListener('click', async () => {
              const res = await fetch('/api/git/worktree/discard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ worktreePath: wt.worktreePath, branch: wt.branch })
              });
              if (res.ok) {
                wtCard.innerHTML = `<span>Discarded isolated worktree <code>${escapeHtml(wt.branch || '')}</code>.</span>`;
              }
            });
            bubble.appendChild(wtCard);
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          processSSEBlock(block);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        processSSEBlock(buffer);
      }
    } catch (err: any) {
      if (runningBadge && runningBadge.parentNode) runningBadge.remove();
      const errBox = document.createElement('div');
      errBox.style.color = 'var(--accent-red)';
      errBox.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><strong>Error:</strong> ${escapeHtml(err?.message || err)}`;
      bubble.appendChild(errBox);
    } finally {
      if (runningBadge && runningBadge.parentNode) runningBadge.remove();
      isStreaming = false;
      sendBtn.disabled = false;
      promptInput.focus();
      updateSendBtnState();
      loadStatus();
      loadSessions();
    }
  }

  // --------------------------------------------------------------------------
  // 8. SKILLS CATALOG & INTERACTIVE REFERENCE VIEWER
  // --------------------------------------------------------------------------
  async function loadSkills() {
    if (!skillsList) return;
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      skillsList.innerHTML = '';

      for (const skill of data.skills || []) {
        // Register workflow skills in inline suggestion actions
        if (skill.type === 'workflow') {
          const actionLabel = `/${skill.name}`;
          if (!ACTION_ITEMS.some((item) => item.label === actionLabel)) {
            ACTION_ITEMS.push({
              label: actionLabel,
              desc: skill.description ? (skill.description.length > 75 ? skill.description.slice(0, 72) + '...' : skill.description) : `Execute ${skill.name} workflow`
            });
          }
        }

        const card = document.createElement('div');
        card.className = 'skill-card';
        const isWorkflow = skill.type === 'workflow';

        let refsHtml = '';
        if (skill.references && skill.references.length > 0) {
          const pillBtns = skill.references.map((ref: string) => {
            return `<button class="ref-pill-btn" type="button" data-skill="${escapeHtml(skill.name)}" data-ref="${escapeHtml(ref)}" title="Read ${escapeHtml(ref)} runbook">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
              <span>${escapeHtml(ref)}</span>
            </button>`;
          }).join('');
          refsHtml = `<div class="skill-refs"><span class="skill-refs-title">References:</span> ${pillBtns}</div>`;
        }

        card.innerHTML = `
          <div class="skill-card-top">
            <span class="skill-title"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px;"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polyline></svg>${escapeHtml(skill.name)}</span>
            <span class="skill-tag ${isWorkflow ? 'workflow-tag' : ''}">${isWorkflow ? 'Workflow' : 'Tool'}</span>
          </div>
          <div class="skill-desc">${escapeHtml(skill.description)}</div>
          ${refsHtml}
          <div class="skill-params">
            <pre><code>${escapeHtml(JSON.stringify(skill.parameters || {}, null, 2))}</code></pre>
          </div>
        `;

        card.querySelectorAll<HTMLElement>('.ref-pill-btn').forEach((btn) => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            openRefViewer(btn.dataset.skill || '', btn.dataset.ref || '');
          });
        });

        skillsList.appendChild(card);
      }
    } catch (e: any) {
      skillsList.innerHTML = `<p style="color:var(--accent-red)">Failed to load skills: ${e?.message || e}</p>`;
    }
  }

  // Global keybindings (Escape closes open modals)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeRefViewer();
      closeSkillCreator();
    }
  });

  // --------------------------------------------------------------------------
  // 10. INITIALIZATION
  // --------------------------------------------------------------------------
  loadStatus();
  loadParameters();
  loadSessions();
  loadActivityHistory();
  connectLiveEvents();
});
