import { resolveMx, resolveNs } from 'node:dns/promises';

type Action = { type: string; value?: string[] };
type CatchAll = { enabled: boolean; actions: Action[]; source?: string };
type DnsRecord = { type: string; name: string; content: string };
type Zone = { id: string; status: string };
export class SetupConflict extends Error {}

const routingMx = /^route[1-3]\.mx\.cloudflare\.net\.?$/i;
const missing = (error: unknown) => ['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException)?.code ?? '');

async function cloudflare<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN, 'Content-Type': 'application/json' },
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

export async function domainSetup(name: string, token: string, apply = false) {
  const ns = await resolveNs(name).catch(error => { if (missing(error)) return []; throw error; });
  const detected = ns.some(server => /\.ns\.cloudflare\.com\.?$/i.test(server));
  const worker = process.env.CLOUDFLARE_EMAIL_WORKER;
  if (!process.env.CLOUDFLARE_API_TOKEN || !worker || !process.env.R2_BUCKET) {
    return { detected, ready: false, message: 'Configure the Cloudflare token, deployed Email Worker and R2 staging first.' };
  }

  const params = new URLSearchParams({ name, status: 'active' });
  const zones = await cloudflare<Zone[]>('/zones?' + params);
  if (zones.length !== 1) return { detected, ready: false, message: 'An active Cloudflare apex zone with token access is required.' };
  const base = '/zones/' + zones[0].id;
  const txtName = '_letterdock.' + name;
  const desiredTxt = 'letterdock=' + token;
  const [live, mx, txt, routing, rule] = await Promise.all([
    resolveMx(name).catch(error => { if (missing(error)) return []; throw error; }),
    cloudflare<DnsRecord[]>(base + '/dns_records?' + new URLSearchParams({ type: 'MX', name })),
    cloudflare<DnsRecord[]>(base + '/dns_records?' + new URLSearchParams({ type: 'TXT', name: txtName })),
    cloudflare<{ enabled: boolean }>(base + '/email/routing'),
    cloudflare<CatchAll>(base + '/email/routing/rules/catch_all')
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
    if (!txt.length) await cloudflare(base + '/dns_records', 'POST', { type: 'TXT', name: txtName, content: desiredTxt, ttl: 1 });
    if (!routing.enabled) await cloudflare(base + '/email/routing/dns', 'POST', { name });
    if (!hasRule) await cloudflare(base + '/email/routing/rules/catch_all', 'PUT', {
      name: 'Letterdock', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }]
    });
  }
  return { detected: true, ready: true, message: apply
    ? 'Cloudflare configured. Verify DNS once changes propagate, then send a test email.'
    : 'Ready to add verification TXT, enable Email Routing and connect catch-all to ' + worker + '.' };
}
