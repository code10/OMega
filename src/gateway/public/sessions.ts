import { bindCollapsibleToggle, escapeHtml, formatMarkdown } from './utils.js';

export interface SessionsDeps {
  sessionsListContainer: HTMLElement | null;
  sessionSearchInput: HTMLInputElement | null;
  topbarSessionTag: HTMLElement | null;
  messagesContainer: HTMLElement;
  resetSessionsCounterBtn: HTMLButtonElement | null;
  appendUserMessage: (text: string, attachments?: any[], timestamp?: number | string) => void;
  createAgentMessageContainer: (modelName?: string) => { row: HTMLElement; bubble: HTMLElement };
  appendCopyAction: (parentEl: HTMLElement, getTextFn: () => string, timestamp?: number | string) => void;
  scrollToBottom: () => void;
  updateModelUsageBar: () => void;
  clearAttachments: () => void;
}

export function initSessions(deps: SessionsDeps) {
  const {
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
    clearAttachments
  } = deps;

  async function loadSessions() {
    if (!sessionsListContainer) return;
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) return;
      const data = await res.json();
      if (data.currentSessionId && topbarSessionTag) {
        topbarSessionTag.textContent = data.currentSessionId;
      }
      renderSessionsList(data.sessions || [], data.currentSessionId);
    } catch (_) { }
  }

  function renderSessionsList(sessions: any[], currentId?: string) {
    if (!sessionsListContainer) return;
    const query = (sessionSearchInput?.value || '').trim().toLowerCase();
    const activeId = currentId || (topbarSessionTag?.textContent || '').trim();

    const filtered = sessions.filter((s: any) => {
      if (!query) return true;
      return (
        s.sessionId.toLowerCase().includes(query) ||
        (s.title && s.title.toLowerCase().includes(query)) ||
        (s.firstTask && s.firstTask.toLowerCase().includes(query))
      );
    });

    sessionsListContainer.innerHTML = '';
    if (filtered.length === 0) {
      sessionsListContainer.innerHTML = '<div style="padding:14px; text-align:center; font-size:0.75rem; color:var(--text-muted);">No sessions yet</div>';
      return;
    }

    for (const s of filtered) {
      const isCurrent = s.sessionId === activeId;
      const item = document.createElement('div');
      item.className = `session-item ${isCurrent ? 'active' : ''}`;
      item.dataset.sessionId = s.sessionId;

      const title = s.title || s.sessionId;
      const dateStr = s.timestamp ? new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

      item.innerHTML = `
        <div class="session-item-left">
          <div class="session-title-row">
            <span class="session-name">${escapeHtml(title)}</span>
            ${isCurrent ? '<span class="session-active-pill">ACTIVE</span>' : ''}
          </div>
          <span class="session-date">${escapeHtml(dateStr || (s.isNew ? 'Fresh turn' : s.sessionId))}</span>
        </div>
      `;

      item.addEventListener('click', () => switchSession(s.sessionId));
      sessionsListContainer.appendChild(item);
    }
  }

  async function switchSession(sessionId: string) {
    try {
      const res = await fetch('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      if (res.ok) {
        const data = await res.json();
        if (topbarSessionTag) topbarSessionTag.textContent = data.session?.title || sessionId;
        renderLoadedSession(data.session);
        await loadSessions();
      }
    } catch (e) {
      console.error('Failed to switch session', e);
    }
  }

  function renderLoadedSession(session: any) {
    messagesContainer.innerHTML = '';
    if (!session || !session.history || session.history.length === 0) {
      if (session?.prompt) {
        appendUserMessage(session.prompt, [], session.timestamp);
      }
      if (session?.finalResponse) {
        const sessionModel =
          (session.model && session.model !== 'unknown' ? session.model : undefined) ||
          session.answers?.[0]?.model;
        const { row, bubble } = createAgentMessageContainer(sessionModel);
        messagesContainer.appendChild(row);
        const answer = document.createElement('div');
        answer.className = 'final-markdown-response';
        answer.innerHTML = formatMarkdown(session.finalResponse);
        bubble.appendChild(answer);
        const ansMeta = session.answers?.[0];
        const reqModel = ansMeta?.fallbackEvents?.[0]?.fromModel || ansMeta?.requestedModel || session.requestedModel;
        const actualModel = ansMeta?.model || sessionModel;
        if (reqModel && actualModel && reqModel !== actualModel) {
          const attrEl = document.createElement('div');
          attrEl.className = 'agent-model-attribution';
          attrEl.style.cssText = 'margin-top: 8px; font-size: 0.72rem; color: var(--text-muted, #8b949e); font-family: var(--font-mono, monospace); opacity: 0.85;';
          attrEl.textContent = `Requested: ${reqModel} → Answered by: ${actualModel}`;
          bubble.appendChild(attrEl);
        }
        appendCopyAction(bubble, () => session.finalResponse, session.timestamp);
      }
      return;
    }

    const totalHistoryAsst = session.history.filter(
      (m: any) => m.role === 'assistant' && !(m.toolCalls && m.toolCalls.length > 0)
    ).length;
    const answerOffset = Math.max(0, (session.answers?.length || 0) - totalHistoryAsst);
    let pendingReasoning: string[] = [];
    let assistantAnswerIdx = 0;
    for (const msg of session.history) {
      if (msg.role === 'user') {
        pendingReasoning = [];
        if (typeof msg.content === 'string' && msg.content.startsWith('[Compacted Earlier Context')) {
          const compactCard = document.createElement('div');
          compactCard.className = 'thought-box collapsed';
          compactCard.style.margin = '4px 0 10px 0';
          const firstLine = msg.content.split('\n')[0];
          compactCard.innerHTML = `
            <div class="thought-header">
              <span class="thought-title">${escapeHtml(firstLine)}</span>
              <span class="thought-chevron">▶</span>
            </div>
            <div class="thought-body" style="display:none;white-space:pre-wrap;">${escapeHtml(msg.content)}</div>
          `;
          bindCollapsibleToggle(compactCard);
          messagesContainer.appendChild(compactCard);
        } else {
          appendUserMessage(msg.content, [], msg.timestamp || session.timestamp);
        }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          if (msg.content) pendingReasoning.push(msg.content);
          continue;
        }
        const ansMeta = session.answers?.[answerOffset + assistantAnswerIdx];
        const answerModel =
          msg.model ||
          ansMeta?.model ||
          (session.model && session.model !== 'unknown' ? session.model : undefined);
        assistantAnswerIdx++;
        const { row, bubble } = createAgentMessageContainer(answerModel);
        messagesContainer.appendChild(row);
        if (pendingReasoning.length > 0) {
          const thoughtBox = document.createElement('div');
          thoughtBox.className = 'thought-box collapsed';
          thoughtBox.innerHTML = `
            <div class="thought-header">
              <span class="thought-title"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"></path><line x1="9" y1="21" x2="15" y2="21"></line></svg>Reasoning...</span>
              <span class="thought-chevron">▶</span>
            </div>
            <div class="thought-body" style="display:none;">${pendingReasoning.map((r) => `<div class="thought-step-entry">${escapeHtml(r)}</div>`).join('')}</div>
          `;
          bindCollapsibleToggle(thoughtBox);
          bubble.appendChild(thoughtBox);
          pendingReasoning = [];
        }
        const answer = document.createElement('div');
        answer.className = 'final-markdown-response';
        answer.innerHTML = formatMarkdown(msg.content);
        bubble.appendChild(answer);
        const reqModel = ansMeta?.fallbackEvents?.[0]?.fromModel || ansMeta?.requestedModel || session.requestedModel;
        const actualModel = ansMeta?.model || answerModel;
        if (reqModel && actualModel && reqModel !== actualModel) {
          const attrEl = document.createElement('div');
          attrEl.className = 'agent-model-attribution';
          attrEl.style.cssText = 'margin-top: 8px; font-size: 0.72rem; color: var(--text-muted, #8b949e); font-family: var(--font-mono, monospace); opacity: 0.85;';
          attrEl.textContent = `Requested: ${reqModel} → Answered by: ${actualModel}`;
          bubble.appendChild(attrEl);
        }
        appendCopyAction(bubble, () => msg.content || '', msg.timestamp || session.timestamp);
      }
    }
    scrollToBottom();
    updateModelUsageBar();
  }

  async function clearChatPage() {
    try {
      const res = await fetch('/api/clear', { method: 'POST' });
      const data = await res.json();
      const currentId = data.sessionId || (topbarSessionTag ? topbarSessionTag.textContent : 'session_1');
      if (topbarSessionTag) topbarSessionTag.textContent = currentId;
      messagesContainer.innerHTML = `
        <div class="welcome-card">
          <h2>OMega</h2>
          <p>Page cleared.</p>
        </div>
      `;
      clearAttachments();
      await loadSessions();
      updateModelUsageBar();
    } catch (_) {
      messagesContainer.innerHTML = `
        <div class="welcome-card">
          <h2>OMega</h2>
          <p>Page cleared.</p>
        </div>
      `;
      updateModelUsageBar();
    }
  }

  async function resetSession() {
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      const data = await res.json();
      if (topbarSessionTag) topbarSessionTag.textContent = data.sessionId || 'session_1';
      messagesContainer.innerHTML = `
        <div class="welcome-card">
          <h2>New Session</h2>
          <p>Context reset.</p>
        </div>
      `;
      await loadSessions();
      updateModelUsageBar();
    } catch (_) { }
  }

  if (sessionSearchInput) {
    sessionSearchInput.addEventListener('input', loadSessions);
  }

  if (resetSessionsCounterBtn) {
    resetSessionsCounterBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const confirmed = confirm('Delete all conversation sessions and restart session counter from 1?\n\nThis will clear all saved session logs and start fresh at session_1.');
      if (!confirmed) return;

      try {
        const res = await fetch('/api/sessions/reset-counter', { method: 'POST' });
        if (!res.ok) {
          const errText = await res.text();
          let errMsg = errText;
          try {
            const errObj = JSON.parse(errText);
            errMsg = errObj.error || errText;
          } catch (_) {}
          alert(`Failed to reset sessions: ${errMsg}`);
          return;
        }
        const data = await res.json();
        if (data.success) {
          if (topbarSessionTag) topbarSessionTag.textContent = data.sessionId || 'session_1';
          messagesContainer.innerHTML = `
            <div class="welcome-card">
              <h2>New Session</h2>
              <p>Context reset. All previous sessions cleared.</p>
            </div>
          `;
          await loadSessions();
          updateModelUsageBar();
        } else {
          alert(data.error || 'Failed to reset sessions');
        }
      } catch (err: any) {
        alert(`Error resetting sessions: ${err?.message || err}`);
      }
    });
  }

  return {
    loadSessions,
    renderSessionsList,
    switchSession,
    renderLoadedSession,
    clearChatPage,
    resetSession
  };
}
