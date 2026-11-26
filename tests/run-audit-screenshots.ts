import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const port = '56331';
const origin = 'http://127.0.0.1:' + port;
const password = 'audit-test-password-16';
const sessionSecret = 'audit-session-secret-over-32-chars-long';
const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';

const { db, migrate } = await import('../src/db.js');
await migrate();

// Seed test domain & message
const testDomain = 'audit-visual.example';
await db.query(`
  INSERT INTO domains (name, verified, workspace_id)
  VALUES ($1, true, 'default')
  ON CONFLICT (name) DO UPDATE SET verified = true
`, [testDomain]);

await db.query(`
  INSERT INTO inboxes (address, name, workspace_id)
  VALUES ('ops@' || $1, 'Operations Fleet', 'default')
  ON CONFLICT (address) DO NOTHING
`, [testDomain]);

const testMsgId = randomUUID();
await db.query(`
  INSERT INTO messages (id, domain, recipient, sender, raw, subject, state, unread, folder, starred, workspace_id)
  VALUES ($1, $2, 'ops@' || $2, 'captain@maritime.example', $3, 'Navigational Dispatch: Harbor Ledger Transit Alpha', 'ready', true, 'inbox', true, 'default')
  ON CONFLICT (id) DO NOTHING
`, [testMsgId, testDomain, Buffer.from('From: captain@maritime.example\r\nTo: ops@audit-visual.example\r\nSubject: Navigational Dispatch: Harbor Ledger Transit Alpha\r\n\r\nAll navigational waypoints confirmed.')]);

// Start server
const srv = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: port,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: dbUrl
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

const browser = await chromium.launch();

try {
  // 1. Desktop Light Theme - Inbox View
  const pageLight = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  await pageLight.goto(origin);
  await pageLight.getByLabel('Admin password').fill(password);
  await pageLight.getByRole('button', { name: 'Sign in' }).click();
  await pageLight.locator('.message-row').first().waitFor();
  await pageLight.screenshot({ path: 'tests/audit-screenshots/01-desktop-inbox-light.png' });
  await pageLight.close();

  // 2. Desktop Dark Theme - Inbox View
  const pageDark = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  await pageDark.goto(origin);
  await pageDark.getByLabel('Admin password').fill(password);
  await pageDark.getByRole('button', { name: 'Sign in' }).click();
  await pageDark.locator('.message-row').first().waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/02-desktop-inbox-dark.png' });

  // 3. Message Reader View (Split View)
  await pageDark.locator('.message-row').first().click();
  await pageDark.locator('.reader').waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/03-desktop-reader-dark.png' });

  // 4. Compose Modal
  await pageDark.keyboard.press('c');
  await pageDark.getByRole('dialog', { name: 'Compose Outbound Email' }).waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/04-desktop-compose-modal.png' });
  await pageDark.keyboard.press('Escape');

  // 5. Keyboard Shortcuts Cheat-sheet
  await pageDark.keyboard.press('?');
  await pageDark.getByRole('dialog', { name: 'Keyboard Shortcuts' }).waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/05-desktop-shortcuts-modal.png' });
  await pageDark.keyboard.press('Escape');

  // 6. Domains Management View
  await pageDark.getByRole('button', { name: 'Domains' }).click();
  await pageDark.locator('.domain-card').first().waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/06-desktop-domains-view.png' });

  // 7. Outbound Relay Settings View
  await pageDark.getByRole('button', { name: 'Outbound Relay' }).click();
  await pageDark.locator('.outbound-page').waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/07-desktop-outbound-settings.png' });

  // 8. API Keys View
  await pageDark.getByRole('button', { name: 'API Keys' }).click();
  await pageDark.locator('.apikeys-page').waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/08-desktop-apikeys-view.png' });

  // 9. Suppressions View
  await pageDark.getByRole('button', { name: 'Suppressions' }).click();
  await pageDark.locator('.settings-panel').waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/09-desktop-suppressions-view.png' });

  // 10. Operational Health View
  await pageDark.getByRole('button', { name: 'Health' }).click();
  await pageDark.locator('.health-heading').waitFor();
  await pageDark.screenshot({ path: 'tests/audit-screenshots/10-desktop-health-view.png' });

  await pageDark.close();

  // 11. Mobile 320px Viewport - Inbox
  const pageMobile = await browser.newPage({ viewport: { width: 320, height: 600 }, colorScheme: 'dark' });
  await pageMobile.goto(origin);
  await pageMobile.getByLabel('Admin password').fill(password);
  await pageMobile.getByRole('button', { name: 'Sign in' }).click();
  await pageMobile.locator('.message-row').first().waitFor();
  await pageMobile.screenshot({ path: 'tests/audit-screenshots/11-mobile-320px-inbox.png' });

  // 12. Mobile 320px Viewport - Navigation Drawer
  await pageMobile.getByRole('button', { name: 'Open menu' }).click();
  await pageMobile.locator('#workspace-navigation').waitFor();
  await pageMobile.screenshot({ path: 'tests/audit-screenshots/12-mobile-320px-drawer.png' });
  await pageMobile.close();

  console.log('All 12 audit screenshots captured successfully!');
} finally {
  await browser.close();
  srv.kill('SIGTERM');
  await db.query('DELETE FROM messages WHERE domain = $1', [testDomain]);
  await db.query('DELETE FROM domains WHERE name = $1', [testDomain]);
  await db.query("DELETE FROM inboxes WHERE address LIKE '%@' || $1", [testDomain]);
  await db.end();
}
