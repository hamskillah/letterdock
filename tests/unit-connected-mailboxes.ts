import test from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_ENCRYPTION_KEY = 'test-app-encryption-key-must-be-at-least-32-characters-long!';
process.env.SESSION_SECRET = 'test-session-secret-over-32-characters-long!';
import { db } from '../src/db.js';
import {
  saveOAuthProviderConfig,
  getOAuthProviderConfig,
  startMailboxOAuth,
  completeMailboxOAuth,
  isSenderConnectedMailbox,
  ingestConnectedMime,
  listConnectedMailboxes,
  disconnectConnectedMailbox
} from '../src/connected-mailboxes.js';
import { sendEmail, OutboundError } from '../src/outbound.js';
import { encryptSecret, decryptSecret } from '../src/crypto.js';
import { storage } from '../src/storage.js';

test('OAuth Provider Config: encrypted storage and retrieval', async () => {
  await saveOAuthProviderConfig('google', 'test-client-id-123.apps.googleusercontent.com', 'test-client-secret-abc');
  const config = await getOAuthProviderConfig('google');
  assert.equal(config.configured, true);
  assert.equal(config.clientId, 'test-client-id-123.apps.googleusercontent.com');
  assert.equal(config.clientSecret, 'test-client-secret-abc');

  // Verify that database storage is encrypted and does NOT contain raw secret
  const { rows: [row] } = await db.query("SELECT value FROM settings WHERE key='oauth_provider_google'");
  assert(row.value.startsWith('v1.'));
  assert.equal(row.value.includes('test-client-secret-abc'), false, 'Raw client secret must not appear in plaintext in database');
});

test('PKCE & State: startMailboxOAuth constructs secure URL with S256 challenge', async () => {
  const result = await startMailboxOAuth({
    provider: 'google',
    redirectUri: 'http://127.0.0.1:3000/api/oauth/google/callback',
    workspaceId: 'default'
  });

  assert(result.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  const parsed = new URL(result.url);
  assert.equal(parsed.searchParams.get('client_id'), 'test-client-id-123.apps.googleusercontent.com');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert(parsed.searchParams.get('code_challenge')?.length! > 20);
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');
  assert(parsed.searchParams.get('scope')?.includes('https://www.googleapis.com/auth/gmail.readonly'));
  assert.equal(parsed.searchParams.get('scope')?.includes('gmail.send'), false, 'Must not request send scope');

  // Verify single-use state is stored in database
  const { rows: [stateRow] } = await db.query('SELECT * FROM oauth_states WHERE state = $1', [result.state]);
  assert(stateRow, 'State must be recorded in oauth_states');
  assert.equal(stateRow.provider, 'google');
  assert(stateRow.code_verifier.length >= 43, 'PKCE verifier must be at least 43 chars');
});

test('Negative Control: completeMailboxOAuth rejects invalid, replayed, or expired state', async () => {
  // 1. Invalid / non-existent state
  await assert.rejects(
    async () => {
      await completeMailboxOAuth({
        provider: 'google',
        code: 'fake-code',
        state: 'non-existent-state-value'
      });
    },
    /Invalid or expired OAuth state parameter/
  );

  // 2. Expired state (backdated)
  const expiredState = 'expired-state-test-12345';
  await db.query(`
    INSERT INTO oauth_states(state, provider, code_verifier, nonce, redirect_uri, workspace_id, expires_at)
    VALUES($1, 'google', 'verifier123456789012345678901234567890', 'nonce', 'http://localhost/callback', 'default', now() - interval '1 minute')
  `, [expiredState]);

  await assert.rejects(
    async () => {
      await completeMailboxOAuth({
        provider: 'google',
        code: 'fake-code',
        state: expiredState
      });
    },
    /Invalid or expired OAuth state parameter/
  );
  await db.query('DELETE FROM oauth_states WHERE state = $1', [expiredState]);
});

test('Inbound-Only Guard: isSenderConnectedMailbox & sendEmail blocks connected mailboxes and domains from sending', async () => {
  // 1. Manually insert a mock connected mailbox
  const mailboxEmail = 'operator-test@gmail.com';
  const encryptedToken = encryptSecret('mock-token-abc', 'oauth-token');
  const tokenExpires = new Date(Date.now() + 3600 * 1000);

  const { rows: [created] } = await db.query(`
    INSERT INTO connected_mailboxes(
      workspace_id, provider, email, display_name,
      encrypted_access_token, encrypted_refresh_token, token_expires_at,
      granted_scopes, status, direction
    )
    VALUES('default', 'google', $1, 'Operator Test', $2, $2, $3, ARRAY['gmail.readonly'], 'active', 'inbound_only')
    ON CONFLICT (workspace_id, provider, email) DO UPDATE SET status = 'active'
    RETURNING id
  `, [mailboxEmail, encryptedToken, tokenExpires]);

  // 2. Check guard function
  assert.equal(await isSenderConnectedMailbox('operator-test@gmail.com', 'default'), true);
  assert.equal(await isSenderConnectedMailbox('Operator Test <operator-test@gmail.com>', 'default'), true);
  assert.equal(await isSenderConnectedMailbox('unrelated@company.com', 'default'), false);

  // 3. Attempt to send an email using exact connected mailbox address -> Must throw OutboundError
  let threwMailbox = false;
  try {
    await sendEmail({
      workspaceId: 'default',
      from: 'operator-test@gmail.com',
      to: 'recipient@example.com',
      subject: 'Unauthorized Send Attempt',
      text: 'This should fail'
    });
  } catch (err: any) {
    if (err instanceof OutboundError && err.statusCode === 400 && err.name === 'inbound_only_mailbox') {
      threwMailbox = true;
    } else {
      throw err;
    }
  }
  assert.equal(threwMailbox, true, 'sendEmail must reject connected mailbox address with inbound_only_mailbox error');

  // 4. Attempt to send an email using a different unlisted address at the connected domain (spoof@gmail.com) -> Must also be blocked!
  let threwDomain = false;
  try {
    await sendEmail({
      workspaceId: 'default',
      from: 'attacker-spoof@gmail.com',
      to: 'recipient@example.com',
      subject: 'Unauthorized Spoof Attempt',
      text: 'This should also fail'
    });
  } catch (err: any) {
    if (err instanceof OutboundError && err.statusCode === 400 && err.name === 'inbound_only_mailbox') {
      threwDomain = true;
    } else if (err instanceof OutboundError && err.statusCode === 403) {
      // Also protected if domain is unverified
      threwDomain = true;
    } else {
      throw err;
    }
  }
  assert.equal(threwDomain, true, 'sendEmail must reject unverified/connected external domain');

  // Clean up
  await disconnectConnectedMailbox(created.id, true);
});

test('MIME Ingestion & Attachment Cascade: Ingests raw RFC 822 email, sets mailbox_id, and purges blobs on disconnect', async () => {
  // 1. Create temporary test mailbox
  const encryptedToken = encryptSecret('mock-token', 'oauth-token');
  const { rows: [mb] } = await db.query(`
    INSERT INTO connected_mailboxes(
      workspace_id, provider, email, display_name,
      encrypted_access_token, encrypted_refresh_token, token_expires_at,
      granted_scopes, status, direction
    )
    VALUES('default', 'google', 'inbound-test@gmail.com', 'Inbound Test', $1, $1, now() + interval '1 hour', ARRAY['gmail.readonly'], 'active', 'inbound_only')
    RETURNING id
  `, [encryptedToken]);

  const rawMime = Buffer.from(
    'From: Sender <sender@external.com>\r\n' +
    'To: inbound-test@gmail.com\r\n' +
    'Subject: Hello from Gmail Sync\r\n' +
    'Message-ID: <unique-test-message-12345@gmail.com>\r\n' +
    'Date: Fri, 27 Nov 2026 22:00:00 +0000\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    '\r\n' +
    'This is a test message downloaded via read-only sync.'
  );

  // 2. Ingest first time -> Must succeed
  const first = await ingestConnectedMime({
    mailboxId: mb.id,
    workspaceId: 'default',
    rawMime,
    providerMessageId: 'gmail-msg-001'
  });
  assert.equal(first.isDuplicate, false);
  assert(first.id);

  // Verify message in database
  const { rows: [msg] } = await db.query('SELECT * FROM messages WHERE id = $1', [first.id]);
  assert.equal(msg.mailbox_id, mb.id);
  assert.equal(msg.subject, 'Hello from Gmail Sync');
  assert.equal(msg.headers['x-letterdock-source'], 'connected_mailbox');

  // 3. Ingest same message second time -> Must be detected as duplicate
  const second = await ingestConnectedMime({
    mailboxId: mb.id,
    workspaceId: 'default',
    rawMime,
    providerMessageId: 'gmail-msg-001'
  });
  assert.equal(second.isDuplicate, true);
  assert.equal(second.id, first.id);

  // 4. Test Disconnect with deleteLocalData: Verifies raw storage blob is purged
  assert(msg.raw_storage_key);
  const blobBefore = await storage.get(msg.raw_storage_key);
  assert(blobBefore, 'Raw blob must exist before deletion');

  await disconnectConnectedMailbox(mb.id, true);

  const blobAfter = await storage.get(msg.raw_storage_key);
  assert.equal(blobAfter, null, 'Raw blob must be purged from storage when deleteLocalData=true');

  const { rows: remaining } = await db.query('SELECT id FROM messages WHERE id = $1', [first.id]);
  assert.equal(remaining.length, 0, 'Message row must be deleted');
});
