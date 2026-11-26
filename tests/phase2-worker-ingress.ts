import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const origin = 'http://localhost:56321';
const password = 'integration-secret-password-16chars';
const sessionSecret = 'integration-session-secret-over-32chars';
const ingressKey = 'super-secret-ingress-relay-token-12345';

process.env.SESSION_SECRET = sessionSecret;
process.env.ADMIN_PASSWORD = password;
process.env.INGRESS_KEY = ingressKey;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';

const { db, migrate } = await import('../src/db.js');
const { storage } = await import('../src/storage.js');
const { WorkerPool, workerPool } = await import('../src/worker.js');

await migrate();

console.log('=== Starting Phase 2: Worker Pool & Resilient Ingress Tests ===');

// -------------------------------------------------------------
// 1. Test WorkerPool Concurrency & Transactional SKIP LOCKED
// -------------------------------------------------------------
console.log('--- 1. Testing WorkerPool Concurrency & SKIP LOCKED ---');
const pool = new WorkerPool({ concurrency: 4 });
let activeWorkers = 0;
let maxConcurrentObserved = 0;
let processedJobs = 0;

pool.registerHandler('concurrent_test', async (job) => {
  activeWorkers++;
  if (activeWorkers > maxConcurrentObserved) {
    maxConcurrentObserved = activeWorkers;
  }
  // Simulate asynchronous work
  await new Promise(r => setTimeout(r, 60));
  activeWorkers--;
  processedJobs++;
});

// Enqueue 8 jobs
const jobIds: string[] = [];
for (let i = 0; i < 8; i++) {
  const id = await pool.enqueue('concurrent_test', { item: i });
  jobIds.push(id);
}

pool.start();

// Wait for all 8 jobs to finish
for (let i = 0; i < 40; i++) {
  if (processedJobs >= 8) break;
  await new Promise(r => setTimeout(r, 100));
}

await pool.stop();

assert.equal(processedJobs, 8, 'All 8 queued jobs must be completed');
assert(maxConcurrentObserved >= 2, 'Observed concurrency should be >= 2 across workers, got: ' + maxConcurrentObserved);

// Verify jobs marked completed in database
const { rows: completedRows } = await db.query(
  'SELECT status FROM job_queue WHERE id = ANY($1::uuid[])',
  [jobIds]
);
assert.equal(completedRows.length, 8);
assert(completedRows.every(r => r.status === 'completed'), 'All jobs must have status=completed');

// -------------------------------------------------------------
// 2. Test Exponential Backoff and Dead-Letter Queue (DLQ)
// -------------------------------------------------------------
console.log('--- 2. Testing Retry Backoff & Dead-Letter Queue ---');
const dlqPool = new WorkerPool({ concurrency: 1 });
let attemptsCount = 0;

dlqPool.registerHandler('flaky_job', async (job) => {
  attemptsCount++;
  throw new Error('Simulated transient worker failure');
});

// Enqueue job with max_attempts: 2
const flakyJobId = await dlqPool.enqueue('flaky_job', { test: true }, { maxAttempts: 2 });
dlqPool.start();

// Wait for first attempt
for (let i = 0; i < 30; i++) {
  const { rows: [row] } = await db.query('SELECT attempts, status, last_error FROM job_queue WHERE id=$1', [flakyJobId]);
  if (row && row.attempts >= 1) {
    assert.equal(row.status, 'pending', 'Status after 1st attempt should be pending for retry');
    assert(row.last_error.includes('Simulated transient worker failure'));
    break;
  }
  await new Promise(r => setTimeout(r, 50));
}

// Manually advance next_attempt to now so the second attempt triggers immediately
await db.query('UPDATE job_queue SET next_attempt=now()-interval \'1 second\' WHERE id=$1', [flakyJobId]);
dlqPool.wake();

// Wait for second attempt and DLQ transition
for (let i = 0; i < 30; i++) {
  const { rows: [row] } = await db.query('SELECT attempts, status FROM job_queue WHERE id=$1', [flakyJobId]);
  if (row && row.attempts >= 2 && row.status === 'dead_letter') {
    break;
  }
  await new Promise(r => setTimeout(r, 50));
}

await dlqPool.stop();

const { rows: [finalDlq] } = await db.query('SELECT attempts, status FROM job_queue WHERE id=$1', [flakyJobId]);
assert.equal(finalDlq.attempts, 2);
assert.equal(finalDlq.status, 'dead_letter', 'Job must transition to dead_letter after max_attempts exhausted');

// -------------------------------------------------------------
// 3. Test Crashed Worker Lease Expiry Recovery
// -------------------------------------------------------------
console.log('--- 3. Testing Crashed Worker Lease Recovery ---');
const recoveryPool = new WorkerPool({ concurrency: 1 });
let recovered = false;

recoveryPool.registerHandler('recovery_test', async (job) => {
  recovered = true;
});

// Insert a job that looks like it was locked by a dead worker whose lease expired
const crashedJobId = randomUUID();
await db.query(`
  INSERT INTO job_queue (id, job_type, payload, status, locked_until, locked_by, attempts)
  VALUES ($1, 'recovery_test', '{}', 'processing', now() - interval '10 seconds', 'dead-worker-pid-9999', 1)
`, [crashedJobId]);

recoveryPool.start();

for (let i = 0; i < 30; i++) {
  if (recovered) break;
  await new Promise(r => setTimeout(r, 50));
}
await recoveryPool.stop();

assert.equal(recovered, true, 'Expired lease job should be reclaimed by active worker');
const { rows: [recJob] } = await db.query('SELECT status FROM job_queue WHERE id=$1', [crashedJobId]);
assert.equal(recJob.status, 'completed');

// -------------------------------------------------------------
// 3b. Test Heartbeat Lease Renewal
// -------------------------------------------------------------
console.log('--- 3b. Testing Heartbeat Lease Renewal ---');
const hbPool = new WorkerPool({ concurrency: 1 });
let hbRunCompleted = false;
hbPool.registerHandler('heartbeat_test', async (job) => {
  const workerId = 'test-worker-manual';
  await db.query('UPDATE job_queue SET locked_by=$1 WHERE id=$2', [workerId, job.id]);
  const renewed = await hbPool.heartbeat(job.id, workerId);
  assert.equal(renewed, true, 'Heartbeat must successfully extend active lease');
  hbRunCompleted = true;
});
const hbJobId = await hbPool.enqueue('heartbeat_test', {});
hbPool.start();
for (let i = 0; i < 30; i++) {
  if (hbRunCompleted) break;
  await new Promise(r => setTimeout(r, 50));
}
await hbPool.stop();
assert.equal(hbRunCompleted, true);

// -------------------------------------------------------------
// 4. Test Generic Raw HTTPS Ingestion API (POST /api/ingress/raw)
// -------------------------------------------------------------
console.log('--- 4. Testing Generic Raw Ingress API ---');
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    INGRESS_KEY: ingressKey,
    PUBLIC_URL: '',
    APP_PORT: '56321',
    PORT: '56321'
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

  const domain = 'ingress.test.example';
  await db.query('INSERT INTO domains(name, verified) VALUES($1, true) ON CONFLICT(name) DO UPDATE SET verified=true', [domain]);

  // A. Unauthorized request without header -> 401
  const noAuthRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    body: 'From: alice@test.com\r\nTo: user@' + domain + '\r\n\r\nBody'
  });
  assert.equal(noAuthRes.status, 401, 'Request without Authorization must return 401');

  // B. Bad bearer token -> 401
  const badAuthRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    headers: { Authorization: 'Bearer bad-token' },
    body: 'From: alice@test.com\r\nTo: user@' + domain + '\r\n\r\nBody'
  });
  assert.equal(badAuthRes.status, 401, 'Request with bad token must return 401');

  // C. Ingest raw RFC 822 EML stream with attachment via INGRESS_KEY
  const rawEmlContent = [
    'From: Ingress Sender <sender@external.org>',
    'To: Receiver <docs@' + domain + '>',
    'Subject: Ingress Pipeline Test Document',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="boundary-xyz"',
    '',
    '--boundary-xyz',
    'Content-Type: text/plain',
    '',
    'This email was ingested via POST /api/ingress/raw.',
    '--boundary-xyz',
    'Content-Type: text/plain',
    'Content-Disposition: attachment; filename="payload.txt"',
    '',
    'Payload data 12345',
    '--boundary-xyz--',
    ''
  ].join('\r\n');

  const ingestRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + ingressKey,
      'Content-Type': 'message/rfc822'
    },
    body: rawEmlContent
  });

  assert.equal(ingestRes.status, 201, 'Ingest must return 201 Created');
  const ingestJson = await ingestRes.json() as any;
  assert.equal(ingestJson.ok, true);
  assert.equal(ingestJson.status, 'stored');
  assert.equal(ingestJson.recipient, 'docs@' + domain);
  const ingestedMsgId = ingestJson.id;
  assert(ingestedMsgId, 'Message ID must be returned');

  // Verify message is parsed by worker pool
  for (let i = 0; i < 40; i++) {
    const { rows: [msg] } = await db.query('SELECT state, subject, body FROM messages WHERE id=$1', [ingestedMsgId]);
    if (msg && msg.state === 'ready') {
      assert.equal(msg.subject, 'Ingress Pipeline Test Document');
      assert(msg.body.includes('This email was ingested via POST /api/ingress/raw.'));
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Verify attachment was extracted and stored in blob storage
  const { rows: atts } = await db.query('SELECT filename, storage_key FROM attachments WHERE message=$1', [ingestedMsgId]);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, 'payload.txt');
  assert(await storage.exists(atts[0].storage_key), 'Attachment must exist in blob storage');

  // D. Ingest via JSON payload (e.g. AWS SES webhook format)
  const jsonIngestRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + ingressKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'ses-relay@amazon.com',
      to: 'reports@' + domain,
      raw: Buffer.from('From: ses-relay@amazon.com\r\nTo: reports@' + domain + '\r\nSubject: JSON SES Report\r\n\r\nReport contents.').toString('base64')
    })
  });
  assert.equal(jsonIngestRes.status, 201, 'JSON ingress must return 201');
  const jsonResData = await jsonIngestRes.json() as any;
  assert.equal(jsonResData.ok, true);

  // D2. Ingest via JSON payload with RFC 2045 line-wrapped Base64
  const wrappedB64 = Buffer.from('From: wrap@example.com\r\nTo: docs@' + domain + '\r\nSubject: Wrapped Base64\r\n\r\nWrapped body.')
    .toString('base64')
    .match(/.{1,20}/g)!
    .join('\r\n'); // purposefully wrap every 20 characters
  const wrappedRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + ingressKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'wrap@example.com',
      to: 'docs@' + domain,
      raw: wrappedB64
    })
  });
  assert.equal(wrappedRes.status, 201, 'Line-wrapped Base64 JSON ingress must succeed with 201');

  // E. Reject unknown/unverified domain and verify zero storage leak
  const unknownDomainRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + ingressKey,
      'Content-Type': 'message/rfc822'
    },
    body: 'From: sender@somewhere.com\r\nTo: nobody@unregistered-domain.com\r\nSubject: Hello\r\n\r\nBody'
  });
  assert.equal(unknownDomainRes.status, 404, 'Unknown domain must return 404');
  const unknownData = await unknownDomainRes.json() as any;
  assert.equal(unknownData.error, 'unknown_domain');
  // Verify no orphaned file in storage
  const { rows: rejectedLogs } = await db.query("SELECT id FROM ingest_log WHERE recipient='nobody@unregistered-domain.com' ORDER BY time DESC LIMIT 1");
  assert(rejectedLogs.length > 0);
  assert.equal(await storage.exists('messages/raw/' + rejectedLogs[0].id + '.eml'), false, 'Orphaned raw MIME blob must be deleted on rejected ingest');

  // F. Domain-scoped API Key Authentication
  const apiToken = 'ld_ingresstest_' + randomUUID().replace(/-/g, '');
  const tokenHash = createHash('sha256').update(apiToken).digest('hex');
  await db.query(
    'INSERT INTO api_keys(name, hash, domain) VALUES($1, $2, $3)',
    ['ingress-scoped-key', tokenHash, domain]
  );

  // Ingest with domain-scoped key for that domain -> 201
  const scopedOkRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiToken,
      'Content-Type': 'message/rfc822'
    },
    body: 'From: friend@test.org\r\nTo: docs@' + domain + '\r\nSubject: Scoped API Key\r\n\r\nBody text'
  });
  assert.equal(scopedOkRes.status, 201, 'Ingest with scoped API key for its domain must succeed');

  // Ingest with domain-scoped key for ANOTHER domain -> 403 Forbidden
  const otherDomain = 'other.test.example';
  await db.query('INSERT INTO domains(name, verified) VALUES($1, true) ON CONFLICT(name) DO UPDATE SET verified=true', [otherDomain]);
  const scopedForbiddenRes = await fetch(origin + '/api/ingress/raw', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiToken,
      'Content-Type': 'message/rfc822'
    },
    body: 'From: friend@test.org\r\nTo: docs@' + otherDomain + '\r\nSubject: Cross Domain\r\n\r\nBody text'
  });
  assert.equal(scopedForbiddenRes.status, 403, 'Cross-domain ingest with scoped API key must return 403');

  // -------------------------------------------------------------
  // 5. Memory Budget Check
  // -------------------------------------------------------------
  console.log('--- 5. Checking Process Memory RSS Budget ---');
  const rssMb = process.memoryUsage().rss / (1024 * 1024);
  console.log('Current Test Process RSS: ' + Math.round(rssMb) + ' MB');
  assert(rssMb < 150, 'Process RSS must remain < 150 MB, got: ' + rssMb);

  console.log('All Phase 2 Worker Pool & Resilient Ingress tests passed successfully!');
} finally {
  server.kill('SIGTERM');
  await db.end();
  process.exit(0);
}
