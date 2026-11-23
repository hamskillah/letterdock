import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { resolveMx, resolveNs, resolveTxt } from 'node:dns/promises';

type Action = { type: string; value?: string[] };
type CatchAll = { enabled: boolean; actions: Action[]; source?: string };
type DnsRecord = { type: string; name: string; content: string };
type Zone = { id: string; status: string; account: { id: string } };
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

export async function readCredential(key: string) {
  const { rows: [row] } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  if (!row) return undefined;
  const [iv, tag, encrypted] = String(row.value).split('.').map(value => Buffer.from(value, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export async function saveCredential(key: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const encoded = [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64')).join('.');
  await db.query(`INSERT INTO settings(key,value) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, encoded]);
}

export async function cloudflareToken() {
  return process.env.CLOUDFLARE_API_TOKEN || await readCredential('cloudflare_token');
}

export async function connectCloudflare(token: string) {
  await cloudflare<Zone[]>(token, '/zones?per_page=5');
  await saveCredential('cloudflare_token', token);
}

export async function connectionStatus() {
  const ingress=await (await import('./cloudflare-ingress.js')).managedIngress();
  const oauth=await (await import('./cloudflare-oauth.js')).oauthCapabilities();
  return {
    canProvision: oauth,
    oauthConnected: Boolean(await readCredential('cloudflare_oauth')),
    configured: Boolean(await readCredential('cloudflare_oauth') || await cloudflareToken()),
    fromEnvironment: Boolean(process.env.CLOUDFLARE_API_TOKEN),
    workerConfigured: Boolean(ingress?.url || process.env.CLOUDFLARE_EMAIL_WORKER),
    stagingConfigured: Boolean(ingress?.url || (process.env.R2_BUCKET && process.env.R2_ENDPOINT
      && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY))
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
  if (!detected) return result(false, 'This domain uses another DNS provider. Use the manual setup below.');
  let worker = process.env.CLOUDFLARE_EMAIL_WORKER;
  const apiToken = await cloudflareToken();
  const oauth = await readCredential('cloudflare_oauth');
  const { mcpRequest, oauthCapabilities } = await import('./cloudflare-oauth.js');
  const { managedIngress, provisionIngress } = await import('./cloudflare-ingress.js');
  const manualReady = worker && process.env.R2_BUCKET && process.env.R2_ENDPOINT
    && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
  const ingress = await managedIngress();
  if(!manualReady)worker=ingress?.worker;
  const canProvision = Boolean(oauth && (ingress?.url || await oauthCapabilities()));
  if ((!apiToken && !oauth) || (!manualReady && !canProvision)) {
    return result(false, 'Connect or reconnect Cloudflare to authorize Email Routing, Worker and R2 setup.');
  }
  const request = <T>(path: string, method?: string, body?: unknown) =>
    oauth ? mcpRequest<T>(path, method, body) : cloudflare<T>(apiToken!, path, method, body);

  const params = new URLSearchParams({ name, status: 'active' });
  const zones = await request<Zone[]>('/zones?' + params);
  if (zones.length !== 1) return result(false, 'An active Cloudflare apex zone with token access is required.');
  const base = '/zones/' + zones[0].id;
  if (!manualReady && ingress?.account && ingress.account!==zones[0].account.id)
    throw new SetupConflict('Select a zone in the Cloudflare account connected to this Letterdock installation.');
  const [mx, txt, routing, rule] = await Promise.all([
    request<DnsRecord[]>(base + '/dns_records?' + new URLSearchParams({ type: 'MX', name })),
    request<DnsRecord[]>(base + '/dns_records?' + new URLSearchParams({ type: 'TXT', name: txtName })),
    request<{ enabled: boolean }>(base + '/email/routing'),
    request<CatchAll>(base + '/email/routing/rules/catch_all')
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
    if (!manualReady)worker=(await provisionIngress(zones[0].account.id)).worker;
    if (!txt.length) await request(base + '/dns_records', 'POST', { type: 'TXT', name: txtName, content: desiredTxt, ttl: 1 });
    if (!routing.enabled) await request(base + '/email/routing/dns', 'POST', { name });
    if (!hasRule) await request(base + '/email/routing/rules/catch_all', 'PUT', {
      name: 'Letterdock', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }]
    });
  }
  return result(true, apply
    ? 'Cloudflare configured. Verify DNS once changes propagate, then send a test email.'
    : 'Ready to configure Email Routing, MX and catch-all.');
}
