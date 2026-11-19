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
  let html = escapeHtml(text).replace(/\r\n/g, '\n');

  // 1. Protect fenced code blocks and inline code from markdown transforms
  const codeBlocks: string[] = [];
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
    const idx = codeBlocks.length;
    const cls = lang ? ` class="lang-${lang}"` : '';
    codeBlocks.push(`<pre><code${cls}>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000CODEBLOCK_${idx}\u0000`;
  });

  const inlineCodes: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_: string, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `\u0000INLINECODE_${idx}\u0000`;
  });

  // 2. Render Markdown tables before paragraph/line splitting
  html = html.replace(
    /^(\|.+\|)\n(\|[ \t:|-]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_: string, headerLine: string, _sepLine: string, bodyBlock: string) => {
      const splitRow = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

      const headers = splitRow(headerLine)
        .map((h) => `<th>${h}</th>`)
        .join('');
      const rows = bodyBlock
        .trim()
        .split('\n')
        .filter((r) => r.trim().startsWith('|'))
        .map((r) => `<tr>${splitRow(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('');
      return `\n<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
    }
  );

  // 3. Horizontal rules
  html = html.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '<hr class="md-hr">');

  // 4. Headings (h6 -> h1)
  html = html.replace(/^######[ \t]+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####[ \t]+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####[ \t]+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###[ \t]+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##[ \t]+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#[ \t]+(.+)$/gm, '<h1>$1</h1>');

  // 5. Blockquotes
  html = html.replace(/(?:^&gt;[ \t]?(.*)$\n?)+/gm, (block: string) => {
    const inner = block
      .trim()
      .split('\n')
      .map((l) => l.replace(/^&gt;[ \t]?/, ''))
      .join('<br>');
    return `<blockquote>${inner}</blockquote>\n`;
  });

  // 6. Unordered (- / * / +) and Ordered (1.) lists
  html = html.replace(/(?:^[ \t]*[-*+][ \t]+.+$\n?)+/gm, (block: string) => {
    const items = block
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^[ \t]*[-*+][ \t]+/, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>\n`;
  });

  html = html.replace(/(?:^[ \t]*\d+\.[ \t]+.+$\n?)+/gm, (block: string) => {
    const items = block
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^[ \t]*\d+\.[ \t]+/, '')}</li>`)
      .join('');
    return `<ol>${items}</ol>\n`;
  });

  // 7. Links (safe http/https only), Bold, Italic
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*\w])\*([^*\n][\s\S]*?[^*\n]?)\*(?!\*)/g, '$1<em>$2</em>');

  // 8. Paragraphs
  html = html
    .split(/\n{2,}/)
    .map((p: string) => {
      p = p.trim();
      if (!p) return '';
      if (/^<(?:pre|ul|ol|h[1-6]|hr|blockquote|div\b|table\b|\u0000CODEBLOCK_)/i.test(p)) {
        return p;
      }
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .filter(Boolean)
    .join('');

  // 9. Restore inline code & fenced code blocks
  html = html.replace(/\u0000INLINECODE_(\d+)\u0000/g, (_: string, i: string) => inlineCodes[Number(i)] ?? '');
  html = html.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_: string, i: string) => codeBlocks[Number(i)] ?? '');

  return html;
}
