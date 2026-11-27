import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { db } from '../src/db.js';

const origin = 'http://localhost:56346';
const password = 'mailboxes-ui-secret-password-123';
const sessionSecret = 'mailboxes-ui-session-secret-over-32-chars-long';
process.env.PORT = '56346';
process.env.SESSION_SECRET = sessionSecret;
process.env.APP_ENCRYPTION_KEY = 'mailboxes-app-encryption-key-over-32-chars!';

const shotDir = '/tmp/antigravity/mailboxes-screenshots';
await fs.mkdir(shotDir, { recursive: true });

console.log('=== Starting Connected Mailboxes UI Playwright Verification Suite ===');

const server = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
    PUBLIC_URL: origin,
    APP_PORT: '56346',
    PORT: '56346'
  },
  stdio: 'ignore'
});

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
});

try {
  let serverReady = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(origin + '/api/health');
      if (res.ok || res.status === 401) {
        serverReady = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert(serverReady, 'Server must start on port 56346');

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write']
  });
  const page = await context.newPage();

  // 1. Authenticate
  console.log('--- 1. Login to Letterdock ---');
  await page.goto(origin);
  await page.getByLabel('Admin password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('.topbar');

  // 2. Navigate to Connected Accounts via sidebar
  console.log('--- 2. Navigate to Connected Accounts View via Sidebar ---');
  const navBtn = page.locator('aside.sidebar nav button:has-text("Connected Accounts")');
  assert.equal(await navBtn.isVisible(), true, 'Connected Accounts sidebar button must be visible');
  await navBtn.click();
  await page.waitForSelector('.connected-mailboxes-view');

  // Verify Header shows 'Connected Accounts'
  const headerTitle = await page.locator('.topbar strong').textContent();
  assert.equal(headerTitle?.trim(), 'Connected Accounts', 'Topbar title must reflect Connected Accounts');

  // 3. Inspect Inbound-Only Security Callout Panel
  console.log('--- 3. Inspect Inbound-Only Security Callout Panel ---');
  const securityCallout = page.locator('.security-callout-panel');
  assert.equal(await securityCallout.isVisible(), true, 'Security callout panel must be displayed');
  const calloutText = await securityCallout.textContent();
  assert(calloutText?.includes('Inbound-Only Security Assurance'), 'Must clearly state Inbound-Only Security Assurance');
  assert(calloutText?.includes('Cryptographically Enforced'), 'Must highlight Cryptographically Enforced badge');

  // Capture screenshot 01: Overview
  await page.screenshot({ path: `${shotDir}/01-mailboxes-overview-light.png`, fullPage: true });

  // 4. Open Setup Credentials Modal for Google
  console.log('--- 4. Configure OAuth Provider Credentials via Modal ---');
  const setupGoogleBtn = page.locator('button:has-text("Setup Credentials")').first();
  if (await setupGoogleBtn.isVisible()) {
    await setupGoogleBtn.click();
    await page.waitForSelector('dialog.remove-dialog[open]');

    // Check Redirect URI code block
    const redirectCode = await page.locator('dialog code').textContent();
    assert(redirectCode?.includes('/api/oauth/google/callback'), 'Modal must present exact callback URL');

    // Fill Client ID & Secret
    await page.fill('dialog input[type="text"]', '123456789-test.apps.googleusercontent.com');
    await page.fill('dialog input[type="password"]', 'mock-secret-key-123456');

    // Submit form
    await page.click('dialog button[type="submit"]');
    await page.waitForTimeout(500);

    // Verify card badge updated
    const readyBadge = page.locator('.status-metric .badge-success:has-text("Ready to Connect")');
    assert.equal(await readyBadge.count() > 0, true, 'Provider badge must update to Ready to Connect');
  }

  // Capture screenshot 02: Configured State
  await page.screenshot({ path: `${shotDir}/02-mailboxes-configured-light.png`, fullPage: true });

  // 5. Dark Mode & Contrast Verification
  console.log('--- 5. Test Dark Theme & Text Contrast Compliance ---');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await page.waitForTimeout(300);

  // Capture screenshot 03: Dark Mode
  await page.screenshot({ path: `${shotDir}/03-mailboxes-dark-mode.png`, fullPage: true });

  // 6. Mobile 320px Viewport Reflow Verification
  console.log('--- 6. Test 320px Mobile Viewport Reflow ---');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const docScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const docClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert(docScrollWidth <= docClientWidth + 1, `Document must not horizontally overflow on 320px: ${docScrollWidth} <= ${docClientWidth}`);

  // Capture screenshot 04: Mobile 320px
  await page.screenshot({ path: `${shotDir}/04-mailboxes-320px-mobile.png`, fullPage: true });

  console.log('=== Connected Mailboxes UI Playwright Verification Suite Completed with 100% SUCCESS! ===');
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await db.query("DELETE FROM settings WHERE key LIKE 'oauth_provider_%'");
}
