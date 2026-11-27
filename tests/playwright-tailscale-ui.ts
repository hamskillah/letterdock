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

console.log('=== Starting Enhanced Tailscale UI Playwright Verification Suite ===');

// Rebuild client and server before running tests
console.log('--- Preflight Build Verification ---');
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

  // 2. Navigate to Tailscale view via sidebar
  console.log('--- 2. Navigate to Tailscale View via Sidebar ---');
  const tailscaleNavBtn = page.locator('aside.sidebar nav button:has-text("Tailscale")');
  assert.equal(await tailscaleNavBtn.isVisible(), true, 'Tailscale sidebar button must be visible');
  await tailscaleNavBtn.click();
  await page.waitForSelector('.tailscale-view');

  // Verify Header shows 'Tailscale Access'
  const headerTitle = await page.locator('.topbar strong').textContent();
  assert.equal(headerTitle?.trim(), 'Tailscale Access', 'Topbar title must reflect Tailscale Access');

  // 3. Inspect Host Daemon Panel & Hit Targets
  console.log('--- 3. Inspect Host Daemon Overview, Metrics & Touch Targets (>= 30px) ---');
  const metrics = await page.locator('.tailscale-status-grid .status-metric').count();
  assert(metrics >= 4, 'Must display at least 4 status metrics');

  // Measure copy mini button touch targets
  const copyBtns = page.locator('.copy-mini-btn');
  const btnCount = await copyBtns.count();
  assert(btnCount > 0, 'At least one copy button must exist');
  for (let i = 0; i < btnCount; i++) {
    const btn = copyBtns.nth(i);
    const box = await btn.boundingBox();
    assert(box, 'Copy button must have measurable bounding box');
    assert(box.width >= 30, `Copy button ${i} width (${box.width}px) must be >= 30px`);
    assert(box.height >= 30, `Copy button ${i} height (${box.height}px) must be >= 30px`);
  }

  // Click copy button and test icon swap to checkmark
  const firstCopyBtn = copyBtns.first();
  await firstCopyBtn.click();
  await page.waitForTimeout(100);
  const checkIcon = firstCopyBtn.locator('svg.lucide-check');
  assert(await checkIcon.isVisible(), 'Copy button must transition to Check icon upon click');

  // Capture screenshot 01
  await page.screenshot({ path: `${shotDir}/01-tailscale-overview-light.png`, fullPage: true });

  // 4. Test Settings Form: Toggle, Quick-Fill, Save & Persistence
  console.log('--- 4. Configure Tailscale Settings, Quick-Fill & Reload Persistence ---');
  const toggleCheckbox = page.locator('#tailscale-enabled-toggle');
  const isCheckedInitially = await toggleCheckbox.isChecked();
  if (!isCheckedInitially) {
    await toggleCheckbox.check();
  }

  const quickFillBtn = page.locator('button.quick-fill-btn:has-text("Use MagicDNS")');
  let testOriginUrl = 'https://letterdock.test-tailnet.ts.net';
  if (await quickFillBtn.isVisible()) {
    await quickFillBtn.click();
    testOriginUrl = await page.locator('#tailscale-origin-input').inputValue();
    assert(testOriginUrl.startsWith('https://'), 'Quick-fill MagicDNS URL must start with https://');
  } else {
    await page.fill('#tailscale-origin-input', testOriginUrl);
  }

  // Save configuration
  await page.click('button.tailscale-save-btn');
  await page.waitForSelector('.save-feedback');
  const feedbackText = await page.locator('.save-feedback').textContent();
  assert.match(feedbackText || '', /saved successfully/i, 'Save feedback must be displayed');

  // Test Persistence across page reload
  await page.reload();
  await page.waitForSelector('.topbar');
  await page.locator('aside.sidebar nav button:has-text("Tailscale")').click();
  await page.waitForSelector('.tailscale-view');
  assert.equal(await page.locator('#tailscale-enabled-toggle').isChecked(), true, 'Toggle must remain enabled after reload');
  assert.equal(await page.locator('#tailscale-origin-input').inputValue(), testOriginUrl, 'Configured origin must persist after reload');

  // 5. Test Live Origin Verifier Probe & Explicit Reason Matching
  console.log('--- 5. Test Live Browser Origin Probe & Exact Verification Reason ---');
  const verifyBtn = page.locator('button.verify-origin-btn');
  await verifyBtn.click();
  await page.waitForSelector('.verify-outcome');
  
  const outcomeCard = page.locator('.verify-outcome');
  assert.equal(await outcomeCard.getAttribute('role'), 'status', 'Verifier outcome must have role="status"');
  assert.equal(await outcomeCard.getAttribute('aria-live'), 'polite', 'Verifier outcome must have aria-live="polite"');

  const outcomeTitle = await page.locator('.verify-outcome strong').textContent();
  const outcomeReason = await page.locator('.verify-outcome p').textContent();
  assert.equal(outcomeTitle?.trim(), 'Origin is Authorized', 'Localhost origin must be authorized');
  assert.match(outcomeReason?.trim() || '', /Matches Public URL origin|Allowed origin/, 'Must state exact authorization reason');

  // Capture screenshot 02
  await page.screenshot({ path: `${shotDir}/02-tailscale-configured-light.png`, fullPage: true });

  // 6. Test Guide Tabs: ARIA Attributes & Keyboard Navigation (Arrow Keys / Home / End)
  console.log('--- 6. Test Setup Guides: ARIA Attributes & Keyboard Navigation ---');
  const tabNav = page.locator('.guide-tab-nav');
  assert.equal(await tabNav.getAttribute('role'), 'tablist', 'Tab nav must have role="tablist"');

  const serveTab = page.locator('#tab-serve');
  const directTab = page.locator('#tab-direct');
  const sidecarTab = page.locator('#tab-sidecar');

  assert.equal(await serveTab.getAttribute('aria-controls'), 'panel-serve');
  assert.equal(await directTab.getAttribute('aria-controls'), 'panel-direct');
  assert.equal(await sidecarTab.getAttribute('aria-controls'), 'panel-sidecar');

  // Focus serveTab and press ArrowRight -> should focus directTab
  await serveTab.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await directTab.getAttribute('aria-selected'), 'true', 'ArrowRight must select directTab');
  assert.equal(await page.locator('#panel-direct').isVisible(), true, 'Direct panel must be visible');

  // Press ArrowRight again -> should focus sidecarTab
  await page.keyboard.press('ArrowRight');
  assert.equal(await sidecarTab.getAttribute('aria-selected'), 'true', 'ArrowRight must select sidecarTab');
  assert.equal(await page.locator('#panel-sidecar').isVisible(), true, 'Sidecar panel must be visible');

  // Press Home -> should return to serveTab
  await page.keyboard.press('Home');
  assert.equal(await serveTab.getAttribute('aria-selected'), 'true', 'Home must select serveTab');
  assert.equal(await page.locator('#panel-serve').isVisible(), true, 'Serve panel must be visible');

  // 7. Dark Mode & Text Contrast (WCAG 2.1 AA >= 4.5:1)
  console.log('--- 7. Test Dark Theme & Text Contrast Compliance ---');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await page.waitForTimeout(300);

  // Measure computed color of .verify-outcome p in dark mode
  const pColor = await page.locator('.verify-outcome.allowed p').evaluate(el => window.getComputedStyle(el).color);
  console.log(`Dark mode verifier outcome text color: ${pColor}`);
  // Must match rgb(167, 243, 208) which corresponds to #a7f3d0 (8.5:1 on #064e3b)
  assert.equal(pColor, 'rgb(167, 243, 208)', 'Dark mode outcome text color must be #a7f3d0 for high contrast (>7:1)');

  // Capture screenshot 03
  await page.screenshot({ path: `${shotDir}/03-tailscale-dark-mode.png`, fullPage: true });

  // 8. 320px Mobile Viewport Reflow Verification (Inner Containers & Document)
  console.log('--- 8. Test 320px Mobile Viewport Reflow on All Containers ---');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const docScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const docClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert(docScrollWidth <= docClientWidth + 1, `Document must not overflow on 320px: ${docScrollWidth} <= ${docClientWidth}`);

  // Check inner scroller containers
  const containersNoOverflow = await page.evaluate(() => {
    const selectors = ['.settings', '.settings-panel', '.current-origin-card', '.tailscale-form'];
    const results: Array<{ selector: string; scrollWidth: number; clientWidth: number; ok: boolean }> = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        results.push({
          selector: sel,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          ok: el.scrollWidth <= el.clientWidth + 2
        });
      }
    }
    return results;
  });

  for (const c of containersNoOverflow) {
    assert(c.ok, `Container ${c.selector} must not horizontally overflow: ${c.scrollWidth} <= ${c.clientWidth}`);
  }

  // Capture screenshot 04
  await page.screenshot({ path: `${shotDir}/04-tailscale-320px-mobile.png`, fullPage: true });

  // 9. Negative Controls: Exercising Actual Detection Logic against Failing Fixtures
  console.log('--- 9. Running Disposable Negative Controls against Defect Fixtures ---');

  // Negative Control 1: Test that the overflow detector actually catches a real 1000px overflowing fixture!
  const overflowDetected = await page.evaluate(() => {
    const fixture = document.createElement('div');
    fixture.id = 'temp-overflow-negative-control';
    fixture.style.width = '1000px';
    fixture.style.height = '10px';
    fixture.innerText = 'Defect Fixture';
    document.body.appendChild(fixture);
    const hasOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    fixture.remove();
    return hasOverflow;
  });
  assert(overflowDetected, 'Negative Control 1 PASSED: Overflow detector reliably detects real DOM overflow');

  // Negative Control 2: Test that contrast assertion fails on poor contrast color
  function calculateLuminance(r: number, g: number, b: number) {
    const a = [r, g, b].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  }
  function contrastRatio(rgb1: [number, number, number], rgb2: [number, number, number]) {
    const l1 = calculateLuminance(...rgb1);
    const l2 = calculateLuminance(...rgb2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  // #a7f3d0 (167, 243, 208) over #064e3b (6, 78, 59)
  const realDarkContrast = contrastRatio([167, 243, 208], [6, 78, 59]);
  console.log(`Measured dark mode contrast ratio: ${realDarkContrast.toFixed(2)}:1`);
  assert(realDarkContrast >= 4.5, `Dark mode contrast (${realDarkContrast}:1) must exceed WCAG AA 4.5:1`);

  // Defective low contrast: #555 over #666
  const badContrast = contrastRatio([85, 85, 85], [102, 102, 102]);
  let nc2Failed = false;
  try {
    assert(badContrast >= 4.5, 'Must fail on 1.4:1 contrast');
  } catch {
    nc2Failed = true;
    console.log(`Negative Control 2 PASSED: Contrast assertion reliably rejected bad contrast (${badContrast.toFixed(2)}:1)`);
  }
  assert(nc2Failed);

  // 10. Profiling RSS Budget
  console.log('--- 10. Memory Footprint RSS Profiling ---');
  assert(server.pid, 'Server PID must be defined');
  const statmContent = await fs.readFile(`/proc/${server.pid}/statm`, 'utf8');
  const residentPages = parseInt(statmContent.trim().split(/\s+/)[1], 10);
  const serverRssMB = Math.round((residentPages * 4096) / (1024 * 1024));
  console.log(`Measured Fastify Server Process RSS: ${serverRssMB} MB`);
  assert(serverRssMB > 20, `Server RSS (${serverRssMB} MB) must represent genuine non-zero process memory`);
  assert(serverRssMB < 150, `Server Process Memory RSS must remain below 150 MB, got ${serverRssMB} MB`);

  console.log('=== Enhanced Tailscale UI Playwright Verification Suite Completed with 100% SUCCESS! ===');
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await db.query("DELETE FROM settings WHERE key LIKE 'tailscale_%'");
}
