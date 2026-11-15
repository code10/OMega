export interface ParametersPanelElements {
  systemPromptInput: HTMLTextAreaElement | null;
  saveSystemPromptBtn: HTMLButtonElement | null;
  tempSlider: HTMLInputElement | null;
  tempValBadge: HTMLElement | null;
}

export function initParametersPanel(elements: ParametersPanelElements) {
  const { systemPromptInput, saveSystemPromptBtn, tempSlider, tempValBadge } = elements;
  let savedSystemPromptValue = '';

  async function loadParameters() {
    try {
      const res = await fetch('/api/system-prompt');
      if (res.ok) {
        const data = await res.json();
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

  if (systemPromptInput && saveSystemPromptBtn) {
    systemPromptInput.addEventListener('input', () => {
      const isDirty = systemPromptInput.value !== savedSystemPromptValue;
      saveSystemPromptBtn.style.display = isDirty ? 'inline-flex' : 'none';
    });

    saveSystemPromptBtn.addEventListener('click', async () => {
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
