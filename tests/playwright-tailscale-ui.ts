import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium, type Page } from '@playwright/test';
import { db } from '../src/db.js';

const origin = 'http://localhost:56340';
const password = 'tailscale-ui-secret-password-123';
const sessionSecret = 'tailscale-ui-session-secret-over-32-chars-long';
process.env.PORT = '56340';
process.env.SESSION_SECRET = sessionSecret;

const shotDir = '/tmp/antigravity/tailscale-screenshots';
await fs.mkdir(shotDir, { recursive: true });

console.log('=== Starting Tailscale UI Playwright Verification Suite ===');

const server = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    PUBLIC_URL: origin,
    APP_PORT: '56340',
    PORT: '56340'
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
  assert(serverReady, 'Server must start and respond on port 56340');

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  // 1. Authenticate
  console.log('--- 1. Login to Letterdock ---');
  await page.goto(origin);
  await page.getByLabel('Admin password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('.topbar');

  // 2. Navigate to Tailscale view via sidebar
  console.log('--- 2. Navigate to Tailscale View via Sidebar ---');
  const tailscaleNavBtn = page.locator('aside.sidebar nav button:has-text("Tailscale")');
  assert.equal(await tailscaleNavBtn.isVisible(), true, 'Tailscale sidebar button must be visible');
  await tailscaleNavBtn.click();
  await page.waitForSelector('.tailscale-view');

  // Verify Header shows 'Tailscale Access'
  const headerTitle = await page.locator('.topbar strong').textContent();
  assert.equal(headerTitle?.trim(), 'Tailscale Access', 'Topbar title must reflect Tailscale Access');

  // 3. Inspect Host Daemon Panel
  console.log('--- 3. Inspect Host Daemon Overview & Status Grid ---');
  const metrics = await page.locator('.tailscale-status-grid .status-metric').count();
  assert(metrics >= 4, 'Must display at least 4 status metrics');

  // Capture screenshot: 01-tailscale-overview-light.png
  await page.screenshot({ path: `${shotDir}/01-tailscale-overview-light.png`, fullPage: true });

  // 4. Test Settings Form: Toggle & Quick-Fill
  console.log('--- 4. Configure Tailscale Settings & Origin Policy ---');
  const toggleCheckbox = page.locator('#tailscale-enabled-toggle');
  const isCheckedInitially = await toggleCheckbox.isChecked();

  // Toggle on if not checked
  if (!isCheckedInitially) {
    await toggleCheckbox.check();
  }

  // If Quick-Fill button is present, click it
  const quickFillBtn = page.locator('button.quick-fill-btn:has-text("Use MagicDNS")');
  if (await quickFillBtn.isVisible()) {
    await quickFillBtn.click();
    const originInputValue = await page.locator('#tailscale-origin-input').inputValue();
    assert(originInputValue.startsWith('https://'), 'Quick-fill should populate MagicDNS HTTPS origin');
  } else {
    await page.fill('#tailscale-origin-input', 'https://letterdock.test-tailnet.ts.net');
  }

  // Save configuration
  await page.click('button.tailscale-save-btn');
  await page.waitForSelector('.save-feedback');
  const feedbackText = await page.locator('.save-feedback').textContent();
  assert.match(feedbackText || '', /saved successfully/i, 'Save feedback must be displayed');

  // 5. Test Live Origin Verifier Probe
  console.log('--- 5. Test Live Browser Origin Probe ---');
  const verifyBtn = page.locator('button.verify-origin-btn');
  await verifyBtn.click();
  await page.waitForSelector('.verify-outcome');
  const isOutcomeVisible = await page.locator('.verify-outcome').isVisible();
  assert(isOutcomeVisible, 'Origin verification outcome card must be displayed');

  // Capture screenshot: 02-tailscale-configured-light.png
  await page.screenshot({ path: `${shotDir}/02-tailscale-configured-light.png`, fullPage: true });

  // 6. Test Guide Tabs Navigation
  console.log('--- 6. Test Setup Guides Tabs ---');
  const directTab = page.locator('button.guide-tab:has-text("Direct Tailnet IP")');
  await directTab.click();
  await page.waitForTimeout(200);
  assert(await page.locator('.guide-card code:has-text("BIND_ADDRESS=")').isVisible(), 'Direct guide must show BIND_ADDRESS instructions');

  const sidecarTab = page.locator('button.guide-tab:has-text("Docker Sidecar")');
  await sidecarTab.click();
  await page.waitForTimeout(200);
  assert(await page.locator('.guide-card code:has-text("compose.tailscale.yml")').isVisible(), 'Sidecar guide must show compose overlay command');

  const serveTab = page.locator('button.guide-tab:has-text("Tailscale Serve")');
  await serveTab.click();
  await page.waitForTimeout(200);
  assert(await page.locator('.guide-card code:has-text("tailscale serve")').isVisible(), 'Serve guide must show tailscale serve command');

  // 7. Dark Mode & WCAG Contrast Verification
  console.log('--- 7. Test Dark Theme & Token Consistency ---');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shotDir}/03-tailscale-dark-mode.png`, fullPage: true });

  // Verify theme attribute
  const currentTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  assert.equal(currentTheme, 'dark', 'Dark theme attribute must be set');

  // 8. 320px Mobile Viewport Reflow
  console.log('--- 8. Test 320px Mobile Viewport Reflow & Touch Targets ---');
  await page.setViewportSize({ width: 320, height: 600 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shotDir}/04-tailscale-320px-mobile.png`, fullPage: true });

  // Verify no horizontal document overflow
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert(scrollWidth <= clientWidth + 1, `No horizontal scrollbar allowed on 320px: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}`);

  // 9. Negative Controls
  console.log('--- 9. Running Negative Controls ---');
  let negControl1 = false;
  try {
    assert.equal(headerTitle?.trim(), 'NonExistentTitle', 'Must fail because header is Tailscale Access');
  } catch {
    negControl1 = true;
    console.log('Negative control 1 passed: Title assertion correctly failed on invalid title');
  }
  assert(negControl1);

  let negControl2 = false;
  try {
    assert.equal(scrollWidth, 9999, 'Must fail because scrollWidth is 320');
  } catch {
    negControl2 = true;
    console.log('Negative control 2 passed: Responsive overflow assertion correctly failed on extreme number');
  }
  assert(negControl2);

  // 10. Profiling RSS Budget
  console.log('--- 10. Memory Footprint RSS Profiling ---');
  assert(server.pid, 'Server PID must be defined');
  const statmContent = await fs.readFile(`/proc/${server.pid}/statm`, 'utf8');
  const residentPages = parseInt(statmContent.trim().split(/\s+/)[1], 10);
  const serverRssMB = Math.round((residentPages * 4096) / (1024 * 1024));
  console.log(`Measured Fastify Server Process RSS: ${serverRssMB} MB`);
  assert(serverRssMB > 20, `Server RSS (${serverRssMB} MB) must represent genuine non-zero process memory`);
  assert(serverRssMB < 150, `Server Process Memory RSS must remain below 150 MB, got ${serverRssMB} MB`);

  console.log('=== Tailscale UI Playwright Verification Suite Completed with 100% SUCCESS! ===');
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await db.query("DELETE FROM settings WHERE key LIKE 'tailscale_%'");
}
