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

const gatewayToken = resolveGatewayToken();
if (gatewayToken) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith('/api/') || urlStr.startsWith(`${window.location.origin}/api/`)) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${gatewayToken}`);
      }
      return originalFetch(input, { ...init, headers });
    }
    return originalFetch(input, init);
  };
}

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
  const modelLoaderPill = byId('modelLoaderPill');
  const modelDropdownMenu = byId('modelDropdownMenu');
  const dropdownCloseBtn = byId<HTMLButtonElement>('dropdownCloseBtn');
  const topLoadedModel = byId('topLoadedModel');
  const topLoadedProvider = byId('topLoadedProvider');
  const modelQuickSearchInput = byId<HTMLInputElement>('modelQuickSearchInput');
  const modelQuickList = byId('modelQuickList');
  const gotoModelsTabBtn = byId<HTMLButtonElement>('gotoModelsTabBtn');
  const ejectModelBtn = byId<HTMLButtonElement>('ejectModelBtn');
  const newChatTopBtn = byId<HTMLButtonElement>('newChatTopBtn');
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
  const clearSessionBtn = byId<HTMLButtonElement>('clearSessionBtn');
  const inputModelTag = byId('inputModelTag');
  const inputModelSelectorBtn = byId<HTMLButtonElement>('inputModelSelectorBtn');
  const welcomeModelLabel = byId('welcomeModelLabel');

  // Cloud / Local Mode Toggle in input bar
  const chatModeCloudBtn = byId<HTMLButtonElement>('chatModeCloudBtn');
  const chatModeLocalBtn = byId<HTMLButtonElement>('chatModeLocalBtn');
  const inputModelTargetPill = byId('inputModelTargetPill');
  const dropdownScopeTabs = byId('dropdownScopeTabs');

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

  // Export Session Elements
  const exportDropdownWrap = byId('exportDropdownWrap');
  const exportChatBtn = byId<HTMLButtonElement>('exportChatBtn');
  const exportChatMenu = byId('exportChatMenu');
  const exportMarkdownBtn = byId<HTMLButtonElement>('exportMarkdownBtn');
  const exportJsonBtn = byId<HTMLButtonElement>('exportJsonBtn');

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
  function switchTab(tab: string) {
    activeTab = tab;
    railItems.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    tabPanes.forEach((p) => p.classList.remove('active'));

    let targetPane = null;
    if (tab === 'chat') targetPane = document.getElementById('paneChat');
    else if (tab === 'agents') targetPane = document.getElementById('paneAgents');
    else if (tab === 'models') targetPane = document.getElementById('paneModels');
    else if (tab === 'skills') targetPane = document.getElementById('paneSkills');
    else if (tab === 'memory') targetPane = document.getElementById('paneMemory');
    else if (tab === 'system') targetPane = document.getElementById('paneSystem');
    else if (tab === 'device') targetPane = document.getElementById('paneDevice');

    if (targetPane) targetPane.classList.add('active');
    if (viewTitle) viewTitle.textContent = TAB_NAMES[tab] || 'OM Agent Studio';

    if (tab === 'chat') loadSessions();
    if (tab === 'agents') loadAgents();
    if (tab === 'models') loadModels();
    if (tab === 'skills') loadSkills();
    else if (tab === 'memory') loadMemory();
    else if (tab === 'system') {
      loadStatus();
      loadModels();
      loadActivityHistory();
    }
    else if (tab === 'device') loadDeviceSpecs();
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
    modelLoaderPill,
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

  // Eject / Reload Button
  if (ejectModelBtn) {
    ejectModelBtn.addEventListener('click', async () => {
      if (confirm('Reload active model and start fresh session context?')) {
        await resetSession();
      }
    });
  }

  if (newChatTopBtn) {
    newChatTopBtn.addEventListener('click', async () => {
      await resetSession();
    });
  }

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
    if (welcomeModelLabel) welcomeModelLabel.textContent = `${mod} loaded`;

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

    if (specMemoryDir && data.memoryDir !== undefined) specMemoryDir.textContent = data.memoryDir;
    if (specWorkspaceDir && data.workspaceDir !== undefined) specWorkspaceDir.textContent = data.workspaceDir;

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
    card.innerHTML = `
      <div style="font-weight:600;color:#fbbf24;margin-bottom:6px;">Approval Required: ${escapeHtml(reqData.tool)}</div>
      <pre style="background:#09090b;padding:8px;border-radius:6px;overflow:auto;max-height:120px;font-size:12px;margin:0 0 10px 0;">${escapeHtml(detail)}</pre>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button data-act="deny" style="padding:6px 12px;border-radius:6px;border:1px solid #3f3f46;background:#27272a;color:#f4f4f5;cursor:pointer;">Deny</button>
        <button data-act="approve" style="padding:6px 12px;border-radius:6px;border:none;background:#10b981;color:#09090b;font-weight:600;cursor:pointer;">Approve</button>
      </div>
    `;
    const respond = async (approved: boolean) => {
      await fetch(`/api/approvals/${encodeURIComponent(reqData.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved })
      });
      card.remove();
    };
    card.querySelector('[data-act="approve"]')?.addEventListener('click', () => respond(true));
    card.querySelector('[data-act="deny"]')?.addEventListener('click', () => respond(false));
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
    clearSessionBtn,
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
  // 6. PARAMETERS SIDEBAR CONTROLS
  // --------------------------------------------------------------------------
  const { loadParameters } = initParametersPanel({
    systemPromptInput,
    saveSystemPromptBtn,
    tempSlider,
    tempValBadge
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
        body: JSON.stringify({ prompt: fullPrompt })
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

  // Export Chat Session Logic
  if (exportChatBtn && exportChatMenu) {
    exportChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShowing = exportChatMenu.classList.contains('show');
      if (isShowing) {
        exportChatMenu.classList.remove('show');
        exportChatBtn.classList.remove('active');
      } else {
        exportChatMenu.classList.add('show');
        exportChatBtn.classList.add('active');
      }
    });

    document.addEventListener('click', (e) => {
      if (exportDropdownWrap && !exportDropdownWrap.contains(e.target as Node)) {
        exportChatMenu.classList.remove('show');
        exportChatBtn.classList.remove('active');
      }
    });

    if (exportMarkdownBtn) {
      exportMarkdownBtn.addEventListener('click', () => {
        const sessionId = (topbarSessionTag?.textContent || 'session_1').trim();
        exportChatMenu.classList.remove('show');
        exportChatBtn.classList.remove('active');
        window.location.href = `/api/sessions/${encodeURIComponent(sessionId)}/export?format=markdown`;
      });
    }

    if (exportJsonBtn) {
      exportJsonBtn.addEventListener('click', () => {
        const sessionId = (topbarSessionTag?.textContent || 'session_1').trim();
        exportChatMenu.classList.remove('show');
        exportChatBtn.classList.remove('active');
        window.location.href = `/api/sessions/${encodeURIComponent(sessionId)}/export?format=json`;
      });
    }
  }

  // Global keybindings (Escape closes open modals)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeRefViewer();
      closeSkillCreator();
      if (exportChatMenu) {
        exportChatMenu.classList.remove('show');
        exportChatBtn?.classList.remove('active');
      }
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
