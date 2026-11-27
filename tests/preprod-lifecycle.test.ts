import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../src/crypto.js';
import { createEncryptedBackup } from '../scripts/backup.js';
import { restoreEncryptedBackup } from '../scripts/restore.js';

const pgBaseUrl = 'postgres://postgres:letterdock_test@127.0.0.1:5432';
const rootDb = new pg.Pool({ connectionString: `${pgBaseUrl}/postgres` });

async function recreateDb(name: string) {
  await rootDb.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await rootDb.query(`CREATE DATABASE ${name}`);
}

async function run() {
  console.log('=== Pre-Production Lifecycle & Disaster Recovery Verification ===');
  process.env.APP_ENCRYPTION_KEY = 'test_app_encryption_key_32_bytes_long_1234';
  process.env.SESSION_SECRET = 'test_session_secret_at_least_32_chars_long_1234';

  // -----------------------------------------------------------------
  // 1. Clean Installation Verification
  // -----------------------------------------------------------------
  console.log('--- 1. Testing Clean Installation from Scratch ---');
  const cleanDbName = 'letterdock_clean_install';
  await recreateDb(cleanDbName);

  const cleanDbUrl = `${pgBaseUrl}/${cleanDbName}`;
  process.env.DATABASE_URL = cleanDbUrl;

  const cleanPool = new pg.Pool({ connectionString: cleanDbUrl });
  const { migrate } = await import('../src/db.js');
  await migrate(cleanPool);
  const { rows: tables } = await cleanPool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);
  const tableNames = tables.map((t: any) => t.table_name);
  console.log(`Clean installation created ${tableNames.length} tables: ${tableNames.join(', ')}`);

  const requiredTables = [
    'settings', 'workspaces', 'sessions', 'domains', 'messages', 'attachments',
    'inboxes', 'blocks', 'api_keys', 'hooks', 'deliveries', 'delivery_log',
    'ingest_log', 'job_queue', 'outbound_profiles', 'suppressions', 'outbound_messages'
  ];

  for (const req of requiredTables) {
    assert(tableNames.includes(req), `Required table '${req}' must exist in clean installation`);
  }

  // Verify default workspace
  const { rows: [defWs] } = await cleanPool.query("SELECT * FROM workspaces WHERE id = 'default'");
  assert(defWs, "Default workspace 'default' must exist");
  assert.equal(defWs.name, 'Default Workspace');

  // -----------------------------------------------------------------
  // 2. Upgrade from Previous Version Verification
  // -----------------------------------------------------------------
  console.log('--- 2. Testing Upgrade from Legacy v0.1.0 Schema ---');
  const upgradeDbName = 'letterdock_upgrade_test';
  await recreateDb(upgradeDbName);
  const upgradePool = new pg.Pool({ connectionString: `${pgBaseUrl}/${upgradeDbName}` });

  // Create legacy v0.1.0 schema (no workspaces, bytea messages, no sessions table, no job_queue)
  await upgradePool.query(`
    CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
    CREATE TABLE domains (name text PRIMARY KEY, token uuid DEFAULT gen_random_uuid(), verified boolean DEFAULT false, last_received timestamptz, retention_days integer);
    CREATE TABLE messages (
      id uuid PRIMARY KEY, domain text REFERENCES domains(name),
      recipient text, sender text, raw bytea,
      subject text DEFAULT '', body text DEFAULT '', html text DEFAULT '',
      headers jsonb DEFAULT '{}', message_id text, state text DEFAULT 'pending',
      error text, received timestamptz DEFAULT now(), unread boolean DEFAULT true,
      starred boolean DEFAULT false, folder text DEFAULT 'inbox', labels text[] DEFAULT '{}'
    );
    CREATE TABLE attachments (
      id uuid PRIMARY KEY, message uuid REFERENCES messages(id) ON DELETE CASCADE,
      filename text, mime text, data bytea
    );
    CREATE TABLE hooks (id uuid PRIMARY KEY, url text NOT NULL, secret text NOT NULL, filter text);
  `);

  // Insert synthetic legacy data
  const legacyMsgId = randomUUID();
  const legacyRawContent = Buffer.from('Subject: Legacy Message\r\n\r\nHello Legacy World');
  const legacyAttachContent = Buffer.from('PDF_DUMMY_CONTENT');

  await upgradePool.query("INSERT INTO domains(name, verified) VALUES('legacy.example.com', true)");
  await upgradePool.query(
    "INSERT INTO messages(id, domain, recipient, sender, subject, raw) VALUES($1, 'legacy.example.com', 'user@legacy.example.com', 'sender@example.net', 'Legacy Message', $2)",
    [legacyMsgId, legacyRawContent]
  );
  await upgradePool.query(
    "INSERT INTO attachments(id, message, filename, mime, data) VALUES($1, $2, 'test.pdf', 'application/pdf', $3)",
    [randomUUID(), legacyMsgId, legacyAttachContent]
  );

  // Now execute migration against the legacy DB
  await migrate(upgradePool);

  // Verify non-destructive upgrade
  const { rows: upgradedMsgs } = await upgradePool.query("SELECT id, subject, raw, workspace_id FROM messages WHERE id = $1", [legacyMsgId]);
  assert.equal(upgradedMsgs.length, 1);
  assert.equal(upgradedMsgs[0].subject, 'Legacy Message');
  assert.equal(upgradedMsgs[0].workspace_id, 'default', 'Legacy message must be mapped to default workspace');
  assert.deepEqual(upgradedMsgs[0].raw, legacyRawContent, 'Legacy bytea content must be preserved exactly');

  // -----------------------------------------------------------------
  // 3. Migration Idempotency & Schema Integrity
  // -----------------------------------------------------------------
  console.log('--- 3. Testing Migration Idempotency (Repeat Execution) ---');
  await migrate(upgradePool);
  await migrate(upgradePool);

  const { rows: recheckMsgs } = await upgradePool.query("SELECT count(*) as count FROM messages");
  assert.equal(Number(recheckMsgs[0].count), 1, 'Message count must remain identical after multiple migrations');

  // -----------------------------------------------------------------
  // 4. Encrypted Backup Verification
  // -----------------------------------------------------------------
  console.log('--- 4. Testing Point-in-Time Encrypted Backup ---');
  const testStorageDir = resolve('/tmp/antigravity', `preprod-storage-${randomUUID()}`);
  await fs.mkdir(testStorageDir, { recursive: true });

  // Write some blob data into storageDir
  const blobKey1 = 'msg-raw/2026/11/' + randomUUID() + '.eml';
  const blobKey2 = 'attach/2026/11/' + randomUUID() + '.bin';
  const blobContent1 = Buffer.from('MIME-RAW-PAYLOAD-FOR-BACKUP-TEST');
  const blobContent2 = Buffer.from('ATTACHMENT-BINARY-PAYLOAD-FOR-BACKUP-TEST');

  await fs.mkdir(dirname(join(testStorageDir, blobKey1)), { recursive: true });
  await fs.writeFile(join(testStorageDir, blobKey1), blobContent1);
  await fs.mkdir(dirname(join(testStorageDir, blobKey2)), { recursive: true });
  await fs.writeFile(join(testStorageDir, blobKey2), blobContent2);

  const backupOut = resolve('/tmp/antigravity', `preprod-backup-${randomUUID()}.ldk.enc`);
  const backupResult = await createEncryptedBackup({
    outputPath: backupOut,
    storageDir: testStorageDir,
    dbUrl: `${pgBaseUrl}/${upgradeDbName}`
  });

  assert(backupResult.backupPath, 'Backup must return backup path');
  assert(backupResult.manifest.blobs_count >= 2, 'Manifest must track all staged blobs');
  assert.equal(backupResult.manifest.blobs[blobKey1]?.sha256, sha256(blobContent1));
  assert.equal(backupResult.manifest.blobs[blobKey2]?.sha256, sha256(blobContent2));

  // Verify file on disk starts with LDKB magic header
  const rawEncBackup = await fs.readFile(backupOut);
  assert.equal(rawEncBackup.subarray(0, 4).toString('utf-8'), 'LDKB', 'Backup must start with LDKB magic header');

  // -----------------------------------------------------------------
  // 5. Encrypted Restore (Disaster Recovery) Verification
  // -----------------------------------------------------------------
  console.log('--- 5. Testing Encrypted Restore into Target Environment ---');
  const restoreDbName = 'letterdock_restore_test';
  await recreateDb(restoreDbName);
  const restoreTargetStorage = resolve('/tmp/antigravity', `preprod-restore-storage-${randomUUID()}`);
  await fs.mkdir(restoreTargetStorage, { recursive: true });

  const restoreResult = await restoreEncryptedBackup(backupOut, {
    targetDbUrl: `${pgBaseUrl}/${restoreDbName}`,
    targetStorageDir: restoreTargetStorage
  });

  assert.equal(restoreResult.verifiedBlobs, 2, 'All 2 blobs must be restored and verified against manifest');

  // Verify blob byte fidelity
  const restoredBlob1 = await fs.readFile(join(restoreTargetStorage, blobKey1));
  const restoredBlob2 = await fs.readFile(join(restoreTargetStorage, blobKey2));
  assert.deepEqual(restoredBlob1, blobContent1, 'Restored blob 1 must match byte-for-byte');
  assert.deepEqual(restoredBlob2, blobContent2, 'Restored blob 2 must match byte-for-byte');

  // Verify database restore fidelity
  const restorePool = new pg.Pool({ connectionString: `${pgBaseUrl}/${restoreDbName}` });
  const { rows: restoredRows } = await restorePool.query("SELECT * FROM messages WHERE id = $1", [legacyMsgId]);
  assert.equal(restoredRows.length, 1);
  assert.equal(restoredRows[0].subject, 'Legacy Message');

  // -----------------------------------------------------------------
  // 6. Negative Control: Tampered Backup Rejection
  // -----------------------------------------------------------------
  console.log('--- 6. Testing Negative Control: Tampered Backup Rejection ---');
  const tamperedBackupOut = resolve('/tmp/antigravity', `preprod-tampered-${randomUUID()}.ldk.enc`);
  const tamperedBuffer = Buffer.from(rawEncBackup);
  // Flip byte in ciphertext payload
  tamperedBuffer[tamperedBuffer.length - 10] ^= 0xff;
  await fs.writeFile(tamperedBackupOut, tamperedBuffer);

  let caughtTamper = false;
  try {
    await restoreEncryptedBackup(tamperedBackupOut, {
      targetDbUrl: `${pgBaseUrl}/${restoreDbName}`,
      targetStorageDir: restoreTargetStorage
    });
  } catch (err: any) {
    if (err.message.includes('Unsupported state or unable to authenticate data') || err.message.includes('corrupted') || err.message.includes('auth tag')) {
      caughtTamper = true;
    }
  }
  assert(caughtTamper, 'Integrity gate: Tampered backup must be strictly rejected with authentication failure');

  // -----------------------------------------------------------------
  // 7. Rollback Verification
  // -----------------------------------------------------------------
  console.log('--- 7. Testing Rollback Procedure ---');
  // Simulate pre-deployment state snapshot
  const rollbackPreSnapshot = await createEncryptedBackup({
    outputPath: resolve('/tmp/antigravity', `rollback-snapshot-${randomUUID()}.ldk.enc`),
    storageDir: testStorageDir,
    dbUrl: `${pgBaseUrl}/${upgradeDbName}`
  });

  // Simulate breaking change / accidental deletion
  await upgradePool.query("DELETE FROM messages WHERE id = $1", [legacyMsgId]);
  const { rows: emptyCheck } = await upgradePool.query("SELECT count(*) as count FROM messages");
  assert.equal(Number(emptyCheck[0].count), 0, 'Messages must be deleted before rollback');

  // Rollback to snapshot
  await restoreEncryptedBackup(rollbackPreSnapshot.backupPath, {
    targetDbUrl: `${pgBaseUrl}/${upgradeDbName}`,
    targetStorageDir: testStorageDir
  });

  const { rows: rolledBackMsgs } = await upgradePool.query("SELECT * FROM messages WHERE id = $1", [legacyMsgId]);
  assert.equal(rolledBackMsgs.length, 1, 'Rollback must restore the database to pre-incident state');
  assert.equal(rolledBackMsgs[0].subject, 'Legacy Message');

  // Cleanup temporary databases and directories
  await cleanPool.end();
  await upgradePool.end();
  await restorePool.end();
  await rootDb.query(`DROP DATABASE IF EXISTS ${cleanDbName} WITH (FORCE)`);
  await rootDb.query(`DROP DATABASE IF EXISTS ${upgradeDbName} WITH (FORCE)`);
  await rootDb.query(`DROP DATABASE IF EXISTS ${restoreDbName} WITH (FORCE)`);
  await rootDb.end();
  await fs.rm(testStorageDir, { recursive: true, force: true });
  await fs.rm(restoreTargetStorage, { recursive: true, force: true });
  await fs.rm(backupOut, { force: true });
  await fs.rm(tamperedBackupOut, { force: true });
  await fs.rm(rollbackPreSnapshot.backupPath, { force: true });

  console.log('All Lifecycle & Disaster Recovery Verification Gates Passed 100%!');
}

run().catch((err) => {
  console.error('Lifecycle test failed:', err);
  process.exit(1);
});
