import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGateway } from '../dist/gateway/server.js';
import { saveConfigPatch } from '../dist/config.js';

const TEST_DIR = path.resolve('./tests/tmp_gateway_test');

test('OM Gateway Server API endpoints', async (t) => {
  const { server, agent, url } = await startGateway({
    port: 3099,
    host: '127.0.0.1',
    memoryDir: path.join(TEST_DIR, 'memory'),
    workspaceDir: TEST_DIR,
    provider: 'om'
  });

  t.after(() => {
    agent.stopWatching();
    server.close();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('GET /api/status returns runtime status', async () => {
    const res = await fetch(`${url}/api/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.name === 'OMega' || data.name === 'OM Gateway');
    assert.equal(data.provider, 'om');
    assert.ok(data.skillsCount > 0);
  });

  await t.test('GET /api/skills returns list of skills', async () => {
    const res = await fetch(`${url}/api/skills`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.skills));
    assert.ok(data.skills.some((s) => s.name === 'exec_command'));
  });

  await t.test('POST /api/chat executes task and returns JSON', async () => {
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'What time is it right now?' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.content.length > 0);
  });

  await t.test('GET /api/models returns available models via ModelService.ListModels', async () => {
    const res = await fetch(`${url}/api/models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.provider, 'om');
    assert.ok(Array.isArray(data.models));
    assert.ok(data.count >= 3);
    assert.ok(data.models.some((m) => m.id === 'om-v1' || m.id === 'om-mock-v1'));
  });

  await t.test('GET /api/sessions and /api/system-prompt support LM Studio studio controls', async () => {
    const sessRes = await fetch(`${url}/api/sessions`);
    assert.equal(sessRes.status, 200);
    const sessData = await sessRes.json();
    assert.equal(sessData.success, true);
    assert.ok(Array.isArray(sessData.sessions));

    const promptRes = await fetch(`${url}/api/system-prompt`);
    assert.equal(promptRes.status, 200);
    const promptData = await promptRes.json();
    assert.equal(promptData.success, true);
    assert.ok(typeof promptData.systemPrompt === 'string');
  });

  await t.test('GET /api/skills/:skill/references/:ref returns reference documentation', async () => {
    // 1. Scraping reference
    const res1 = await fetch(`${url}/api/skills/deepapi/references/scraping.md`);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.success, true);
    assert.equal(data1.skill, 'deepapi');
    assert.equal(data1.reference, 'scraping.md');
    assert.ok(data1.content.includes('DeepAPI Scraping Reference'));

    // 2. Browse-web reference
    const res2 = await fetch(`${url}/api/skills/deepapi/references/browse-web.md`);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.success, true);
    assert.ok(data2.content.includes('DeepAPI Browse-Web Reference'));

    // 3. Nonexistent reference returns 404
    const res3 = await fetch(`${url}/api/skills/deepapi/references/unknown-file.md`);
    assert.equal(res3.status, 404);
  });

  await t.test('POST /api/skills/create scaffolds new workflows and tools interactively', async () => {
    // 1. Create a workflow skill
    const wfName = 'test-workflow-auto';
    const wfRes = await fetch(`${url}/api/skills/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'workflow',
        name: wfName,
        description: 'Automated test workflow skill',
        prompt: 'Run the automated workflow checklist.'
      })
    });
    assert.equal(wfRes.status, 200);
    const wfData = await wfRes.json();
    assert.equal(wfData.success, true);
    assert.equal(wfData.name, wfName);
    assert.equal(agent.skills.has(wfName), true);
    assert.equal(agent.skills.get(wfName).type, 'workflow');

    // 2. Create a JS tool skill
    const toolName = 'test-tool-auto';
    const toolRes = await fetch(`${url}/api/skills/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'tool',
        name: toolName,
        description: 'Automated test tool skill',
        code: `export const skill = {
  name: '${toolName}',
  description: 'Automated test tool skill',
  parameters: { type: 'object', properties: {} },
  async execute() { return { success: true, toolRan: true }; }
};`
      })
    });
    assert.equal(toolRes.status, 200);
    const toolData = await toolRes.json();
    assert.equal(toolData.success, true);
    assert.equal(agent.skills.has(toolName), true);

    // Clean up created files/folders
    try {
      const fs = await import('fs');
      const path = await import('path');
      const wfDir = path.join(agent.config.skillsDir, wfName);
      if (fs.existsSync(wfDir)) fs.rmSync(wfDir, { recursive: true, force: true });
      const toolFile = path.join(agent.config.skillsDir, `${toolName}.js`);
      if (fs.existsSync(toolFile)) fs.unlinkSync(toolFile);
      agent.skills.skills.delete(wfName);
      agent.skills.skills.delete(toolName);
    } catch (_) {}
  });

  await t.test('GET /api/sessions/:id/export exports session transcripts in Markdown & JSON', async () => {
    // Ensure agent has at least one message in history
    agent.history.push({ role: 'user', content: 'Hello export test' });
    agent.history.push({ role: 'assistant', content: 'Export test response from agent' });

    // 1. Markdown export
    const mdRes = await fetch(`${url}/api/sessions/${agent.sessionId}/export?format=markdown`);
    assert.equal(mdRes.status, 200);
    assert.ok(mdRes.headers.get('content-type').includes('text/markdown'));
    const mdText = await mdRes.text();
    assert.ok(mdText.includes(`# OMega Session Transcript: ${agent.sessionId}`));
    assert.ok(mdText.includes('### User'));
    assert.ok(mdText.includes('Hello export test'));
    assert.ok(mdText.includes('### Agent'));

    // 2. JSON export
    const jsonRes = await fetch(`${url}/api/sessions/${agent.sessionId}/export?format=json`);
    assert.equal(jsonRes.status, 200);
    assert.ok(jsonRes.headers.get('content-type').includes('application/json'));
    const jsonData = await jsonRes.json();
    assert.equal(jsonData.sessionId, agent.sessionId);
    assert.ok(Array.isArray(jsonData.history));
    assert.ok(Array.isArray(jsonData.answers));
    assert.ok(jsonData.history.some((m) => m.content === 'Hello export test'));
  });

  await t.test('POST /api/sessions/reset-counter deletes all sessions and resets counter to session_1', async () => {
    // 1. Create a dummy session file in agent.memory.sessionsDir
    agent.memory.saveSession('session_99', {
      sessionId: 'session_99',
      history: [{ role: 'user', content: 'dummy' }]
    });

    const resetRes = await fetch(`${url}/api/sessions/reset-counter`, { method: 'POST' });
    assert.equal(resetRes.status, 200);
    const resetData = await resetRes.json();
    assert.equal(resetData.success, true);
    assert.equal(resetData.sessionId, 'session_1');
    assert.equal(agent.sessionId, 'session_1');
    assert.equal(agent.history.length, 0);

    // Verify GET /api/sessions now returns session_1 as active
    const listRes = await fetch(`${url}/api/sessions`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.currentSessionId, 'session_1');
    assert.ok(listData.sessions.some((s) => s.sessionId === 'session_1'));
  });

  await t.test('POST /api/clear clears active history clean as new without changing sessionId', async () => {
    agent.history.push({ role: 'user', content: 'message before clear' });
    const initialSessionId = agent.sessionId;

    const clearRes = await fetch(`${url}/api/clear`, { method: 'POST' });
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.success, true);
    assert.equal(clearData.sessionId, initialSessionId);
    assert.equal(agent.sessionId, initialSessionId);
    assert.equal(agent.history.length, 0);
  });

  await t.test('GET /api/memory/search, POST /api/memory/reindex, and GET /api/activity support vector search & live telemetry', async () => {
    agent.memory.appendFact('OMega uses 256-dimensional local vector embeddings for semantic recall', 'Architecture');

    const searchRes = await fetch(`${url}/api/memory/search?q=vector+semantic+embeddings&mode=hybrid`);
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.success, true);
    assert.ok(searchData.count >= 1);
    assert.ok(searchData.results.some((r) => r.text.includes('256-dimensional')));

    const reindexRes = await fetch(`${url}/api/memory/reindex`, { method: 'POST' });
    assert.equal(reindexRes.status, 200);
    const reindexData = await reindexRes.json();
    assert.equal(reindexData.success, true);
    assert.ok(reindexData.vectorStats.totalVectors >= 1);

    const actRes = await fetch(`${url}/api/activity`);
    assert.equal(actRes.status, 200);
    const actData = await actRes.json();
    assert.equal(actData.success, true);
    assert.ok(Array.isArray(actData.activities));
    assert.ok(actData.routingStats);
  });

  await t.test('POST /api/system-prompt validates temperature and saveConfigPatch persists runtime updates', async () => {
    const badRes = await fetch(`${url}/api/system-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature: 5 })
    });
    assert.equal(badRes.status, 400);
    const badData = await badRes.json();
    assert.equal(badData.success, false);

    const nanRes = await fetch(`${url}/api/system-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature: 'not-a-number' })
    });
    assert.equal(nanRes.status, 400);

    const okRes = await fetch(`${url}/api/system-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature: 0.7 })
    });
    assert.equal(okRes.status, 200);
    const okData = await okRes.json();
    assert.equal(okData.temperature, 0.7);
    assert.equal(agent.config.temperature, 0.7);

    // Verify saveConfigPatch persists to an isolated om.config.json
    const cfgDir = path.join(TEST_DIR, 'cfg_persist');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, 'om.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ provider: 'om', model: 'om-turbo', temperature: 0.2 }, null, 2));
    const saved = saveConfigPatch({ temperature: 0.7, model: 'om-reasoning' }, cfgDir);
    assert.equal(saved, true);
    const updatedCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(updatedCfg.temperature, 0.7);
    assert.equal(updatedCfg.model, 'om-reasoning');
  });
});
