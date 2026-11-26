import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { db, migrate } from '../src/db.js';
import { encryptSecret, decryptSecret, sha256 } from '../src/crypto.js';
import { sendEmail } from '../src/outbound.js';
import { createEncryptedBackup } from '../scripts/backup.js';
import { restoreEncryptedBackup } from '../scripts/restore.js';
import { rotateAllSecrets } from '../scripts/rotate-keys.js';

console.log('=== Running Post-Release Audit Remediation Test Suite ===');
await migrate();

const port = '56340';
const origin = 'http://127.0.0.1:' + port;
const password = 'audit-remediation-pass-16';
const sessionSecret = 'audit-remediation-session-secret-over-32-chars';
process.env.SESSION_SECRET = sessionSecret;
const appKey1 = '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
const appKey2 = 'ffff0000999988887777666655554444333322221111aaaabbbbccccddddeeee';

// -------------------------------------------------------------
// 1. Outbound SES Relay Driver Test
// -------------------------------------------------------------
console.log('--- 1. Testing Amazon SES Relay Driver ---');
const sesDomain = 'ses-test-' + randomUUID().slice(0, 8) + '.example';
await db.query('INSERT INTO domains (name, verified, workspace_id) VALUES ($1, true, $2)', [sesDomain, 'default']);
await db.query(`
  INSERT INTO outbound_profiles (workspace_id, domain, provider, credentials_encrypted, from_name, from_email, is_default)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`, [
  'default',
  sesDomain,
  'ses',
  encryptSecret(JSON.stringify({
    region: 'us-east-1',
    accessKeyId: 'test-ses-user',
    secretAccessKey: 'test-ses-secret',
    mock: true
  }), 'outbound'),
  'SES Test Dispatcher',
  'noreply@' + sesDomain,
  true
]);

const sesSendResult = await sendEmail({
  workspaceId: 'default',
  from: 'noreply@' + sesDomain,
  to: 'customer@ses-delivery.example',
  subject: 'SES Fleet Advisory',
  text: 'Dispatch confirmed via SES driver.'
});

assert(sesSendResult.id, 'SES send must return message ID');
const { rows: [sesMsg] } = await db.query('SELECT status, provider_message_id FROM outbound_messages WHERE id = $1', [sesSendResult.id]);
assert.equal(sesMsg.status, 'sent', 'SES message status must be updated to sent');
assert(sesMsg.provider_message_id.startsWith('ses-simulated-'), 'Provider message ID must reflect SES relay');

// -------------------------------------------------------------
// 2. Encrypted Backup and Disaster Recovery Restore Test
// -------------------------------------------------------------
console.log('--- 2. Testing Encrypted Backup & Restore ---');
// Create dummy blob for backup
const testStorageDir = resolve('/tmp/antigravity/test-storage-' + randomUUID());
await fs.mkdir(join(testStorageDir, 'blobs'), { recursive: true });
const dummyBlobData = Buffer.from('DISASTER RECOVERY ATOMIC BLOB TEST CONTENT');
await fs.writeFile(join(testStorageDir, 'blobs', 'blob-1.bin'), dummyBlobData);

const backupOutFile = resolve('/tmp/antigravity/backup-test-' + randomUUID() + '.ldk.enc');
const { backupPath, manifest } = await createEncryptedBackup({
  outputPath: backupOutFile,
  storageDir: testStorageDir
});

assert(manifest.db_sha256, 'Manifest must contain database dump SHA256');
assert.equal(manifest.blobs_count, 1, 'Manifest must record 1 blob');
const encryptedRaw = await fs.readFile(backupPath);
assert.equal(encryptedRaw.subarray(0, 4).toString('utf-8'), 'LDKB', 'Backup must start with LDKB magic bytes');

// Test Restore
const restoreTargetDir = resolve('/tmp/antigravity/test-restore-' + randomUUID());
const { manifest: restoredManifest, verifiedBlobs } = await restoreEncryptedBackup(backupPath, {
  targetStorageDir: restoreTargetDir
});

assert.equal(verifiedBlobs, 1, 'Restore must verify and extract all blobs');
const restoredContent = await fs.readFile(join(restoreTargetDir, 'blobs', 'blob-1.bin'));
assert.equal(restoredContent.toString('utf-8'), dummyBlobData.toString('utf-8'), 'Restored blob content must match exact original');

// -------------------------------------------------------------
// 3. Cryptographic Key Rotation Test
// -------------------------------------------------------------
console.log('--- 3. Testing Atomic Cryptographic Key Rotation ---');
// Seed test hook and profile with Key 1
const originalSecret = 'super-secret-webhook-key-12345';
const hookId = randomUUID();
const { rows: [insertedHook] } = await db.query(
  'INSERT INTO hooks (id, url, secret, filter) VALUES ($1, $2, $3, $4) RETURNING id',
  [hookId, 'https://example.com/webhook', encryptSecret(originalSecret, 'webhook'), '']
);

const { hooksRotated } = await rotateAllSecrets(sessionSecret, appKey2);
assert(hooksRotated >= 1, 'At least 1 webhook must be re-encrypted');

// Verify decryption with new key works
const { rows: [rotatedHook] } = await db.query('SELECT secret FROM hooks WHERE id = $1', [hookId]);
process.env.APP_ENCRYPTION_KEY = appKey2;
const decryptedPlaintext = decryptSecret(rotatedHook.secret, 'webhook');
assert.equal(decryptedPlaintext, originalSecret, 'Plaintext after key rotation must match original exactly');
delete process.env.APP_ENCRYPTION_KEY;
await db.query('DELETE FROM hooks WHERE id = $1', [hookId]);

// -------------------------------------------------------------
// 4. Prometheus /metrics Endpoint & Health Test
// -------------------------------------------------------------
console.log('--- 4. Testing Prometheus /metrics Endpoint ---');
const srv = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: port,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: process.env.DATABASE_URL
  },
  stdio: 'inherit'
});

for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(origin + '/health');
    if (res.ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}

const metricsRes = await fetch(origin + '/metrics');
assert.equal(metricsRes.status, 200, '/metrics must return HTTP 200');
const metricsContentType = metricsRes.headers.get('content-type') || '';
assert(metricsContentType.includes('text/plain'), '/metrics must return text/plain Prometheus format');
const metricsBody = await metricsRes.text();
assert(metricsBody.includes('letterdock_up 1'), 'Metrics must export letterdock_up 1');
assert(metricsBody.includes('letterdock_process_resident_memory_bytes'), 'Metrics must export RSS memory');
assert(metricsBody.includes('letterdock_messages_total'), 'Metrics must export total messages counter');
assert(metricsBody.includes('letterdock_storage_free_bytes'), 'Metrics must export storage free bytes');
assert(metricsBody.includes('letterdock_outbound_messages_total'), 'Metrics must export outbound messages total');

// -------------------------------------------------------------
// 5. Dark Mode Contrast & Negative Controls Verification
// -------------------------------------------------------------
console.log('--- 5. Testing Visual Contrast & Negative Controls on Dark Domains ---');
function measureContrast(rgb1Str: string, rgb2Str: string): number {
  const parse = (c: string) => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  };
  const lum = (rgb: number[]) => {
    const a = rgb.map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  };
  const l1 = lum(parse(rgb1Str));
  const l2 = lum(parse(rgb2Str));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// 5a. Negative Control Verification
const paleOnPaleContrast = measureContrast('rgb(248, 250, 252)', 'rgb(243, 247, 242)'); // near white on near white
assert(paleOnPaleContrast < 2.0, 'Negative control: pale on pale text must fail contrast check');

const browser = await chromium.launch();
try {
  const darkPage = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark'
  });

  await darkPage.goto(origin);
  await darkPage.getByLabel('Admin password').fill(password);
  await darkPage.getByRole('button', { name: 'Sign in' }).click();

  // Navigate to Domains page
  await darkPage.getByRole('button', { name: 'Domains' }).click();
  await darkPage.locator('.domain-card').first().waitFor();

// Measure contrast on both section.domain-card and .connection-checks
  const domainCard = darkPage.locator('section.domain-card').first();
  await domainCard.waitFor();
  const cardContrast = await domainCard.evaluate(el => {
    const cardBg = window.getComputedStyle(el).backgroundColor;
    const h2 = el.querySelector('h2');
    const h2Color = h2 ? window.getComputedStyle(h2).color : '';
    return { cardBg, h2Color };
  });

  const domainH2Ratio = measureContrast(cardContrast.h2Color, cardContrast.cardBg);
  console.log(`Domain Card H2 Contrast Ratio: ${domainH2Ratio.toFixed(2)}:1 (${cardContrast.h2Color} on ${cardContrast.cardBg})`);
  assert(domainH2Ratio >= 4.5, `Domain Card heading contrast in dark mode must be >= 4.5:1, got ${domainH2Ratio.toFixed(2)}:1`);

  // Verify Header breadcrumb title mapping
  await darkPage.getByRole('button', { name: 'API Keys' }).click();
  await darkPage.locator('.apikeys-page').waitFor();
  const breadcrumbText = await darkPage.locator('.topbar strong').innerText();
  assert.equal(breadcrumbText, 'API Keys', 'Breadcrumb must display formatted "API Keys" instead of raw "ApiKeys"');
  await darkPage.close();

  // Helper for rigorous WCAG contrast measurement
  async function probeElementContrast(loc: any, label: string) {
    await loc.waitFor({ state: 'visible', timeout: 5000 });
    const { textRgb, bgRgb } = await loc.evaluate((el: HTMLElement) => {
      const s = window.getComputedStyle(el);
      let bg = s.backgroundColor;
      let p = el.parentElement;
      while (p && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
        bg = window.getComputedStyle(p).backgroundColor;
        p = p.parentElement;
      }
      return { textRgb: s.color, bgRgb: bg };
    });
    const ratio = measureContrast(textRgb, bgRgb);
    if (ratio < 4.5) {
      throw new Error(`Contrast failure on ${label}: expected >= 4.5:1, got ${ratio.toFixed(2)}:1 (${textRgb} on ${bgRgb})`);
    }
    return { ratio, textRgb, bgRgb };
  }

  // -------------------------------------------------------------
  // 5b. Comprehensive Surface Contrast Across Both Themes
  // -------------------------------------------------------------
  console.log('--- 5b. Measuring Contrast Across All Elements in Light & Dark Themes ---');
  for (const theme of ['dark', 'light'] as const) {
    const themePage = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      colorScheme: theme
    });
    await themePage.goto(origin);
    await themePage.getByLabel('Admin password').fill(password);
    await themePage.getByRole('button', { name: 'Sign in' }).click();
    await themePage.getByRole('button', { name: 'Domains' }).click();
    
    // Explicitly open Cloudflare setup checklist
    const cfDetails = themePage.locator('.connection-card');
    await cfDetails.waitFor({ state: 'attached' });
    await cfDetails.evaluate((el: HTMLDetailsElement) => { el.open = true; });

    // Explicitly open all domain disclosures (DNS records, Delivery health)
    const domCard = themePage.locator('section.domain-card').first();
    await domCard.waitFor({ state: 'visible' });
    await domCard.locator('details').evaluateAll((list: HTMLDetailsElement[]) => {
      for (const d of list) d.open = true;
    });

    // Probes that MUST exist and be visible (including Delivery Health heading/text & DNS summary)
    const requiredProbes = [
      { loc: domCard.locator('h2'), name: 'Domain Card H2' },
      { loc: domCard.locator('.status'), name: 'Domain Status Pill' },
      { loc: domCard.locator('.delivery-panel h3'), name: 'Delivery Health Heading' },
      { loc: domCard.locator('.delivery-panel p').first(), name: 'Delivery Health Supporting Text' },
      { loc: domCard.locator('.delivery-panel button').first(), name: 'Delivery Health Button' },
      { loc: domCard.locator('.dns-panel:not(.delivery-panel) h3'), name: 'DNS Records Heading' },
      { loc: domCard.locator('.dns-record-details summary'), name: 'DNS Show Record Values Summary' },
      { loc: themePage.locator('.connection-checks dt').first(), name: 'Connection Check DT' },
      { loc: themePage.locator('.connection-checks dd').first(), name: 'Connection Check DD' },
      { loc: domCard.locator('.dns-data dt').first(), name: 'DNS Data DT' },
      { loc: domCard.locator('.dns-data dd').first(), name: 'DNS Data DD' }
    ];

    for (const p of requiredProbes) {
      const { ratio, textRgb, bgRgb } = await probeElementContrast(p.loc, `[${theme}] ${p.name}`);
      console.log(`[${theme}] ${p.name}: ${ratio.toFixed(2)}:1 (${textRgb} on ${bgRgb})`);
    }

    await themePage.close();
  }

  // -------------------------------------------------------------
  // 5c. Rigorous Negative Control: Same Probe on Broken Fixture
  // -------------------------------------------------------------
  console.log('--- 5c. Validating Negative Control via Same Probe Function ---');
  const negControlPage = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark'
  });
  await negControlPage.goto(origin);
  await negControlPage.getByLabel('Admin password').fill(password);
  await negControlPage.getByRole('button', { name: 'Sign in' }).click();

  // Inject old pale-on-pale styling onto a disposable fixture element
  await negControlPage.evaluate(() => {
    const div = document.createElement('div');
    div.id = 'broken-contrast-fixture';
    div.style.backgroundColor = '#f3f7f2'; // Old hardcoded pale background
    div.style.color = '#f8fafc'; // Dark theme light text
    div.innerText = 'Broken Contrast Text';
    document.body.appendChild(div);
  });

  let probeCaughtFailure = false;
  try {
    // Run identical probe function
    await probeElementContrast(negControlPage.locator('#broken-contrast-fixture'), 'Broken Pale Fixture');
  } catch (err: any) {
    if (err.message.includes('Contrast failure on Broken Pale Fixture')) {
      probeCaughtFailure = true;
    }
  }
  assert(probeCaughtFailure, 'Integrity gate: probeElementContrast MUST fail on broken fixture');
  await negControlPage.close();

  // -------------------------------------------------------------
  // 5d. Compose Focus Containment, Boundary Wraps & Opener Restoration
  // -------------------------------------------------------------
  console.log('--- 5d. Testing Focus Trap Boundaries & Opener Restoration ---');
  const focusPage = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark'
  });
  await focusPage.goto(origin);
  await focusPage.getByLabel('Admin password').fill(password);
  await focusPage.getByRole('button', { name: 'Sign in' }).click();

  // Locate opener button and resolve/store its exact element handle BEFORE clicking
  const composeOpener = focusPage.getByRole('button', { name: /compose/i });
  const openerHandle = await composeOpener.elementHandle();
  assert(openerHandle !== null, 'Compose opener handle must be resolved before opening');
  await composeOpener.click();

  const composeDialog = focusPage.getByRole('dialog', { name: 'Compose Outbound Email' });
  await composeDialog.waitFor({ state: 'visible' });

  // Get exact first and last focusable elements inside dialog
  const firstFocusable = composeDialog.locator('button, input, select, textarea').first();
  const lastFocusable = composeDialog.locator('button, input, select, textarea').last();

  // Focus exact first element
  await firstFocusable.focus();
  const isFirstFocusedInitially = await composeDialog.evaluate((dlg, el) => document.activeElement === el, await firstFocusable.elementHandle());
  assert(isFirstFocusedInitially, 'First focusable element must be focused');

  // Shift+Tab from first element wraps to exact last element
  await focusPage.keyboard.down('Shift');
  await focusPage.keyboard.press('Tab');
  await focusPage.keyboard.up('Shift');
  const isLastFocusedAfterWrap = await composeDialog.evaluate((dlg, el) => document.activeElement === el, await lastFocusable.elementHandle());
  assert(isLastFocusedAfterWrap, 'Shift+Tab on first element must wrap exactly to the last element inside dialog');

  // Tab from last element wraps back to exact first element
  await focusPage.keyboard.press('Tab');
  const isFirstFocusedAfterForwardWrap = await composeDialog.evaluate((dlg, el) => document.activeElement === el, await firstFocusable.elementHandle());
  assert(isFirstFocusedAfterForwardWrap, 'Tab on last element must wrap back exactly to the first element inside dialog');

  // Escape closes dialog and restores focus to opener (evaluated strictly against openerHandle saved before opening)
  await focusPage.keyboard.press('Escape');
  await composeDialog.waitFor({ state: 'hidden' });
  const isOpenerFocused = await focusPage.evaluate((btn) => document.activeElement === btn, openerHandle);
  assert(isOpenerFocused, 'Focus must be restored exactly to the original Compose opener element upon closing dialog');
  await focusPage.close();

  // -------------------------------------------------------------
  // 5e. Real DOM Mobile Reachability & Partial-Clipping Rejection Probe
  // -------------------------------------------------------------
  console.log('--- 5e. Testing Mobile Reachability & Partial-Clipping Rejection on Real DOM ---');
  const mobilePage = await browser.newPage({
    viewport: { width: 320, height: 600 },
    colorScheme: 'dark'
  });
  await mobilePage.goto(origin);
  await mobilePage.getByLabel('Admin password').fill(password);
  await mobilePage.getByRole('button', { name: 'Sign in' }).click();

  // Helper function executed directly in browser context to verify unclipped reachability
  async function checkLiveElementReachability(loc: any, label: string) {
    const res = await loc.evaluate((el: HTMLElement) => {
      const box = el.getBoundingClientRect();
      const cx = Math.round(box.x + box.width / 2);
      const cy = Math.round(box.y + box.height / 2);

      // Check clipping against all scrollable/overflow ancestors and viewport
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const pStyle = window.getComputedStyle(parent);
        if (pStyle.overflow !== 'visible' || pStyle.overflowX !== 'visible' || pStyle.overflowY !== 'visible') {
          const pBox = parent.getBoundingClientRect();
          if (box.left < pBox.left - 1 || box.right > pBox.right + 1 || box.top < pBox.top - 1 || box.bottom > pBox.bottom + 1) {
            return { ok: false, error: 'Element overflows clipping ancestor' };
          }
        }
        parent = parent.parentElement;
      }

      // Check viewport bounds
      if (box.left < 0 || box.right > window.innerWidth || box.top < 0 || box.bottom > window.innerHeight) {
        return { ok: false, error: 'Element overflows viewport bounds' };
      }

      // Check hit target at center
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || (!el.contains(hit) && !hit.contains(el))) {
        return { ok: false, error: 'Hit area obscured at center point' };
      }

      return { ok: true };
    });

    if (!res.ok) throw new Error(`Reachability failure on ${label}: ${res.error}`);
    return true;
  }

  // Probe real mobile 320px targets
  await checkLiveElementReachability(mobilePage.getByRole('button', { name: 'Open menu' }), 'Mobile Menu Button');
  await checkLiveElementReachability(mobilePage.getByRole('textbox', { name: /search/i }), 'Mobile Search Bar');

  // Negative Control: Render partly-clipped fixture in live browser where center is strictly inside visible container and receives hit, but right edge is clipped
  await mobilePage.evaluate(() => {
    const container = document.createElement('div');
    container.id = 'clipping-parent';
    container.style.position = 'fixed';
    container.style.top = '10px';
    container.style.left = '10px';
    container.style.width = '80px'; // Container is 80px wide (bounds [10px, 90px])
    container.style.height = '40px';
    container.style.overflow = 'hidden';
    container.style.zIndex = '99999';

    const child = document.createElement('button');
    child.id = 'clipped-child-btn';
    child.style.width = '120px'; // Child is 120px wide (bounds [10px, 130px], clipped from 90px to 130px)
    child.style.height = '40px';
    child.innerText = 'Clipped';
    container.appendChild(child);
    document.body.appendChild(container);
  });

  // Verify that child center (x = 10 + 60 = 70px) is strictly within visible bounds [10px, 90px] and hits the child
  const centerHitResult = await mobilePage.evaluate(() => {
    const child = document.getElementById('clipped-child-btn');
    if (!child) return false;
    const box = child.getBoundingClientRect();
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return hit === child;
  });
  assert(centerHitResult, 'Center point of partly-clipped fixture MUST receive hit test directly');

  let clippingProbeRejected = false;
  try {
    await checkLiveElementReachability(mobilePage.locator('#clipped-child-btn'), 'Partly Clipped Fixture');
  } catch (err: any) {
    if (err.message.includes('Element overflows clipping ancestor')) {
      clippingProbeRejected = true;
    }
  }
  assert(clippingProbeRejected, 'Integrity gate: Mobile reachability probe MUST reject partially clipped element even when center receives hit');
  await mobilePage.close();

  console.log('All Remediation Audit Checks Passed 100%!');
} finally {
  await browser.close();
  srv.kill('SIGTERM');
  await db.query('DELETE FROM hooks WHERE id = $1', [hookId]);
  await db.query('DELETE FROM outbound_profiles WHERE domain = $1', [sesDomain]);
  await db.query('DELETE FROM outbound_messages WHERE domain = $1', [sesDomain]);
  await db.query('DELETE FROM domains WHERE name = $1', [sesDomain]);
  await fs.rm(testStorageDir, { recursive: true, force: true });
  await fs.rm(restoreTargetDir, { recursive: true, force: true });
  await fs.rm(backupOutFile, { force: true });
  await db.end();
}
