import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { db } from '../src/db.js';
import { encryptSecret } from '../src/crypto.js';

process.env.APP_ENCRYPTION_KEY = 'test-app-encryption-key-must-be-at-least-32-characters-long!';
process.env.SESSION_SECRET = 'test-session-secret-over-32-characters-long!';
process.env.PORT = '56345';
process.env.ADMIN_PASSWORD = 'test-feature-mailboxes-password';

const origin = 'http://127.0.0.1:56345';

test('Feature: Connected Mailboxes & OAuth Endpoints Integration', async () => {
  // 1. Launch Fastify server process on port 56345
  const server = spawn('node', ['dist/server.js'], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      ADMIN_PASSWORD: 'test-feature-mailboxes-password',
      SESSION_SECRET: 'test-session-secret-over-32-characters-long!',
      APP_ENCRYPTION_KEY: 'test-app-encryption-key-must-be-at-least-32-characters-long!',
      PORT: '56345',
      PUBLIC_URL: origin
    },
    stdio: 'ignore'
  });

  try {
    // Wait for server to start
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${origin}/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert(ready, 'Server must start on port 56345');

    // 2. Sign in to obtain session cookie
    const loginRes = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: {
        'Origin': origin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: 'test-feature-mailboxes-password' })
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
    assert(cookie, 'Must return signed session cookie');

    // 3. GET /api/oauth/providers
    const provRes = await fetch(`${origin}/api/oauth/providers`, {
      headers: { Cookie: cookie }
    });
    assert.equal(provRes.status, 200);
    const provData = await provRes.json();
    assert('google' in provData);
    assert('microsoft' in provData);

    // 4. POST /api/oauth/providers/google (Configure credentials)
    const saveRes = await fetch(`${origin}/api/oauth/providers/google`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        clientId: '987654321-feature.apps.googleusercontent.com',
        clientSecret: 'secret-feature-key-xyz'
      })
    });
    assert.equal(saveRes.status, 200);
    const saveData = await saveRes.json();
    assert.equal(saveData.ok, true);

    // 5. GET /api/oauth/google/authorize (Initiate flow)
    const authRes = await fetch(`${origin}/api/oauth/google/authorize`, {
      headers: { Cookie: cookie }
    });
    assert.equal(authRes.status, 200);
    const authData = await authRes.json();
    assert(authData.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
    assert(authData.state);

    // 6. Insert mock connected mailbox directly
    const encryptedToken = encryptSecret('mock-token-abc', 'oauth-token');
    const { rows: [mb] } = await db.query(`
      INSERT INTO connected_mailboxes(
        workspace_id, provider, email, display_name,
        encrypted_access_token, encrypted_refresh_token, token_expires_at,
        granted_scopes, status, direction
      )
      VALUES('default', 'google', 'feature-test@gmail.com', 'Feature Tester', $1, $1, now() + interval '1 hour', ARRAY['gmail.readonly'], 'active', 'inbound_only')
      ON CONFLICT (workspace_id, provider, email) DO UPDATE SET status = 'active'
      RETURNING id
    `, [encryptedToken]);

    // 7. GET /api/connected-mailboxes
    const listRes = await fetch(`${origin}/api/connected-mailboxes`, {
      headers: { Cookie: cookie }
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert(Array.isArray(listData));
    const found = listData.find((m: any) => m.id === mb.id);
    assert(found);
    assert.equal(found.email, 'feature-test@gmail.com');
    assert.equal(found.direction, 'inbound_only');

    // 8. POST /api/connected-mailboxes/:id/toggle (Pause / Resume)
    const toggleRes = await fetch(`${origin}/api/connected-mailboxes/${mb.id}/toggle`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin }
    });
    assert.equal(toggleRes.status, 200);
    const toggleData = await toggleRes.json();
    assert.equal(toggleData.status, 'paused');

    // 9. DELETE /api/connected-mailboxes/:id
    const delRes = await fetch(`${origin}/api/connected-mailboxes/${mb.id}?deleteLocalData=true`, {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: origin }
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.ok, true);

    // Verify deletion
    const { rows: remaining } = await db.query('SELECT id FROM connected_mailboxes WHERE id = $1', [mb.id]);
    assert.equal(remaining.length, 0);

  } finally {
    server.kill('SIGTERM');
  }
});
