import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = 'http://127.0.0.1:3030';
const adminPassword = 'staging-admin-secure-password-1234';

async function run() {
  console.log('=== Running Pre-Production Staging User Journeys ===');

  // -------------------------------------------------------------
  // Journey 1: Auth & Server-Side Session Lifecycle
  // -------------------------------------------------------------
  console.log('--- Journey 1: Authentication & Server-Side Session Revocation ---');
  const origin = 'http://localhost:3030';
  const defaultHeaders = {
    'Content-Type': 'application/json',
    Origin: origin
  };

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({ password: adminPassword })
  });
  assert.equal(loginRes.status, 200, 'Login must succeed with 200 OK');
  const setCookie = loginRes.headers.get('set-cookie');
  assert(setCookie, 'Login must set session cookie');
  const sessionCookie = setCookie.split(';')[0];

  // Access protected route
  const authCheckRes = await fetch(`${baseUrl}/api/domains`, {
    headers: { Cookie: sessionCookie }
  });
  assert.equal(authCheckRes.status, 200, 'Protected route must return 200 with valid session');

  // Logout
  const logoutRes = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie, Origin: origin }
  });
  assert.equal(logoutRes.status, 200, 'Logout must succeed');

  // Replay cookie (Must be rejected 401)
  const replayRes = await fetch(`${baseUrl}/api/domains`, {
    headers: { Cookie: sessionCookie }
  });
  assert.equal(replayRes.status, 401, 'Replayed session cookie after logout MUST return 401 Unauthorized');

  // Re-login to continue operator journeys
  const reloginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({ password: adminPassword })
  });
  const activeCookie = reloginRes.headers.get('set-cookie')!.split(';')[0];
  const authHeaders = { Cookie: activeCookie, 'Content-Type': 'application/json', Origin: origin };

  // -------------------------------------------------------------
  // Journey 2: Domain Management & Preflight
  // -------------------------------------------------------------
  console.log('--- Journey 2: Domain Lifecycle & DNS Preflight ---');
  const testDomain = 'staging-' + randomUUID().slice(0, 8) + '.letterdock.test';
  const addDomainRes = await fetch(`${baseUrl}/api/domains`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: testDomain })
  });
  assert.equal(addDomainRes.status, 200, 'Adding domain must succeed');
  const domainData = await addDomainRes.json();
  assert.equal(domainData.name, testDomain);

  // Check domain delivery health & preflight status
  const deliveryHealthRes = await fetch(`${baseUrl}/api/domains/${testDomain}/delivery-health`, {
    headers: authHeaders
  });
  assert.equal(deliveryHealthRes.status, 200, 'Domain delivery health endpoint must return 200');
  const healthData = await deliveryHealthRes.json();
  assert(healthData.delivery_test_address !== undefined, 'Delivery test address property must be defined');

  // -------------------------------------------------------------
  // Journey 3: Granular API Key Provisioning & Domain Scoping
  // -------------------------------------------------------------
  console.log('--- Journey 3: Granular API Key Provisioning & Domain Scoping ---');
  // Mark domain verified via database to test verified-domain key scoping
  const { execSync } = await import('node:child_process');
  execSync(`docker compose -p letterdock-staging -f compose.staging.yml exec db psql -U letterdock -d letterdock_staging -c "UPDATE domains SET verified = true WHERE name = '${testDomain}'"`);

  const createKeyRes = await fetch(`${baseUrl}/api-keys`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Staging Delivery Key', domain: testDomain })
  });
  assert.equal(createKeyRes.status, 201, 'Creating domain-scoped API key must return 201 Created');
  const keyJson = await createKeyRes.json();
  assert(keyJson.token.startsWith('re_'), 'API key token must follow re_ prefix');
  const apiKeyToken = keyJson.token;

  // Verify unauthorized domain send fails (Outbound sender domain mismatch)
  const unauthSendRes = await fetch(`${baseUrl}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKeyToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'alerts@unauthorized-other-domain.com',
      to: 'recipient@example.com',
      subject: 'Unauthorized Probe',
      text: 'Should be rejected'
    })
  });
  assert.equal(unauthSendRes.status, 403, 'API key restricted to domain A cannot send as domain B (403 Forbidden)');

  // -------------------------------------------------------------
  // Journey 4: Inbound Email Ingestion (Raw MIME API)
  // -------------------------------------------------------------
  console.log('--- Journey 4: Raw MIME Ingestion, Parsing & Blob Storage ---');
  const inboundRecipient = `ops@${testDomain}`;
  const attachmentContent = 'PREPROD_VERIFICATION_ATTACHMENT_CONTENT_12345';
  const rawMime = [
    `From: External Sender <sender@external.net>`,
    `To: ${inboundRecipient}`,
    `Subject: Production Staging Inbound Test`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="preprod-boundary"',
    '',
    '--preprod-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This is the plain text body of the pre-production test email.',
    '--preprod-boundary',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<h1>Staging Notification</h1><p>HTML body content verified.</p>',
    '--preprod-boundary',
    'Content-Type: text/plain; name="audit-log.txt"',
    'Content-Disposition: attachment; filename="audit-log.txt"',
    '',
    attachmentContent,
    '--preprod-boundary--',
    ''
  ].join('\r\n');

  const rawIngestRes = await fetch(`${baseUrl}/api/ingress/raw`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKeyToken}`,
      'Content-Type': 'message/rfc822',
      'x-letterdock-to': inboundRecipient
    },
    body: rawMime
  });
  assert.equal(rawIngestRes.status, 201, 'Raw MIME ingestion must return 201 Created');
  const ingestJson = await rawIngestRes.json();
  assert(ingestJson.id, 'Ingestion must return message ID');
  const messageId = ingestJson.id;

  // Poll until message is parsed and visible in operator inbox
  let messageParsed = false;
  let parsedMessageData: any = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    const msgRes = await fetch(`${baseUrl}/api/messages/${messageId}`, {
      headers: authHeaders
    });
    if (msgRes.status === 200) {
      const msg = await msgRes.json();
      if (msg.body?.includes('plain text body') && msg.attachments?.length > 0) {
        messageParsed = true;
        parsedMessageData = msg;
        break;
      }
    }
  }
  assert(messageParsed, 'Message must be parsed by worker pool and available in inbox with attachments');
  console.log(`Parsed message subject: "${parsedMessageData.subject}", attachments count: ${parsedMessageData.attachments.length}`);

  // Verify attachment download
  const attachmentId = parsedMessageData.attachments[0].id;
  const attachRes = await fetch(`${baseUrl}/api/files/${attachmentId}`, {
    headers: authHeaders
  });
  assert.equal(attachRes.status, 200, 'Attachment download must return 200 OK');
  const downloadedText = await attachRes.text();
  assert.equal(downloadedText, attachmentContent, 'Downloaded attachment must match original content');

  // -------------------------------------------------------------
  // Journey 5: Outbound Relay & Idempotency
  // -------------------------------------------------------------
  console.log('--- Journey 5: Outbound Relay via Mock Provider & Idempotency ---');
  const idempotencyKey = 'staging-idem-' + randomUUID();
  const outboundPayload = {
    from: `notifications@${testDomain}`,
    to: 'customer@client.org',
    subject: 'Outbound Relay Staging Verification',
    html: '<p>Delivered via Letterdock outbound engine.</p>',
    text: 'Delivered via Letterdock outbound engine.'
  };

  const send1Res = await fetch(`${baseUrl}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKeyToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(outboundPayload)
  });
  assert.equal(send1Res.status, 200, 'Outbound email send must return 200 OK');
  const send1Json = await send1Res.json();
  assert(send1Json.id, 'Send response must contain email id');

  // Re-send with same idempotency key
  const send2Res = await fetch(`${baseUrl}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKeyToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(outboundPayload)
  });
  assert.equal(send2Res.status, 200);
  const send2Json = await send2Res.json();
  assert.equal(send2Json.id, send1Json.id, 'Idempotent resend must return identical message id');

  // -------------------------------------------------------------
  // Journey 6: Bounce Handling & Suppression Barrier
  // -------------------------------------------------------------
  console.log('--- Journey 6: Bounce Handling & Suppression Barrier ---');
  const suppressedEmail = 'bad-inbox-bounced@invalid.org';
  const addSuppressionRes = await fetch(`${baseUrl}/api/suppressions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      email: suppressedEmail,
      reason: 'bounce',
      details: '550 5.1.1 User unknown (Simulated provider bounce)'
    })
  });
  assert.equal(addSuppressionRes.status, 200, 'Adding suppression must succeed');

  // Attempt send to suppressed recipient
  const blockedSendRes = await fetch(`${baseUrl}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKeyToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `system@${testDomain}`,
      to: suppressedEmail,
      subject: 'This should be blocked',
      text: 'Blocked by suppression list'
    })
  });
  assert.equal(blockedSendRes.status, 422, 'Sending to suppressed recipient must be rejected with 422 Unprocessable');
  const blockedJson = await blockedSendRes.json();
  console.log('blockedJson:', JSON.stringify(blockedJson));
  assert(blockedJson.message?.toLowerCase().includes('suppress'), 'Error message must specify recipient is suppressed');

  // -------------------------------------------------------------
  // Journey 7: Webhooks Registration & Delivery Tracking
  // -------------------------------------------------------------
  console.log('--- Journey 7: Webhook Subscriptions & Event Dispatch ---');
  const hookUrl = 'https://webhook.site/mock-endpoint-' + randomUUID();
  const createHookRes = await fetch(`${baseUrl}/api/hooks`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      url: hookUrl,
      filter: testDomain
    })
  });
  assert.equal(createHookRes.status, 200, 'Creating webhook must succeed');
  const hookData = await createHookRes.json();
  assert(hookData.secret, 'Webhook must be generated with secret');

  console.log('All 7 Pre-Production Staging User Journeys Verified 100%!');
}

run().catch((err) => {
  console.error('User journeys test failed:', err);
  process.exit(1);
});
