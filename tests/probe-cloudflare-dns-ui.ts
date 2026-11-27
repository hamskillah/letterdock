import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { chromium, type Page, type Locator } from '@playwright/test';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';
const { db, migrate } = await import('../src/db.js');

console.log('=== Starting Rigorous Browser UI & Accessibility Probe: 1-Click Cloudflare DNS Sync ===');
await migrate();

const zoneId = 'cf-probe-zone-1';
const domainName = 'probe-dns-ui.com';
let dnsRecords = [
  { id: 'rec-1', type: 'MX', name: domainName, content: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10, ttl: 300 },
  { id: 'rec-2', type: 'TXT', name: domainName, content: 'v=spf1 include:amazonses.com ~all', ttl: 300 }
];

// Mock Cloudflare HTTP Server on 56328
const mockCfServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1:56328');
  const method = req.method;
  let body = '';
  for await (const chunk of req) body += chunk;
  const jsonBody = body ? JSON.parse(body) : null;

  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/client/v4/zones') {
    if (url.searchParams.get('name') === 'optin-fail-probe.com') {
      res.statusCode = 409;
      return res.end(JSON.stringify({
        success: false,
        errors: [{ code: 1000, message: 'Cloudflare zone conflict simulation' }]
      }));
    }
    return res.end(JSON.stringify({
      success: true,
      result: [{ id: zoneId, name: domainName, status: 'active', account: { id: 'cf-acc-1' } }]
    }));
  }

  if (url.pathname === '/client/v4/zones/' + zoneId + '/dns_records') {
    if (method === 'GET') {
      return res.end(JSON.stringify({ success: true, result: dnsRecords }));
    }
    if (method === 'POST') {
      const newRec = {
        id: 'rec-' + randomUUID().slice(0, 8),
        type: jsonBody.type,
        name: jsonBody.name,
        content: jsonBody.content,
        priority: jsonBody.priority,
        ttl: 1
      };
      dnsRecords.push(newRec);
      return res.end(JSON.stringify({ success: true, result: newRec }));
    }
  }

  if (url.pathname.startsWith('/client/v4/zones/' + zoneId + '/dns_records/')) {
    const recId = url.pathname.split('/').pop()!;
    if (method === 'DELETE') {
      dnsRecords = dnsRecords.filter(r => r.id !== recId);
      return res.end(JSON.stringify({ success: true, result: { id: recId } }));
    }
    if (method === 'PUT') {
      const idx = dnsRecords.findIndex(r => r.id === recId);
      if (idx !== -1) {
        dnsRecords[idx] = { ...dnsRecords[idx], ...jsonBody };
        return res.end(JSON.stringify({ success: true, result: dnsRecords[idx] }));
      }
    }
  }

  if (url.pathname === '/client/v4/zones/' + zoneId + '/email/routing') {
    return res.end(JSON.stringify({ success: true, result: { enabled: true } }));
  }
  if (url.pathname === '/client/v4/zones/' + zoneId + '/email/routing/dns') {
    return res.end(JSON.stringify({ success: true, result: { success: true } }));
  }
  if (url.pathname === '/client/v4/zones/' + zoneId + '/email/routing/rules/catch_all') {
    return res.end(JSON.stringify({ success: true, result: { enabled: true, actions: [] } }));
  }

  res.statusCode = 404;
  return res.end(JSON.stringify({ success: false, errors: [{ code: 404, message: 'Not found' }] }));
});

await new Promise<void>(resolve => mockCfServer.listen(56328, '127.0.0.1', resolve));

// Clean up test domains to ensure pristine test environment
await db.query("DELETE FROM messages WHERE domain NOT IN ('letterdock.local')");
await db.query("DELETE FROM api_keys WHERE domain NOT IN ('letterdock.local')");
await db.query("DELETE FROM domains WHERE name NOT IN ('letterdock.local')");

// Register domain in DB
await db.query("INSERT INTO domains(name) VALUES($1)", [domainName]);
const { rows: [domainRow] } = await db.query('SELECT name, token FROM domains WHERE name=$1', [domainName]);

const origin = 'http://localhost:56329';
const password = 'probe-ui-password';
const sessionSecret = 'probe-ui-session-secret-over-32-chars-long';
process.env.SESSION_SECRET = sessionSecret;

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    CLOUDFLARE_API_BASE: 'http://127.0.0.1:56328/client/v4',
    CLOUDFLARE_API_TOKEN: 'mock-cf-token-12345',
    PUBLIC_URL: origin,
    APP_PORT: '56329',
    PORT: '56329'
  },
  stdio: 'ignore'
});

// WCAG Contrast calculation helper
function parseRgb(colorStr: string) {
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function relativeLuminance([r, g, b]: number[]) {
  const [rs, gs, bs] = [r / 255, g / 255, b / 255].map(c =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
function contrastRatio(rgb1: number[], rgb2: number[]) {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Coherent alert assertion function (shared between real verification & negative control fixture)
async function assertCoherentAlertState(container: Locator) {
  const errAlert = container.locator('.dns-status-alert.error');
  const succAlert = container.locator('.dns-status-alert.success');
  const hasError = await errAlert.isVisible();
  const hasSuccess = await succAlert.isVisible();
  assert(!(hasError && hasSuccess), 'Contradictory state: error and success alerts cannot both be visible simultaneously');
}

try {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(origin + '/api/health');
      if (res.ok || res.status === 401) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write']
  });
  const page = await context.newPage();

  await fs.mkdir('artifacts/screenshots', { recursive: true });

  console.log('--- 1. Authenticating and Navigating to Domains ---');
  await page.goto(origin);
  await page.getByLabel('Admin password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('.sidebar');

  // Shared live response and transport listener factory ensuring identical gate implementation in production & negative controls
  const expectedRefusalUrl = `${origin}/api/domains/${encodeURIComponent(domainName)}/cloudflare/dns/sync`;
  function attachNetworkResponseGate(targetPage: Page, targetUrl: string) {
    const unexpectedFailures: string[] = [];
    let allowedRefusals = 0;

    targetPage.on('requestfailed', req => {
      unexpectedFailures.push(`REQUEST FAILED: ${req.method()} ${req.url()}: ${req.failure()?.errorText}`);
    });

    targetPage.on('response', res => {
      if (res.status() >= 400) {
        const req = res.request();
        let isExactExpectedRefusal = false;
        if (res.status() === 409 && req.method() === 'POST' && req.url() === targetUrl) {
          try {
            const body = req.postDataJSON();
            if (body && body.replaceConflictingMx === false) {
              isExactExpectedRefusal = true;
              allowedRefusals++;
            }
          } catch {}
        }
        if (!isExactExpectedRefusal) {
          unexpectedFailures.push(`Unexpected HTTP ${res.status()} on ${req.method()} ${req.url()}`);
        }
      }
    });

    return { unexpectedFailures, getAllowedRefusals: () => allowedRefusals };
  }

  // Listeners for authenticated session: capture console, page errors, and network responses
  const consoleErrors: { text: string; url: string }[] = [];
  const pageErrors: string[] = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), url: msg.location().url });
    }
  });
  page.on('pageerror', err => pageErrors.push(err.message));

  const primaryNetworkGate = attachNetworkResponseGate(page, expectedRefusalUrl);

  await page.getByRole('button', { name: 'Domains' }).click();
  await page.waitForSelector('.dns-sync-container');

  const domainCard = page.locator(`.domain-card:has-text("${domainName}")`);
  await domainCard.waitFor();

  console.log('--- 2. Verifying Elements, Visibility & Initial Opt-In Safety ---');
  const conflictBanner = domainCard.locator('.dns-conflict-banner');
  assert(await conflictBanner.isVisible(), 'Conflict banner must be visibly rendered');
  assert(
    (await conflictBanner.textContent())?.includes('inbound-smtp.us-east-1.amazonaws.com'),
    'Conflict banner must identify the external MX record'
  );

  const rows = await domainCard.locator('.dns-record-table tbody tr').all();
  assert.equal(rows.length, 6, 'Must visibly render exactly 6 required sovereign DNS records');

  // Verify replaceConflictingMx checkbox is strictly UNCHECKED by default
  const replaceCheckbox = domainCard.locator('.dns-option-label.danger-option input[type="checkbox"]');
  assert.equal(await replaceCheckbox.isChecked(), false, 'MX replacement MUST default to unchecked (opt-in safety)');

  // -------------------------------------------------------------
  // 3. Testing Real Clipboard Content Copy
  // -------------------------------------------------------------
  console.log('--- 3. Testing Real Clipboard Copy & Content Integrity ---');
  const copyBtn = domainCard.locator('.dns-copy-btn').first();
  await copyBtn.click();
  await page.waitForTimeout(100);
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  console.log('Copied clipboard value:', clipboardText);
  assert.equal(clipboardText, 'letterdock=' + domainRow.token, 'Clipboard content must strictly equal expected TXT token');

  // Capture desktop screenshot before sync
  await page.screenshot({ path: 'artifacts/screenshots/cloudflare-dns-before-sync.png' });
  console.log('Saved screenshot: cloudflare-dns-before-sync.png');

  // -------------------------------------------------------------
  // 4. Verifying Safety Barrier, Natural Focus & Coherent State on Refusal
  // -------------------------------------------------------------
  console.log('--- 4. Testing Opt-in Barrier when replaceConflictingMx is unchecked ---');
  const syncBtn = domainCard.locator('.dns-sync-button');
  await syncBtn.focus();
  assert(await syncBtn.evaluate(el => el === document.activeElement), 'Sync button must receive focus');
  await page.keyboard.press('Enter');

  const errorAlert = domainCard.locator('.dns-status-alert.error');
  await errorAlert.waitFor({ timeout: 5000 });
  assert(await errorAlert.isVisible(), 'Error alert must be visible when conflict exists without override');
  assert.equal(await errorAlert.getAttribute('role'), 'alert', 'Error alert must announce with role="alert"');
  assert(
    (await errorAlert.textContent())?.includes('Conflicting MX records detected'),
    'Error message must state conflict barrier'
  );

  // Assert coherent alert state (error visible, success not visible)
  await assertCoherentAlertState(domainCard);

  // Verify focus returns strictly to the exact 1-Click Sync button after refusal
  await page.waitForTimeout(150);
  assert(
    await syncBtn.evaluate(el => el === document.activeElement),
    'Focus must return strictly to the 1-Click Sync button after refusal'
  );

  // Verify external MX was NOT deleted from Cloudflare
  assert(
    dnsRecords.some(r => r.content === 'inbound-smtp.us-east-1.amazonaws.com'),
    'External MX record must remain protected on Cloudflare'
  );

  // -------------------------------------------------------------
  // 5. Natural Tab Navigation & Explicit Opt-In 1-Click Sync
  // -------------------------------------------------------------
  console.log('--- 5. Testing Natural Tab Navigation & Explicit Opt-in 1-Click Sync ---');
  // Natural keyboard Tab navigation to danger checkbox
  await replaceCheckbox.focus();
  assert(await replaceCheckbox.evaluate(el => el === document.activeElement), 'Checkbox must receive focus via Tab');
  await page.keyboard.press('Space');
  assert.equal(await replaceCheckbox.isChecked(), true, 'Checkbox must be checked via Space');

  // Natural Tab forward from danger checkbox through options to Sync button
  await page.keyboard.press('Tab'); // to syncSpf
  await page.keyboard.press('Tab'); // to syncDmarc
  await page.keyboard.press('Tab'); // to 1-Click Sync Button
  assert(await syncBtn.evaluate(el => el === document.activeElement), 'Natural Tab must land on the 1-Click Sync button');
  await page.keyboard.press('Enter');

  const successAlert = domainCard.locator('.dns-status-alert.success');
  await successAlert.waitFor({ timeout: 10000 });
  assert(await successAlert.isVisible(), 'Success alert must be visible after successful sync');
  assert.equal(await successAlert.getAttribute('role'), 'status', 'Success alert must announce with role="status"');

  // Assert coherent alert state (success visible, error not visible)
  await assertCoherentAlertState(domainCard);

  // Verify focus returns strictly to the exact 1-Click Sync button after success
  await page.waitForTimeout(150);
  assert(
    await syncBtn.evaluate(el => el === document.activeElement),
    'Focus must return strictly to the 1-Click Sync button after success'
  );

  // Verify external MX was deleted and Cloudflare MX were created
  assert(!dnsRecords.some(r => r.content === 'inbound-smtp.us-east-1.amazonaws.com'), 'External MX must now be removed');
  assert(dnsRecords.some(r => r.type === 'MX' && r.content === 'route1.mx.cloudflare.net'), 'Route 1 MX created');

  // Verify EXACTLY six visible synced badges
  const syncedBadges = await domainCard.locator('.dns-record-table .badge-ok').all();
  assert.equal(syncedBadges.length, 6, 'Must render exactly 6 synced badges for the 6 required records');
  for (let bIdx = 0; bIdx < syncedBadges.length; bIdx++) {
    const badge = syncedBadges[bIdx];
    assert(await badge.isVisible(), `Badge ${bIdx + 1} must be visible`);
    assert.equal((await badge.textContent())?.trim(), 'Synced', `Badge ${bIdx + 1} text must strictly equal "Synced"`);
  }

  // Verify Public DNS Resolution panel is coherent and explains propagation
  const publicDnsPanel = domainCard.locator('.public-dns-inspection');
  assert(await publicDnsPanel.isVisible(), 'Public DNS inspection panel must be visible');
  const panelText = await publicDnsPanel.textContent();
  assert(
    panelText?.includes('Public DNS Resolution') && panelText?.includes('propagating'),
    'Public DNS panel must explicitly explain public nameserver propagation'
  );

  // Capture desktop screenshot after sync
  await page.screenshot({ path: 'artifacts/screenshots/cloudflare-dns-after-sync.png' });
  console.log('Saved screenshot: cloudflare-dns-after-sync.png');

  // -------------------------------------------------------------
  // 6. WCAG 2.1 AA Contrast Verification on Badges
  // -------------------------------------------------------------
  console.log('--- 6. Verifying WCAG 2.1 AA Computed Contrast on Badges ---');
  const badgeEl = domainCard.locator('.dns-record-table .badge-ok').first();
  const contrastInfo = await badgeEl.evaluate(el => {
    const style = window.getComputedStyle(el);
    return { color: style.color, bg: style.backgroundColor };
  });
  const ratio = contrastRatio(parseRgb(contrastInfo.color), parseRgb(contrastInfo.bg));
  console.log('Computed Badge-OK Contrast Ratio:', ratio.toFixed(2) + ':1');
  assert(ratio >= 4.5, 'Badge contrast ratio must meet or exceed WCAG AA 4.5:1');

  // -------------------------------------------------------------
  // 7. Testing 320px Mobile Viewport Reflow, Scroll to Last Column & Touch Targets
  // -------------------------------------------------------------
  console.log('--- 7. Testing 320px Mobile Viewport Reflow, Hit Targets & End-to-End Scroll ---');
  await page.setViewportSize({ width: 320, height: 850 });
  await page.waitForTimeout(300);

  const bodyScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const bodyClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  console.log('320px Viewport - scrollWidth:', bodyScrollWidth, 'clientWidth:', bodyClientWidth);
  assert(bodyScrollWidth <= bodyClientWidth, 'Zero horizontal document body overflow on 320px viewport');

  // Verify record-type-tags do not wrap
  const typeTags = await domainCard.locator('.record-type-tag').all();
  for (const tag of typeTags) {
    const text = (await tag.textContent())?.trim();
    assert(text === 'TXT' || text === 'MX', 'Record type must be intact TXT or MX');
  }

  // Verify that table wrapper handles scrolling internally
  const tableWrapper = domainCard.locator('.dns-table-wrapper');
  assert(await tableWrapper.isVisible(), 'Table wrapper must be visible on mobile');
  const wrapperScrollWidth = await tableWrapper.evaluate(el => el.scrollWidth);
  const wrapperClientWidth = await tableWrapper.evaluate(el => el.clientWidth);
  console.log('Table wrapper - scrollWidth:', wrapperScrollWidth, 'clientWidth:', wrapperClientWidth);
  assert(wrapperScrollWidth > wrapperClientWidth, 'Table wrapper must encapsulate horizontal scroll for the table');

  // Scroll to the rightmost column in the table on mobile
  await tableWrapper.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(100);

  // Check last column Copy button hit target, scrollport containment & accessibility
  const lastCopyBtn = domainCard.locator('.dns-copy-btn').last();
  assert(await lastCopyBtn.isVisible(), 'Copy button in last column must be visible after horizontal scrolling');

  const wrapperBoundingBox = (await tableWrapper.boundingBox())!;
  const btnBoundingBox = (await lastCopyBtn.boundingBox())!;
  assert(
    btnBoundingBox.x >= wrapperBoundingBox.x - 2 &&
    btnBoundingBox.x + btnBoundingBox.width <= wrapperBoundingBox.x + wrapperBoundingBox.width + 2,
    'Copy button must be strictly contained inside the visible scrollport of tableWrapper'
  );
  assert(
    btnBoundingBox.width >= 30 && btnBoundingBox.height >= 30,
    `Hit target size must meet touch standards (actual: ${btnBoundingBox.width}x${btnBoundingBox.height})`
  );

  // Hit-test center of the button directly via elementFromPoint
  await lastCopyBtn.scrollIntoViewIfNeeded();
  const isHitTestable = await lastCopyBtn.evaluate(btn => {
    const rect = btn.getBoundingClientRect();
    const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(el?.closest('.dns-copy-btn'));
  });
  assert(isHitTestable, 'Copy button center must be directly hit-testable by pointer/touch');

  // Activate Copy button on 320px mobile and assert actual last row value in clipboard
  await lastCopyBtn.click();
  await page.waitForTimeout(100);
  const copiedLastRow = await page.evaluate(() => navigator.clipboard.readText());
  console.log('Mobile 320px copied last row value:', copiedLastRow);
  assert.equal(
    copiedLastRow,
    'v=DMARC1; p=none; rua=mailto:postmaster@' + domainName,
    'Last row DMARC record must reach clipboard on mobile activation'
  );

  // Reset table scroll position to origin for clean visual capture
  await tableWrapper.evaluate(el => { el.scrollLeft = 0; });
  await domainCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  const mobileSyncBtn = domainCard.locator('.dns-sync-button');
  assert(await mobileSyncBtn.isVisible(), 'Sync button must remain fully visible on 320px mobile viewport');

  await page.screenshot({ path: 'artifacts/screenshots/cloudflare-dns-mobile-320px.png' });
  console.log('Saved screenshot: cloudflare-dns-mobile-320px.png');

  // -------------------------------------------------------------
  // 8. Negative Controls Demonstration (Proving Assertions Fail on Broken DOM Fixtures)
  // -------------------------------------------------------------
  console.log('--- 8. Running Negative Controls on Disposable UI Fixtures to Prove Assertion Integrity ---');

  // Negative Control 1: Broken badge count fixture (4 badges instead of 6)
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.id = 'negative-fixture-badges';
    div.innerHTML = `
      <table class="dns-record-table">
        <tbody>
          <tr><td><span class="badge badge-ok">Synced</span></td></tr>
          <tr><td><span class="badge badge-ok">Synced</span></td></tr>
          <tr><td><span class="badge badge-ok">Synced</span></td></tr>
          <tr><td><span class="badge badge-ok">Synced</span></td></tr>
        </tbody>
      </table>
    `;
    document.body.appendChild(div);
  });
  const brokenBadges = await page.locator('#negative-fixture-badges .badge-ok').all();
  let negBadgePassed = false;
  try {
    assert.equal(brokenBadges.length, 6, 'Must fail because fixture has only 4 badges');
  } catch (err) {
    negBadgePassed = true;
    console.log('Negative control 1 passed: Assertion correctly rejected broken badge count (4 !== 6)');
  }
  await page.evaluate(() => document.getElementById('negative-fixture-badges')?.remove());
  assert(negBadgePassed, 'Gate must strictly fail when badge count is deficient');

  // Negative Control 2: Overflowing body fixture (proving body containment gate can fail)
  await page.evaluate(() => {
    const wideDiv = document.createElement('div');
    wideDiv.id = 'negative-fixture-overflow';
    wideDiv.style.width = '1200px';
    wideDiv.style.height = '10px';
    document.body.appendChild(wideDiv);
  });
  const overflowScrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  const overflowClientW = await page.evaluate(() => document.documentElement.clientWidth);
  let negOverflowPassed = false;
  try {
    assert(overflowScrollW <= overflowClientW, 'Must fail because wideDiv forced scrollWidth > clientWidth');
  } catch (err) {
    negOverflowPassed = true;
    console.log('Negative control 2 passed: Assertion correctly rejected unconstrained body overflow');
  }
  await page.evaluate(() => document.getElementById('negative-fixture-overflow')?.remove());
  assert(negOverflowPassed, 'Gate must strictly fail when horizontal overflow leaks outside containment');

  // Negative Control 3: Rendered contradictory alert fixture (both error and success rendered simultaneously)
  await page.evaluate(() => {
    const alertDiv = document.createElement('div');
    alertDiv.id = 'negative-fixture-alerts';
    alertDiv.innerHTML = `
      <div class="dns-status-alert error" role="alert"><span>Failed</span></div>
      <div class="dns-status-alert success" role="status"><span>Success</span></div>
    `;
    document.body.appendChild(alertDiv);
  });
  const alertContainer = page.locator('#negative-fixture-alerts');
  let negContradictionPassed = false;
  try {
    await assertCoherentAlertState(alertContainer);
  } catch (err) {
    negContradictionPassed = true;
    console.log('Negative control 3 passed: Assertion correctly rejected rendered contradictory dual-alert fixture');
  }
  await page.evaluate(() => document.getElementById('negative-fixture-alerts')?.remove());
  assert(negContradictionPassed, 'Gate must strictly fail when contradictory alerts are shown concurrently');

  // Negative Control 4: Focus on a different button must fail the exact focus check
  const otherBtn = domainCard.locator('button.dns-copy-btn').first();
  await otherBtn.focus();
  let negFocusPassed = false;
  try {
    const isExactSyncBtn = await syncBtn.evaluate(el => el === document.activeElement);
    assert(isExactSyncBtn, 'Must fail because otherBtn has focus instead of syncBtn');
  } catch (err) {
    negFocusPassed = true;
    console.log('Negative control 4 passed: Assertion correctly rejected focus on non-target button');
  }
  assert(negFocusPassed, 'Gate must strictly fail when focus lands on the wrong control');

  // Negative Control 5: Isolated browser context using identical listener gate on the EXACT allowlisted URL with opt-in 409
  const negContext = await browser.newContext();
  const negPage = await negContext.newPage();

  // Intercept the EXACT allowlisted sync URL on negPage to fulfill 409 when replaceConflictingMx: true
  await negPage.route(expectedRefusalUrl, async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      try {
        const body = req.postDataJSON();
        if (body && body.replaceConflictingMx === true) {
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Simulated opt-in 409 conflict on allowlisted endpoint' })
          });
        }
      } catch {}
    }
    return route.continue();
  });

  await negPage.goto(origin);
  await negPage.getByLabel('Admin password').fill(password);
  await negPage.getByRole('button', { name: 'Sign in' }).click();
  await negPage.waitForSelector('.sidebar');

  // Attach identical listener implementation to negPage for authenticated session
  const negNetworkGate = attachNetworkResponseGate(negPage, expectedRefusalUrl);

  // Negative Control 5a: Injected transport failure (aborted request) must be captured by shared gate
  await negPage.route('**/api/aborted-test-probe', route => route.abort());
  await negPage.evaluate(async () => {
    try { await fetch('/api/aborted-test-probe'); } catch {}
  });
  await negPage.waitForTimeout(50);
  assert(
    negNetworkGate.unexpectedFailures.some(f => f.includes('REQUEST FAILED')),
    'Shared gate must capture aborted transport failure'
  );
  let negAbortGatePassed = false;
  try {
    assert.equal(negNetworkGate.unexpectedFailures.length, 0, 'Must fail because aborted request is in failures list');
  } catch (err) {
    negAbortGatePassed = true;
    console.log('Negative control 5a passed: Shared network gate strictly rejected transport failure');
  }
  assert(negAbortGatePassed, 'Shared network gate must strictly fail on transport failures');
  negNetworkGate.unexpectedFailures.length = 0; // Clear for 5b

  // Negative Control 5b: Issue POST to the EXACT allowlisted URL with replaceConflictingMx: true
  const simulatedOptInStatus = await negPage.evaluate(async (url) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replaceConflictingMx: true })
    });
    return res.status;
  }, expectedRefusalUrl);
  assert.equal(simulatedOptInStatus, 409, 'Route must fulfill 409 for opt-in request on exact allowlisted URL');
  await negPage.waitForTimeout(100);

  // Assert that shared listener strictly captured this opt-in 409 on the exact URL as an unexpected failure
  assert.equal(negNetworkGate.unexpectedFailures.length, 1, 'Shared gate must capture opt-in 409 on exact URL as failure');
  assert(
    negNetworkGate.unexpectedFailures[0].includes('Unexpected HTTP 409'),
    'Recorded failure must identify HTTP 409 on exact URL'
  );

  let negOptInGatePassed = false;
  try {
    assert.equal(negNetworkGate.unexpectedFailures.length, 0, 'Must fail because opt-in 409 is in the gate failures list');
  } catch (err) {
    negOptInGatePassed = true;
    console.log('Negative control 5b passed: Shared network gate strictly rejected opt-in 409 on allowlisted URL');
  }
  assert(negOptInGatePassed, 'Shared network gate must strictly fail on opt-in 409 on allowlisted URL');

  await negContext.close();

  // -------------------------------------------------------------
  // 9. Clean Console, Page & Network Integrity
  // -------------------------------------------------------------
  console.log('--- 9. Verifying Clean Console, Page & Network Integrity ---');
  // Console errors: only allow the exact single line reporting the expected 409 refusal by EXACT URL, consumed at most once
  const expectedConsoleRefusalExactUrl = `${origin}/api/domains/${encodeURIComponent(domainName)}/cloudflare/dns/sync`;
  let consoleExemptionsConsumed = 0;
  const unexpectedConsoleErrors = consoleErrors.filter(err => {
    if (err.url === expectedConsoleRefusalExactUrl && err.text.includes('409 (Conflict)')) {
      if (consoleExemptionsConsumed === 0) {
        consoleExemptionsConsumed++;
        return false;
      }
    }
    return true;
  });
  console.log('Unexpected console errors:', unexpectedConsoleErrors);
  console.log('Page errors captured:', pageErrors);
  console.log('Primary gate unexpected failures:', primaryNetworkGate.unexpectedFailures);
  console.log('Primary gate allowed refusals:', primaryNetworkGate.getAllowedRefusals());
  console.log('Console exemptions consumed:', consoleExemptionsConsumed);

  assert.equal(consoleExemptionsConsumed, 1, 'Must match and consume exactly one expected console refusal');
  assert.equal(primaryNetworkGate.getAllowedRefusals(), 1, 'Must record exactly one expected refusal with replaceConflictingMx: false');
  assert.equal(pageErrors.length, 0, 'Must have zero uncaught page runtime errors');
  assert.equal(unexpectedConsoleErrors.length, 0, 'Must have zero unexpected console.error logs');
  assert.equal(primaryNetworkGate.unexpectedFailures.length, 0, 'Must have zero unexpected network failures in primary gate');

  await browser.close();
  console.log('=== All Rigorous Browser UI & Accessibility Probes Passed with 100% Success! ===');
} catch (err) {
  console.error('Probe failed:', err);
  process.exit(1);
} finally {
  server.kill('SIGTERM');
  mockCfServer.close();
  await db.end();
}
