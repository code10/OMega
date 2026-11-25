import { escapeHtml } from './utils.js';

export interface PluginCatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: 'builtin' | 'mcp';
  icon: string;
  accentColor: string;
  defaultTransport?: 'stdio' | 'http';
  defaultCommand?: string;
  defaultArgs?: string[];
  defaultUrl?: string;
  fields?: Array<{
    key: string;
    label: string;
    placeholder?: string;
    secret?: boolean;
    required?: boolean;
    defaultValue?: string;
  }>;
  docsHint?: string;
}

export interface ConnectedPluginItem {
  id: string;
  name: string;
  description: string;
  kind: 'builtin' | 'mcp';
  category: string;
  icon: string;
  accentColor: string;
  enabled: boolean;
  connected: boolean;
  status: 'connected' | 'disabled' | 'offline';
  toolCount: number;
  lastError?: string;
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

export interface PluginsDeps {
  skillsCountBadge: HTMLElement | null;
  setServerContextUsage: (usage: any) => void;
  closeOtherPopovers: () => void;
  onPluginsUpdated?: (state: { connected: ConnectedPluginItem[]; catalog: PluginCatalogItem[] }, fromMutation: boolean) => void;
}

function getPluginIconSvg(icon: string, accentColor = 'currentColor'): string {
  const c = escapeHtml(accentColor);
  switch (icon) {
    case 'file-text':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
    case 'clock':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 15"></polyline></svg>`;
    case 'github':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>`;
    case 'gitlab':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"></path></svg>`;
    case 'figma':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z"></path><path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z"></path><path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z"></path><path d="M5 19.5A3.5 3.5 0 0 1 8.5 16H12v3.5a3.5 3.5 0 1 1-7 0z"></path><path d="M5 12.5A3.5 3.5 0 0 1 8.5 9H12v7H8.5A3.5 3.5 0 0 1 5 12.5z"></path></svg>`;
    case 'discord':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;
    case 'slack':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="13" y="2" width="3" height="8" rx="1.5"></rect><path d="M19 8.5V10h1.5A1.5 1.5 0 1 0 19 8.5"></path><rect x="8" y="14" width="3" height="8" rx="1.5"></rect><path d="M5 15.5V14H3.5A1.5 1.5 0 1 0 5 15.5"></path><rect x="14" y="13" width="8" height="3" rx="1.5"></rect><path d="M15.5 19H14v1.5a1.5 1.5 0 1 0 1.5-1.5"></path><rect x="2" y="8" width="8" height="3" rx="1.5"></rect><path d="M8.5 5H10V3.5A1.5 1.5 0 1 0 8.5 5"></path></svg>`;
    case 'google':
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><polyline points="3 8 12 13 21 8"></polyline></svg>`;
    default:
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path></svg>`;
  }
}

export function initPlugins(deps: PluginsDeps) {
  const { skillsCountBadge, setServerContextUsage, closeOtherPopovers, onPluginsUpdated } = deps;

  const pluginsWrap = document.getElementById('pluginsMenuWrap');
  const pluginsTriggerBtn = document.getElementById('pluginsTriggerBtn') as HTMLButtonElement | null;
  const pluginsCountBadge = document.getElementById('pluginsCountBadge');
  const pluginsPopover = document.getElementById('pluginsPopover');
  const pluginsConnectedList = document.getElementById('pluginsConnectedList');
  const pluginsConnectFlyoutTrigger = document.getElementById('pluginsConnectFlyoutTrigger') as HTMLButtonElement | null;
  const pluginsCatalogSubmenu = document.getElementById('pluginsCatalogSubmenu');
  const pluginsCatalogList = document.getElementById('pluginsCatalogList');

  // Connect Modal elements
  const pluginConnectModal = document.getElementById('pluginConnectModal');
  const pluginModalTitle = document.getElementById('pluginModalTitle');
  const pluginModalSubtitle = document.getElementById('pluginModalSubtitle');
  const closePluginModalBtn = document.getElementById('closePluginModalBtn');
  const cancelPluginModalBtn = document.getElementById('cancelPluginModalBtn');
  const pluginConnectForm = document.getElementById('pluginConnectForm') as HTMLFormElement | null;
  const pluginIdInput = document.getElementById('pluginIdInput') as HTMLInputElement | null;
  const pluginNameInput = document.getElementById('pluginNameInput') as HTMLInputElement | null;
  const pluginCustomNameRow = document.getElementById('pluginCustomNameRow');
  const pluginTransportSelect = document.getElementById('pluginTransportSelect') as HTMLSelectElement | null;
  const pluginStdioFields = document.getElementById('pluginStdioFields');
  const pluginHttpFields = document.getElementById('pluginHttpFields');
  const pluginCommandInput = document.getElementById('pluginCommandInput') as HTMLInputElement | null;
  const pluginArgsInput = document.getElementById('pluginArgsInput') as HTMLInputElement | null;
  const pluginUrlInput = document.getElementById('pluginUrlInput') as HTMLInputElement | null;
  const pluginDynamicFields = document.getElementById('pluginDynamicFields');
  const pluginModalStatusMsg = document.getElementById('pluginModalStatusMsg');
  const submitPluginConnectBtn = document.getElementById('submitPluginConnectBtn') as HTMLButtonElement | null;

  let connectedPlugins: ConnectedPluginItem[] = [];
  let catalogPlugins: PluginCatalogItem[] = [];
  let activeCatalogTarget: PluginCatalogItem | null = null;

  function applyServerSync(data: any, fromMutation = false) {
    if (Array.isArray(data?.connected)) connectedPlugins = data.connected;
    if (Array.isArray(data?.catalog)) catalogPlugins = data.catalog;
    if (skillsCountBadge && data?.skillsCount !== undefined) {
      skillsCountBadge.textContent = String(data.skillsCount);
    }
    if (data?.contextUsage !== undefined) {
      setServerContextUsage(data.contextUsage);
    }
    renderMenus();
    onPluginsUpdated?.({ connected: connectedPlugins, catalog: catalogPlugins }, fromMutation);
  }

  function closePluginsMenu() {
    if (pluginsPopover) pluginsPopover.classList.remove('open');
    if (pluginsCatalogSubmenu) pluginsCatalogSubmenu.classList.remove('open');
    if (pluginsTriggerBtn) {
      pluginsTriggerBtn.classList.remove('active');
      pluginsTriggerBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function openPluginsMenu() {
    closeOtherPopovers();
    if (pluginsPopover) pluginsPopover.classList.add('open');
    if (pluginsTriggerBtn) {
      pluginsTriggerBtn.classList.add('active');
      pluginsTriggerBtn.setAttribute('aria-expanded', 'true');
    }
    void loadPlugins();
  }

  function closePluginConnectModal() {
    if (pluginConnectModal) pluginConnectModal.style.display = 'none';
    if (pluginModalStatusMsg) {
      pluginModalStatusMsg.textContent = '';
      pluginModalStatusMsg.className = 'modal-footer-msg';
    }
    activeCatalogTarget = null;
  }

  function syncTransportFields() {
    const transport = pluginTransportSelect?.value || 'stdio';
    if (pluginStdioFields) pluginStdioFields.style.display = transport === 'stdio' ? 'block' : 'none';
    if (pluginHttpFields) pluginHttpFields.style.display = transport === 'http' ? 'block' : 'none';
  }

  function openPluginConnectModal(entry: PluginCatalogItem | null) {
    closePluginsMenu();
    activeCatalogTarget = entry;
    if (!pluginConnectModal) return;

    const isCustom = !entry;
    if (pluginModalTitle) {
      pluginModalTitle.textContent = isCustom ? 'Connect Custom MCP Server' : `Connect ${entry.name}`;
    }
    if (pluginModalSubtitle) {
      pluginModalSubtitle.textContent = isCustom
        ? 'Attach any local stdio or remote Streamable HTTP MCP server'
        : entry.description;
    }
    if (pluginCustomNameRow) {
      pluginCustomNameRow.style.display = isCustom ? 'flex' : 'none';
    }
    if (pluginIdInput) pluginIdInput.value = entry?.id || '';
    if (pluginNameInput) {
      pluginNameInput.value = entry?.name || '';
      pluginNameInput.required = isCustom;
    }

    const transport = entry?.defaultTransport || 'stdio';
    if (pluginTransportSelect) pluginTransportSelect.value = transport;
    if (pluginCommandInput) pluginCommandInput.value = entry?.defaultCommand || 'npx';
    if (pluginArgsInput) pluginArgsInput.value = (entry?.defaultArgs || []).join(' ');
    if (pluginUrlInput) pluginUrlInput.value = entry?.defaultUrl || '';
    syncTransportFields();

    if (pluginDynamicFields) {
      const fields = entry?.fields || [];
      if (fields.length === 0) {
        pluginDynamicFields.innerHTML = entry?.docsHint
          ? `<p class="form-help">${escapeHtml(entry.docsHint)}</p>`
          : '';
      } else {
        pluginDynamicFields.innerHTML = fields
          .map(
            (f) => `
          <div class="form-group">
            <label class="form-label" for="pluginField_${escapeHtml(f.key)}">
              ${escapeHtml(f.label)}${f.required ? ' <span class="required-star">*</span>' : ''}
            </label>
            <input
              type="${f.secret ? 'password' : 'text'}"
              id="pluginField_${escapeHtml(f.key)}"
              data-plugin-env-key="${escapeHtml(f.key)}"
              class="form-input"
              placeholder="${escapeHtml(f.placeholder || '')}"
              value="${escapeHtml(f.defaultValue || '')}"
              ${f.required ? 'required' : ''}
              autocomplete="off"
            />
          </div>`
          )
          .join('') + (entry?.docsHint ? `<p class="form-help">${escapeHtml(entry.docsHint)}</p>` : '');
      }
    }

    if (pluginModalStatusMsg) {
      pluginModalStatusMsg.textContent = '';
      pluginModalStatusMsg.className = 'modal-footer-msg';
    }

    pluginConnectModal.style.display = 'flex';
    const firstInput = pluginConnectModal.querySelector<HTMLInputElement>('input:not([type="hidden"]):not([style*="display: none"])');
    firstInput?.focus();
  }

  async function togglePlugin(id: string, enabled: boolean) {
    try {
      const res = await fetch('/api/plugins/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled })
      });
      const data = await res.json();
      if (res.ok) applyServerSync(data, true);
    } catch (_) {}
  }

  async function disconnectPlugin(id: string) {
    try {
      const res = await fetch('/api/plugins/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const data = await res.json();
      if (res.ok) applyServerSync(data, true);
    } catch (_) {}
  }

  async function quickConnectBuiltin(entry: PluginCatalogItem) {
    try {
      const res = await fetch('/api/plugins/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id, name: entry.name })
      });
      const data = await res.json();
      if (res.ok) applyServerSync(data, true);
    } catch (_) {}
  }

  function renderMenus() {
    const enabledCount = connectedPlugins.filter((p) => p.enabled).length;
    if (pluginsCountBadge) {
      if (enabledCount > 0) {
        pluginsCountBadge.textContent = String(enabledCount);
        pluginsCountBadge.hidden = false;
      } else {
        pluginsCountBadge.hidden = true;
      }
    }
    if (pluginsTriggerBtn) {
      pluginsTriggerBtn.classList.toggle('has-active', enabledCount > 0);
    }

    if (pluginsConnectedList) {
      if (connectedPlugins.length === 0) {
        pluginsConnectedList.innerHTML = `<div class="plugins-empty-hint">No plugins connected yet</div>`;
      } else {
        pluginsConnectedList.innerHTML = '';
        for (const p of connectedPlugins) {
          const row = document.createElement('div');
          row.className = `plugin-menu-row ${p.enabled ? 'enabled' : 'disabled'}`;
          const statusTitle =
            p.status === 'offline'
              ? p.lastError || 'Saved (MCP offline)'
              : p.enabled
                ? p.toolCount > 0
                  ? `Active (${p.toolCount} tools)`
                  : 'Active'
                : 'Disabled';

          row.innerHTML = `
            <div class="plugin-row-main" title="${escapeHtml(statusTitle)}">
              <span class="plugin-row-icon">${getPluginIconSvg(p.icon, p.accentColor)}</span>
              <span class="plugin-row-name">${escapeHtml(p.name)}</span>
              <span class="plugin-status-dot ${escapeHtml(p.status)}" aria-label="${escapeHtml(p.status)}"></span>
            </div>
            <div class="plugin-row-actions">
              <button type="button" class="plugin-toggle-pill ${p.enabled ? 'on' : ''}"
                aria-pressed="${p.enabled ? 'true' : 'false'}"
                aria-label="Toggle ${escapeHtml(p.name)}"
                title="${p.enabled ? 'Disable' : 'Enable'} ${escapeHtml(p.name)}">
                <span class="plugin-toggle-thumb"></span>
              </button>
              ${
                p.kind === 'mcp'
                  ? `<button type="button" class="plugin-disconnect-btn" aria-label="Disconnect ${escapeHtml(p.name)}" title="Disconnect ${escapeHtml(p.name)}">&times;</button>`
                  : ''
              }
            </div>
          `;

          row.querySelector('.plugin-toggle-pill')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void togglePlugin(p.id, !p.enabled);
          });
          row.querySelector('.plugin-disconnect-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void disconnectPlugin(p.id);
          });
          pluginsConnectedList.appendChild(row);
        }
      }
    }

    if (pluginsCatalogList) {
      const connectedIds = new Set(connectedPlugins.map((p) => p.id));
      pluginsCatalogList.innerHTML = '';

      for (const item of catalogPlugins) {
        const isConnected = connectedIds.has(item.id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `plugin-catalog-item ${isConnected ? 'is-connected' : ''}`;
        btn.title = item.description;
        btn.innerHTML = `
          <span class="plugin-row-icon">${getPluginIconSvg(item.icon, item.accentColor)}</span>
          <span class="plugin-catalog-name">${escapeHtml(item.name)}</span>
          <span class="plugin-catalog-action" aria-hidden="true">${isConnected ? '✓' : '+'}</span>
        `;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (item.kind === 'builtin') {
            if (isConnected) {
              const current = connectedPlugins.find((p) => p.id === item.id);
              void togglePlugin(item.id, !current?.enabled);
            } else {
              void quickConnectBuiltin(item);
            }
          } else {
            openPluginConnectModal(item);
          }
        });
        pluginsCatalogList.appendChild(btn);
      }

      const sep = document.createElement('div');
      sep.className = 'plugins-menu-sep';
      pluginsCatalogList.appendChild(sep);

      const customBtn = document.createElement('button');
      customBtn.type = 'button';
      customBtn.className = 'plugin-catalog-item plugin-catalog-custom';
      customBtn.innerHTML = `
        <span class="plugin-row-icon">${getPluginIconSvg('plug', 'var(--accent-primary)')}</span>
        <span class="plugin-catalog-name">Custom MCP Server</span>
        <span class="plugin-catalog-action" aria-hidden="true">+</span>
      `;
      customBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPluginConnectModal(null);
      });
      pluginsCatalogList.appendChild(customBtn);
    }
  }

  async function loadPlugins() {
    try {
      const res = await fetch('/api/plugins');
      if (!res.ok) return;
      const data = await res.json();
      applyServerSync(data);
    } catch (_) {}
  }

  // Event listeners
  if (pluginsTriggerBtn) {
    pluginsTriggerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pluginsPopover?.classList.contains('open')) {
        closePluginsMenu();
      } else {
        openPluginsMenu();
      }
    });
  }

  if (pluginsConnectFlyoutTrigger && pluginsCatalogSubmenu) {
    pluginsConnectFlyoutTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      pluginsCatalogSubmenu.classList.toggle('open');
    });
    pluginsConnectFlyoutTrigger.addEventListener('mouseenter', () => {
      pluginsCatalogSubmenu.classList.add('open');
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (pluginsWrap && !pluginsWrap.contains(target)) {
      closePluginsMenu();
    }
  });

  if (pluginTransportSelect) {
    pluginTransportSelect.addEventListener('change', syncTransportFields);
  }

  closePluginModalBtn?.addEventListener('click', closePluginConnectModal);
  cancelPluginModalBtn?.addEventListener('click', closePluginConnectModal);
  pluginConnectModal?.addEventListener('click', (e) => {
    if (e.target === pluginConnectModal) closePluginConnectModal();
  });

  if (pluginConnectForm) {
    pluginConnectForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitPluginConnectBtn) submitPluginConnectBtn.disabled = true;
      if (pluginModalStatusMsg) {
        pluginModalStatusMsg.textContent = 'Connecting plugin...';
        pluginModalStatusMsg.className = 'modal-footer-msg';
      }

      const env: Record<string, string> = {};
      pluginDynamicFields?.querySelectorAll<HTMLInputElement>('input[data-plugin-env-key]').forEach((inp) => {
        const k = inp.dataset.pluginEnvKey;
        if (k && inp.value.trim()) env[k] = inp.value.trim();
      });

      const transport = pluginTransportSelect?.value === 'http' ? 'http' : 'stdio';
      const payload: Record<string, any> = {
        id: activeCatalogTarget?.id || (pluginIdInput?.value || pluginNameInput?.value || '').trim(),
        name: (pluginNameInput?.value || activeCatalogTarget?.name || '').trim(),
        transport,
        env
      };

      if (transport === 'http') {
        payload.url = (pluginUrlInput?.value || '').trim();
      } else {
        payload.command = (pluginCommandInput?.value || '').trim();
        payload.args = (pluginArgsInput?.value || '').trim();
      }

      try {
        const res = await fetch('/api/plugins/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to connect plugin');
        }
        applyServerSync(data, true);
        if (data.warning && pluginModalStatusMsg) {
          pluginModalStatusMsg.textContent = data.warning;
          pluginModalStatusMsg.className = 'modal-footer-msg';
          setTimeout(() => closePluginConnectModal(), 1800);
        } else {
          closePluginConnectModal();
        }
      } catch (err: any) {
        if (pluginModalStatusMsg) {
          pluginModalStatusMsg.textContent = err?.message || 'Connection failed';
          pluginModalStatusMsg.className = 'modal-footer-msg error';
        }
      } finally {
        if (submitPluginConnectBtn) submitPluginConnectBtn.disabled = false;
      }
    });
  }

  return {
    loadPlugins,
    closePluginsMenu,
    closePluginConnectModal,
    openPluginConnectModal,
    togglePlugin,
    disconnectPlugin,
    quickConnectBuiltin,
    getPluginsState: () => ({ connected: connectedPlugins, catalog: catalogPlugins })
  };
}
