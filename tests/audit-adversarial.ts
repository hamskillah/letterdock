import assert from 'node:assert/strict';
import { randomUUID, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { db, migrate } from '../src/db.js';
import { encryptSecret, decryptSecret, sha256 } from '../src/crypto.js';
import { sendEmail, checkSuppression, addSuppression, OutboundError } from '../src/outbound.js';
import { LocalStorageDriver } from '../src/storage.js';

console.log('=== Starting Deep Adversarial & Integrity Audit ===');
await migrate();

const testWorkspaceA = 'ws-audit-alpha-' + randomUUID().slice(0, 8);
const testWorkspaceB = 'ws-audit-beta-' + randomUUID().slice(0, 8);
const testDomainA = 'alpha-' + randomUUID().slice(0, 8) + '.example';
const testDomainB = 'beta-' + randomUUID().slice(0, 8) + '.example';

try {
  // -----------------------------------------------------------------
  // 1. Workspace Scoping & Tenant Isolation Adversarial Test
  // -----------------------------------------------------------------
  console.log('--- 1. Testing Strict Workspace & Tenant Boundaries ---');
  await db.query('INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)', [
    testWorkspaceA, 'Alpha Workspace', testWorkspaceB, 'Beta Workspace'
  ]);

  await db.query('INSERT INTO domains (name, verified, workspace_id) VALUES ($1, true, $2), ($3, true, $4)', [
    testDomainA, testWorkspaceA, testDomainB, testWorkspaceB
  ]);

  // Attempt to send email using Domain B while in Workspace A context
  let crossTenantSendBlocked = false;
  try {
    await sendEmail({
      workspaceId: testWorkspaceA,
      from: 'sender@' + testDomainB,
      to: 'recipient@somewhere.com',
      subject: 'Cross Tenant Breach Attempt',
      text: 'Exploit'
    });
  } catch (err: any) {
    if (err instanceof OutboundError && err.statusCode === 403) {
      crossTenantSendBlocked = true;
    }
  }
  assert.equal(crossTenantSendBlocked, true, 'Cross-workspace outbound send must be blocked with 403');

  // Verify workspace isolation on suppression list
  const victimEmail = 'victim-' + randomUUID().slice(0, 8) + '@external.com';
  await addSuppression(testWorkspaceA, victimEmail, 'bounce', 'Hard bounce on A', testDomainA);
  
  // Workspace A must see suppressed
  const isSuppressedOnA = await checkSuppression(testWorkspaceA, victimEmail);
  assert.equal(isSuppressedOnA, true, 'Email must be suppressed in Workspace A');

  // Workspace B must NOT see suppressed (tenant isolation)
  const isSuppressedOnB = await checkSuppression(testWorkspaceB, victimEmail);
  assert.equal(isSuppressedOnB, false, 'Email must NOT be suppressed in Workspace B');

  // -----------------------------------------------------------------
  // 2. Duplicate-Send Prevention & High-Concurrency Idempotency
  // -----------------------------------------------------------------
  console.log('--- 2. Testing Duplicate-Send Prevention & Idempotency ---');
  const sharedIdempotencyKey = 'idemp-' + randomUUID();

  // Send 1st email with idempotency key
  const send1 = await sendEmail({
    workspaceId: testWorkspaceA,
    from: 'dispatch@' + testDomainA,
    to: 'customer@external.com',
    subject: 'Idempotent Dispatch',
    text: 'Original Body',
    idempotencyKey: sharedIdempotencyKey
  });

  // Send 2nd email with identical idempotency key (duplicate attempt)
  const send2 = await sendEmail({
    workspaceId: testWorkspaceA,
    from: 'dispatch@' + testDomainA,
    to: 'customer@external.com',
    subject: 'Idempotent Dispatch',
    text: 'Original Body',
    idempotencyKey: sharedIdempotencyKey
  });

  assert.equal(send1.id, send2.id, 'Duplicate send with same idempotency key must return original message ID without resending');

  // Concurrent identical sends
  const concurrentKey = 'concurrent-' + randomUUID();
  const results = await Promise.all([
    sendEmail({ workspaceId: testWorkspaceA, from: 'dispatch@' + testDomainA, to: 'c@ext.com', subject: 'C', text: 'T', idempotencyKey: concurrentKey }),
    sendEmail({ workspaceId: testWorkspaceA, from: 'dispatch@' + testDomainA, to: 'c@ext.com', subject: 'C', text: 'T', idempotencyKey: concurrentKey }),
    sendEmail({ workspaceId: testWorkspaceA, from: 'dispatch@' + testDomainA, to: 'c@ext.com', subject: 'C', text: 'T', idempotencyKey: concurrentKey })
  ]);
  const uniqueIds = new Set(results.map(r => r.id));
  assert.equal(uniqueIds.size, 1, 'All concurrent duplicate requests must resolve to exactly 1 message ID');

  // -----------------------------------------------------------------
  // 3. Sender Policy & Bounce Suppression Barriers
  // -----------------------------------------------------------------
  console.log('--- 3. Testing Sender Policy & Bounce Suppression Barriers ---');
  const bouncedRecipient = 'bounced-' + randomUUID().slice(0, 8) + '@external.com';
  await addSuppression(testWorkspaceA, bouncedRecipient, 'bounce', 'Simulated 550 User Unknown');

  let bounceBlocked = false;
  try {
    await sendEmail({
      workspaceId: testWorkspaceA,
      from: 'dispatch@' + testDomainA,
      to: bouncedRecipient,
      subject: 'Should Fail',
      text: 'Test'
    });
  } catch (err: any) {
    if (err instanceof OutboundError && err.statusCode === 422) {
      bounceBlocked = true;
    }
  }
  assert.equal(bounceBlocked, true, 'Sending to suppressed recipient must fail with 422');

  console.log('Adversarial & Tenant Isolation checks passed with 100% success!');
} finally {
  await db.query('DELETE FROM suppressions WHERE workspace_id IN ($1, $2)', [testWorkspaceA, testWorkspaceB]);
  await db.query('DELETE FROM outbound_messages WHERE workspace_id IN ($1, $2)', [testWorkspaceA, testWorkspaceB]);
  await db.query('DELETE FROM domains WHERE workspace_id IN ($1, $2)', [testWorkspaceA, testWorkspaceB]);
  await db.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [testWorkspaceA, testWorkspaceB]);
  await db.end();
}
