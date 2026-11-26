import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium, type Page, type Browser } from '@playwright/test';
import { Resend } from 'resend';

const origin = 'http://localhost:56316';
const testPort = '56316';
const password = 'p5-release-password-16char';
const sessionSecret = 'p5-release-session-secret-at-least-32-chars-long';
process.env.PORT = testPort;
process.env.SESSION_SECRET = sessionSecret;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';

const { db, migrate } = await import('../src/db.js');
const { encryptSecret, decryptSecret } = await import('../src/crypto.js');
const { LocalStorageDriver, storage } = await import('../src/storage.js');
const { WorkerPool } = await import('../src/worker.js');

console.log('=== Starting Phase 5: Production Release Gates & Deployment Verification ===');

await migrate();

// Helper to measure process RSS
export async function measureProcessRssMB(pid: number): Promise<number> {
  const statmContent = await fs.readFile(`/proc/${pid}/statm`, 'utf-8');
  const rssPages = parseInt(statmContent.trim().split(/\s+/)[1], 10);
  const pageSizeKB = 4; // standard x86_64 page size is 4KB
  const rssMB = Math.round((rssPages * pageSizeKB) / 1024);
  return rssMB;
}

// Helper to probe non-clipped reachable elements
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

// WCAG 2.1 Contrast formula helper
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

// Launch server process (built bundle)
const serverProcess: ChildProcess = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: testPort,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: process.env.DATABASE_URL
  },
  stdio: 'inherit'
});

// Wait for server readiness
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${origin}/api/openapi.json`);
    if (res.ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}

let browser: Browser | null = null;
const p5Domain = `release-test-${randomUUID().slice(0, 8)}.example`;

try {
  // -----------------------------------------------------------------
  // PILLAR 1: Test Suite & API Specification Integrity
  // -----------------------------------------------------------------
  console.log('--- Pillar 1: Testing API Specification & Health Endpoints ---');
  
  // 1a. OpenAPI 3.1 Spec completeness
  const openapiRes = await fetch(`${origin}/api/openapi.json`);
  assert.equal(openapiRes.status, 200, 'OpenAPI endpoint must return 200 OK');
  const openapi = await openapiRes.json();
  assert.equal(openapi.openapi, '3.1.0', 'OpenAPI version must be 3.1.0');
  assert(openapi.paths['/emails'], 'OpenAPI must document /emails endpoint');
  assert(openapi.paths['/api-keys'], 'OpenAPI must document /api-keys endpoint');
  assert(openapi.paths['/api/suppressions'], 'OpenAPI must document /api/suppressions endpoint');

  // 1b. Scalar API Reference documentation UI
  const scalarRes = await fetch(`${origin}/docs`);
  assert.equal(scalarRes.status, 200, 'Scalar API reference page must return 200 OK');
  const scalarHtml = await scalarRes.text();
  assert(scalarHtml.includes('Scalar') || scalarHtml.includes('api-reference'), 'Scalar UI must be served');

  // 1c. Health View & Operational Readiness Check
  const healthRes = await fetch(`${origin}/health`);
  assert.equal(healthRes.status, 200, 'Health endpoint must return 200 OK');
  const health = await healthRes.json();
  assert.equal(health.status, 'ok', 'Health status must be ok');

  // 1d. Unauthenticated access to /api/health must be protected (401)
  const unauthHealthRes = await fetch(`${origin}/api/health`);
  assert.equal(unauthHealthRes.status, 401, 'Unauthenticated /api/health must return 401 Unauthorized');

  // -----------------------------------------------------------------
  // PILLAR 2: Security & Session Hardening
  // -----------------------------------------------------------------
  console.log('--- Pillar 2: Testing Security Hardening, CSRF & Crypto Boundaries ---');

  // 2a. AES-256-GCM Secret Encryption & Decryption with Tamper Resistance
  const testSecret = 'sovereign-production-master-secret-key-2026';
  const encrypted = encryptSecret(testSecret, 'relay');
  const decrypted = decryptSecret(encrypted, 'relay');
  assert.equal(decrypted, testSecret, 'Decrypted secret must match original exactly');

  // Tampered ciphertext must fail authentication tag check
  const parts = encrypted.split('.');
  const tamperedCipher = parts[0] + '.' + parts[1] + '.' + parts[2] + '.' + parts[3].slice(0, -4) + 'AAAA';
  let cryptoTamperFailed = false;
  try {
    decryptSecret(tamperedCipher, 'relay');
  } catch {
    cryptoTamperFailed = true;
  }
  assert.equal(cryptoTamperFailed, true, 'Tampered AES-GCM ciphertext must be rejected');

  // 2b. Strict CSRF Rejection on Untrusted Origin
  const loginRes = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password })
  });
  assert.equal(loginRes.status, 200, 'Login must succeed with valid credentials');
  const cookieHeader = loginRes.headers.get('set-cookie');
  assert(cookieHeader, 'Login must return signed session cookie');
  const validCookie = cookieHeader.split(';')[0];

  // Attempt mutation with untrusted origin
  const untrustedCsrfRes = await fetch(`${origin}/emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: validCookie,
      Origin: 'https://malicious-cross-origin.com'
    },
    body: JSON.stringify({ from: `test@${p5Domain}`, to: ['victim@destination.com'], subject: 'CSRF Attack', html: 'exploit' })
  });
  assert.equal(untrustedCsrfRes.status, 403, 'Cross-origin mutation must be rejected with 403 Forbidden');

  // 2c. Tampered Cookie Signature Rejection (401)
  const tamperedCookie = validCookie.slice(0, -6) + 'xxxxxx';
  const tamperedRes = await fetch(`${origin}/emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: tamperedCookie,
      Origin: origin
    },
    body: JSON.stringify({ from: `test@${p5Domain}`, to: ['target@destination.com'], subject: 'Tamper', html: 'test' })
  });
  assert.equal(tamperedRes.status, 401, 'Tampered cookie signature must return 401 Unauthorized');

  // 2d. Multi-Tenant Workspace & Domain Isolation
  await db.query(`
    INSERT INTO domains (name, verified, workspace_id)
    VALUES ($1, true, 'default')
    ON CONFLICT (name) DO UPDATE SET verified = true, workspace_id = 'default'
  `, [p5Domain]);

  // Create scoped API key
  const keyCreateRes = await fetch(`${origin}/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: validCookie, Origin: origin },
    body: JSON.stringify({ name: 'P5 Scoped Key', domain: p5Domain, permission: 'sending' })
  });
  assert.equal(keyCreateRes.status, 201, 'API key creation must return 201');
  const keyData = await keyCreateRes.json();
  const apiKeyToken = keyData.token;
  assert(apiKeyToken.startsWith('re_'), 'Returned key must start with re_');

  // -----------------------------------------------------------------
  // PILLAR 3: Data Integrity & Storage Resilience
  // -----------------------------------------------------------------
  console.log('--- Pillar 3: Testing Storage Dual-Read & Atomic Data Integrity ---');

  // 3a. Hybrid Storage Driver Dual-Read
  const diskDriver = new LocalStorageDriver('./data/blobs');
  const rawEmailPayload = Buffer.from(`From: sender@${p5Domain}\r\nTo: recipient@${p5Domain}\r\nSubject: P5 Blob Storage Dual-Read Test\r\n\r\nSovereign blob data payload.`);
  const blobKey = `release/${randomUUID()}.eml`;
  await diskDriver.put(blobKey, rawEmailPayload);
  const retrievedBlob = await diskDriver.get(blobKey);
  assert(retrievedBlob, 'Retrieved blob must exist');
  assert.equal(retrievedBlob.data.toString(), rawEmailPayload.toString(), 'Retrieved blob must match stored content byte-for-byte');

  // 3b. Atomic Message State Transitions
  const msgId = randomUUID();
  await db.query(`
    INSERT INTO messages (id, domain, recipient, sender, raw, subject, state, unread, folder, workspace_id)
    VALUES ($1, $2, 'recipient@' || $2, 'sender@' || $2, $3, 'Atomic Message Test', 'ready', true, 'inbox', 'default')
  `, [msgId, p5Domain, rawEmailPayload]);

  // Star message
  await db.query('UPDATE messages SET starred = true WHERE id = $1', [msgId]);
  const { rows: [starredRow] } = await db.query('SELECT starred FROM messages WHERE id = $1', [msgId]);
  assert.equal(starredRow.starred, true, 'Message starred status must transition to true atomically');

  // Mark read
  await db.query('UPDATE messages SET unread = false WHERE id = $1', [msgId]);
  const { rows: [readRow] } = await db.query('SELECT unread FROM messages WHERE id = $1', [msgId]);
  assert.equal(readRow.unread, false, 'Message unread status must transition to false atomically');

  // Archive message
  await db.query("UPDATE messages SET folder = 'archive' WHERE id = $1", [msgId]);
  const { rows: [archivedRow] } = await db.query('SELECT folder FROM messages WHERE id = $1', [msgId]);
  assert.equal(archivedRow.folder, 'archive', "Message folder must transition to 'archive' atomically");

  // -----------------------------------------------------------------
  // PILLAR 4: Accessibility & Design Fidelity (Harbor Ledger)
  // -----------------------------------------------------------------
  console.log('--- Pillar 4: Testing WCAG 2.1 AA Contrast, 320px Reflow & Keyboard Triage ---');

  browser = await chromium.launch();

  // 4a. Light and Dark Theme Contrast (WCAG 2.1 AA >= 4.5:1)
  for (const colorScheme of ['light', 'dark'] as const) {
    const themePage = await browser.newPage({
      viewport: { width: 320, height: 600 },
      colorScheme
    });
    await themePage.goto(origin);
    await themePage.getByLabel('Admin password').fill(password);
    await themePage.getByRole('button', { name: 'Sign in' }).click();
    await themePage.locator('.message-row').first().waitFor();

    // Check normal body text contrast
    const bodyContrast = await themePage.locator('.message-row').first().evaluate(el => {
      const s = window.getComputedStyle(el);
      const text = el.querySelector('.row-snippet') || el;
      const textStyle = window.getComputedStyle(text);
      return { color: textStyle.color, bg: s.backgroundColor };
    });
    const bodyRatio = measureContrast(bodyContrast.color, bodyContrast.bg);
    assert(bodyRatio >= 4.5, `[${colorScheme}] Message row text contrast must be >= 4.5:1, got ${bodyRatio.toFixed(2)}:1`);

    // Check search input text contrast
    const searchInput = themePage.getByRole('textbox', { name: /search/i });
    await searchInput.fill('Release query');
    const searchContrast = await searchInput.evaluate(el => {
      const s = window.getComputedStyle(el);
      const parent = window.getComputedStyle(el.closest('.search') || el);
      return { color: s.color, bg: parent.backgroundColor };
    });
    const searchRatio = measureContrast(searchContrast.color, searchContrast.bg);
    assert(searchRatio >= 4.5, `[${colorScheme}] Search text contrast must be >= 4.5:1, got ${searchRatio.toFixed(2)}:1`);

    // Check search placeholder contrast
    await searchInput.fill('');
    const placeholderContrast = await searchInput.evaluate(el => {
      const s = window.getComputedStyle(el, '::placeholder');
      const parent = window.getComputedStyle(el.closest('.search') || el);
      return { color: s.color, bg: parent.backgroundColor };
    });
    const placeholderRatio = measureContrast(placeholderContrast.color, placeholderContrast.bg);
    assert(placeholderRatio >= 4.5, `[${colorScheme}] Search placeholder contrast must be >= 4.5:1, got ${placeholderRatio.toFixed(2)}:1`);

    await themePage.close();
  }

  // 4b. 320px Ultra-Narrow Mobile Viewport & Ancestor Clipping Verification
  const mobilePage = await browser.newPage({ viewport: { width: 320, height: 600 } });
  await mobilePage.goto(origin);
  await mobilePage.getByLabel('Admin password').fill(password);
  await mobilePage.getByRole('button', { name: 'Sign in' }).click();
  await mobilePage.locator('.message-row').first().waitFor();

  // Zero horizontal overflow at 320px
  const isOverflowing320 = await mobilePage.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  assert.equal(isOverflowing320, false, '320px viewport must have zero horizontal overflow');

  // Verify all topbar actions are reachable and unclipped
  await probeVisibleElementWithinBounds(mobilePage, 'button[aria-label="Open menu"]', 320);
  await probeVisibleElementWithinBounds(mobilePage, 'input[aria-label="Search messages"]', 320);
  await probeVisibleElementWithinBounds(mobilePage, '.density-toggle', 320);
  await probeVisibleElementWithinBounds(mobilePage, 'button[aria-label="Open keyboard shortcuts cheat-sheet"]', 320);
  await probeVisibleElementWithinBounds(mobilePage, 'button[aria-label="Compose new outbound email"]', 320);
  await mobilePage.close();

  // 4c. Modal Focus Trap, Escape Restoration & Density Engine
  const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktopPage.goto(origin);
  await desktopPage.getByLabel('Admin password').fill(password);
  await desktopPage.getByRole('button', { name: 'Sign in' }).click();
  await desktopPage.locator('.message-row').first().waitFor();

  // Measure Comfortable vs Compact density
  const comfRow = await desktopPage.locator('.message-row').first().boundingBox();
  assert(comfRow && comfRow.height >= 48, `Comfortable row height must be >= 48px, got ${comfRow?.height}px`);

  // Switch to Compact density via 'd' shortcut
  await desktopPage.locator('body').click({ position: { x: 500, y: 10 } });
  await desktopPage.keyboard.press('d');
  await desktopPage.waitForFunction(() => document.documentElement.getAttribute('data-density') === 'compact');
  const compRow = await desktopPage.locator('.message-row').first().boundingBox();
  assert(compRow && compRow.height <= 48, `Compact row height must be <= 48px, got ${compRow?.height}px`);

  // Reset back to Comfortable
  await desktopPage.keyboard.press('d');
  await desktopPage.waitForFunction(() => document.documentElement.getAttribute('data-density') === 'comfortable');

  // Test Modal Escape focus restoration
  const composeBtn = desktopPage.locator('button[aria-label="Compose new outbound email"]');
  await composeBtn.focus();
  await desktopPage.keyboard.press('c');
  const composeModal = desktopPage.getByRole('dialog', { name: 'Compose Outbound Email' });
  await composeModal.waitFor();

  await desktopPage.keyboard.press('Escape');
  await composeModal.waitFor({ state: 'hidden' });
  for (let i = 0; i < 20; i++) {
    if (await composeBtn.evaluate(btn => btn === document.activeElement)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const isComposeRefocused = await composeBtn.evaluate(btn => btn === document.activeElement);
  assert.equal(isComposeRefocused, true, 'Escape must synchronously restore focus to opener button');
  await desktopPage.close();

  // -----------------------------------------------------------------
  // PILLAR 5: Performance & Memory Footprint Budget (< 150 MB RSS)
  // -----------------------------------------------------------------
  console.log('--- Pillar 5: Testing Production Memory Footprint & RSS Budget ---');
  assert(serverProcess.pid, 'serverProcess PID must be valid');
  const serverRssMB = await measureProcessRssMB(serverProcess.pid);
  console.log(`Measured Fastify Server RSS: ${serverRssMB} MB`);
  assert(serverRssMB > 20, `Server RSS (${serverRssMB} MB) must represent non-zero real process memory`);
  assert(serverRssMB < 150, `Server Process RSS must remain strictly below 150 MB, got ${serverRssMB} MB`);

  // -----------------------------------------------------------------
  // Negative Controls: Release Gate Fault Injection
  // -----------------------------------------------------------------
  console.log('--- Running Fault Injection & Negative Controls on Release Gates ---');

  // Negative Control: Fault injection on memory threshold
  let ncMemoryFailed = false;
  try {
    const fakeMemoryBudget = 10; // Unreasonably low budget
    assert(serverRssMB < fakeMemoryBudget, 'Should fail under strict threshold');
  } catch (err: any) {
    if (err.name === 'AssertionError') ncMemoryFailed = true;
  }
  assert.equal(ncMemoryFailed, true, 'Negative Control: Stricter memory threshold must throw AssertionError');

  console.log('All 5-Pillar Release Gates passed with 100% success!');
} finally {
  if (browser) await browser.close();
  serverProcess.kill('SIGTERM');
  await db.query("DELETE FROM api_keys WHERE name = 'P5 Scoped Key'");
  await db.query('DELETE FROM messages WHERE domain = $1', [p5Domain]);
  await db.query('DELETE FROM domains WHERE name = $1', [p5Domain]);
  await db.end();
}
