import { db } from './db.js';
import { resolveMx, resolveNs, resolveTxt } from 'node:dns/promises';
import { encryptSecret, decryptSecret } from './crypto.js';

export { encryptSecret, decryptSecret };

type Action = { type: string; value?: string[] };
type CatchAll = { enabled: boolean; actions: Action[]; source?: string };
type DnsRecord = { id?: string; type: string; name: string; content: string; priority?: number; ttl?: number };
type Zone = { id: string; name: string; status: string; account: { id: string } };
export class SetupConflict extends Error {}

export type DnsRecordItem = {
  id?: string;
  type: 'TXT' | 'MX';
  name: string;
  expected: string;
  expectedPriority?: number;
  current?: string | null;
  currentPriority?: number;
  status: 'synced' | 'missing' | 'conflicted';
};

export type DnsStatusReport = {
  domain: string;
  zoneId: string;
  zoneName: string;
  detected: boolean;
  canSync: boolean;
  hasConflicts: boolean;
  conflicts: Array<{ id?: string; type: string; name: string; content: string; priority?: number }>;
  records: DnsRecordItem[];
  spf: { status: 'synced' | 'missing' | 'needs_merge'; current?: string | null; expected: string };
  dmarc: { status: 'synced' | 'missing'; current?: string | null; expected: string };
};

export type SyncDnsOptions = {
  replaceConflictingMx?: boolean;
  syncSpf?: boolean;
  syncDmarc?: boolean;
  apiToken?: string;
};

export type SyncActionResult = {
  record: string;
  type: 'TXT' | 'MX';
  action: 'created' | 'updated' | 'already_synced';
  content: string;
  priority?: number;
};

export type SyncDnsReport = {
  ok: boolean;
  domain: string;
  zoneId: string;
  verified: boolean;
  synced: SyncActionResult[];
  removed: Array<{ type: string; name: string; content: string; priority?: number }>;
  message: string;
};

const routingMx = /^route[1-3]\.mx\.cloudflare\.net\.?$/i;
const missing = (error: unknown) => ['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException)?.code ?? '');

async function cloudflare<T>(apiToken: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const base = process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
  const response = await fetch(base + path, {
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

export async function readCredential(key: string) {
  const { rows: [row] } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  return row ? decryptSecret(row.value, 'cloudflare-token') : undefined;
}

export async function saveCredential(key: string, value: string) {
  const encoded = encryptSecret(value, 'cloudflare-token');
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

export async function getCloudflareRequester(tokenOverride?: string) {
  const apiToken = tokenOverride || await cloudflareToken();
  const oauth = !tokenOverride ? await readCredential('cloudflare_oauth') : null;

  if (oauth) {
    const { mcpRequest } = await import('./cloudflare-oauth.js');
    return <T>(path: string, method = 'GET', body?: unknown) => mcpRequest<T>(path, method, body);
  }
  if (apiToken) {
    return <T>(path: string, method = 'GET', body?: unknown) => cloudflare<T>(apiToken, path, method, body);
  }
  throw new SetupConflict('Cloudflare credentials not found. Connect Cloudflare OAuth or configure an API Token.');
}

export async function getZoneForDomain(requester: <T>(path: string, method?: string, body?: unknown) => Promise<T>, domainName: string): Promise<Zone> {
  const params = new URLSearchParams({ name: domainName, status: 'active' });
  const zones = await requester<Zone[]>('/zones?' + params);
  if (zones.length >= 1) return zones[0];

  const parts = domainName.split('.');
  if (parts.length > 2) {
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      const pZones = await requester<Zone[]>('/zones?' + new URLSearchParams({ name: parent, status: 'active' }));
      if (pZones.length >= 1) return pZones[0];
    }
  }
  throw new SetupConflict(`No active Cloudflare zone found for domain: ${domainName}. Ensure the zone is active in your Cloudflare account.`);
}

export async function domainSetup(name: string, token: string, apply = false, options: { replaceMx?: boolean } = {}) {
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
  if (externalMx.length && !options.replaceMx) return result(false, 'Existing mail service detected. MX has been preserved.');
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
  if (conflicts.length && !options.replaceMx) throw new SetupConflict('Existing MX must be preserved: ' + [...new Set(conflicts)].join(', '));
  if (txt.some(record => record.content.replace(/^"|"$/g, '') !== desiredTxt)) {
    throw new SetupConflict('An existing verification TXT belongs to another setup.');
  }
  const hasRule = rule.enabled && rule.actions.length === 1 && rule.actions[0].type === 'worker' && rule.actions[0].value?.[0] === worker;
  if ((rule.enabled && !hasRule) || (rule.source === 'wrangler' && !hasRule)) {
    throw new SetupConflict('An existing catch-all rule must be preserved.');
  }
  if (apply) {
    if (options.replaceMx) {
      for (const rec of mx.filter(r => !routingMx.test(r.content))) {
        if (rec.id) await request(base + '/dns_records/' + rec.id, 'DELETE');
      }
    }
    if (!manualReady)worker=(await provisionIngress(zones[0].account.id)).worker;
    if (!txt.length) await request(base + '/dns_records', 'POST', { type: 'TXT', name: txtName, content: desiredTxt, ttl: 1 });
    // Cloudflare interprets a supplied name as a subdomain; omit it for the zone apex.
    if (!routing.enabled) await request(base + '/email/routing/dns', 'POST');
    if (!hasRule) await request(base + '/email/routing/rules/catch_all', 'PUT', {
      name: 'Letterdock', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }]
    });
  }
  return result(true, apply
    ? 'Cloudflare configured. Verify DNS once changes propagate, then send a test email.'
    : 'Ready to configure Email Routing, MX and catch-all.');
}

export async function getDomainDnsStatus(name: string, token: string, tokenOverride?: string): Promise<DnsStatusReport> {
  const request = await getCloudflareRequester(tokenOverride);
  const zone = await getZoneForDomain(request, name);
  const base = '/zones/' + zone.id;

  const txtName = '_letterdock.' + name;
  const desiredTxt = 'letterdock=' + token;
  const dmarcName = '_dmarc.' + name;
  const desiredDmarc = 'v=DMARC1; p=none; rua=mailto:postmaster@' + name;
  const desiredSpf = 'v=spf1 include:_spf.mx.cloudflare.net ~all';

  const dnsRecords = await request<DnsRecord[]>(base + '/dns_records?per_page=100');

  const conflicts: Array<{ id?: string; type: string; name: string; content: string; priority?: number }> = [];
  const records: DnsRecordItem[] = [];

  // 1. Check TXT _letterdock
  const txtRec = dnsRecords.find(r => r.type === 'TXT' && (r.name === txtName || r.name === '_letterdock' || r.name === '_letterdock.' + zone.name));
  if (!txtRec) {
    records.push({ type: 'TXT', name: txtName, expected: desiredTxt, current: null, status: 'missing' });
  } else {
    const cleanContent = txtRec.content.replace(/^"|"$/g, '');
    if (cleanContent === desiredTxt) {
      records.push({ id: txtRec.id, type: 'TXT', name: txtName, expected: desiredTxt, current: cleanContent, status: 'synced' });
    } else {
      records.push({ id: txtRec.id, type: 'TXT', name: txtName, expected: desiredTxt, current: cleanContent, status: 'conflicted' });
      conflicts.push({ id: txtRec.id, type: 'TXT', name: txtName, content: cleanContent });
    }
  }

  // 2. Check MX Records
  const expectedMx = [
    { exchange: 'route1.mx.cloudflare.net', priority: 49 },
    { exchange: 'route2.mx.cloudflare.net', priority: 78 },
    { exchange: 'route3.mx.cloudflare.net', priority: 41 }
  ];

  const apexMx = dnsRecords.filter(r => r.type === 'MX' && (r.name === name || r.name === '@' || r.name === zone.name));
  for (const mx of apexMx) {
    if (!routingMx.test(mx.content)) {
      conflicts.push({ id: mx.id, type: 'MX', name: mx.name, content: mx.content, priority: mx.priority });
    }
  }

  for (const exp of expectedMx) {
    const found = apexMx.find(r => r.content.toLowerCase().replace(/\.$/, '') === exp.exchange && r.priority === exp.priority);
    if (found) {
      records.push({
        id: found.id,
        type: 'MX',
        name,
        expected: exp.exchange,
        expectedPriority: exp.priority,
        current: found.content,
        currentPriority: found.priority,
        status: 'synced'
      });
    } else {
      records.push({
        type: 'MX',
        name,
        expected: exp.exchange,
        expectedPriority: exp.priority,
        current: null,
        status: 'missing'
      });
    }
  }

  // 3. Check SPF
  const spfRec = dnsRecords.find(r => r.type === 'TXT' && (r.name === name || r.name === '@' || r.name === zone.name) && r.content.replace(/^"|"$/g, '').startsWith('v=spf1'));
  let spfStatus: 'synced' | 'missing' | 'needs_merge' = 'missing';
  let currentSpf: string | null = null;
  if (spfRec) {
    currentSpf = spfRec.content.replace(/^"|"$/g, '');
    if (currentSpf.includes('include:_spf.mx.cloudflare.net')) {
      spfStatus = 'synced';
    } else {
      spfStatus = 'needs_merge';
    }
  }

  // 4. Check DMARC
  const dmarcRec = dnsRecords.find(r => r.type === 'TXT' && (r.name === dmarcName || r.name === '_dmarc' || r.name === '_dmarc.' + zone.name) && r.content.replace(/^"|"$/g, '').startsWith('v=DMARC1'));
  let dmarcStatus: 'synced' | 'missing' = 'missing';
  let currentDmarc: string | null = null;
  if (dmarcRec) {
    currentDmarc = dmarcRec.content.replace(/^"|"$/g, '');
    dmarcStatus = 'synced';
  }

  return {
    domain: name,
    zoneId: zone.id,
    zoneName: zone.name,
    detected: true,
    canSync: true,
    hasConflicts: conflicts.length > 0,
    conflicts,
    records,
    spf: { status: spfStatus, current: currentSpf, expected: desiredSpf },
    dmarc: { status: dmarcStatus, current: currentDmarc, expected: desiredDmarc }
  };
}

export async function syncDomainDns(name: string, token: string, options: SyncDnsOptions = {}): Promise<SyncDnsReport> {
  const request = await getCloudflareRequester(options.apiToken);
  const zone = await getZoneForDomain(request, name);
  const base = '/zones/' + zone.id;

  const txtName = '_letterdock.' + name;
  const desiredTxt = 'letterdock=' + token;
  const dmarcName = '_dmarc.' + name;
  const desiredDmarc = 'v=DMARC1; p=none; rua=mailto:postmaster@' + name;

  const dnsRecords = await request<DnsRecord[]>(base + '/dns_records?per_page=100');

  const synced: SyncActionResult[] = [];
  const removed: Array<{ type: string; name: string; content: string; priority?: number }> = [];

  // Check MX conflicts
  const apexMx = dnsRecords.filter(r => r.type === 'MX' && (r.name === name || r.name === '@' || r.name === zone.name));
  const conflictingMx = apexMx.filter(r => !routingMx.test(r.content));

  if (conflictingMx.length > 0) {
    if (!options.replaceConflictingMx) {
      throw new SetupConflict('Conflicting MX records detected (' + conflictingMx.map(m => m.content).join(', ') + '). Set replaceConflictingMx=true to replace.');
    }
    for (const cmx of conflictingMx) {
      if (cmx.id) {
        await request(base + '/dns_records/' + cmx.id, 'DELETE');
        removed.push({ type: 'MX', name: cmx.name, content: cmx.content, priority: cmx.priority });
      }
    }
  }

  // 1. Sync TXT _letterdock
  const existingTxt = dnsRecords.find(r => r.type === 'TXT' && (r.name === txtName || r.name === '_letterdock' || r.name === '_letterdock.' + zone.name));
  if (!existingTxt) {
    await request(base + '/dns_records', 'POST', { type: 'TXT', name: txtName, content: desiredTxt, ttl: 1 });
    synced.push({ record: txtName, type: 'TXT', action: 'created', content: desiredTxt });
  } else {
    const clean = existingTxt.content.replace(/^"|"$/g, '');
    if (clean !== desiredTxt) {
      await request(base + '/dns_records/' + existingTxt.id, 'PUT', { type: 'TXT', name: txtName, content: desiredTxt, ttl: 1 });
      synced.push({ record: txtName, type: 'TXT', action: 'updated', content: desiredTxt });
    } else {
      synced.push({ record: txtName, type: 'TXT', action: 'already_synced', content: desiredTxt });
    }
  }

  // 2. Sync MX records
  const expectedMx = [
    { exchange: 'route1.mx.cloudflare.net', priority: 49 },
    { exchange: 'route2.mx.cloudflare.net', priority: 78 },
    { exchange: 'route3.mx.cloudflare.net', priority: 41 }
  ];

  for (const exp of expectedMx) {
    const found = apexMx.find(r => r.content.toLowerCase().replace(/\.$/, '') === exp.exchange && r.priority === exp.priority);
    if (!found) {
      await request(base + '/dns_records', 'POST', { type: 'MX', name, content: exp.exchange, priority: exp.priority, ttl: 1 });
      synced.push({ record: name, type: 'MX', action: 'created', content: exp.exchange, priority: exp.priority });
    } else {
      synced.push({ record: name, type: 'MX', action: 'already_synced', content: exp.exchange, priority: exp.priority });
    }
  }

  // 3. Sync SPF (if syncSpf !== false)
  if (options.syncSpf !== false) {
    const existingSpf = dnsRecords.find(r => r.type === 'TXT' && (r.name === name || r.name === '@' || r.name === zone.name) && r.content.replace(/^"|"$/g, '').startsWith('v=spf1'));
    if (!existingSpf) {
      const spfContent = 'v=spf1 include:_spf.mx.cloudflare.net ~all';
      await request(base + '/dns_records', 'POST', { type: 'TXT', name, content: spfContent, ttl: 1 });
      synced.push({ record: name, type: 'TXT', action: 'created', content: spfContent });
    } else {
      const cleanSpf = existingSpf.content.replace(/^"|"$/g, '');
      if (!cleanSpf.includes('include:_spf.mx.cloudflare.net')) {
        const mergedSpf = cleanSpf.replace(/(~all|-all|\?all|\+all|$)/, 'include:_spf.mx.cloudflare.net $1').replace(/\s+/g, ' ').trim();
        await request(base + '/dns_records/' + existingSpf.id, 'PUT', { type: 'TXT', name: existingSpf.name, content: mergedSpf, ttl: 1 });
        synced.push({ record: name, type: 'TXT', action: 'updated', content: mergedSpf });
      } else {
        synced.push({ record: name, type: 'TXT', action: 'already_synced', content: cleanSpf });
      }
    }
  }

  // 4. Sync DMARC (if syncDmarc !== false)
  if (options.syncDmarc !== false) {
    const existingDmarc = dnsRecords.find(r => r.type === 'TXT' && (r.name === dmarcName || r.name === '_dmarc' || r.name === '_dmarc.' + zone.name) && r.content.replace(/^"|"$/g, '').startsWith('v=DMARC1'));
    if (!existingDmarc) {
      await request(base + '/dns_records', 'POST', { type: 'TXT', name: dmarcName, content: desiredDmarc, ttl: 1 });
      synced.push({ record: dmarcName, type: 'TXT', action: 'created', content: desiredDmarc });
    } else {
      synced.push({ record: dmarcName, type: 'TXT', action: 'already_synced', content: existingDmarc.content.replace(/^"|"$/g, '') });
    }
  }

  // 5. Try enabling Cloudflare Email Routing & catch-all rule if available
  try {
    const routing = await request<{ enabled: boolean }>(base + '/email/routing').catch(() => null);
    if (routing && !routing.enabled) {
      await request(base + '/email/routing/dns', 'POST').catch(() => {});
    }
    const ingress = await (await import('./cloudflare-ingress.js')).managedIngress().catch(() => null);
    const worker = ingress?.worker || process.env.CLOUDFLARE_EMAIL_WORKER;
    if (worker) {
      const rule = await request<CatchAll>(base + '/email/routing/rules/catch_all').catch(() => null);
      const hasRule = rule?.enabled && rule.actions?.some(a => a.type === 'worker' && a.value?.[0] === worker);
      if (!hasRule) {
        await request(base + '/email/routing/rules/catch_all', 'PUT', {
          name: 'Letterdock', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }]
        }).catch(() => {});
      }
    }
  } catch {
    // Non-fatal if zone lacks worker routing permissions
  }

  // 6. Update local DB verification
  await db.query('UPDATE domains SET verified=true WHERE name=$1', [name]);

  return {
    ok: true,
    domain: name,
    zoneId: zone.id,
    verified: true,
    synced,
    removed,
    message: 'Cloudflare DNS successfully synchronized with LetterDock. Domain is verified.'
  };
}
