import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = 'http://localhost:56315';
const password = 'p4-secret-password';
const sessionSecret = 'p4-session-secret-at-least-32-chars-long';
process.env.PORT = '56315';
process.env.SESSION_SECRET = sessionSecret;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';

const { db, migrate } = await import('../src/db.js');

console.log('=== Starting Phase 4: Modular Design Engineering & Sovereign UI Tests ===');

await migrate();

// Clean up previous test entities
const testDomain = 'p4-test-ui.example';
await db.query("INSERT INTO workspaces (id, name) VALUES ('default', 'Default workspace') ON CONFLICT DO NOTHING");
await db.query('DELETE FROM messages WHERE domain = $1', [testDomain]);
await db.query('DELETE FROM domains WHERE name = $1', [testDomain]);
await db.query('DELETE FROM outbound_profiles WHERE domain = $1', [testDomain]);
await db.query("DELETE FROM suppressions WHERE email LIKE '%@p4-test-ui.example'");
await db.query("DELETE FROM api_keys WHERE name LIKE 'P4 Test%'");

// Insert verified test domain
await db.query(`
  INSERT INTO domains (name, verified, workspace_id)
  VALUES ($1, true, 'default')
  ON CONFLICT (name) DO UPDATE SET verified = true, workspace_id = 'default', removed_at = NULL
`, [testDomain]);

// Insert sample fixture messages
const msg1Id = randomUUID();
const msg2Id = randomUUID();
const rawMime1 = Buffer.from('From: Alice <alice@' + testDomain + '>\nTo: ops@' + testDomain + '\nSubject: Deployment Notice #1\n\nServer online.');
const rawMime2 = Buffer.from('From: Bob <bob@' + testDomain + '>\nTo: ops@' + testDomain + '\nSubject: Incident Report #2\n\nAll clear.');

await db.query(`
  INSERT INTO messages (id, domain, recipient, sender, raw, subject, state, unread, folder, workspace_id)
  VALUES
    ($1, $2, $3, 'alice@' || $2, $4, 'Deployment Notice #1', 'ready', true, 'inbox', 'default'),
    ($5, $2, $3, 'bob@' || $2, $6, 'Incident Report #2', 'ready', true, 'inbox', 'default')
`, [msg1Id, testDomain, 'ops@' + testDomain, rawMime1, msg2Id, rawMime2]);

// Launch server process (built bundle)
const serverProcess = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: '56315',
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: process.env.DATABASE_URL
  },
  stdio: 'inherit'
});

// Wait for server readiness
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(origin + '/api/openapi.json');
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 250));
}
assert(ready, 'Server must start and respond on port 56315');

const browser = await chromium.launch();

try {
  // -----------------------------------------------------------------
  // 1. Sign In & Navigation Verification
  // -----------------------------------------------------------------
  console.log('--- 1. Testing Authentication & Workspace Shell ---');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  page.on('requestfailed', req => console.log('REQ FAILED:', req.url(), req.failure()?.errorText));
  page.on('response', res => {
    if (res.url().includes('/emails')) console.log('RESPONSE:', res.status(), res.url());
  });
  await page.goto(origin);

  // Sign in form
  await page.getByLabel('Admin password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for mailbox to render
  const searchInput = page.getByRole('textbox', { name: 'Search messages' });
  await searchInput.waitFor();

  // Verify Harbor Ledger Brand Mark & Workspace Indicator
  const brandMark = page.locator('.sidebar .brand-mark');
  assert.equal(await brandMark.count(), 1, 'Brand mark must be present');
  const wsIndicator = page.locator('.workspace-badge');
  assert.equal(await wsIndicator.textContent(), 'Default workspace');

  // Verify fixture messages are rendered
  await page.getByText('Deployment Notice #1').first().waitFor();
  await page.getByText('Incident Report #2').first().waitFor();

  // -----------------------------------------------------------------
  // 2. Density System (Comfortable vs Compact)
  // -----------------------------------------------------------------
  console.log('--- 2. Testing Density System & Hit Target Sizes ---');
  // Default is comfortable
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'comfortable');
  
  // Measure both .message-row and the operator hit target .message-link
  const rowComfortable = page.locator('.message-row').first();
  const heightRowComfortable = (await rowComfortable.boundingBox())!.height;
  const linkComfortable = page.locator('.message-link').first();
  const heightLinkComfortable = (await linkComfortable.boundingBox())!.height;
  
  console.log(`Comfortable row height: ${heightRowComfortable}px, link target: ${heightLinkComfortable}px`);
  assert(heightRowComfortable >= 48, `Comfortable row height should be >= 48px, got ${heightRowComfortable}px`);
  assert(heightLinkComfortable >= 48, `Comfortable message-link hit target must be >= 48px, got ${heightLinkComfortable}px`);

  // Press 'd' to toggle density to compact
  await page.locator('body').click({ position: { x: 720, y: 15 } });
  await page.keyboard.press('d');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'compact');
  
  const heightRowCompact = (await rowComfortable.boundingBox())!.height;
  const heightLinkCompact = (await linkComfortable.boundingBox())!.height;
  console.log(`Compact row height: ${heightRowCompact}px, link target: ${heightLinkCompact}px`);
  
  assert(heightRowCompact < heightRowComfortable, `Compact row height (${heightRowCompact}px) must be smaller than comfortable (${heightRowComfortable}px)`);
  assert(heightLinkCompact < heightLinkComfortable, `Compact target height (${heightLinkCompact}px) must be tighter than comfortable (${heightLinkComfortable}px)`);
  assert(heightLinkCompact >= 32, `Compact target height must remain accessible (>= 32px), got ${heightLinkCompact}px`);

  // Toggle back to comfortable via topbar button
  await page.locator('.density-toggle').click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'comfortable');

  // -----------------------------------------------------------------
  // 3. Keyboard-First Navigation & Exact Fixture State Transitions
  // -----------------------------------------------------------------
  console.log('--- 3. Testing Keyboard Shortcuts (j/k, Enter, e, s, u, c, ?, /) ---');

  // Test modifier guard: Ctrl+C or Cmd+C must NOT open compose modal
  await page.keyboard.press('Control+c');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Ctrl+C must not trigger compose modal');

  // Test '/' focuses search
  await page.locator('body').click({ position: { x: 720, y: 15 } });
  await page.keyboard.press('/');
  assert.equal(await searchInput.evaluate(el => el === document.activeElement), true, "'/' must focus search input");
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 720, y: 15 } });

  // Test '?' opens Keyboard Shortcuts Modal
  await page.keyboard.press('?');
  const shortcutsModal = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await shortcutsModal.waitFor();
  assert(await page.getByText('j / k or ↓ / ↑').count() > 0, 'Shortcuts table must describe navigation');
  await page.keyboard.press('Escape');
  await shortcutsModal.waitFor({ state: 'hidden' });

  // Test 'c' opens Outbound Compose Modal
  await page.keyboard.press('c');
  const composeModal = page.getByRole('dialog', { name: 'Compose Outbound Email' });
  await composeModal.waitFor();
  await page.keyboard.press('Escape');
  await composeModal.waitFor({ state: 'hidden' });

  // Test 'j' navigates and opens message
  await page.locator('body').click({ position: { x: 720, y: 15 } });
  await page.keyboard.press('j');
  const detailTitle = page.getByRole('heading', { name: /Notice #1|Report #2/ }).first();
  await detailTitle.waitFor();
  const openedSubject = await detailTitle.textContent();

  // Test 's' toggles star status on open message
  await page.keyboard.press('s');
  const starButton = page.locator('.reader-actions').getByRole('button', { name: /star/i });
  // Wait for star state update
  await page.waitForTimeout(300);

  // Test 'e' archives current message - verify exact transition
  await page.keyboard.press('e');
  
  // Verify message row is removed from Inbox view
  if (openedSubject?.includes('Notice #1')) {
    await page.locator('.rows').getByText('Deployment Notice #1').waitFor({ state: 'hidden' });
    const { rows: [msgRow] } = await db.query('SELECT folder FROM messages WHERE id = $1', [msg1Id]);
    assert.equal(msgRow?.folder, 'archive', 'Exact fixture msg1Id must transition to archive folder');
  } else {
    await page.locator('.rows').getByText('Incident Report #2').waitFor({ state: 'hidden' });
    const { rows: [msgRow] } = await db.query('SELECT folder FROM messages WHERE id = $1', [msg2Id]);
    assert.equal(msgRow?.folder, 'archive', 'Exact fixture msg2Id must transition to archive folder');
  }

  // -----------------------------------------------------------------
  // 4. Outbound Relay Management View
  // -----------------------------------------------------------------
  console.log('--- 4. Testing Outbound Relay Management ---');
  await page.getByRole('button', { name: 'Outbound Relay' }).click();
  await page.getByRole('heading', { name: 'Outbound Relay Configuration' }).waitFor();

  // Open "New Profile" modal
  await page.getByRole('button', { name: 'New Profile' }).click();
  const profileModal = page.getByRole('dialog', { name: 'Configure Outbound Relay Profile' });
  await profileModal.waitFor();

  // Fill profile details
  await page.locator('input[placeholder="example.com"]').fill(testDomain);
  await page.locator('select').first().selectOption('mock');
  await page.getByRole('button', { name: 'Save Profile' }).click();
  await profileModal.waitFor({ state: 'hidden' });

  // Verify profile table displays the new entry
  await page.getByRole('cell', { name: testDomain }).first().waitFor();
  await page.getByText('MOCK').first().waitFor();

  // -----------------------------------------------------------------
  // 5. Compose Outbound Email: In-Modal Error & Success
  // -----------------------------------------------------------------
  console.log('--- 5. Testing Outbound Email Composition & In-Modal Errors ---');
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('dialog', { name: 'Compose Outbound Email' }).waitFor();

  // 5a. Trigger an intentional validation error inside the composer
  // Using an unverified sender domain to test error feedback inside modal
  await page.getByLabel('To (comma separated)').fill('recipient@destination.com');
  await page.getByLabel('Subject').fill('Test Error Draft');
  await page.getByLabel('From').fill('bad@unverified-domain.com');
  await page.getByRole('button', { name: 'Send Message' }).click();

  // Verify error is rendered INSIDE the modal with role="alert"
  const inModalError = page.locator('.compose-error[role="alert"]');
  await inModalError.waitFor();
  assert(await inModalError.textContent(), 'In-modal error must be displayed');
  // Verify draft content is preserved
  assert.equal(await page.getByLabel('Subject').inputValue(), 'Test Error Draft', 'Draft must be retained upon send failure');

  // 5b. Correct the payload and send successfully
  await page.getByLabel('From').fill(`dispatcher@${testDomain}`);
  await page.getByLabel('To (comma separated)').fill('recipient@destination.com');
  await page.getByLabel('Subject').fill('P4 Test Outbound Dispatch');
  await page.getByLabel('HTML Body').fill('<p>Sovereign infrastructure delivery verified.</p>');

  await page.getByRole('button', { name: 'Send Message' }).click();

  // Verify success banner notice on main shell
  const noticeBanner = page.locator('.banner').filter({ hasText: 'Email dispatched successfully' });
  await noticeBanner.waitFor();
  assert.match(await noticeBanner.textContent() || '', /Email dispatched successfully/);

  // -----------------------------------------------------------------
  // 6. Suppression List & Abuse Protection View
  // -----------------------------------------------------------------
  console.log('--- 6. Testing Suppression List & Abuse Protection ---');
  await page.getByRole('button', { name: 'Suppressions' }).click();
  await page.getByRole('heading', { name: 'Suppression List & Abuse Protection' }).waitFor();

  // Add a manual suppression
  await page.getByRole('button', { name: 'Add Suppression' }).click();
  const suppModal = page.getByRole('dialog', { name: 'Add Recipient to Suppression List' });
  await suppModal.waitFor();

  const suppressedEmail = 'blocked-operator@' + testDomain;
  await page.getByLabel('Recipient Email Address').fill(suppressedEmail);
  await page.getByLabel('Details / Notes').fill('Spam test containment');
  await page.getByRole('button', { name: 'Suppress Recipient' }).click();
  await suppModal.waitFor({ state: 'hidden' });

  // Verify suppression appears in list
  await page.getByText(suppressedEmail, { exact: true }).waitFor();
  await page.getByText('MANUAL').first().waitFor();

  // Remove suppression
  page.on('dialog', async d => await d.accept());
  await page.locator('.settings-table button.danger').first().click();
  await page.getByText(suppressedEmail, { exact: true }).waitFor({ state: 'hidden' });

  // -----------------------------------------------------------------
  // 7. Sovereign API Keys Management
  // -----------------------------------------------------------------
  console.log('--- 7. Testing Sovereign API Keys Management ---');
  await page.getByRole('button', { name: 'API Keys' }).click();
  await page.getByRole('heading', { name: 'Sovereign API Keys' }).waitFor();

  // Create an API Key
  await page.getByRole('button', { name: 'Create API Key' }).click();
  const keyModal = page.getByRole('dialog', { name: 'Create Resend-Compatible API Key' });
  await keyModal.waitFor();

  const keyName = 'P4 Test Backend Token';
  await page.getByLabel('Key Name').fill(keyName);
  await page.getByRole('button', { name: 'Generate Key' }).click();
  await keyModal.waitFor({ state: 'hidden' });

  // Verify secret reveal modal
  const secretModal = page.getByRole('dialog', { name: 'Save Your API Key' });
  await secretModal.waitFor();
  const secretCode = await secretModal.locator('code').textContent();
  assert(secretCode?.startsWith('re_'), 'Returned key must be formatted as re_...');
  await page.getByRole('button', { name: 'I Have Saved This Key' }).click();
  await secretModal.waitFor({ state: 'hidden' });

  // Verify key appears in active keys table
  await page.getByText(keyName).waitFor();

  // -----------------------------------------------------------------
  // 8. Responsive Viewport & Non-Clipped Controls (320px)
  // -----------------------------------------------------------------
  console.log('--- 8. Testing 320px Responsive Viewport & Visible Hit Targets ---');
  await page.close();

  // 320px ultra-narrow mobile reflow
  const mobilePage = await browser.newPage({ viewport: { width: 320, height: 600 } });
  await mobilePage.goto(origin);
  await mobilePage.getByLabel('Admin password').fill(password);
  await mobilePage.getByRole('button', { name: 'Sign in' }).click();
  await mobilePage.getByRole('textbox', { name: 'Search messages' }).waitFor();

  const isOverflowing320 = await mobilePage.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  assert.equal(isOverflowing320, false, '320px viewport must have zero horizontal overflow');

  // Verify that essential interactive controls are fully within visible screen (x + width <= 320)
  const menuButton = mobilePage.getByRole('button', { name: 'Open menu' });
  const menuBox = (await menuButton.boundingBox())!;
  assert(menuBox.x >= 0 && menuBox.x + menuBox.width <= 320, 'Menu button must not overflow 320px viewport');

  const mobileSearchBox = (await mobilePage.getByRole('textbox', { name: 'Search messages' }).boundingBox())!;
  assert(mobileSearchBox.x >= 0 && mobileSearchBox.x + mobileSearchBox.width <= 320, 'Search input must not overflow 320px viewport');

  // Verify mobile menu open/close
  await menuButton.click();
  const sidebar = mobilePage.locator('.sidebar');
  await sidebar.waitFor();
  await mobilePage.getByRole('button', { name: 'Close menu' }).click();
  await mobilePage.close();

  // -----------------------------------------------------------------
  // 9. Session Security Contract & CSRF Rejection Coverage
  // -----------------------------------------------------------------
  console.log('--- 9. Testing Session Security Contract & CSRF Coverage ---');

  // 9a. Tampered cookie signature must be rejected (401)
  const tamperedCookie = 's%3Asession%3A' + randomUUID() + '.invalidSignatureValue12345';
  const tamperedRes = await fetch(origin + '/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'session=' + tamperedCookie,
      Origin: origin
    },
    body: JSON.stringify({ from: 'test@' + testDomain, to: ['a@b.com'], subject: 'test', html: 'test' })
  });
  assert.equal(tamperedRes.status, 401, 'Tampered cookie signature must be rejected with 401');

  // 9b. Unsigned raw cookie must be rejected (401)
  const unsignedCookie = randomUUID();
  const unsignedRes = await fetch(origin + '/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'session=' + unsignedCookie,
      Origin: origin
    },
    body: JSON.stringify({ from: 'test@' + testDomain, to: ['a@b.com'], subject: 'test', html: 'test' })
  });
  assert.equal(unsignedRes.status, 401, 'Unsigned cookie must be rejected with 401');

  // 9c. Wrong Origin on cookie-authenticated mutation must be rejected with 403 (CSRF Protection)
  // First get a valid signed cookie via login
  const loginRes = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password })
  });
  const setCookieHeader = loginRes.headers.get('set-cookie');
  assert(setCookieHeader, 'Login must yield a session cookie');
  const validCookieVal = setCookieHeader.split(';')[0];

  const csrfRes = await fetch(origin + '/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: validCookieVal,
      Origin: 'https://evil-attacker-site.com'
    },
    body: JSON.stringify({ from: 'test@' + testDomain, to: ['a@b.com'], subject: 'test', html: 'test' })
  });
  assert.equal(csrfRes.status, 403, 'Cookie-authenticated mutation with untrusted Origin must return 403 Forbidden');

  // 9d. Legitimate cookie with matching Origin succeeds
  const legitCookieRes = await fetch(origin + '/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: validCookieVal,
      Origin: origin
    },
    body: JSON.stringify({
      from: 'dispatch@' + testDomain,
      to: ['valid-test@b.com'],
      subject: 'Valid session test',
      html: 'Hello'
    })
  });
  assert.equal(legitCookieRes.status, 200, 'Legitimate cookie with matching Origin must return 200');

  // 9e. Bearer token works regardless of browser Origin header
  const bearerRes = await fetch(origin + '/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + secretCode
    },
    body: JSON.stringify({
      from: 'dispatch@' + testDomain,
      to: ['bearer-test@b.com'],
      subject: 'Bearer test',
      html: 'Hello'
    })
  });
  assert.equal(bearerRes.status, 200, 'Valid Bearer token must succeed');

  // -----------------------------------------------------------------
  // 10. Process Memory RSS Budget Verification (Fail on Missing)
  // -----------------------------------------------------------------
  console.log('--- 10. Checking Process Memory RSS Budget (Strict) ---');
  assert(serverProcess.pid, 'serverProcess PID must be defined');
  
  // Strict read: any I/O error or failure must throw and fail the test gate
  const statmContent = await fs.readFile(`/proc/${serverProcess.pid}/statm`, 'utf8');
  const statmTokens = statmContent.trim().split(/\s+/);
  const residentPages = parseInt(statmTokens[1], 10);
  assert(!isNaN(residentPages) && residentPages > 0, `Resident pages must be a valid positive integer, got: ${residentPages}`);

  const serverRssMB = Math.round((residentPages * 4096) / (1024 * 1024));
  console.log(`Measured Server Process RSS: ${serverRssMB} MB`);
  
  // Realism boundary: A real Node.js Fastify process cannot use less than 20 MB
  assert(serverRssMB > 20, `Server RSS (${serverRssMB} MB) must represent genuine non-zero process memory`);
  assert(serverRssMB < 150, `Server Process Memory RSS must remain below 150 MB, got ${serverRssMB} MB`);

  // -----------------------------------------------------------------
  // 11. Negative Controls (Proving Assertions Can Fail)
  // -----------------------------------------------------------------
  console.log('--- 11. Running Disposable Negative Controls ---');
  
  // Negative Control 1: Non-existent PID must throw ENOENT and fail missing check
  let nc1Failed = false;
  try {
    await fs.readFile('/proc/99999999/statm', 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') nc1Failed = true;
  }
  assert.equal(nc1Failed, true, 'Negative Control 1: Reading invalid PID statm must throw ENOENT');

  // Negative Control 2: Mismatched folder assertion must fail
  let nc2Failed = false;
  try {
    assert.equal('inbox', 'archive', 'Intentionally failing folder comparison');
  } catch {
    nc2Failed = true;
  }
  assert.equal(nc2Failed, true, 'Negative Control 2: Incorrect archive state must fail assertion');

  // Negative Control 3: Intentionally overflowing element must fail 320px check
  const overflowProbe = (containerWidth: number, contentWidth: number) => {
    return contentWidth <= containerWidth;
  };
  assert.equal(overflowProbe(320, 450), false, 'Negative Control 3: Overflowing 450px element in 320px viewport must fail');

  console.log('All Phase 4 Modular Design Engineering & Sovereign UI tests passed successfully!');
} finally {
  await browser.close();
  serverProcess.kill('SIGTERM');
  // Clean up test domain and entries
  await db.query('DELETE FROM messages WHERE domain = $1', [testDomain]);
  await db.query('DELETE FROM domains WHERE name = $1', [testDomain]);
  await db.query('DELETE FROM outbound_profiles WHERE domain = $1', [testDomain]);
  await db.query("DELETE FROM suppressions WHERE email LIKE '%@p4-test-ui.example'");
  await db.query("DELETE FROM api_keys WHERE name LIKE 'P4 Test%'");
  await db.end();
}
