import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGateway } from '../dist/gateway/server.js';
import { formatMarkdown } from '../dist/gateway/public/utils.js';

const TMP_DIR = path.resolve('./tests/tmp_frontend_integrity');

test('Frontend HTML partials, CSS modules, and DOM IDs integrity', async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    workspaceDir: TMP_DIR,
    memoryDir: path.join(TMP_DIR, '.mem'),
    provider: 'om',
    model: 'om-turbo'
  });

  try {
    const port = gw.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Verify GET / renders all 8 partials
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();

    const requiredIds = [
      'paneChat',
      'paneAgents',
      'paneModels',
      'paneSkills',
      'paneMemory',
      'paneSystem',
      'paneDevice',
      'refViewerModal',
      'skillCreatorModal',
      'routingConfigModal'
    ];
    for (const id of requiredIds) {
      assert.ok(html.includes(`id="${id}"`), `Rendered HTML missing #${id}`);
    }

    // 2. Verify styles.css and all @import CSS modules return 200 OK
    const cssRes = await fetch(`${baseUrl}/styles.css`);
    assert.equal(cssRes.status, 200);
    const cssManifest = await cssRes.text();
    const importMatches = [...cssManifest.matchAll(/@import\s+url\(['"]\.\/([^'"]+)['"]\)/g)];
    assert.ok(importMatches.length >= 6, `Expected >= 6 CSS @imports, got ${importMatches.length}`);

    for (const match of importMatches) {
      const modRes = await fetch(`${baseUrl}/${match[1]}`);
      assert.equal(modRes.status, 200, `CSS module /${match[1]} failed with ${modRes.status}`);
      const modText = await modRes.text();
      assert.ok(modText.trim().length > 0, `CSS module /${match[1]} is empty`);
    }

    // 3. Verify static DOM IDs referenced via byId(...) or getElementById(...) in app.ts and agents.ts exist in HTML
    const optionalLegacyIds = new Set([
      'modelLoaderPill',
      'ejectModelBtn',
      'newChatTopBtn',
      'clearSessionBtn',
      'welcomeModelLabel',
      'omApprovalContainer'
    ]);
    const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
    for (const tsFile of ['src/gateway/public/app.ts', 'src/gateway/public/agents.ts']) {
      const src = fs.readFileSync(path.resolve(tsFile), 'utf8');
      const idRefs = [
        ...src.matchAll(/\bbyId(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...src.matchAll(/document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)
      ].map((m) => m[1]);
      for (const id of idRefs) {
        if (optionalLegacyIds.has(id)) continue;
        assert.ok(htmlIds.has(id), `DOM ID '${id}' referenced in ${tsFile} is missing from rendered index.html`);
      }
    }
  } finally {
    gw.server.close();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

test('formatMarkdown renders h4-h6, tables, hr, lists, and italics without raw * or #', () => {
  const sample = [
    '#### A. Derivatives & Leverage Flush',
    '',
    '---',
    '',
    '| Scenario | Behavior |',
    '| :--- | :--- |',
    '| 1. Downside | Price breaks support |',
    '',
    '* Bullet one',
    '* Bullet two',
    '',
    '1. First item',
    '2. Second item',
    '',
    '*Disclaimer: educational only',
    'not advice.*'
  ].join('\n');

  const rendered = formatMarkdown(sample);
  assert.ok(rendered.includes('<h4>A. Derivatives &amp; Leverage Flush</h4>'));
  assert.ok(rendered.includes('<hr class="md-hr">'));
  assert.ok(rendered.includes('<table class="md-table">'));
  assert.ok(rendered.includes('<th>Scenario</th>'));
  assert.ok(rendered.includes('<td>1. Downside</td>'));
  assert.ok(rendered.includes('<ul><li>Bullet one</li><li>Bullet two</li></ul>'));
  assert.ok(rendered.includes('<ol><li>First item</li><li>Second item</li></ol>'));
  assert.ok(rendered.includes('<em>Disclaimer: educational only<br>not advice.</em>'));
  assert.ok(!rendered.includes('####'));
  assert.ok(!rendered.includes('*'));
});
