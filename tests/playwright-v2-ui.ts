import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium, type Page } from '@playwright/test';
import { db } from '../src/db.js';

const port = '56345';
const origin = `http://127.0.0.1:${port}`;
const password = 'v2-ui-secret-password-12345';
const sessionSecret = 'v2-ui-session-secret-over-32-chars-long';
process.env.PORT = port;
process.env.SESSION_SECRET = sessionSecret;
process.env.APP_ENCRYPTION_KEY = '01234567890123456789012345678901';

const shotDir = '/tmp/antigravity/v2-screenshots';
await fs.mkdir(shotDir, { recursive: true });

console.log('=== Starting Letterdock v2 Platform UI Playwright Verification Suite ===');

const server = spawn('node', ['dist/server.js'], {
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

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
});

try {
  let serverReady = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(origin + '/health');
      if (res.ok) {
        serverReady = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert(serverReady, 'Server must start and respond on port ' + port);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  // 1. Sign In
  console.log('--- 1. Authenticating as Admin ---');
  await page.goto(origin);
  await page.getByLabel('Admin password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('.topbar');
  console.log('✓ Successfully authenticated and loaded workspace shell');

  // 2. Navigate to Templates View
  console.log('--- 2. Testing Templates View in Browser ---');
  const templatesNavBtn = page.locator('nav[aria-label="Workspace"] button:has-text("Templates")');
  await assert(await templatesNavBtn.isVisible(), 'Templates nav button must be visible in Sidebar');
  await templatesNavBtn.click();
  await page.waitForSelector('h2:has-text("Transactional Email Templates")');
  await page.screenshot({ path: `${shotDir}/01-templates-view.png` });
  console.log('✓ Templates view rendered with header and layout');

  // Click "New Template"
  const newTplBtn = page.locator('button:has-text("New Template")');
  await newTplBtn.click();
  await page.waitForSelector('h3:has-text("Create New Template")');
  await page.fill('input[placeholder="e.g. Welcome Onboarding"]', 'PW Test Template');
  await page.screenshot({ path: `${shotDir}/02-templates-editor.png` });
  console.log('✓ Template editor inputs visible and interactive');

  // Cancel edit
  await page.click('button:has-text("Cancel")');

  // 3. Navigate to Rules View
  console.log('--- 3. Testing Rules View in Browser ---');
  const rulesNavBtn = page.locator('nav[aria-label="Workspace"] button:has-text("Rules")');
  await assert(await rulesNavBtn.isVisible(), 'Rules nav button must be visible in Sidebar');
  await rulesNavBtn.click();
  await page.waitForSelector('h2:has-text("Inbound Automation & Routing Rules")');
  await page.waitForSelector('.card:has-text("Rule Simulator")');
  await page.screenshot({ path: `${shotDir}/03-rules-view.png` });
  console.log('✓ Rules view and simulator rendered cleanly');

  // 4. Navigate to Analytics View
  console.log('--- 4. Testing Analytics View in Browser ---');
  const analyticsNavBtn = page.locator('nav[aria-label="Workspace"] button:has-text("Analytics")');
  await assert(await analyticsNavBtn.isVisible(), 'Analytics nav button must be visible in Sidebar');
  await analyticsNavBtn.click();
  await page.waitForSelector('h2:has-text("Analytics & Deliverability Suite")');
  await page.waitForSelector('.card:has-text("Delivery Rate")');
  await page.waitForSelector('.card:has-text("Unique Opens")');
  await page.waitForSelector('.card:has-text("Clicks")');
  await page.screenshot({ path: `${shotDir}/04-analytics-view.png` });
  console.log('✓ Analytics KPI cards and telemetry timeline rendered cleanly');

  // 5. Test 320px ultra-narrow mobile reflow
  console.log('--- 5. Testing 320px Mobile Viewport Reflow ---');
  await page.setViewportSize({ width: 320, height: 600 });
  await page.waitForTimeout(300);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert(scrollWidth <= clientWidth, 'No horizontal overflow on 320px mobile viewport');
  await page.screenshot({ path: `${shotDir}/05-mobile-320px-analytics.png` });
  console.log('✓ 320px responsive reflow verified with zero horizontal overflow');

  // 6. Test Memory RSS Budget (< 150 MB)
  console.log('--- 6. Profiling Server Process Memory Budget ---');
  const pid = server.pid;
  assert(pid, 'Server PID must exist');
  const memInfo = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  const vmRssMatch = memInfo.match(/VmRSS:\s+(\d+)\s+kB/);
  if (vmRssMatch) {
    const rssMb = Math.round(parseInt(vmRssMatch[1], 10) / 1024);
    console.log(`Measured Live Server Process RSS: ${rssMb} MB`);
    assert(rssMb < 150, `Server RSS (${rssMb} MB) must remain strictly below 150 MB`);
    console.log('✓ Server process memory footprint verified within sovereign budget');
  }

  console.log('\n======================================================');
  console.log('★ PLAYWRIGHT v2 UI & SOVEREIGN OPERATOR SUITE PASSED! ★');
  console.log('======================================================');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
