import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Resend } from 'resend';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';
const { db, migrate } = await import('../src/db.js');
const { mockSentEmails, clearMockSentEmails } = await import('../src/outbound.js');
const { decryptSecret } = await import('../src/crypto.js');

const origin = 'http://127.0.0.1:56322';
const password = 'phase3-secret-password-12345';
const sessionSecret = 'phase3-session-secret-over-32-chars-long';
process.env.SESSION_SECRET = sessionSecret;

console.log('=== Starting Phase 3: Outbound Relay & Resend Parity Tests ===');

await migrate();

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    PUBLIC_URL: origin,
    APP_PORT: '56322',
    PORT: '56322'
  },
  stdio: 'ignore'
});

try {
  // Wait for server to be responsive
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(origin + '/api/health');
      if (res.ok || res.status === 401) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // -------------------------------------------------------------
  // 1. Setup Verified Test Domain and API Key
  // -------------------------------------------------------------
  console.log('--- 1. Setting Up Test Domains & Scoped API Keys ---');
  const domain = 'outbound.test.example';
  const unverifiedDomain = 'unverified.test.example';

  await db.query("DELETE FROM outbound_profiles WHERE domain LIKE '%.test.example'");
  await db.query("DELETE FROM suppressions WHERE email LIKE '%@destination.com' OR email LIKE '%@target.com'");
  await db.query("DELETE FROM outbound_messages WHERE domain LIKE '%.test.example'");

  await db.query(`
    INSERT INTO domains (name, verified) VALUES ($1, true)
    ON CONFLICT (name) DO UPDATE SET verified = true, removed_at = NULL
  `, [domain]);

  await db.query(`
    INSERT INTO domains (name, verified) VALUES ($1, false)
    ON CONFLICT (name) DO UPDATE SET verified = false, removed_at = NULL
  `, [unverifiedDomain]);

  // Create an unrestricted API key for testing
  const masterKeyRaw = 're_' + randomBytes(32).toString('hex');
  const { createHash } = await import('node:crypto');
  const masterHash = createHash('sha256').update(masterKeyRaw).digest('hex');
  await db.query(`
    INSERT INTO api_keys (name, hash, domain, workspace_id)
    VALUES ('Master Test Key', $1, NULL, 'default')
  `, [masterHash]);

  // Create a domain-scoped API key
  const scopedKeyRaw = 're_' + randomBytes(32).toString('hex');
  const scopedHash = createHash('sha256').update(scopedKeyRaw).digest('hex');
  await db.query(`
    INSERT INTO api_keys (name, hash, domain, workspace_id)
    VALUES ('Scoped Test Key', $1, $2, 'default')
  `, [scopedHash, domain]);

  // -------------------------------------------------------------
  // 2. Test Official Resend SDK Drop-In Parity
  // -------------------------------------------------------------
  console.log('--- 2. Testing Official Resend SDK Endpoints ---');
  clearMockSentEmails();
  const sdk = new Resend(masterKeyRaw, { baseUrl: origin });

  // A. Send single email
  const sendRes = await sdk.emails.send({
    from: 'Test Sender <sender@' + domain + '>',
    to: ['recipient1@somewhere.com', 'recipient2@somewhere.com'],
    subject: 'Welcome to Letterdock Phase 3',
    html: '<h1>Hello</h1><p>Relayed via Letterdock!</p>',
    text: 'Hello. Relayed via Letterdock!'
  });
  assert(sendRes.data, 'sdk.emails.send must return data object');
  assert(sendRes.data.id, 'sdk.emails.send must return an email id');
  assert.equal(sendRes.error, null, 'sdk.emails.send must have null error');

  const sentId = sendRes.data.id;

  // Verify database record
  const { rows: [storedOutbound] } = await db.query('SELECT * FROM outbound_messages WHERE id = $1', [sentId]);
  assert(storedOutbound, 'Outbound message must be stored in database');
  assert.equal(storedOutbound.status, 'sent');
  assert.equal(storedOutbound.domain, domain);
  assert.equal(storedOutbound.subject, 'Welcome to Letterdock Phase 3');
  assert.equal(storedOutbound.provider, 'mock');
  assert(storedOutbound.provider_message_id?.startsWith('mock-'));

  // B. Get email details
  const getRes = await sdk.emails.get(sentId);
  assert(getRes.data, 'sdk.emails.get must return data object');
  assert.equal(getRes.data.id, sentId);
  assert.equal(getRes.data.last_event, 'sent');

  // C. Batch send emails
  clearMockSentEmails();
  const batchRes = await sdk.batch.send([
    {
      from: 'batch1@' + domain,
      to: 'user1@target.com',
      subject: 'Batch Email 1',
      html: '<p>Batch 1</p>'
    },
    {
      from: 'batch2@' + domain,
      to: 'user2@target.com',
      subject: 'Batch Email 2',
      html: '<p>Batch 2</p>'
    }
  ]);

  assert(batchRes.data, 'sdk.batch.send must return data');
  const batchItems = Array.isArray(batchRes.data) ? batchRes.data : (batchRes.data as any).data;
  assert(Array.isArray(batchItems), 'batch items must be array');
  assert.equal(batchItems.length, 2);
  const { rows: batchRows } = await db.query(
    'SELECT * FROM outbound_messages WHERE id = ANY($1)',
    [batchItems.map((b: any) => b.id)]
  );
  assert.equal(batchRows.length, 2);
  assert(batchRows.every(r => r.status === 'sent'));

  // D. Domains API via Resend SDK
  const domainList = await sdk.domains.list();
  assert(domainList.data, 'sdk.domains.list must return data');
  const domainItems = Array.isArray(domainList.data) ? domainList.data : (domainList.data as any).data;
  assert(Array.isArray(domainItems), 'domain items must be array');
  const foundDomain = domainItems.find((d: any) => d.name === domain);
  assert(foundDomain, 'Target domain must be listed in domains');
  assert.equal(foundDomain.status, 'verified');

  const domainGet = await sdk.domains.get(domain);
  assert(domainGet.data, 'sdk.domains.get must return data');
  assert.equal(domainGet.data.name, domain);
  assert(Array.isArray(domainGet.data.records), 'domain must contain DNS records array');

  const domainVerify = await sdk.domains.verify(domain);
  assert(domainVerify.data, 'sdk.domains.verify must return data');
  assert.equal(domainVerify.data.status, 'verified');

  // E. API Keys API via Resend SDK
  const newKeyRes = await sdk.apiKeys.create({
    name: 'Dynamic Created Key'
  });
  assert(newKeyRes.data, 'sdk.apiKeys.create must return data');
  assert(newKeyRes.data.token.startsWith('re_'), 'API key token must start with re_');

  const keyListRes = await sdk.apiKeys.list();
  assert(keyListRes.data, 'sdk.apiKeys.list must return data');
  const keyItems = Array.isArray(keyListRes.data) ? keyListRes.data : (keyListRes.data as any).data;
  assert(Array.isArray(keyItems), 'key items must be array');
  assert(keyItems.some((k: any) => k.id === newKeyRes.data?.id));

  const deleteKeyRes = await sdk.apiKeys.remove(newKeyRes.data.id);
  assert(deleteKeyRes.data, 'sdk.apiKeys.remove must succeed');
  assert.equal(deleteKeyRes.data.deleted, true);

  // -------------------------------------------------------------
  // 3. Test Sender Verification & Abuse Protection
  // -------------------------------------------------------------
  console.log('--- 3. Testing Sender Verification & Authorization Barriers ---');

  // A. Reject send from unverified domain -> 403
  const unverifiedSend = await sdk.emails.send({
    from: 'attacker@' + unverifiedDomain,
    to: 'victim@target.com',
    subject: 'Spam from unverified domain',
    html: '<p>Spam</p>'
  });
  assert.equal(unverifiedSend.data, null, 'Sending from unverified domain must fail');
  assert(unverifiedSend.error, 'Error must be populated');
  assert.equal(unverifiedSend.error.statusCode, 403);

  // B. Enforce Domain-Scoped API Key Isolation -> 403
  const scopedSdk = new Resend(scopedKeyRaw, { baseUrl: origin });
  const crossDomainSend = await scopedSdk.emails.send({
    from: 'legit@another-verified.com',
    to: 'victim@target.com',
    subject: 'Cross domain spoof',
    html: '<p>Spoof</p>'
  });
  assert.equal(crossDomainSend.data, null, 'Cross-domain send on scoped key must fail');
  assert.equal(crossDomainSend.error?.statusCode, 403);

  // C. Idempotency Key Deduplication
  const idempotencyKey = 'idem-' + randomUUID();
  const send1 = await fetch(origin + '/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + masterKeyRaw,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({
      from: 'idem@' + domain,
      to: 'target@example.com',
      subject: 'Idempotency Test',
      html: '<p>Hello</p>'
    })
  });
  assert.equal(send1.status, 200);
  const data1 = await send1.json() as { id: string };

  const send2 = await fetch(origin + '/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + masterKeyRaw,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({
      from: 'idem@' + domain,
      to: 'target@example.com',
      subject: 'Idempotency Test',
      html: '<p>Hello</p>'
    })
  });
  assert.equal(send2.status, 200);
  const data2 = await send2.json() as { id: string };
  assert.equal(data1.id, data2.id, 'Idempotent calls must return the same message ID');

  // -------------------------------------------------------------
  // 4. Test Suppression List, Webhook Auth & CC/BCC Protection
  // -------------------------------------------------------------
  console.log('--- 4. Testing Suppression List, Webhook Auth & CC/BCC Protection ---');
  const bounceTarget = 'bounced-user@destination.com';

  // A. Unauthenticated bounce webhook must be rejected with 401
  const unauthBounce = await fetch(origin + '/api/webhooks/bounces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: bounceTarget,
      reason: 'hard_bounce'
    })
  });
  assert.equal(unauthBounce.status, 401, 'Unauthenticated bounce webhook must return 401');

  // B. Authenticated bounce webhook succeeds
  const bounceRes = await fetch(origin + '/api/webhooks/bounces', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + masterKeyRaw,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: bounceTarget,
      reason: 'hard_bounce',
      details: '550 5.1.1 User unknown',
      domain
    })
  });
  assert.equal(bounceRes.status, 200);
  const bounceData = await bounceRes.json() as { ok: boolean; suppressed: boolean };
  assert.equal(bounceData.suppressed, true);

  // C. Verify recipient is suppressed when placed in 'to'
  const suppressedSend = await sdk.emails.send({
    from: 'support@' + domain,
    to: bounceTarget,
    subject: 'Should be suppressed',
    html: '<p>Test</p>'
  });
  assert.equal(suppressedSend.data, null, 'Sending to suppressed recipient must fail');
  assert.equal(suppressedSend.error?.statusCode, 422, 'Suppressed recipient must return 422');

  // D. Verify recipient is also suppressed when placed in 'cc' or 'bcc'
  const ccSuppressedSend = await sdk.emails.send({
    from: 'support@' + domain,
    to: 'innocent@example.com',
    cc: [bounceTarget],
    subject: 'Suppressed CC',
    html: '<p>Test</p>'
  });
  assert.equal(ccSuppressedSend.data, null, 'Sending with suppressed recipient in CC must fail');
  assert.equal(ccSuppressedSend.error?.statusCode, 422, 'Suppressed CC recipient must return 422');

  const bccSuppressedSend = await sdk.emails.send({
    from: 'support@' + domain,
    to: 'innocent@example.com',
    bcc: [bounceTarget],
    subject: 'Suppressed BCC',
    html: '<p>Test</p>'
  });
  assert.equal(bccSuppressedSend.data, null, 'Sending with suppressed recipient in BCC must fail');
  assert.equal(bccSuppressedSend.error?.statusCode, 422, 'Suppressed BCC recipient must return 422');

  // E. Verify suppression can be cleared
  const delSuppression = await fetch(origin + '/api/suppressions/' + encodeURIComponent(bounceTarget), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + masterKeyRaw }
  });
  assert.equal(delSuppression.status, 200);

  // Send to recipient again -> now succeeds
  const unsuppressedSend = await sdk.emails.send({
    from: 'support@' + domain,
    to: bounceTarget,
    subject: 'Unsuppressed send',
    html: '<p>Now allowed</p>'
  });
  assert(unsuppressedSend.data?.id, 'Send must succeed after removing suppression');

  // F. Multi-Tenant Domain & Message Isolation
  console.log('--- 4b. Testing Multi-Tenant Domain & Message Isolation ---');
  await db.query("INSERT INTO workspaces (id, name) VALUES ('tenant-b', 'Tenant B') ON CONFLICT DO NOTHING");
  const tenantBDomain = 'tenant-b.test.example';
  await db.query(`
    INSERT INTO domains (name, verified, workspace_id) VALUES ($1, true, 'tenant-b')
    ON CONFLICT (name) DO UPDATE SET verified = true, workspace_id = 'tenant-b', removed_at = NULL
  `, [tenantBDomain]);

  const crossTenantSend = await sdk.emails.send({
    from: 'attacker@' + tenantBDomain,
    to: 'target@example.com',
    subject: 'Cross tenant send',
    html: '<p>Hijack</p>'
  });
  assert.equal(crossTenantSend.data, null, 'Sending from another workspace domain must fail');
  assert.equal(crossTenantSend.error?.statusCode, 403, 'Cross-tenant domain send must return 403');

  const tenantBKeyRaw = 're_' + randomBytes(32).toString('hex');
  const tenantBKeyHash = createHash('sha256').update(tenantBKeyRaw).digest('hex');
  await db.query(`
    INSERT INTO api_keys (name, hash, domain, workspace_id)
    VALUES ('Tenant B Key', $1, NULL, 'tenant-b')
  `, [tenantBKeyHash]);

  const tenantBSdk = new Resend(tenantBKeyRaw, { baseUrl: origin });
  const leakCheck = await tenantBSdk.emails.get(sentId);
  assert.equal(leakCheck.data, null, 'Tenant B cannot inspect emails from default workspace');
  assert.equal(leakCheck.error?.statusCode, 404, 'Cross-tenant email retrieval must return 404');

  // -------------------------------------------------------------
  // 5. Test Outbound Profiles Management & Encryption
  // -------------------------------------------------------------
  console.log('--- 5. Testing Outbound Profiles Management & Encryption ---');
  const profileDomain = 'profile.test.example';
  await db.query('INSERT INTO domains(name, verified) VALUES($1, true) ON CONFLICT DO NOTHING', [profileDomain]);

  const profileRes = await fetch(origin + '/api/outbound/profiles', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + masterKeyRaw,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      domain: profileDomain,
      provider: 'smtp',
      credentials: {
        host: 'smtp.mailgun.org',
        port: 587,
        user: 'test-user',
        pass: 'super-secret-smtp-password'
      },
      from_name: 'Profile Sender',
      from_email: 'noreply@' + profileDomain,
      is_default: false
    })
  });
  assert.equal(profileRes.status, 200);

  // Verify database encryption (credentials must not be in plaintext)
  const { rows: [savedProfile] } = await db.query(
    'SELECT credentials_encrypted, provider FROM outbound_profiles WHERE domain = $1',
    [profileDomain]
  );
  assert(savedProfile, 'Profile must be saved');
  assert.equal(savedProfile.provider, 'smtp');
  assert(!savedProfile.credentials_encrypted.includes('super-secret-smtp-password'), 'Credentials must not be plaintext');
  assert(savedProfile.credentials_encrypted.startsWith('v1.'), 'Credentials must be encrypted with v1 AES-256-GCM');

  const decryptedCreds = JSON.parse(decryptSecret(savedProfile.credentials_encrypted, 'outbound'));
  assert.equal(decryptedCreds.pass, 'super-secret-smtp-password');

  // -------------------------------------------------------------
  // 6. Test OpenAPI 3.1 & Scalar Documentation UI
  // -------------------------------------------------------------
  console.log('--- 6. Testing OpenAPI 3.1 Specification & Scalar UI ---');

  const openApiRes = await fetch(origin + '/api/openapi.json');
  assert.equal(openApiRes.status, 200);
  const spec = await openApiRes.json() as any;
  assert.equal(spec.openapi, '3.1.0', 'Spec must be OpenAPI 3.1.0');
  assert(spec.paths['/emails'], 'Spec must define /emails path');
  assert(spec.paths['/emails/batch'], 'Spec must define /emails/batch path');
  assert(spec.paths['/domains'], 'Spec must define /domains path');
  assert(spec.paths['/api-keys'], 'Spec must define /api-keys path');

  // Scalar UI endpoint
  const docsRes = await fetch(origin + '/docs/');
  assert.equal(docsRes.status, 200);
  const docsHtml = await docsRes.text();
  assert(docsHtml.includes('<title>'), 'Docs must return an HTML document');
  assert(docsHtml.includes('scalar') || docsHtml.includes('Scalar'), 'Docs must reference Scalar');

  // -------------------------------------------------------------
  // 7. Memory RSS Verification
  // -------------------------------------------------------------
  console.log('--- 7. Checking Process Memory RSS Budget ---');
  const memoryUsage = process.memoryUsage();
  const rssMB = Math.round(memoryUsage.rss / 1024 / 1024);
  console.log('Current Test Process RSS: ' + rssMB + ' MB');
  assert(rssMB < 150, 'Process memory RSS (' + rssMB + ' MB) must be below 150 MB ceiling');

  console.log('All Phase 3 Outbound Relay & Resend Parity tests passed successfully!');
} catch (err) {
  console.error('Test failed with error:', err);
  process.exit(1);
} finally {
  server.kill('SIGTERM');
  await db.end();
}
