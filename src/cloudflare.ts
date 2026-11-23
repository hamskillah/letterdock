import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { resolveMx, resolveNs, resolveTxt } from 'node:dns/promises';

type Action = { type: string; value?: string[] };
type CatchAll = { enabled: boolean; actions: Action[]; source?: string };
type DnsRecord = { type: string; name: string; content: string };
type Zone = { id: string; status: string };
export class SetupConflict extends Error {}

const routingMx = /^route[1-3]\.mx\.cloudflare\.net\.?$/i;
const missing = (error: unknown) => ['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException)?.code ?? '');

async function cloudflare<T>(apiToken: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method,
    headers: { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json() as { success: boolean; result: T; errors?: { code: number }[] };
  if (!response.ok || !data.success) {
    throw new SetupConflict('Cloudflare rejected the request (' + response.status +
      (data.errors?.length ? ', code ' + data.errors[0].code : '') + '). Check zone access and token permissions.');
  }
  return data.result;
}

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('Session secret is unavailable');
  return createHash('sha256').update('letterdock-cloudflare-token:' + secret).digest();
}

export async function cloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const { rows: [row] } = await db.query("SELECT value FROM settings WHERE key='cloudflare_token'");
  if (!row) return undefined;
  const [iv, tag, encrypted] = String(row.value).split('.').map(value => Buffer.from(value, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export async function connectCloudflare(token: string) {
  await cloudflare<Zone[]>(token, '/zones?per_page=5');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const value = [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64')).join('.');
  await db.query(`INSERT INTO settings(key,value) VALUES('cloudflare_token',$1)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [value]);
}

export async function connectionStatus() {
  return {
    configured: Boolean(await cloudflareToken()),
    fromEnvironment: Boolean(process.env.CLOUDFLARE_API_TOKEN),
    workerConfigured: Boolean(process.env.CLOUDFLARE_EMAIL_WORKER),
    stagingConfigured: Boolean(process.env.R2_BUCKET && process.env.R2_ENDPOINT
      && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  };
}

export async function domainSetup(name: string, token: string, apply = false) {
  const txtName = '_letterdock.' + name;
  const desiredTxt = 'letterdock=' + token;
  const [ns,live,publicTxt] = await Promise.all([
    resolveNs(name).catch(error => { if (missing(error)) return []; throw error; }),
    resolveMx(name).catch(error => { if (missing(error)) return []; throw error; }),
    resolveTxt(txtName).catch(error => { if (missing(error)) return []; throw error; })
  ]);
  const detected = ns.some(server => /\.ns\.cloudflare\.com\.?$/i.test(server));
  const dns = {
    nameservers: ns, mx: live.map(record => record.exchange),
    txtVerified: publicTxt.some(record => record.join('') === desiredTxt)
  };
  const result = (ready: boolean, message: string) => ({ detected, ready, message, dns });
  const externalMx = dns.mx.filter(host => !routingMx.test(host));
  if (externalMx.length) return result(false, 'Existing mail service detected. MX has been preserved.');
  const worker = process.env.CLOUDFLARE_EMAIL_WORKER;
  const apiToken = await cloudflareToken();
  if (!apiToken || !worker || !process.env.R2_BUCKET || !process.env.R2_ENDPOINT
    || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return result(false, 'Automatic setup requires a server-side Cloudflare token, Email Worker and R2 staging.');
  }

  const params = new URLSearchParams({ name, status: 'active' });
  const zones = await cloudflare<Zone[]>(apiToken, '/zones?' + params);
  if (zones.length !== 1) return result(false, 'An active Cloudflare apex zone with token access is required.');
  const base = '/zones/' + zones[0].id;
  const [mx, txt, routing, rule] = await Promise.all([
    cloudflare<DnsRecord[]>(apiToken, base + '/dns_records?' + new URLSearchParams({ type: 'MX', name })),
    cloudflare<DnsRecord[]>(apiToken, base + '/dns_records?' + new URLSearchParams({ type: 'TXT', name: txtName })),
    cloudflare<{ enabled: boolean }>(apiToken, base + '/email/routing'),
    cloudflare<CatchAll>(apiToken, base + '/email/routing/rules/catch_all')
  ]);
  const conflicts = [...live.map(record => record.exchange), ...mx.map(record => record.content)].filter(host => !routingMx.test(host));
  if (conflicts.length) throw new SetupConflict('Existing MX must be preserved: ' + [...new Set(conflicts)].join(', '));
  if (txt.some(record => record.content.replace(/^"|"$/g, '') !== desiredTxt)) {
    throw new SetupConflict('An existing verification TXT belongs to another setup.');
  }
  const hasRule = rule.enabled && rule.actions.length === 1 && rule.actions[0].type === 'worker' && rule.actions[0].value?.[0] === worker;
  if ((rule.enabled && !hasRule) || (rule.source === 'wrangler' && !hasRule)) {
    throw new SetupConflict('An existing catch-all rule must be preserved.');
  }
  if (apply) {
    if (!txt.length) await cloudflare(apiToken, base + '/dns_records', 'POST', { type: 'TXT', name: txtName, content: desiredTxt, ttl: 1 });
    if (!routing.enabled) await cloudflare(apiToken, base + '/email/routing/dns', 'POST', { name });
    if (!hasRule) await cloudflare(apiToken, base + '/email/routing/rules/catch_all', 'PUT', {
      name: 'Letterdock', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }]
    });
  }
  return result(true, apply
    ? 'Cloudflare configured. Verify DNS once changes propagate, then send a test email.'
    : 'Ready to add verification TXT, enable Email Routing and connect catch-all to ' + worker + '.');
}
