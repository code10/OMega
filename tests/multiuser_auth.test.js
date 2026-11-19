import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startGateway } from '../dist/gateway/server.js';
import { hashToken, signJwtHs256 } from '../dist/gateway/auth.js';
import { TenantManager } from '../dist/gateway/tenantManager.js';

const TMP_DIR = path.resolve('./tests/tmp_multiuser_auth');

test('Multi-User Auth, RBAC, and Per-Tenant Storage Isolation', async (t) => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const jwtSecret = 'test-multiuser-jwt-secret-12345';
  const aliceToken = 'tok-alice-operator';
  const viewerToken = 'tok-viewer-only';
  const adminJwt = signJwtHs256({ sub: 'charlie', role: 'admin' }, jwtSecret);

  const gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    workspaceDir: TMP_DIR,
    memoryDir: path.join(TMP_DIR, '.mem'),
    provider: 'om',
    model: 'om-turbo',
    auth: {
      mode: 'multiuser',
      jwtSecret,
      users: [
        { id: 'alice', role: 'operator', tokenHash: hashToken(aliceToken) },
        { id: 'bob_viewer', role: 'viewer', token: viewerToken }
      ]
    }
  });

  try {
    const baseUrl = gw.url;

    await t.test('1. Does not inject shared ephemeral token into index.html in multiuser mode', async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(!html.includes('name="om-gateway-token"'), 'multiuser index.html must not embed a shared token');
    });

    await t.test('2. Rejects unauthenticated / invalid tokens with 401', async () => {
      const noAuth = await fetch(`${baseUrl}/api/status`);
      assert.equal(noAuth.status, 401);

      const badAuth = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: 'Bearer wrong-token' }
      });
      assert.equal(badAuth.status, 401);
    });

    await t.test('3. Enforces RBAC (viewer < operator < admin)', async () => {
      // Viewer can GET /api/status
      const vStatus = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: `Bearer ${viewerToken}` }
      });
      assert.equal(vStatus.status, 200);

      // Viewer cannot POST /api/chat (requires operator)
      const vChat = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' })
      });
      assert.equal(vChat.status, 403);

      // Operator (alice) can POST /api/chat
      const opChat = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Say ok' })
      });
      assert.equal(opChat.status, 200);

      // Operator cannot POST /api/system-prompt (requires admin)
      const opAdmin = await fetch(`${baseUrl}/api/system-prompt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ temperature: 0.2 })
      });
      assert.equal(opAdmin.status, 403);

      // Admin JWT can POST /api/system-prompt
      const admRes = await fetch(`${baseUrl}/api/system-prompt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ temperature: 0.2 })
      });
      assert.equal(admRes.status, 200);
    });

    await t.test('4. Isolates memoryDir and workspaceDir per tenant', async () => {
      const aliceStatus = await (
        await fetch(`${baseUrl}/api/status`, { headers: { Authorization: `Bearer ${aliceToken}` } })
      ).json();
      const charlieStatus = await (
        await fetch(`${baseUrl}/api/status`, { headers: { Authorization: `Bearer ${adminJwt}` } })
      ).json();

      assert.ok(aliceStatus.memoryDir.includes(`${path.sep}tenants${path.sep}alice${path.sep}memory`));
      assert.ok(charlieStatus.memoryDir.includes(`${path.sep}tenants${path.sep}charlie${path.sep}memory`));
      assert.notEqual(aliceStatus.workspaceDir, charlieStatus.workspaceDir);
    });

    await t.test('5. TenantManager evicts idle tenant instances after TTL', async () => {
      const tm = new TenantManager({
        baseConfig: { provider: 'om', model: 'om-turbo', workspaceDir: TMP_DIR },
        tenantsRoot: path.join(TMP_DIR, 'evict_tenants'),
        idleTtlMs: 1000
      });
      try {
        const ctx = await tm.getTenant('idle_user');
        assert.equal(tm.tenants.size, 1);
        ctx.lastAccessAt = Date.now() - 5000;
        const evicted = await tm.evictIdle();
        assert.deepEqual(evicted, ['idle_user']);
        assert.equal(tm.tenants.size, 0);
      } finally {
        await tm.closeAll();
      }
    });
  } finally {
    gw.server.close();
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch (_) {
      // ignore Windows handle release delay
    }
  }
});
