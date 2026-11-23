import { byId, escapeHtml, formatMarkdown } from './utils.js';

const DEFAULT_TOOL_CODE = `export const skill = {
  name: 'custom_tool',
  description: 'Custom tool description',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input parameter' }
    },
    required: ['input']
  },
  async execute(args, context) {
    return {
      success: true,
      message: 'Executed custom tool successfully',
      args
    };
  }
};
`;

export function initModals({ loadSkills }: { loadSkills: () => Promise<void> }) {
  const refViewerModal = byId('refViewerModal');
  const refViewerSkillTag = byId('refViewerSkillTag');
  const refViewerTitle = byId('refViewerTitle');
  const refViewerContent = byId('refViewerContent');
  const copyRefContentBtn = byId<HTMLButtonElement>('copyRefContentBtn');
  const copyRefBtnText = byId('copyRefBtnText');
  const closeRefViewerBtn = byId<HTMLButtonElement>('closeRefViewerBtn');
  let currentRefRawContent = '';

  const openCreateSkillModalBtn = byId<HTMLButtonElement>('openCreateSkillModalBtn');
  const skillCreatorModal = byId('skillCreatorModal');
  const closeSkillCreatorBtn = byId<HTMLButtonElement>('closeSkillCreatorBtn');
  const cancelSkillCreatorBtn = byId<HTMLButtonElement>('cancelSkillCreatorBtn');
  const createSkillForm = byId<HTMLFormElement>('createSkillForm');
  const selectTypeWorkflow = byId<HTMLButtonElement>('selectTypeWorkflow');
  const selectTypeTool = byId<HTMLButtonElement>('selectTypeTool');
  const newSkillName = byId<HTMLInputElement>('newSkillName');
  const newSkillDescription = byId<HTMLInputElement>('newSkillDescription');
  const workflowFieldsContainer = byId('workflowFieldsContainer');
  const toolFieldsContainer = byId('toolFieldsContainer');
  const newSkillPrompt = byId<HTMLTextAreaElement>('newSkillPrompt');
  const newSkillCode = byId<HTMLTextAreaElement>('newSkillCode');
  const skillCreatorStatusMsg = byId('skillCreatorStatusMsg');
  const submitCreateSkillBtn = byId<HTMLButtonElement>('submitCreateSkillBtn');
  let activeCreateSkillType = 'workflow';

  async function openRefViewer(skillName: string, refName: string) {
    if (!refViewerModal) return;
    try {
      if (refViewerSkillTag) refViewerSkillTag.textContent = skillName;
      if (refViewerTitle) refViewerTitle.textContent = refName;
      if (refViewerContent) refViewerContent.innerHTML = '<p style="color:var(--text-muted)">Loading reference runbook...</p>';
      currentRefRawContent = '';
      refViewerModal.style.display = 'flex';

      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/references/${encodeURIComponent(refName)}`);
      const data = await res.json();
      if (data.success && data.content) {
        currentRefRawContent = data.content;
        refViewerContent.innerHTML = formatMarkdown(data.content);
      } else {
        refViewerContent.innerHTML = `<p style="color:var(--accent-red)">Failed to load reference: ${escapeHtml(data.error || 'Unknown error')}</p>`;
      }
    } catch (err: any) {
      if (refViewerContent) {
        refViewerContent.innerHTML = `<p style="color:var(--accent-red)">Error loading reference: ${escapeHtml(err?.message || err)}</p>`;
      }
    }
  }

  function closeRefViewer() {
    if (refViewerModal) refViewerModal.style.display = 'none';
    currentRefRawContent = '';
  }

  if (closeRefViewerBtn) closeRefViewerBtn.addEventListener('click', closeRefViewer);
  if (refViewerModal) {
    refViewerModal.addEventListener('click', (e) => {
      if (e.target === refViewerModal) closeRefViewer();
    });
  }

  if (copyRefContentBtn) {
    copyRefContentBtn.addEventListener('click', async () => {
      if (!currentRefRawContent) return;
      try {
        await navigator.clipboard.writeText(currentRefRawContent);
        if (copyRefBtnText) copyRefBtnText.textContent = 'Copied!';
        setTimeout(() => {
          if (copyRefBtnText) copyRefBtnText.textContent = 'Copy';
        }, 1500);
      } catch (_) {}
    });
  }

  function openSkillCreator() {
    if (!skillCreatorModal) return;
    activeCreateSkillType = 'workflow';
    selectTypeWorkflow?.classList.add('active');
    selectTypeTool?.classList.remove('active');
    if (workflowFieldsContainer) workflowFieldsContainer.style.display = 'block';
    if (toolFieldsContainer) toolFieldsContainer.style.display = 'none';
    if (createSkillForm) createSkillForm.reset();
    if (newSkillCode) newSkillCode.value = DEFAULT_TOOL_CODE;
    if (skillCreatorStatusMsg) {
      skillCreatorStatusMsg.textContent = '';
      skillCreatorStatusMsg.className = 'modal-footer-msg';
    }
    if (submitCreateSkillBtn) {
      submitCreateSkillBtn.disabled = false;
      submitCreateSkillBtn.textContent = 'Create & Register';
    }
    skillCreatorModal.style.display = 'flex';
    if (newSkillName) newSkillName.focus();
  }

  function closeSkillCreator() {
    if (skillCreatorModal) skillCreatorModal.style.display = 'none';
  }

  if (openCreateSkillModalBtn) openCreateSkillModalBtn.addEventListener('click', openSkillCreator);
  if (closeSkillCreatorBtn) closeSkillCreatorBtn.addEventListener('click', closeSkillCreator);
  if (cancelSkillCreatorBtn) cancelSkillCreatorBtn.addEventListener('click', closeSkillCreator);
  if (skillCreatorModal) {
    skillCreatorModal.addEventListener('click', (e) => {
      if (e.target === skillCreatorModal) closeSkillCreator();
    });
  }

  if (selectTypeWorkflow) {
    selectTypeWorkflow.addEventListener('click', () => {
      activeCreateSkillType = 'workflow';
      selectTypeWorkflow.classList.add('active');
      selectTypeTool?.classList.remove('active');
      if (workflowFieldsContainer) workflowFieldsContainer.style.display = 'block';
      if (toolFieldsContainer) toolFieldsContainer.style.display = 'none';
      if (newSkillName) newSkillName.placeholder = 'e.g. summarize-doc';
    });
  }

  if (selectTypeTool) {
    selectTypeTool.addEventListener('click', () => {
      activeCreateSkillType = 'tool';
      selectTypeTool.classList.add('active');
      selectTypeWorkflow?.classList.remove('active');
      if (workflowFieldsContainer) workflowFieldsContainer.style.display = 'none';
      if (toolFieldsContainer) toolFieldsContainer.style.display = 'block';
      if (newSkillName) newSkillName.placeholder = 'e.g. query-database';
      if (newSkillCode && !newSkillCode.value.trim()) {
        newSkillCode.value = DEFAULT_TOOL_CODE;
      }
    });
  }

  if (createSkillForm) {
    createSkillForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (newSkillName?.value || '').trim().toLowerCase();
      const description = (newSkillDescription?.value || '').trim();
      const prompt = (newSkillPrompt?.value || '').trim();
      const code = (newSkillCode?.value || '').trim();

      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        if (skillCreatorStatusMsg) {
          skillCreatorStatusMsg.textContent = 'Name must contain only letters, numbers, and hyphens';
          skillCreatorStatusMsg.className = 'modal-footer-msg error';
        }
        return;
      }

      if (submitCreateSkillBtn) {
        submitCreateSkillBtn.disabled = true;
        submitCreateSkillBtn.textContent = 'Creating...';
      }
      if (skillCreatorStatusMsg) {
        skillCreatorStatusMsg.textContent = '';
        skillCreatorStatusMsg.className = 'modal-footer-msg';
      }

      try {
        const res = await fetch('/api/skills/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: activeCreateSkillType,
            name,
            description,
            prompt,
            code
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          if (skillCreatorStatusMsg) {
            skillCreatorStatusMsg.textContent = `Skill '${data.name}' registered successfully!`;
            skillCreatorStatusMsg.className = 'modal-footer-msg success';
          }
          await loadSkills();
          setTimeout(() => {
            closeSkillCreator();
          }, 800);
        } else {
          if (skillCreatorStatusMsg) {
            skillCreatorStatusMsg.textContent = data.error || 'Failed to create skill';
            skillCreatorStatusMsg.className = 'modal-footer-msg error';
          }
          if (submitCreateSkillBtn) {
            submitCreateSkillBtn.disabled = false;
            submitCreateSkillBtn.textContent = 'Create & Register';
          }
        }
      } catch (err: any) {
        if (skillCreatorStatusMsg) {
          skillCreatorStatusMsg.textContent = err?.message || String(err);
          skillCreatorStatusMsg.className = 'modal-footer-msg error';
        }
        if (submitCreateSkillBtn) {
          submitCreateSkillBtn.disabled = false;
          submitCreateSkillBtn.textContent = 'Create & Register';
        }
      }
    });
  }

  return { openRefViewer, closeRefViewer, closeSkillCreator };
}

export function initRoutingModal() {
  const pillBtn = byId<HTMLButtonElement>('routingStatusPillBtn');
  const pillDot = byId('routingPillDot');
  const pillLabel = byId('routingPillLabel');
  const pillMeta = byId('routingPillMeta');

  const modal = byId('routingConfigModal');
  const modalDot = byId('routingModalDot');
  const closeBtn = byId<HTMLButtonElement>('closeRoutingModalBtn');
  const doneBtn = byId<HTMLButtonElement>('doneRoutingModalBtn');
  const enabledToggle = byId<HTMLInputElement>('routingEnabledToggle');
  const autoHandoffToggle = byId<HTMLInputElement>('routingAutoHandoffToggle');
  const maxRetriesSelect = byId<HTMLSelectElement>('routingMaxRetriesSelect');
  const statCalls = byId('routingStatCalls');
  const statFallbacks = byId('routingStatFallbacks');
  const statRetries = byId('routingStatRetries');
  const statCost = byId('routingStatCost');
  const fallbackList = byId('routingFallbackList');
  const providersList = byId('routingProvidersList');
  const statusMsg = byId('routingModalStatusMsg');

  let editingEnv: string | null = null;

  function setStatusMessage(text: string, kind: 'success' | 'error' | '' = '') {
    if (!statusMsg) return;
    statusMsg.textContent = text;
    statusMsg.className = kind ? `modal-footer-msg ${kind}` : 'modal-footer-msg';
  }

  function applyDotClass(el: HTMLElement | null, state: 'healthy' | 'warn' | 'off') {
    if (!el) return;
    el.classList.remove('healthy', 'warn', 'off');
    el.classList.add(state);
  }

  function renderRoutingData(data: any) {
    const enabled = data.enabled !== false;
    const chain: any[] = Array.isArray(data.fallbackChain) ? data.fallbackChain : [];
    const readyCount = chain.filter((c) => c.ready).length;
    const hasMissing = chain.some((c) => !c.ready);
    const fallbacks = Number(data.stats?.fallbacks || 0);

    const dotState: 'healthy' | 'warn' | 'off' = !enabled
      ? 'off'
      : (hasMissing || fallbacks > 0 ? 'warn' : 'healthy');

    applyDotClass(pillDot, dotState);
    applyDotClass(modalDot, dotState);

    if (pillLabel) {
      pillLabel.textContent = enabled ? 'Routing: Auto' : 'Routing: Off';
    }
    if (pillMeta) {
      pillMeta.textContent = enabled
        ? `${readyCount}/${chain.length} ready`
        : (data.activeProvider || 'manual');
    }
    if (pillBtn) {
      pillBtn.title = enabled
        ? `Auto-Failover enabled (${readyCount}/${chain.length} targets ready, ${fallbacks} fallbacks)`
        : 'Auto-Failover disabled';
    }

    if (enabledToggle) enabledToggle.checked = enabled;
    if (autoHandoffToggle) autoHandoffToggle.checked = data.autoHandoffOnContextLimit !== false;
    if (maxRetriesSelect) maxRetriesSelect.value = String(data.maxRetries ?? 1);

    if (statCalls) statCalls.textContent = String(data.stats?.totalCalls ?? 0);
    if (statFallbacks) statFallbacks.textContent = String(fallbacks);
    if (statRetries) statRetries.textContent = String(data.stats?.retries ?? 0);
    if (statCost) {
      const cost = Number(data.stats?.estimatedCostUsd || 0);
      statCost.textContent = `$${cost.toFixed(4)}`;
    }

    if (fallbackList) {
      if (chain.length === 0) {
        fallbackList.innerHTML = '<div class="routing-chain-item"><span style="color:var(--text-muted)">No fallback chain configured.</span></div>';
      } else {
        fallbackList.innerHTML = chain
          .map((item, idx) => {
            const badgeClass = item.isLocal ? 'local' : (item.ready ? 'ready' : 'missing');
            return `
              <div class="routing-chain-item">
                <div class="routing-chain-left">
                  <span class="routing-chain-idx">${idx + 1}.</span>
                  <span class="routing-chain-provider">${escapeHtml(item.provider)}</span>
                  <span class="routing-chain-model">${escapeHtml(item.model)}</span>
                </div>
                <span class="routing-badge ${badgeClass}">${escapeHtml(item.reason)}</span>
              </div>
            `;
          })
          .join('');
      }
    }

    const hasActiveEditInput = Boolean(editingEnv && providersList?.querySelector(`[data-env-input="${editingEnv}"]`));
    if (providersList && !hasActiveEditInput) {
      const providers: any[] = Array.isArray(data.providers) ? data.providers : [];
      providersList.innerHTML = providers
        .map((prov) => {
          const isEditing = Boolean(prov.apiKeyEnv && editingEnv === prov.apiKeyEnv);
          const subText = prov.isLocal
            ? (prov.baseUrl || prov.model || 'Local runtime')
            : `${prov.apiKeyEnv || 'API Key'}: ${prov.hasKey ? prov.maskedKey : 'Not set'}`;
          const badgeClass = prov.isLocal ? 'local' : (prov.hasKey ? 'ready' : 'missing');
          const badgeText = prov.isLocal ? 'Local' : (prov.hasKey ? 'Configured' : 'Missing');

          const actionsHtml = prov.apiKeyEnv
            ? isEditing
              ? `
                <input type="password" class="routing-key-input" data-env-input="${escapeHtml(prov.apiKeyEnv)}" placeholder="Paste ${escapeHtml(prov.apiKeyEnv)}..." autocomplete="off" />
                <button type="button" class="btn-sm primary-sm" data-save-env="${escapeHtml(prov.apiKeyEnv)}">Save</button>
                <button type="button" class="btn-sm ghost-sm" data-cancel-env="1">Cancel</button>
              `
              : `
                <span class="routing-badge ${badgeClass}">${badgeText}</span>
                <button type="button" class="btn-sm ghost-sm" data-edit-env="${escapeHtml(prov.apiKeyEnv)}">${prov.hasKey ? 'Edit' : 'Add'}</button>
              `
            : `<span class="routing-badge ${badgeClass}">${badgeText}</span>`;

          return `
            <div class="routing-provider-row">
              <div class="routing-provider-meta">
                <span class="routing-provider-name">${escapeHtml(prov.id)}</span>
                <span class="routing-provider-sub">${escapeHtml(subText)}</span>
              </div>
              <div class="routing-provider-actions">${actionsHtml}</div>
            </div>
          `;
        })
        .join('');
    }
  }

  async function refreshRouting() {
    try {
      const res = await fetch('/api/routing');
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) renderRoutingData(data);
    } catch (_) {}
  }

  async function saveRoutingPatch(patch: Record<string, any>) {
    setStatusMessage('Saving...');
    try {
      const res = await fetch('/api/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatusMessage('Routing settings saved.', 'success');
        await refreshRouting();
      } else {
        setStatusMessage(data.error || 'Failed to update routing settings', 'error');
      }
    } catch (err: any) {
      setStatusMessage(err?.message || String(err), 'error');
    }
  }

  function openModal() {
    if (!modal) return;
    editingEnv = null;
    setStatusMessage('');
    modal.style.display = 'flex';
    void refreshRouting();
  }

  function closeModal() {
    if (modal) modal.style.display = 'none';
    editingEnv = null;
  }

  if (pillBtn) pillBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (doneBtn) doneBtn.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  if (enabledToggle) {
    enabledToggle.addEventListener('change', () => {
      void saveRoutingPatch({ enabled: enabledToggle.checked });
    });
  }
  if (autoHandoffToggle) {
    autoHandoffToggle.addEventListener('change', () => {
      void saveRoutingPatch({ autoHandoffOnContextLimit: autoHandoffToggle.checked });
    });
  }
  if (maxRetriesSelect) {
    maxRetriesSelect.addEventListener('change', () => {
      void saveRoutingPatch({ maxRetries: Number(maxRetriesSelect.value) });
    });
  }

  if (providersList) {
    providersList.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const editBtn = target.closest('[data-edit-env]') as HTMLElement | null;
      if (editBtn) {
        editingEnv = editBtn.getAttribute('data-edit-env');
        await refreshRouting();
        const input = providersList.querySelector(`[data-env-input="${editingEnv}"]`) as HTMLInputElement | null;
        if (input) input.focus();
        return;
      }

      if (target.closest('[data-cancel-env]')) {
        editingEnv = null;
        setStatusMessage('');
        await refreshRouting();
        return;
      }

      const saveBtn = target.closest('[data-save-env]') as HTMLElement | null;
      if (saveBtn) {
        const envName = saveBtn.getAttribute('data-save-env');
        if (!envName) return;
        const input = providersList.querySelector(`[data-env-input="${envName}"]`) as HTMLInputElement | null;
        const apiKey = input ? input.value.trim() : '';
        setStatusMessage(`Saving ${envName}...`);
        try {
          const res = await fetch('/api/providers/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKeyEnv: envName, apiKey })
          });
          const data = await res.json();
          if (res.ok && data.success) {
            editingEnv = null;
            setStatusMessage(`${envName} ${data.hasKey ? 'saved to .env' : 'cleared'}.`, 'success');
            await refreshRouting();
          } else {
            setStatusMessage(data.error || `Failed to save ${envName}`, 'error');
          }
        } catch (err: any) {
          setStatusMessage(err?.message || String(err), 'error');
        }
      }
    });
  }

  void refreshRouting();
  return { refreshRouting, openRoutingModal: openModal, closeRoutingModal: closeModal };
}
