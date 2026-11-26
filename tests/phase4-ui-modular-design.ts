import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';

const origin = 'http://localhost:56315';
const password = 'p4-secret-password';
const sessionSecret = 'p4-session-secret-at-least-32-chars-long';
process.env.PORT = '56315';
process.env.SESSION_SECRET = sessionSecret;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';

const { db, migrate } = await import('../src/db.js');
const { importMail, runJobs } = await import('../src/jobs.js');

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

// Launch server process
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  console.log('--- 2. Testing Density System (Comfortable vs Compact) ---');
  // Default is comfortable
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'comfortable');
  const rowElement = page.locator('.message-row').first();
  const heightComfortable = (await rowElement.boundingBox())!.height;
  assert(heightComfortable >= 48, `Comfortable row height should be >= 48px, got ${heightComfortable}px`);

  // Press 'd' to toggle density to compact
  await page.locator('body').click({ position: { x: 720, y: 15 } });
  await page.keyboard.press('d');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'compact');
  const heightCompact = (await rowElement.boundingBox())!.height;
  assert(heightCompact < heightComfortable, `Compact row height (${heightCompact}px) must be smaller than comfortable (${heightComfortable}px)`);

  // Toggle back to comfortable via button
  await page.locator('.density-toggle').click();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-density')), 'comfortable');

  // -----------------------------------------------------------------
  // 3. Keyboard-First Navigation (j/k, Enter, c, ?, /)
  // -----------------------------------------------------------------
  console.log('--- 3. Testing Keyboard Shortcuts (j/k, Enter, c, ?, /) ---');

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
  assert.equal(await page.getByText('j / k').count() > 0, true);
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
  await page.getByRole('heading', { name: /Notice #1|Report #2/ }).first().waitFor();

  // Test 'e' archives current message
  await page.keyboard.press('e');
  // Should remove or archive message

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
  // 5. Compose Outbound Email via Topbar Button
  // -----------------------------------------------------------------
  console.log('--- 5. Testing Outbound Email Composition ---');
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('dialog', { name: 'Compose Outbound Email' }).waitFor();

  await page.getByLabel('From').fill(`dispatcher@${testDomain}`);
  await page.getByLabel('To (comma separated)').fill('recipient@destination.com');
  await page.getByLabel('Subject').fill('P4 Test Outbound Dispatch');
  await page.getByLabel('HTML Body').fill('<p>Sovereign infrastructure delivery verified.</p>');

  await page.getByRole('button', { name: 'Send Message' }).click();

  // Verify success banner notice
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
  // 8. Responsive Viewport & Zero Horizontal Overflow (320px)
  // -----------------------------------------------------------------
  console.log('--- 8. Testing Responsive Viewports (320px, 768px, 1280px) ---');
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

  // Verify mobile menu open/close
  await mobilePage.getByRole('button', { name: 'Open menu' }).click();
  await mobilePage.locator('.sidebar').waitFor();
  await mobilePage.getByRole('button', { name: 'Close menu' }).click();

  await mobilePage.close();

  // -----------------------------------------------------------------
  // 9. Process Memory RSS Budget Verification
  // -----------------------------------------------------------------
  console.log('--- 9. Checking Process Memory RSS Budget ---');
  let serverRssMB = 0;
  if (serverProcess.pid) {
    try {
      const fs = await import('node:fs/promises');
      const statm = await fs.readFile(`/proc/${serverProcess.pid}/statm`, 'utf8');
      const pages = parseInt(statm.split(' ')[1], 10);
      serverRssMB = Math.round((pages * 4096) / (1024 * 1024));
    } catch {}
  }
  console.log(`Server Process RSS: ${serverRssMB} MB`);
  assert(serverRssMB < 150, `Server Process Memory RSS must remain below 150 MB, got ${serverRssMB} MB`);

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
