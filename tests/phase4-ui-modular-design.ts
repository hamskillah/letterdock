import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium, type Page } from '@playwright/test';

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

// Production gate probe functions (exercised by both positive tests and negative controls)
export async function measureProcessRssMB(pid: number): Promise<number> {
  const statmContent = await fs.readFile(`/proc/${pid}/statm`, 'utf8');
  const statmTokens = statmContent.trim().split(/\s+/);
  const residentPages = parseInt(statmTokens[1], 10);
  if (isNaN(residentPages) || residentPages <= 0) {
    throw new Error(`Invalid resident pages reading from /proc/${pid}/statm: ${residentPages}`);
  }
  const rssMB = Math.round((residentPages * 4096) / (1024 * 1024));
  if (rssMB <= 20) {
    throw new Error(`Suspicious sub-20MB RSS reading: ${rssMB} MB`);
  }
  return rssMB;
}

export async function assertMessageFolder(msgId: string, expectedFolder: string): Promise<void> {
  const { rows: [row] } = await db.query('SELECT folder FROM messages WHERE id = $1', [msgId]);
  assert(row, `Message ${msgId} must exist in database`);
  assert.equal(row.folder, expectedFolder, `Message ${msgId} folder must be '${expectedFolder}', got '${row.folder}'`);
}

export async function probeVisibleElementWithinBounds(
  page: Page,
  selector: string,
  maxWidth = 320
): Promise<{ x: number; width: number; right: number }> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible' });
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Element ${selector} has no valid bounding box`);
  }
  const right = box.x + box.width;
  if (box.x < 0 || right > maxWidth) {
    throw new Error(`Element ${selector} exceeds viewport bounds: x=${box.x}, width=${box.width}, right=${right}, max=${maxWidth}`);
  }

  // Check ancestor overflow clipping and hit-area reachability via elementFromPoint
  const clippingOrReachabilityError = await page.evaluate(({ sel, cx, cy }) => {
    const el = document.querySelector(sel);
    if (!el) return 'Element not found in DOM';

    const rect = el.getBoundingClientRect();
    let parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      const style = window.getComputedStyle(parent);
      if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
        const parentRect = parent.getBoundingClientRect();
        if (
          rect.top >= parentRect.bottom ||
          rect.bottom <= parentRect.top ||
          rect.left >= parentRect.right ||
          rect.right <= parentRect.left ||
          parentRect.width === 0 ||
          parentRect.height === 0
        ) {
          return `Element ${sel} is clipped by ancestor <${parent.tagName.toLowerCase()} class="${parent.className}"> with overflow:hidden`;
        }
      }
      parent = parent.parentElement;
    }

    const hit = document.elementFromPoint(cx, cy);
    if (!hit || (!el.contains(hit) && !hit.contains(el))) {
      return `Element ${sel} hit area at (${cx}, ${cy}) is obscured or clipped (hit element: <${hit?.tagName?.toLowerCase()} class="${hit?.className}">)`;
    }
    return null;
  }, { sel: selector, cx: Math.round(box.x + box.width / 2), cy: Math.round(box.y + box.height / 2) });

  if (clippingOrReachabilityError) {
    throw new Error(clippingOrReachabilityError);
  }

  return { x: box.x, width: box.width, right };
}

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
  console.log('--- 2. Testing Density System & Measured Target Heights ---');
  // Default is comfortable
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'comfortable');
  
  // Measure both .message-row and the operator hit target .message-link in Comfortable mode
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
  
  // Measure both .message-row and .message-link in Compact mode
  const heightRowCompact = (await rowComfortable.boundingBox())!.height;
  const heightLinkCompact = (await linkComfortable.boundingBox())!.height;
  console.log(`Compact row height: ${heightRowCompact}px, link target: ${heightLinkCompact}px`);
  
  assert(heightRowCompact < heightRowComfortable, `Compact row height (${heightRowCompact}px) must be tighter than comfortable (${heightRowComfortable}px)`);
  assert(heightLinkCompact < heightLinkComfortable, `Compact target height (${heightLinkCompact}px) must be tighter than comfortable (${heightLinkComfortable}px)`);
  assert(heightRowCompact <= 48, `Compact row height must be compact (<= 48px), got ${heightRowCompact}px`);
  assert(heightLinkCompact <= 48, `Compact hit target must be compact (<= 48px), got ${heightLinkCompact}px`);

  // Toggle back to comfortable via topbar button
  await page.locator('.density-toggle').click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'comfortable');

  // -----------------------------------------------------------------
  // 3. Dynamic Keyboard Walk: Focus, Containment, Traversal & DB Transitions
  // -----------------------------------------------------------------
  console.log('--- 3. Testing Keyboard Shortcuts, Focus Traps & State Transitions ---');

  // 3a. Native modifier guard: Ctrl+C / Cmd+C must not open compose modal
  await page.keyboard.press('Control+c');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Ctrl+C must not trigger compose modal');

  // 3b. '/' focuses search input
  await page.locator('body').click({ position: { x: 720, y: 15 } });
  await page.keyboard.press('/');
  assert.equal(await searchInput.evaluate(el => el === document.activeElement), true, "'/' must focus search input");
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 720, y: 15 } });

  // 3c. '?' opens Keyboard Shortcuts Modal with Focus Trap & Escape return
  const helpButton = page.locator('button[aria-label="Open keyboard shortcuts cheat-sheet"]');
  await helpButton.focus();
  await page.keyboard.press('?');
  const shortcutsModal = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await shortcutsModal.waitFor();
  
  // Verify focus entered dialog
  const isFocusInShortcuts = await shortcutsModal.evaluate(dialog => dialog.contains(document.activeElement));
  assert.equal(isFocusInShortcuts, true, 'Focus must enter Shortcuts modal on open');
  
  // Press Escape and verify focus restores to helpButton opener
  await page.keyboard.press('Escape');
  await shortcutsModal.waitFor({ state: 'hidden' });
  const isHelpRefocused = await helpButton.evaluate(btn => btn === document.activeElement);
  assert.equal(isHelpRefocused, true, 'Escape must return focus to the opener element');

  // 3d. 'c' opens Outbound Compose Modal with Focus Trap & Tab containment
  const composeTrigger = page.locator('button[aria-label="Compose new outbound email"]');
  await composeTrigger.focus();
  await page.keyboard.press('c');
  const composeModal = page.getByRole('dialog', { name: 'Compose Outbound Email' });
  await composeModal.waitFor();

  // Verify focus entered dialog on first input
  const isFocusInCompose = await composeModal.evaluate(dialog => dialog.contains(document.activeElement));
  assert.equal(isFocusInCompose, true, 'Focus must enter Compose modal on open');

  // Test Tab cycling containment inside dialog
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const isTabStillInCompose = await composeModal.evaluate(dialog => dialog.contains(document.activeElement));
  assert.equal(isTabStillInCompose, true, 'Tab navigation must stay contained inside dialog');

  // Test Shift+Tab backwards navigation
  await page.keyboard.press('Shift+Tab');
  const isShiftTabStillInCompose = await composeModal.evaluate(dialog => dialog.contains(document.activeElement));
  assert.equal(isShiftTabStillInCompose, true, 'Shift+Tab navigation must stay contained inside dialog');

  // Dismiss via Escape and verify focus restoration to composeTrigger
  await page.keyboard.press('Escape');
  await composeModal.waitFor({ state: 'hidden' });
  const isComposeRefocused = await composeTrigger.evaluate(btn => btn === document.activeElement);
  assert.equal(isComposeRefocused, true, 'Closing modal via Escape must restore focus to opener button');

  // 3e. 'j' / 'ArrowDown' navigates and opens message
  await page.locator('body').click({ position: { x: 720, y: 15 } });
  await page.keyboard.press('j');
  const detailTitle = page.getByRole('heading', { name: /Notice #1|Report #2/ }).first();
  await detailTitle.waitFor();
  const openedSubject = await detailTitle.textContent();
  const targetMsgId = openedSubject?.includes('Notice #1') ? msg1Id : msg2Id;

  // 3f. 's' toggles star status: verify database transition
  await page.keyboard.press('s');
  for (let i = 0; i < 20; i++) {
    const { rows: [r] } = await db.query('SELECT starred FROM messages WHERE id = $1', [targetMsgId]);
    if (r?.starred === true) break;
    await new Promise(res => setTimeout(res, 50));
  }
  const { rows: [starredRow] } = await db.query('SELECT starred FROM messages WHERE id = $1', [targetMsgId]);
  assert.equal(starredRow?.starred, true, 'Pressing s must transition database starred column to true');

  // 3g. 'u' toggles unread status: since open() marks it read, pressing 'u' marks it unread (unread = true)
  await page.keyboard.press('u');
  for (let i = 0; i < 20; i++) {
    const { rows: [r] } = await db.query('SELECT unread FROM messages WHERE id = $1', [targetMsgId]);
    if (r?.unread === true) break;
    await new Promise(res => setTimeout(res, 50));
  }
  const { rows: [unreadRow] } = await db.query('SELECT unread FROM messages WHERE id = $1', [targetMsgId]);
  assert.equal(unreadRow?.unread, true, 'Pressing u on open message must transition database unread column to true');

  // 3h. 'e' archives current message: verify exact fixture database transition
  await page.keyboard.press('e');
  
  if (openedSubject?.includes('Notice #1')) {
    await page.locator('.rows').getByText('Deployment Notice #1').waitFor({ state: 'hidden' });
    await assertMessageFolder(msg1Id, 'archive');
  } else {
    await page.locator('.rows').getByText('Incident Report #2').waitFor({ state: 'hidden' });
    await assertMessageFolder(msg2Id, 'archive');
  }

  // 3i. Inbox search filtering: assert search input retains focus while filtering
  const remainingTerm = openedSubject?.includes('Notice #1') ? 'Incident' : 'Deployment';
  const remainingText = remainingTerm === 'Incident' ? 'Incident Report #2' : 'Deployment Notice #1';
  await searchInput.focus();
  await searchInput.fill(remainingTerm);
  await page.locator('.rows').getByText(remainingText).waitFor();
  const isSearchStillFocused = await searchInput.evaluate(input => input === document.activeElement);
  assert.equal(isSearchStillFocused, true, 'Search input must retain focus while filtering messages');
  await searchInput.fill('');
  await page.keyboard.press('Escape');

  // -----------------------------------------------------------------
  // 4. Outbound Relay Management View & Landmark Focus
  // -----------------------------------------------------------------
  console.log('--- 4. Testing Outbound Relay Management & Landmark Focus ---');
  await page.getByRole('button', { name: 'Outbound Relay' }).click();
  await page.getByRole('heading', { name: 'Outbound Relay Configuration' }).waitFor();

  // Verify landmark workspace receives focus upon navigation
  const isWorkspaceFocused = await page.locator('main.workspace').evaluate(el => el === document.activeElement);
  assert.equal(isWorkspaceFocused, true, 'Navigating views must move focus to main workspace landmark');

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
  // 5. Compose Outbound Email: In-Modal Error, Draft Retain & Focus
  // -----------------------------------------------------------------
  console.log('--- 5. Testing Outbound Email Composition, In-Modal Alert Focus & Draft Retain ---');
  const composeBtn = page.getByRole('button', { name: 'Compose' });
  await composeBtn.click();
  await page.getByRole('dialog', { name: 'Compose Outbound Email' }).waitFor();

  // 5a. Trigger an intentional validation error inside the composer
  await page.getByLabel('To (comma separated)').fill('recipient@destination.com');
  await page.getByLabel('Subject').fill('Test Error Draft');
  await page.getByLabel('From').fill('bad@unverified-domain.com');
  await page.getByRole('button', { name: 'Send Message' }).click();

  // Verify error is rendered INSIDE the modal with role="alert" and receives focus
  const inModalError = page.locator('.compose-error[role="alert"]');
  await inModalError.waitFor();
  const isErrorFocused = await inModalError.evaluate(el => el === document.activeElement);
  assert.equal(isErrorFocused, true, 'In-modal error alert must receive focus upon dispatch failure');

  // Verify draft content is retained intact
  assert.equal(await page.getByLabel('Subject').inputValue(), 'Test Error Draft', 'Draft subject must be retained');
  assert.equal(await page.getByLabel('To (comma separated)').inputValue(), 'recipient@destination.com', 'Draft recipients must be retained');

  // 5b. Correct payload and send successfully
  await page.getByLabel('From').fill(`dispatcher@${testDomain}`);
  await page.getByLabel('Subject').fill('P4 Test Outbound Dispatch');
  await page.getByLabel('HTML Body').fill('<p>Sovereign infrastructure delivery verified.</p>');
  await page.getByRole('button', { name: 'Send Message' }).click();

  // Verify modal closes upon successful dispatch
  const composeDialog = page.getByRole('dialog', { name: 'Compose Outbound Email' });
  await composeDialog.waitFor({ state: 'hidden' });

  // Verify focus returns to Compose button opener
  const isComposeRefocusedAfterSuccess = await composeBtn.evaluate(btn => btn === document.activeElement);
  assert.equal(isComposeRefocusedAfterSuccess, true, 'Focus must return to Compose button opener upon successful dispatch');

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
  // 8. Responsive Viewport & Non-Clipped Actionable Controls (320px)
  // -----------------------------------------------------------------
  console.log('--- 8. Testing 320px Responsive Viewport & All Visible Controls ---');
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

  // Verify ALL visible actionable topbar and search controls using production reachability probe
  await probeVisibleElementWithinBounds(mobilePage, 'button[aria-label="Open menu"]', 320);
  await probeVisibleElementWithinBounds(mobilePage, 'input[aria-label="Search messages"]', 320);
  await probeVisibleElementWithinBounds(mobilePage, '.density-toggle', 320);
  await probeVisibleElementWithinBounds(mobilePage, 'button[aria-label="Open keyboard shortcuts cheat-sheet"]', 320);
  await probeVisibleElementWithinBounds(mobilePage, 'button[aria-label="Compose new outbound email"]', 320);

  // Open mobile drawer
  await mobilePage.getByRole('button', { name: 'Open menu' }).click();
  const sidebar = mobilePage.locator('.sidebar');
  await sidebar.waitFor();

  // Verify drawer controls stay within 320px bounds and are reachable
  await probeVisibleElementWithinBounds(mobilePage, 'button[aria-label="Close menu"]', 320);
  await probeVisibleElementWithinBounds(mobilePage, '.sidebar button.active', 320);

  // Close drawer
  await mobilePage.getByRole('button', { name: 'Close menu' }).click();

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
  // 10. Process Memory RSS Budget Verification (Strict Production Probe)
  // -----------------------------------------------------------------
  console.log('--- 10. Checking Process Memory RSS Budget (Strict) ---');
  assert(serverProcess.pid, 'serverProcess PID must be defined');
  
  const serverRssMB = await measureProcessRssMB(serverProcess.pid);
  console.log(`Measured Server Process RSS: ${serverRssMB} MB`);
  
  assert(serverRssMB > 20, `Server RSS (${serverRssMB} MB) must represent genuine non-zero process memory`);
  assert(serverRssMB < 150, `Server Process Memory RSS must remain below 150 MB, got ${serverRssMB} MB`);

  // -----------------------------------------------------------------
  // 11. Disposable Negative Controls (Proving Real Production Gates Fail)
  // -----------------------------------------------------------------
  console.log('--- 11. Running Disposable Negative Controls on Real Production Probes ---');
  
  // Negative Control 1: Real measureProcessRssMB must fail on invalid PID
  let nc1Failed = false;
  try {
    await measureProcessRssMB(99999999);
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.message.includes('ENOENT')) nc1Failed = true;
  }
  assert.equal(nc1Failed, true, 'Negative Control 1: measureProcessRssMB with invalid PID must throw ENOENT');

  // Negative Control 2: Real assertMessageFolder must fail when message remains in 'inbox'
  const failingMsgId = randomUUID();
  await db.query(`
    INSERT INTO messages (id, domain, recipient, sender, raw, subject, state, unread, folder, workspace_id)
    VALUES ($1, $2, 'nc@test', 'sender@test', $3, 'NC Test', 'ready', true, 'inbox', 'default')
  `, [failingMsgId, testDomain, Buffer.from('test')]);

  let nc2Failed = false;
  try {
    // Assert message is in 'archive' when it is actually in 'inbox'
    await assertMessageFolder(failingMsgId, 'archive');
  } catch (err: any) {
    if (err.name === 'AssertionError') nc2Failed = true;
  }
  await db.query('DELETE FROM messages WHERE id = $1', [failingMsgId]);
  assert.equal(nc2Failed, true, 'Negative Control 2: assertMessageFolder must throw AssertionError when DB folder != expected');

  // Negative Control 3: probeVisibleElementWithinBounds must fail on ancestor-clipped element inside viewport
  // Creates an ancestor with overflow:hidden and places button inside viewport bounds (right=190px <= 320px) but clipped by ancestor
  await mobilePage.evaluate(() => {
    const ancestor = document.createElement('div');
    ancestor.id = 'nc-clipping-ancestor';
    ancestor.style.position = 'absolute';
    ancestor.style.left = '10px';
    ancestor.style.top = '10px';
    ancestor.style.width = '50px';
    ancestor.style.height = '50px';
    ancestor.style.overflow = 'hidden';

    const child = document.createElement('button');
    child.id = 'nc-clipped-child';
    child.textContent = 'Ancestor Clipped';
    child.style.position = 'absolute';
    child.style.left = '100px'; // Viewport x is 10 + 100 = 110, right is 190px <= 320px, but outside 50px ancestor
    child.style.top = '0';
    child.style.width = '80px';
    child.style.height = '40px';

    ancestor.appendChild(child);
    document.body.appendChild(ancestor);
  });

  let nc3Failed = false;
  try {
    await probeVisibleElementWithinBounds(mobilePage, '#nc-clipped-child', 320);
  } catch (err: any) {
    if (err.message.includes('clipped by ancestor') || err.message.includes('hit area')) {
      nc3Failed = true;
    }
  }
  await mobilePage.evaluate(() => document.getElementById('nc-clipping-ancestor')?.remove());
  await mobilePage.close();
  assert.equal(nc3Failed, true, 'Negative Control 3: probeVisibleElementWithinBounds must detect and fail on ancestor-clipped element');

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
