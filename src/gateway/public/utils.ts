export const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export function bindCollapsibleToggle(
  card: HTMLElement,
  headerSel = '.thought-header',
  chevronSel = '.thought-chevron',
  bodySel = '.thought-body'
): void {
  card.querySelector(headerSel)?.addEventListener('click', () => {
    card.classList.toggle('collapsed');
    const isCollapsed = card.classList.contains('collapsed');
    const chev = card.querySelector(chevronSel);
    const body = card.querySelector<HTMLElement>(bodySel);
    if (chev) chev.textContent = isCollapsed ? '▶' : '▼';
    if (body) body.style.display = isCollapsed ? 'none' : 'block';
  });
}

export function isLocalProviderName(providerName: string): boolean {
  const p = (providerName || '').toLowerCase();
  return ['lmstudio', 'vllm', 'om', 'omega', 'mock'].includes(p);
}

export const MODEL_LIMITS_MAP: Record<string, { input: number; output: number; displayName: string }> = {
  'om-v1': { input: 128000, output: 4096, displayName: 'OM v1' },
  'om-turbo': { input: 128000, output: 4096, displayName: 'OM Turbo' },
  'om-reasoning': { input: 128000, output: 8192, displayName: 'OM Reasoning' },
  'om-mock-v1': { input: 128000, output: 4096, displayName: 'OM v1' },
  'om-mock-turbo': { input: 128000, output: 4096, displayName: 'OM Turbo' },
  'om-mock-reasoning': { input: 128000, output: 8192, displayName: 'OM Reasoning' },
  'gemini-2.0-flash': { input: 1048576, output: 8192, displayName: 'Gemini 2.0 Flash' },
  'gemini-1.5-pro': { input: 2097152, output: 8192, displayName: 'Gemini 1.5 Pro' },
  'gemini-1.5-flash': { input: 1048576, output: 8192, displayName: 'Gemini 1.5 Flash' },
  'gpt-4o': { input: 128000, output: 4096, displayName: 'GPT-4o' },
  'gpt-4o-mini': { input: 128000, output: 16384, displayName: 'GPT-4o mini' },
  'o1': { input: 200000, output: 100000, displayName: 'o1' },
  'claude-3-5-sonnet': { input: 200000, output: 8192, displayName: 'Claude 3.5 Sonnet' },
  'claude-3-opus': { input: 200000, output: 4096, displayName: 'Claude 3 Opus' },
  'claude-3-haiku': { input: 200000, output: 4096, displayName: 'Claude 3 Haiku' }
};

export function formatTokens(count: number): string {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (count >= 1000) {
    return Math.round(count / 1000) + 'k';
  }
  return String(count);
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function escapeHtml(str: unknown): string {
  const s = typeof str === 'string' ? str : String(str ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMarkdown(text: string): string {
  if (!text) return '';
  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
    return `<pre><code class="lang-${lang}">${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // Bullet points
  html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Paragraphs
  html = html
    .split('\n\n')
    .map((p: string) => {
      p = p.trim();
      if (p.startsWith('<pre>') || p.startsWith('<ul>') || p.startsWith('<h')) return p;
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');

  return html;
}
