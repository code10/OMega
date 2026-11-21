export interface ParametersPanelElements {
  systemPromptInput: HTMLTextAreaElement | null;
  saveSystemPromptBtn: HTMLButtonElement | null;
  tempSlider: HTMLInputElement | null;
  tempValBadge: HTMLElement | null;
  onEffortLoaded?: (effort: 'low' | 'medium' | 'high') => void;
}

export function initParametersPanel(elements: ParametersPanelElements) {
  const { systemPromptInput, saveSystemPromptBtn, tempSlider, tempValBadge, onEffortLoaded } = elements;
  let savedSystemPromptValue = '';

  const sandboxModeLabels: Record<string, string> = {
    off: 'Off',
    auto: 'Auto',
    os: 'OS',
    container: 'Container'
  };

  function setSandboxDropdownValue(mode: string) {
    const dropdown = document.getElementById('permSandboxDropdown');
    const label = document.getElementById('permSandboxLabel');
    if (!dropdown) return;
    const normalized = mode in sandboxModeLabels ? mode : 'off';
    dropdown.dataset.value = normalized;
    if (label) label.textContent = sandboxModeLabels[normalized];
    dropdown.querySelectorAll<HTMLButtonElement>('.perm-dropdown-option').forEach((opt) => {
      const isSelected = opt.dataset.value === normalized;
      opt.classList.toggle('active', isSelected);
      opt.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
  }

  function setSandboxDropdownOpen(open: boolean) {
    const dropdown = document.getElementById('permSandboxDropdown');
    const trigger = document.getElementById('permSandboxTrigger');
    if (!dropdown || !trigger) return;
    dropdown.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function applyPermissionsToUI(perms: Record<string, any>) {
    const section = document.getElementById('machinePermissionsSection');
    if (!section || !perms) return;
    const checkboxes = section.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-perm]');
    checkboxes.forEach((cb) => {
      const key = cb.dataset.perm;
      if (key && typeof perms[key] === 'boolean') {
        cb.checked = perms[key];
      }
    });
    if (typeof perms.sandboxMode === 'string') {
      setSandboxDropdownValue(perms.sandboxMode);
    }
    const sandboxStrictCb = document.getElementById('permSandboxStrict') as HTMLInputElement | null;
    if (sandboxStrictCb) {
      sandboxStrictCb.disabled = !perms.sandboxMode || perms.sandboxMode === 'off';
    }
    const fullBtn = document.getElementById('grantFullMachineBtn');
    if (fullBtn) {
      const isFull = Boolean(perms.fullMachineAccess);
      fullBtn.classList.toggle('active', isFull);
      fullBtn.textContent = isFull ? 'Full Control On' : 'Full Control';
    }
  }

  async function updatePermissions(patch: Record<string, any>) {
    try {
      const res = await fetch('/api/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.permissions) applyPermissionsToUI(data.permissions);
      }
    } catch (_) { }
  }

  const permSection = document.getElementById('machinePermissionsSection');
  if (permSection) {
    permSection.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-perm]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.perm;
        if (key) updatePermissions({ [key]: cb.checked });
      });
    });
    const sandboxDropdown = document.getElementById('permSandboxDropdown');
    const sandboxTrigger = document.getElementById('permSandboxTrigger');
    if (sandboxDropdown && sandboxTrigger) {
      sandboxTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = sandboxDropdown.classList.contains('open');
        setSandboxDropdownOpen(!isOpen);
      });

      sandboxDropdown.querySelectorAll<HTMLButtonElement>('.perm-dropdown-option').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.value || 'off';
          setSandboxDropdownValue(val);
          setSandboxDropdownOpen(false);
          updatePermissions({ sandboxMode: val });
        });
      });

      sandboxDropdown.addEventListener('keydown', (e) => {
        const options = Array.from(sandboxDropdown.querySelectorAll<HTMLButtonElement>('.perm-dropdown-option'));
        if (e.key === 'Escape') {
          setSandboxDropdownOpen(false);
          sandboxTrigger.focus();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!sandboxDropdown.classList.contains('open')) {
            setSandboxDropdownOpen(true);
            const active = options.find((o) => o.classList.contains('active')) || options[0];
            active?.focus();
            return;
          }
          const idx = options.indexOf(document.activeElement as HTMLButtonElement);
          const nextIdx = e.key === 'ArrowDown'
            ? (idx + 1) % options.length
            : (idx - 1 + options.length) % options.length;
          options[nextIdx]?.focus();
        }
      });

      document.addEventListener('click', (e) => {
        if (!sandboxDropdown.contains(e.target as Node)) {
          setSandboxDropdownOpen(false);
        }
      });
    }
    const fullBtn = document.getElementById('grantFullMachineBtn');
    if (fullBtn) {
      fullBtn.addEventListener('click', () => {
        const nextFull = !fullBtn.classList.contains('active');
        updatePermissions({ fullMachineAccess: nextFull });
      });
    }
  }

  let lastFiniteMaxSteps = 50;

  function applyMaxStepsToUI(val: number) {
    const input = document.getElementById('maxStepsInput') as HTMLInputElement | null;
    const badge = document.getElementById('maxStepsBadge');
    const unlimBtn = document.getElementById('maxStepsUnlimitedBtn');
    const stepper = document.getElementById('maxStepsStepper');
    const isUnlimited = val === 0;
    if (val > 0) lastFiniteMaxSteps = val;
    if (input) input.value = String(val);
    if (badge) badge.textContent = isUnlimited ? 'Unlimited' : String(val);
    if (unlimBtn) {
      unlimBtn.classList.toggle('active', isUnlimited);
      unlimBtn.setAttribute('aria-pressed', isUnlimited ? 'true' : 'false');
    }
    if (stepper) stepper.classList.toggle('is-unlimited', isUnlimited);
  }

  async function saveMaxSteps(val: number) {
    const clamped = Math.max(0, Math.min(500, Math.round(val)));
    applyMaxStepsToUI(clamped);
    try {
      const res = await fetch('/api/system-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSteps: clamped })
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.maxSteps === 'number') applyMaxStepsToUI(data.maxSteps);
      }
    } catch (_) { }
  }

  const maxStepsInputEl = document.getElementById('maxStepsInput') as HTMLInputElement | null;
  if (maxStepsInputEl) {
    maxStepsInputEl.addEventListener('change', () => {
      const parsed = parseInt(maxStepsInputEl.value, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        saveMaxSteps(parsed);
      } else {
        applyMaxStepsToUI(lastFiniteMaxSteps);
      }
    });
  }
  const maxStepsDecBtn = document.getElementById('maxStepsDecBtn');
  if (maxStepsDecBtn) {
    maxStepsDecBtn.addEventListener('click', () => {
      const current = parseInt(maxStepsInputEl?.value || '50', 10);
      const base = Number.isFinite(current) ? current : lastFiniteMaxSteps;
      saveMaxSteps(Math.max(0, base - 5));
    });
  }
  const maxStepsIncBtn = document.getElementById('maxStepsIncBtn');
  if (maxStepsIncBtn) {
    maxStepsIncBtn.addEventListener('click', () => {
      const current = parseInt(maxStepsInputEl?.value || '0', 10);
      const base = Number.isFinite(current) ? current : 0;
      saveMaxSteps(Math.min(500, base + 5));
    });
  }
  const maxStepsUnlimitedBtn = document.getElementById('maxStepsUnlimitedBtn');
  if (maxStepsUnlimitedBtn) {
    maxStepsUnlimitedBtn.addEventListener('click', () => {
      const isCurrentlyUnlimited = maxStepsUnlimitedBtn.classList.contains('active');
      const next = isCurrentlyUnlimited ? (lastFiniteMaxSteps > 0 ? lastFiniteMaxSteps : 50) : 0;
      saveMaxSteps(next);
    });
  }

  async function loadParameters() {
    try {
      const [promptRes, permRes] = await Promise.all([
        fetch('/api/system-prompt'),
        fetch('/api/permissions')
      ]);
      if (promptRes.ok) {
        const data = await promptRes.json();
        if (systemPromptInput && typeof data.systemPrompt === 'string') {
          systemPromptInput.value = data.systemPrompt;
          savedSystemPromptValue = data.systemPrompt;
        }
        if (saveSystemPromptBtn) {
          saveSystemPromptBtn.style.display = 'none';
        }
        if (tempSlider && data.temperature !== undefined) {
          const tempStr = String(data.temperature);
          tempSlider.value = tempStr;
          if (tempValBadge) tempValBadge.textContent = tempStr;
        }
        if (onEffortLoaded && (data.effort === 'low' || data.effort === 'medium' || data.effort === 'high')) {
          onEffortLoaded(data.effort);
        }
        if (typeof data.maxSteps === 'number') {
          applyMaxStepsToUI(data.maxSteps);
        }
      }
      if (permRes.ok) {
        const permData = await permRes.json();
        if (permData.permissions) applyPermissionsToUI(permData.permissions);
      }
    } catch (_) { }
  }

  if (tempSlider) {
    tempSlider.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (tempValBadge) tempValBadge.textContent = target.value;
    });
    tempSlider.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const parsed = parseFloat(target.value);
      if (!Number.isFinite(parsed)) return;
      try {
        const res = await fetch('/api/system-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ temperature: parsed })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.temperature !== undefined) {
            const tempStr = String(data.temperature);
            target.value = tempStr;
            if (tempValBadge) tempValBadge.textContent = tempStr;
          }
        }
      } catch (_) { }
    });
  }

  const systemPromptSection = document.getElementById('systemPromptSection');
  const systemPromptToggle = document.getElementById('systemPromptToggle');
  const systemPromptBody = document.getElementById('systemPromptBody');
  if (systemPromptSection && systemPromptToggle && systemPromptBody) {
    const toggleSystemPrompt = () => {
      const nextOpen = !systemPromptSection.classList.contains('open');
      systemPromptSection.classList.toggle('open', nextOpen);
      systemPromptToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      systemPromptBody.hidden = !nextOpen;
      if (nextOpen) systemPromptInput?.focus();
    };
    systemPromptToggle.addEventListener('click', toggleSystemPrompt);
    systemPromptToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSystemPrompt();
      }
    });
  }

  if (systemPromptInput && saveSystemPromptBtn) {
    systemPromptInput.addEventListener('input', () => {
      const isDirty = systemPromptInput.value !== savedSystemPromptValue;
      saveSystemPromptBtn.style.display = isDirty ? 'inline-flex' : 'none';
    });

    saveSystemPromptBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      saveSystemPromptBtn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/system-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemPrompt: systemPromptInput.value })
        });
        if (res.ok) {
          savedSystemPromptValue = systemPromptInput.value;
          saveSystemPromptBtn.textContent = 'Saved!';
          setTimeout(() => {
            saveSystemPromptBtn.textContent = 'Save';
            if (systemPromptInput.value === savedSystemPromptValue) {
              saveSystemPromptBtn.style.display = 'none';
            }
          }, 1200);
        } else {
          saveSystemPromptBtn.textContent = 'Save';
        }
      } catch (_) {
        saveSystemPromptBtn.textContent = 'Save';
      }
    });
  }

  return { loadParameters };
}
