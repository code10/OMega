import { bindCollapsibleToggle, escapeHtml, formatMarkdown } from './utils.js';

export interface TraceRendererDeps {
  messagesContainer: HTMLElement;
  topLoadedModel: HTMLElement | null;
  inputModelTag: HTMLElement | null;
  updateModelUsageBar: () => void;
}

export interface StreamState {
  thoughts: Array<{ step: number; content: string }>;
  tools: Array<{ id: string; name: string; args: any; status: string; durationMs?: number; result?: any }>;
  fallbacks: any[];
}

export function initTraceRenderer(deps: TraceRendererDeps) {
  const { messagesContainer, topLoadedModel, inputModelTag, updateModelUsageBar } = deps;

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function appendCopyAction(parentEl: HTMLElement, getTextFn: () => string, timestamp: number | string = Date.now()) {
    if (!parentEl) return;
    const ts = timestamp ? new Date(timestamp).getTime() : Date.now();
    const resolvedTs = Number.isFinite(ts) ? ts : Date.now();
    const actionsRow = document.createElement('div');
    actionsRow.className = 'msg-actions-row';

    const timeLabel = document.createElement('span');
    timeLabel.className = 'msg-time-label';
    const timeDate = new Date(resolvedTs);
    timeLabel.textContent = timeDate.toLocaleTimeString();
    timeLabel.title = timeDate.toLocaleString();

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = 'Copy text';
    copyBtn.setAttribute('aria-label', 'Copy text');
    const copySvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const checkSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    copyBtn.innerHTML = copySvg;

    copyBtn.addEventListener('click', async () => {
      const textToCopy = String(typeof getTextFn === 'function' ? getTextFn() : '');
      if (!textToCopy) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(textToCopy);
        } else {
          const ta = document.createElement('textarea');
          ta.value = textToCopy;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        copyBtn.innerHTML = checkSvg;
        copyBtn.classList.add('copied');
        copyBtn.title = 'Copied!';
        setTimeout(() => {
          copyBtn.innerHTML = copySvg;
          copyBtn.classList.remove('copied');
          copyBtn.title = 'Copy text';
        }, 1500);
      } catch (_) { }
    });

    actionsRow.appendChild(timeLabel);
    actionsRow.appendChild(copyBtn);
    parentEl.appendChild(actionsRow);
  }

  function appendUserMessage(text: string, attachments: any[] = [], timestamp: number | string = Date.now()) {
    const row = document.createElement('div');
    row.className = 'message-row user-msg';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (attachments && attachments.length > 0) {
      const attWrap = document.createElement('div');
      attWrap.className = 'msg-attachments-wrap';
      attWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;';
      attachments.forEach((att) => {
        const chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex; align-items:center; gap:5px; font-size:0.72rem; padding:3px 8px; border-radius:6px; background:rgba(242,236,224,0.08); border:1px solid rgba(242,236,224,0.15); font-family:var(--font-mono); color:var(--text-primary);';
        const iconSvg = att.isFolder
          ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'
          : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
        chip.innerHTML = `<span style="display:inline-flex;align-items:center;">${iconSvg}</span> <span>${escapeHtml(att.name)}</span>`;
        attWrap.appendChild(chip);
      });
      bubble.appendChild(attWrap);
    }

    if (text) {
      const textSpan = document.createElement('div');
      textSpan.textContent = text;
      bubble.appendChild(textSpan);
    }

    row.appendChild(bubble);
    if (text) {
      appendCopyAction(row, () => text, timestamp);
    }
    messagesContainer.appendChild(row);
    scrollToBottom();
  }

  function createAgentMessageContainer(modelName?: string) {
    const row = document.createElement('div');
    row.className = 'message-row agent-msg';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const resolvedModel =
      (modelName && modelName !== 'unknown' ? modelName : '') ||
      (topLoadedModel && topLoadedModel.textContent) ||
      (inputModelTag && inputModelTag.textContent) ||
      'OM Agent';

    const header = document.createElement('div');
    header.className = 'agent-header-row';
    header.innerHTML = `
      <span class="agent-header-chip">${escapeHtml(resolvedModel)}</span>
    `;
    bubble.appendChild(header);

    row.appendChild(bubble);
    return { row, bubble };
  }

  function handleAgentEvent(
    event: string,
    data: any,
    container: HTMLElement,
    runningBadge: HTMLElement,
    streamState: StreamState = { thoughts: [], tools: [], fallbacks: [] }
  ) {
    if (!streamState.fallbacks) streamState.fallbacks = [];

    let liveTraceWrap = container.querySelector('.live-trace-wrap');
    if (!liveTraceWrap && (event === 'thought' || event === 'tool_start' || event === 'fallback' || event === 'retry')) {
      liveTraceWrap = document.createElement('div');
      liveTraceWrap.className = 'live-trace-wrap';
      if (runningBadge && runningBadge.parentNode === container) {
        container.insertBefore(liveTraceWrap, runningBadge);
      } else {
        container.appendChild(liveTraceWrap);
      }
    }

    if (event === 'step_start') {
      const badgeText = runningBadge ? runningBadge.querySelector('.running-status-text') : null;
      if (badgeText) {
        badgeText.textContent = data.step > 1 ? 'Reasoning...' : 'Thinking...';
      }
      return;
    }

    if (event === 'retry') {
      const badgeText = runningBadge ? runningBadge.querySelector('.running-status-text') : null;
      if (badgeText) badgeText.textContent = `Retrying (${data.attempt}/${data.maxRetries})...`;
      return;
    }

    if (event === 'fallback') {
      streamState.fallbacks.push(data);
      const badgeText = runningBadge ? runningBadge.querySelector('.running-status-text') : null;
      if (badgeText) badgeText.textContent = `Handed off to ${data.toProvider} (${data.toModel})...`;
      if (liveTraceWrap) {
        const fbPill = document.createElement('div');
        fbPill.className = 'fallback-trace-banner';
        fbPill.innerHTML = `⇄ <strong>Model Failover:</strong> Handed off from <code>${escapeHtml(data.fromModel)}</code> to <code>${escapeHtml(data.toModel)}</code> (${escapeHtml(data.reasonType || 'failover')})`;
        liveTraceWrap.appendChild(fbPill);
      }
      return;
    }

    if (event === 'thought' && data.content) {
      streamState.thoughts.push({ step: data.step, content: data.content });
      const badgeText = runningBadge ? runningBadge.querySelector('.running-status-text') : null;
      if (badgeText) badgeText.textContent = `Step ${data.step || 1} — Reasoning...`;
      return;
    }

    if (event === 'tool_start') {
      const toolEntry = { id: data.id, name: data.name, args: data.args, status: 'running' };
      streamState.tools.push(toolEntry);
      const badgeText = runningBadge ? runningBadge.querySelector('.running-status-text') : null;
      if (badgeText) badgeText.textContent = `Executing tool: ${data.name}...`;

      if (liveTraceWrap) {
        const toolCard = document.createElement('div');
        toolCard.className = 'tool-trace-card collapsed';
        toolCard.dataset.toolId = data.id;
        toolCard.innerHTML = `
          <div class="tool-trace-header">
            <div class="tool-trace-left">
              <span class="tool-trace-status running-dot"></span>
              <span class="tool-name-badge">${escapeHtml(data.name)}</span>
              <span class="tool-args-preview">${escapeHtml(JSON.stringify(data.args || {}).slice(0, 65))}</span>
            </div>
            <div class="tool-trace-right">
              <span class="tool-duration" data-dur-id="${escapeHtml(data.id)}">Running...</span>
              <span class="tool-trace-chevron">▶</span>
            </div>
          </div>
          <div class="tool-trace-body" style="display: none;">
            <div class="tool-trace-section-label">Arguments:</div>
            <pre class="tool-trace-code">${escapeHtml(JSON.stringify(data.args || {}, null, 2))}</pre>
            <div class="tool-trace-section-label">Output:</div>
            <pre class="tool-trace-code" data-out-id="${escapeHtml(data.id)}">Waiting for execution result...</pre>
          </div>
        `;
        bindCollapsibleToggle(toolCard, '.tool-trace-header', '.tool-trace-chevron', '.tool-trace-body');
        liveTraceWrap.appendChild(toolCard);
        scrollToBottom();
      }
      return;
    }

    if (event === 'tool_end') {
      const tool = streamState.tools.find((t) => t.id === data.id);
      if (tool) {
        tool.durationMs = data.durationMs;
        tool.result = data.result;
        tool.status = data.result?.success === false ? 'failed' : 'done';
      }
      if (liveTraceWrap) {
        const card = liveTraceWrap.querySelector(`[data-tool-id="${CSS.escape(data.id)}"]`);
        if (card) {
          const isOk = data.result?.success !== false;
          card.classList.add(isOk ? 'tool-success' : 'tool-fail');
          const dot = card.querySelector('.tool-trace-status');
          if (dot) {
            dot.className = `tool-trace-status ${isOk ? 'ok-dot' : 'err-dot'}`;
          }
          const durEl = card.querySelector(`[data-dur-id="${CSS.escape(data.id)}"]`);
          if (durEl) durEl.textContent = `${data.durationMs ?? 0}ms`;
          const outEl = card.querySelector(`[data-out-id="${CSS.escape(data.id)}"]`);
          if (outEl) {
            const formattedOut = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
            outEl.textContent = formattedOut.length > 2000 ? formattedOut.slice(0, 2000) + '\n... [truncated]' : formattedOut;
          }
        }
      }
      return;
    }

    if (event === 'error') {
      if (runningBadge && runningBadge.parentNode) runningBadge.remove();
      const errBox = document.createElement('div');
      errBox.className = 'error-box';
      errBox.style.cssText = 'color: var(--accent-red); margin-top: 8px; padding: 10px; background: rgba(239, 68, 68, 0.1); border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.2); font-size: 0.9rem;';
      errBox.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><strong>Error:</strong> ${escapeHtml(data.error || 'Agent encountered an error')}`;
      container.appendChild(errBox);
      scrollToBottom();
      return;
    }

    if (event === 'done') {
      if (runningBadge && runningBadge.parentNode) runningBadge.remove();

      const usedModel = data.model || '';
      const firstFallback = (Array.isArray(data.fallbackEvents) && data.fallbackEvents[0]) || (streamState.fallbacks && streamState.fallbacks[0]);
      if (usedModel) {
        const chip = container.querySelector('.agent-header-chip');
        if (chip) chip.textContent = usedModel;
      }

      if (streamState.thoughts.length > 0) {
        const thoughtBox = document.createElement('div');
        thoughtBox.className = 'thought-box collapsed';
        thoughtBox.innerHTML = `
          <div class="thought-header">
            <span class="thought-title"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"></path><line x1="9" y1="21" x2="15" y2="21"></line></svg>Reasoning (${streamState.thoughts.length} step${streamState.thoughts.length > 1 ? 's' : ''})</span>
            <span class="thought-chevron">▶</span>
          </div>
          <div class="thought-body" style="display:none;">
            ${streamState.thoughts.map((t) => `<div class="thought-step-entry"><div class="thought-step-label">Step ${t.step}</div><div class="thought-step-content">${escapeHtml(t.content)}</div></div>`).join('')}
          </div>
        `;

        bindCollapsibleToggle(thoughtBox);

        if (liveTraceWrap) {
          liveTraceWrap.insertBefore(thoughtBox, liveTraceWrap.firstChild);
        } else {
          container.appendChild(thoughtBox);
        }
      }

      const answer = document.createElement('div');
      answer.className = 'final-markdown-response';
      answer.innerHTML = formatMarkdown(data.content || 'Task completed.');
      container.appendChild(answer);

      if (usedModel && firstFallback && firstFallback.fromModel && firstFallback.fromModel !== usedModel) {
        const attrEl = document.createElement('div');
        attrEl.className = 'agent-model-attribution';
        attrEl.style.cssText = 'margin-top: 8px; font-size: 0.72rem; color: var(--text-muted, #8b949e); font-family: var(--font-mono, monospace); opacity: 0.85;';
        attrEl.textContent = `Requested: ${firstFallback.fromModel} → Answered by: ${usedModel}`;
        container.appendChild(attrEl);
      }
      appendCopyAction(container, () => data.content || '', data.timestamp);
      scrollToBottom();
      updateModelUsageBar();
    }
  }

  return {
    scrollToBottom,
    appendCopyAction,
    appendUserMessage,
    createAgentMessageContainer,
    handleAgentEvent
  };
}
