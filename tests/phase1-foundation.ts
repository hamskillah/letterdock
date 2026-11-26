import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const origin = 'http://localhost:56320';
const password = 'integration-secret-password-16chars';
const sessionSecret = 'integration-session-secret-over-32chars';
process.env.SESSION_SECRET = sessionSecret;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';

const { db, migrate } = await import('../src/db.js');
const { storage } = await import('../src/storage.js');
const { importMail, parseNext, migrateLegacyStorage } = await import('../src/jobs.js');

await migrate();

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    PUBLIC_URL: '',
    APP_PORT: '56320',
    PORT: '56320'
  },
  stdio: 'ignore'
});

try {
  // Wait for server to start
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // 1. Test Server-Side Session Creation and Revocation
  console.log('--- Testing Server-Side Session Management ---');
  const loginRes = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  });
  assert.equal(loginRes.status, 200, 'Login must succeed');
  const rawCookie = loginRes.headers.get('set-cookie');
  assert(rawCookie, 'Set-Cookie header must be present');
  const cookieVal = rawCookie.split(';')[0];

  // Verify session exists in DB
  const { rows: sessions } = await db.query('SELECT id, workspace_id, expires_at FROM sessions ORDER BY created_at DESC LIMIT 1');
  assert(sessions.length > 0, 'Session record must be created in PostgreSQL');
  assert.equal(sessions[0].workspace_id, 'default', 'Session workspace_id must default to "default"');
  const activeSessionId = sessions[0].id;

  // Make an authenticated request using this session
  const checkAuth = await fetch(origin + '/api/messages', {
    headers: { cookie: cookieVal, origin }
  });
  assert.equal(checkAuth.status, 200, 'Request with active session cookie must return 200');

  // Perform logout
  const logoutRes = await fetch(origin + '/api/logout', {
    method: 'POST',
    headers: { cookie: cookieVal, origin }
  });
  assert.equal(logoutRes.status, 200, 'Logout must succeed');

  // Verify session is deleted from PostgreSQL
  const { rows: deletedCheck } = await db.query('SELECT id FROM sessions WHERE id=$1', [activeSessionId]);
  assert.equal(deletedCheck.length, 0, 'Session record must be deleted from PostgreSQL on logout');

  // Verify replay of the copied cookie is now 401 Unauthorized
  const replayedReq = await fetch(origin + '/api/messages', {
    headers: { cookie: cookieVal, origin }
  });
  assert.equal(replayedReq.status, 401, 'Replay of logged-out session cookie must be rejected with 401');

  // 2. Test Workspace Zero-State
  console.log('--- Testing Workspace Zero-State ---');
  const { rows: wsRows } = await db.query('SELECT * FROM workspaces WHERE id=$1', ['default']);
  assert.equal(wsRows.length, 1, 'Default workspace must exist');

  // 3. Test Hybrid Blob Storage Ingestion & Lazy Dual-Read
  console.log('--- Testing Hybrid Blob Storage & Dual-Read ---');
  const domain = 'phase1.test.example';
  await db.query('INSERT INTO domains(name, verified) VALUES($1, true) ON CONFLICT(name) DO UPDATE SET verified=true', [domain]);

  const msgId = randomUUID();
  const recipient = 'user@' + domain;
  const rawEml = Buffer.from([
    'From: Alice <alice@example.org>',
    'To: user@' + domain,
    'Subject: Invoice #999',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="sep"',
    '',
    '--sep',
    'Content-Type: text/plain',
    '',
    'Please find attached invoice.',
    '--sep',
    'Content-Type: text/plain',
    'Content-Disposition: attachment; filename="invoice.txt"',
    '',
    'Total: $500',
    '--sep--',
    ''
  ].join('\r\n'));

  // Ingest via importMail
  const imported = await importMail(msgId, 'alice@example.org', recipient, rawEml);
  assert(imported, 'Email should be imported');

  // Verify raw_storage_key in messages table
  const { rows: [msgRow] } = await db.query('SELECT id, raw_storage_key, raw_checksum_sha256, raw_size_bytes FROM messages WHERE id=$1', [msgId]);
  assert(msgRow.raw_storage_key, 'raw_storage_key must be populated');
  assert(await storage.exists(msgRow.raw_storage_key), 'Raw MIME must exist in blob storage');

  // Parse email
  await parseNext();

  // Verify attachment has storage_key and checksum
  const { rows: attRows } = await db.query('SELECT id, filename, mime, storage_key, checksum_sha256, size_bytes FROM attachments WHERE message=$1', [msgId]);
  assert.equal(attRows.length, 1, 'One attachment should be parsed');
  assert(attRows[0].storage_key, 'attachment storage_key must be populated');
  assert(await storage.exists(attRows[0].storage_key), 'Attachment file must exist in blob storage');

  // Log in again to get fresh valid session
  const freshLogin = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const freshCookie = freshLogin.headers.get('set-cookie')!.split(';')[0];

  // Test downloading attachment via /api/files/:id
  const downloadRes = await fetch(origin + '/api/files/' + attRows[0].id, {
    headers: { cookie: freshCookie, origin }
  });
  assert.equal(downloadRes.status, 200, 'Download from blob storage must succeed');
  const downloadedText = await downloadRes.text();
  assert.equal(downloadedText, 'Total: $500', 'Downloaded content must match');

  // Test downloading raw MIME via /api/raw/:id
  const rawRes = await fetch(origin + '/api/raw/' + msgId, {
    headers: { cookie: freshCookie, origin }
  });
  assert.equal(rawRes.status, 200, 'Raw EML download must succeed');
  const rawText = await rawRes.text();
  assert(rawText.includes('Subject: Invoice #999'), 'Raw EML must match');

  // 4. Test Legacy Dual-Read Fallback (Row with storage_key=null and data=bytea)
  console.log('--- Testing Legacy Dual-Read Fallback ---');
  const legacyAttId = randomUUID();
  const legacyContent = Buffer.from('legacy bytea attachment content');
  await db.query(
    'INSERT INTO attachments(id, message, filename, mime, data, storage_key) VALUES($1, $2, $3, $4, $5, NULL)',
    [legacyAttId, msgId, 'legacy.txt', 'text/plain', legacyContent]
  );

  const legacyDownloadRes = await fetch(origin + '/api/files/' + legacyAttId, {
    headers: { cookie: freshCookie, origin }
  });
  assert.equal(legacyDownloadRes.status, 200, 'Legacy bytea download must succeed via fallback');
  assert.equal(await legacyDownloadRes.text(), 'legacy bytea attachment content');

  // 5. Test Background Storage Migration
  console.log('--- Testing Background Storage Migration ---');
  const migRes = await migrateLegacyStorage(50);
  assert(migRes.migratedAttachments >= 1, 'At least 1 legacy attachment must be migrated');

  // Verify that the legacy row now has storage_key populated
  const { rows: [migratedRow] } = await db.query('SELECT storage_key, checksum_sha256, size_bytes FROM attachments WHERE id=$1', [legacyAttId]);
  assert(migratedRow.storage_key, 'storage_key must be populated after migration');
  assert(await storage.exists(migratedRow.storage_key), 'Migrated file must exist in blob storage');

  // Test downloading again after migration
  const afterMigRes = await fetch(origin + '/api/files/' + legacyAttId, {
    headers: { cookie: freshCookie, origin }
  });
  assert.equal(afterMigRes.status, 200);
  assert.equal(await afterMigRes.text(), 'legacy bytea attachment content');

  console.log('All Phase 1 Foundation & Storage tests passed with 100% success!');
} finally {
  server.kill('SIGTERM');
  await db.end();
  process.exit(0);
}
