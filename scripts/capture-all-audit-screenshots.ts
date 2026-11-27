import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const origin = 'http://127.0.0.1:3030';
const adminPassword = 'staging-admin-secure-password-1234';

const baseOutDir = resolve('artifacts/visual-audit-screenshots');
const lightDir = join(baseOutDir, 'desktop/light');
const darkDir = join(baseOutDir, 'desktop/dark');
const mobileDir = join(baseOutDir, 'mobile-320px');

async function run() {
  console.log('=== Capturing Complete Visual Audit Screenshots across Light/Dark/Mobile ===');
  await fs.mkdir(lightDir, { recursive: true });
  await fs.mkdir(darkDir, { recursive: true });
  await fs.mkdir(mobileDir, { recursive: true });

  const browser = await chromium.launch();

  // Helper for Desktop themes
  async function captureDesktopSuite(theme: 'light' | 'dark', outDir: string) {
    console.log(`Capturing Desktop (${theme.toUpperCase()}) suite...`);
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      colorScheme: theme
    });

    // 1. Login View
    await page.goto(origin);
    await page.getByLabel('Admin password').waitFor();
    await page.screenshot({ path: join(outDir, '01-login.png') });

    // Login
    await page.getByLabel('Admin password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(500);

    // 2. Inbox View
    await page.locator('.message-row').first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '02-inbox.png') });

    // 3. Reader View
    const firstRow = page.locator('.message-row').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      await page.locator('.reader').waitFor({ timeout: 3000 }).catch(() => {});
      await page.screenshot({ path: join(outDir, '03-reader.png') });
    }

    // 4. Compose Modal
    await page.keyboard.press('c');
    await page.getByRole('dialog', { name: 'Compose Outbound Email' }).waitFor({ timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '04-compose-modal.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 5. Domains View
    await page.getByRole('button', { name: 'Domains' }).click();
    await page.locator('.domain-card, .domains-list').first().waitFor({ timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '05-domains.png') });

    // 6. Outbound Settings View
    await page.getByRole('button', { name: 'Outbound Relay' }).click();
    await page.locator('.outbound-page, .settings').first().waitFor({ timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '06-outbound-settings.png') });

    // 7. API Keys View
    await page.getByRole('button', { name: 'API Keys' }).click();
    await page.locator('.apikeys-page, .settings').first().waitFor({ timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '07-api-keys.png') });

    // 8. Webhooks / Integrations View
    await page.getByRole('button', { name: 'Integrations' }).click();
    await page.locator('.settings').first().waitFor({ timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '08-webhooks-integrations.png') });

    // 9. Suppressions View
    await page.getByRole('button', { name: 'Suppressions' }).click();
    await page.locator('.settings-panel, .settings').first().waitFor({ timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '09-suppressions.png') });

    // 10. Health Dashboard
    await page.getByRole('button', { name: 'Health' }).click();
    await page.locator('.health-heading, .health-view').first().waitFor({ timeout: 3000 }).catch(() => {});
    await page.screenshot({ path: join(outDir, '10-health-dashboard.png') });

    // 11. Scalar API Docs
    await page.goto(origin + '/docs');
    await page.waitForTimeout(1500); // Wait for Scalar interactive rendering
    await page.screenshot({ path: join(outDir, '11-scalar-api-docs.png') });

    await page.close();
  }

  // Capture Desktop Light
  await captureDesktopSuite('light', lightDir);

  // Capture Desktop Dark
  await captureDesktopSuite('dark', darkDir);

  // Capture Mobile 320px
  console.log('Capturing Mobile 320px suite...');
  const mobilePage = await browser.newPage({
    viewport: { width: 320, height: 640 },
    colorScheme: 'dark'
  });

  // Mobile Login
  await mobilePage.goto(origin);
  await mobilePage.getByLabel('Admin password').waitFor();
  await mobilePage.screenshot({ path: join(mobileDir, '01-login.png') });

  // Mobile Sign in
  await mobilePage.getByLabel('Admin password').fill(adminPassword);
  await mobilePage.getByRole('button', { name: 'Sign in' }).click();
  await mobilePage.waitForTimeout(500);

  // Mobile Inbox
  await mobilePage.locator('.message-row').first().waitFor({ timeout: 5000 }).catch(() => {});
  await mobilePage.screenshot({ path: join(mobileDir, '02-inbox.png') });

  // Mobile Navigation Drawer
  const menuBtn = mobilePage.getByRole('button', { name: 'Open menu' });
  if (await menuBtn.isVisible()) {
    await menuBtn.click();
    await mobilePage.locator('#workspace-navigation').waitFor({ timeout: 3000 }).catch(() => {});
    await mobilePage.screenshot({ path: join(mobileDir, '03-drawer-navigation.png') });
    await mobilePage.getByRole('button', { name: 'Close menu' }).click().catch(() => {});
    await mobilePage.waitForTimeout(300);
  }

  // Mobile Reader
  const firstMobileRow = mobilePage.locator('.message-row').first();
  if (await firstMobileRow.isVisible()) {
    await firstMobileRow.click();
    await mobilePage.locator('.reader').waitFor({ timeout: 3000 }).catch(() => {});
    await mobilePage.screenshot({ path: join(mobileDir, '04-reader.png') });
  }

  await mobilePage.close();
  await browser.close();

  // Create Zip Bundle
  console.log('Creating ZIP artifact bundle...');
  const zipPath = resolve('artifacts/letterdock-v1.0.1-visual-audit-screenshots.zip');
  await exec('zip', ['-r', zipPath, 'visual-audit-screenshots'], { cwd: resolve('artifacts') });

  console.log('Successfully captured all audit screenshots and packaged artifact into:', zipPath);
}

run().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
