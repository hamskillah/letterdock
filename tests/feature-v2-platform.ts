import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';
const { db, migrate } = await import('../src/db.js');
const { mockSentEmails, clearMockSentEmails } = await import('../src/outbound.js');

const port = '56330';
const origin = `http://127.0.0.1:${port}`;
const password = 'v2-platform-test-password-12345';
const sessionSecret = 'v2-platform-session-secret-over-32-chars-long';
process.env.SESSION_SECRET = sessionSecret;
process.env.APP_ENCRYPTION_KEY = '01234567890123456789012345678901';

console.log('=== Starting Letterdock v2 Platform Integration Test Suite ===');

await migrate();

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
    PUBLIC_URL: origin,
    BASE_URL: origin,
    APP_PORT: port,
    PORT: port
  },
  stdio: 'ignore'
});

try {
  // Wait for server to boot
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(origin + '/health');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'Server failed to start within timeout');

  // Login as admin
  const loginRes = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': origin },
    body: JSON.stringify({ password })
  });
  assert.equal(loginRes.status, 200, 'Login failed');
  const setCookie = loginRes.headers.get('set-cookie');
  assert.ok(setCookie, 'Session cookie must be returned');
  const sessionCookie = setCookie.split(';')[0];
  const authHeaders = {
    'Cookie': sessionCookie,
    'Origin': origin,
    'Content-Type': 'application/json'
  };

  // Setup verified test domain
  const testDomain = 'v2test.letterdock.local';
  await db.query("INSERT INTO domains(name, verified, workspace_id) VALUES ($1, true, 'default') ON CONFLICT (name) DO UPDATE SET verified=true", [testDomain]);

  // Create API Key
  const rawKey = 're_v2test_' + randomBytes(16).toString('hex');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  await db.query("INSERT INTO api_keys(name, hash, domain, workspace_id) VALUES ('v2-key', $1, $2, 'default')", [keyHash, testDomain]);
  const bearerHeaders = {
    'Authorization': 'Bearer ' + rawKey,
    'Content-Type': 'application/json'
  };

  // -------------------------------------------------------------
  // Pillar 1: Templates Engine & API Integration
  // -------------------------------------------------------------
  console.log('--- 1. Testing Templates CRUD & Template Email Sending ---');

  // Clean up any test artifacts
  await db.query("DELETE FROM templates WHERE slug LIKE 'welcome-onboarding%'");
  await db.query("DELETE FROM inbound_rules WHERE name LIKE '%Discord%'");

  const tplSlug = 'welcome-onboarding-' + randomBytes(4).toString('hex');

  // Create Template
  const createTplRes = await fetch(origin + '/templates', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Welcome Onboarding',
      slug: tplSlug,
      subject: 'Welcome to Letterdock, {{ name }}!',
      html_content: '<h1>Hello {{ name }}</h1><p>Your team is {{ team }}.</p><a href="https://example.com/activate">Activate</a>',
      text_content: 'Hello {{ name }}. Your team is {{ team }}.',
      sample_data: { name: 'Alex', team: 'Platform Engineering' }
    })
  });
  assert.equal(createTplRes.status, 201, 'Create template should succeed');
  const tplData = await createTplRes.json();
  assert.equal(tplData.slug, tplSlug);
  assert.ok(Array.isArray(tplData.variables), 'Variables must be auto-extracted');
  const varKeys = tplData.variables.map((v: any) => v.key).sort();
  assert.deepEqual(varKeys, ['name', 'team']);

  // Preview Template
  const previewRes = await fetch(origin + `/templates/${tplData.id}/preview`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ variables: { name: 'Sarah', team: 'Design Ops' } })
  });
  assert.equal(previewRes.status, 200);
  const previewData = await previewRes.json();
  assert.equal(previewData.rendered.subject, 'Welcome to Letterdock, Sarah!');
  assert.ok(previewData.rendered.html.includes('Hello Sarah'));

  // Send Email with Template & Tracking via Bearer API Key
  clearMockSentEmails();
  const sendRes = await fetch(origin + '/emails', {
    method: 'POST',
    headers: bearerHeaders,
    body: JSON.stringify({
      from: `Letterdock <system@${testDomain}>`,
      to: ['developer@client.com'],
      template: tplSlug,
      variables: { name: 'Budi', team: 'Alpha Squad' },
      track_opens: true,
      track_clicks: true
    })
  });
  const sendData = await sendRes.json();
  if (sendRes.status !== 200) {
    console.error('Send error:', sendRes.status, sendData);
  }
  assert.equal(sendRes.status, 200, 'Sending with template must succeed');
  assert.ok(sendData.id, 'Dispatched email ID must be returned');

  // Verify rendered outbound message from database
  const { rows: [sentRow] } = await db.query(
    'SELECT id, subject, html_body, text_body, track_opens, track_clicks, status FROM outbound_messages WHERE id = $1',
    [sendData.id]
  );
  assert.ok(sentRow, 'Outbound message record must exist');
  assert.equal(sentRow.subject, 'Welcome to Letterdock, Budi!');
  assert.ok(sentRow.html_body?.includes('Hello Budi'));
  assert.ok(sentRow.html_body?.includes('/t/c/'), 'Tracking click URL must be injected');
  assert.ok(sentRow.html_body?.includes('/t/o/'), 'Tracking open pixel must be injected');
  assert.equal(sentRow.status, 'sent');
  console.log('✓ Pillar 1: Templates CRUD, auto-extraction, preview & sendEmail drop-in passed');

  // -------------------------------------------------------------
  // Pillar 2: Inbound Automation Rules API
  // -------------------------------------------------------------
  console.log('--- 2. Testing Inbound Automation Rules API ---');
  const createRuleRes = await fetch(origin + '/api/rules', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Forward Alerts to Discord',
      priority: 50,
      enabled: true,
      match_all: true,
      conditions: [
        { field: 'subject', operator: 'contains', value: 'ALERT' }
      ],
      actions: [
        { type: 'add_label', params: { label: 'urgent' } },
        { type: 'star' }
      ]
    })
  });
  assert.equal(createRuleRes.status, 201, 'Create rule should succeed');
  const ruleData = await createRuleRes.json();
  assert.equal(ruleData.name, 'Forward Alerts to Discord');

  // Test simulation
  const testRuleRes = await fetch(origin + '/api/rules/test', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      rule: ruleData,
      message: {
        subject: '[ALERT] High Latency Detected',
        sender: 'monitor@infra.com',
        recipient: 'oncall@letterdock.local',
        body: 'Latency spiked to 450ms',
        headers: {},
        hasAttachments: false
      }
    })
  });
  assert.equal(testRuleRes.status, 200);
  const simData = await testRuleRes.json();
  assert.equal(simData.matches, true, 'Rule should match alert subject');
  assert.equal(simData.simulatedActions.length, 2);
  console.log('✓ Pillar 2: Inbound Automation Rules CRUD & simulation passed');

  // -------------------------------------------------------------
  // Pillar 3: Search Query & Threading API
  // -------------------------------------------------------------
  console.log('--- 3. Testing Advanced Search & Conversation Threading ---');
  const threadId = 'thread-test-' + randomUUID();
  const msgId1 = randomUUID();
  await db.query(
    `INSERT INTO messages (id, domain, sender, recipient, subject, body, html, state, thread_id, workspace_id)
     VALUES ($1, $2, 'alice@example.com', 'bob@example.com', 'Discussion on Project', 'Initial discussion message', '<p>Initial</p>', 'ready', $3, 'default')`,
    [msgId1, testDomain, threadId]
  );

  // Search API with operator syntax
  const searchRes = await fetch(origin + `/api/messages?q=from:alice subject:Discussion`, {
    headers: authHeaders
  });
  assert.equal(searchRes.status, 200);
  const searchResults = await searchRes.json();
  assert.ok(Array.isArray(searchResults));
  assert.ok(searchResults.some((m: any) => m.id === msgId1), 'Search should locate message by operator syntax');

  // Thread API
  const threadRes = await fetch(origin + `/api/threads/${threadId}`, {
    headers: authHeaders
  });
  assert.equal(threadRes.status, 200);
  const threadData = await threadRes.json();
  assert.equal(threadData.thread_id, threadId);
  assert.ok(threadData.messages.length >= 1, 'Thread must contain message');
  console.log('✓ Pillar 3: Advanced operator search & conversation thread API passed');

  // -------------------------------------------------------------
  // Pillar 4: Analytics, Open Pixel & Click Tracking Proxy
  // -------------------------------------------------------------
  console.log('--- 4. Testing Analytics, Open Pixel, & Click Tracking ---');

  // Extract open pixel URL and click URL from sent email HTML
  const sentHtml = sentRow.html_body || '';
  const openTokenMatch = sentHtml.match(/\/t\/o\/([a-zA-Z0-9_.-]+)\.gif/);
  assert.ok(openTokenMatch, 'Must find open token in HTML');
  const openToken = openTokenMatch[1];

  const clickTokenMatch = sentHtml.match(/\/t\/c\/([a-zA-Z0-9_.-]+)/);
  assert.ok(clickTokenMatch, 'Must find click token in HTML');
  const clickToken = clickTokenMatch[1];

  // Fetch Open Pixel (Public endpoint, no auth required)
  const pixelRes = await fetch(origin + `/t/o/${openToken}.gif`);
  assert.equal(pixelRes.status, 200, 'Open pixel must return 200 OK');
  assert.equal(pixelRes.headers.get('content-type'), 'image/gif');
  const pixelBytes = Buffer.from(await pixelRes.arrayBuffer());
  assert.ok(pixelBytes.length > 0, 'Pixel GIF bytes must not be empty');

  // Fetch Click Tracking Redirect (Public endpoint, redirect 302)
  const clickRes = await fetch(origin + `/t/c/${clickToken}`, {
    redirect: 'manual'
  });
  assert.equal(clickRes.status, 302, 'Click proxy must redirect with 302');
  assert.equal(clickRes.headers.get('location'), 'https://example.com/activate');

  // Fetch Analytics Overview (Admin API)
  const analyticsRes = await fetch(origin + '/api/analytics/overview', {
    headers: authHeaders
  });
  assert.equal(analyticsRes.status, 200);
  const stats = await analyticsRes.json();
  assert.ok(stats.totals.sent >= 1, 'Sent count should be >= 1');
  assert.ok(stats.totals.opens >= 1, 'Open count should be recorded >= 1');
  assert.ok(stats.totals.clicks >= 1, 'Click count should be recorded >= 1');
  assert.ok(stats.rates.openRate > 0, 'Open rate should be > 0%');
  assert.ok(stats.rates.clickRate > 0, 'Click rate should be > 0%');

  // Fetch Analytics Events list
  const eventsRes = await fetch(origin + '/api/analytics/events', {
    headers: authHeaders
  });
  assert.equal(eventsRes.status, 200);
  const eventsData = await eventsRes.json();
  assert.ok(eventsData.events.length >= 2, 'Events list must record delivery, open, and click');
  console.log('✓ Pillar 4: Open pixel, click redirect proxy, event recording & analytics overview passed');

  console.log('\n======================================================');
  console.log('★ ALL 4 LETTERDOCK v2 PLATFORM PILLARS VERIFIED LIVE! ★');
  console.log('======================================================');
} finally {
  server.kill('SIGTERM');
}
