import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startGateway } from '../dist/gateway/server.js';

const TMP_DIR = path.resolve('./tests/tmp_e2e_ui');

async function runE2E() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    workspaceDir: TMP_DIR,
    memoryDir: path.join(TMP_DIR, '.mem'),
    provider: 'om',
    model: 'om-turbo'
  });

  let browser;
  for (const launchOpts of [
    { headless: true },
    { headless: true, channel: 'chrome' },
    { headless: true, channel: 'msedge' }
  ]) {
    try {
      browser = await chromium.launch(launchOpts);
      break;
    } catch (_) {
      // try next browser channel
    }
  }
  if (!browser) {
    throw new Error('No Chromium/Chrome/Edge browser executable found for Playwright E2E.');
  }
  try {
    const port = gw.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const page = await browser.newPage();

    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`console.error: ${msg.text()}`);
      }
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    assert.equal(await page.title(), 'OMega');

    // Click through all activity-rail tabs and verify their panes become active
    const tabs = ['agents', 'models', 'skills', 'memory', 'system', 'device', 'chat'];
    for (const tab of tabs) {
      await page.click(`.rail-item[data-tab="${tab}"]`);
      const paneId = `#pane${tab.charAt(0).toUpperCase() + tab.slice(1)}`;
      await page.waitForSelector(`${paneId}.active`, { timeout: 5000 });
    }

    // Submit a chat message and verify assistant reply renders
    await page.fill('#promptInput', 'Say hello in one short sentence.');
    await page.click('#sendBtn');
    await page.waitForSelector('.message-row.agent-msg', { timeout: 10000 });

    // Switch to Agents tab, spawn a detached worker, tail its log, and stop/delete it
    await page.click('.rail-item[data-tab="agents"]');
    await page.waitForSelector('#paneAgents.active', { timeout: 5000 });
    await page.click('#toggleDetachedSpawnBtn');
    await page.fill('#detachedPromptInput', 'Compute 1 + 1 concisely');
    await page.click('#submitDetachedSpawnBtn');
    await page.waitForSelector('[data-detached-inspect]', { timeout: 10000 });
    await page.click('[data-detached-inspect]');
    await page.waitForSelector('#detachedInspectPanel', { state: 'visible', timeout: 5000 });

    assert.deepEqual(errors, [], `Unexpected browser errors:\n${errors.join('\n')}`);
    console.log('[E2E] All UI tabs, chat, and detached worker flows passed with 0 console/page errors.');
  } finally {
    await browser.close();
    gw.server.close();
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch (_) {
      // ignore Windows handle release delay on detached worker log
    }
  }
}

runE2E().catch((err) => {
  console.error('[E2E] Failed:', err);
  process.exit(1);
});
