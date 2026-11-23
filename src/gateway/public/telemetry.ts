import { byId, escapeHtml } from './utils.js';
import { renderVectorHitHtml, renderStatusNotice, renderErrorMessage, type VectorHitViewModel } from './components.js';

export function initTelemetry() {
  const liveActivityFeed = byId('liveActivityFeed');
  const clearActivityLogBtn = byId<HTMLButtonElement>('clearActivityLogBtn');
  const sysActivityTimeline = byId('sysActivityTimeline');

  const longTermMemoryEditor = byId<HTMLTextAreaElement>('longTermMemoryEditor');
  const saveMemoryBtn = byId<HTMLButtonElement>('saveMemoryBtn');
  const dailyJournalViewer = byId('dailyJournalViewer');
  const vectorCountBadge = byId('vectorCountBadge');
  const reindexVectorsBtn = byId<HTMLButtonElement>('reindexVectorsBtn');
  const vectorSearchInput = byId<HTMLInputElement>('vectorSearchInput');
  const vectorSearchMode = byId<HTMLSelectElement>('vectorSearchMode');
  const vectorSearchBtn = byId<HTMLButtonElement>('vectorSearchBtn');
  const vectorSearchResults = byId('vectorSearchResults');

  const activityEntries: any[] = [];

  function formatActivitySummary(entry: any): string {
    const d = entry.data || {};
    switch (entry.type) {
      case 'start':
        return `Task started: "${(d.prompt || '').slice(0, 55)}"`;
      case 'step_start':
        return `Step ${d.step}/${d.maxSteps} [${d.provider || entry.provider}:${d.model || entry.model}]`;
      case 'thought':
        return `Thought (Step ${d.step}): ${(d.content || '').slice(0, 75)}`;
      case 'tool_start':
        return `Calling tool ${d.name}(${JSON.stringify(d.args || {}).slice(0, 50)})`;
      case 'tool_end':
        return `Tool ${d.name} ${d.success !== false ? 'succeeded' : 'failed'} (${d.durationMs || 0}ms)`;
      case 'retry':
        return `Retry #${d.attempt} on ${d.provider}/${d.model}: ${d.reason}`;
      case 'fallback':
        return `Failover: ${d.fromProvider}/${d.fromModel} → ${d.toProvider}/${d.toModel} (${d.reasonType})`;
      case 'error':
        return `Error: ${d.error}`;
      case 'done':
        return `Completed in ${d.totalSteps || 1} step(s)${d.fallbackUsed ? ' [Failover Used]' : ''}`;
      default:
        return `${entry.type}`;
    }
  }

  function renderActivityFeeds() {
    const renderItems = (limit = 25) => {
      if (activityEntries.length === 0) {
        return '<div class="activity-empty">Listening for real-time agent events...</div>';
      }
      return activityEntries
        .slice(0, limit)
        .map((e) => {
          const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour12: false }) : '';
          const badgeClass = `act-badge act-${escapeHtml(e.type)}`;
          return `
            <div class="activity-item">
              <div class="activity-item-top">
                <span class="${badgeClass}">${escapeHtml(e.type.toUpperCase())}</span>
                <span class="activity-time">${escapeHtml(time)}</span>
              </div>
              <div class="activity-summary">${escapeHtml(formatActivitySummary(e))}</div>
            </div>
          `;
        })
        .join('');
    };

    if (liveActivityFeed) liveActivityFeed.innerHTML = renderItems(25);
    if (sysActivityTimeline) sysActivityTimeline.innerHTML = renderItems(40);
  }

  function appendActivityLogEntry(entry: any) {
    activityEntries.unshift(entry);
    if (activityEntries.length > 80) activityEntries.pop();
    renderActivityFeeds();
  }

  async function loadActivityHistory() {
    try {
      const res = await fetch('/api/activity');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.activities)) {
        activityEntries.length = 0;
        for (const item of [...data.activities].reverse()) {
          activityEntries.push(item);
        }
        renderActivityFeeds();
      }
    } catch (_) {}
  }

  if (clearActivityLogBtn) {
    clearActivityLogBtn.addEventListener('click', () => {
      activityEntries.length = 0;
      renderActivityFeeds();
    });
  }

  async function loadMemory() {
    try {
      const res = await fetch('/api/memory');
      const data = await res.json();
      if (longTermMemoryEditor) longTermMemoryEditor.value = data.longTerm || '';
      if (dailyJournalViewer) dailyJournalViewer.textContent = data.daily || 'No entries logged yet for today.';
      if (vectorCountBadge && data.vectorStats) {
        vectorCountBadge.textContent = `${data.vectorStats.totalVectors || 0} vectors (${data.vectorStats.dimension || 256}d)`;
      }
    } catch (e) {
      console.error('Failed to load memory', e);
    }
  }

  async function runVectorSearch() {
    if (!vectorSearchInput || !vectorSearchResults) return;
    const q = vectorSearchInput.value.trim();
    if (!q) {
      vectorSearchResults.style.display = 'none';
      return;
    }
    const mode = vectorSearchMode ? vectorSearchMode.value : 'hybrid';
    vectorSearchResults.style.display = 'block';
    vectorSearchResults.innerHTML = renderStatusNotice('Searching vector embeddings...');

    try {
      const res = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}&topK=8`);
      const data = await res.json();
      if (vectorCountBadge && data.vectorStats) {
        vectorCountBadge.textContent = `${data.vectorStats.totalVectors || 0} vectors (${data.vectorStats.dimension || 256}d)`;
      }
      if (!data.results || data.results.length === 0) {
        vectorSearchResults.innerHTML = renderStatusNotice(`No matching memories found for "${q}".`);
        return;
      }
      vectorSearchResults.innerHTML = (data.results as VectorHitViewModel[])
        .map((r) => renderVectorHitHtml(r))
        .join('');
    } catch (err: unknown) {
      vectorSearchResults.innerHTML = renderErrorMessage('Search failed', err);
    }
  }

  if (vectorSearchBtn) {
    vectorSearchBtn.addEventListener('click', runVectorSearch);
  }
  if (vectorSearchInput) {
    vectorSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runVectorSearch();
      }
    });
  }
  if (reindexVectorsBtn) {
    reindexVectorsBtn.addEventListener('click', async () => {
      reindexVectorsBtn.textContent = 'Indexing...';
      try {
        const res = await fetch('/api/memory/reindex', { method: 'POST' });
        const data = await res.json();
        if (data.vectorStats && vectorCountBadge) {
          vectorCountBadge.textContent = `${data.vectorStats.totalVectors || 0} vectors (${data.vectorStats.dimension || 256}d)`;
        }
        reindexVectorsBtn.textContent = 'Re-indexed!';
        setTimeout(() => (reindexVectorsBtn.textContent = 'Re-index'), 1500);
      } catch (_) {
        reindexVectorsBtn.textContent = 'Re-index';
      }
    });
  }

  if (saveMemoryBtn) {
    saveMemoryBtn.addEventListener('click', async () => {
      saveMemoryBtn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: longTermMemoryEditor.value })
        });
        if (res.ok) {
          saveMemoryBtn.textContent = 'Saved!';
          setTimeout(() => (saveMemoryBtn.textContent = 'Save Changes'), 1500);
        } else {
          alert('Failed to save memory.');
          saveMemoryBtn.textContent = 'Save Changes';
        }
      } catch (e: any) {
        alert(`Error saving memory: ${e?.message || e}`);
        saveMemoryBtn.textContent = 'Save Changes';
      }
    });
  }

  return {
    appendActivityLogEntry,
    loadActivityHistory,
    loadMemory
  };
}
