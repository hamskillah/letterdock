import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:letterdock_test@127.0.0.1:5432/postgres';
const { db, migrate } = await import('../src/db.js');

console.log('=== Starting Feature Test: 1-Click Cloudflare DNS Sync ===');
await migrate();

// Mock Cloudflare State
const zoneId = 'cf-zone-' + randomUUID().slice(0, 8);
const domainName = 'sync-test-' + Date.now() + '.com';
let dnsRecords: Array<{ id: string; type: string; name: string; content: string; priority?: number; ttl?: number }> = [];

// Seed with existing external mail service and SPF
dnsRecords.push({
  id: 'rec-mx-ext',
  type: 'MX',
  name: domainName,
  content: 'inbound-smtp.us-east-1.amazonaws.com',
  priority: 10,
  ttl: 300
});
dnsRecords.push({
  id: 'rec-spf-ext',
  type: 'TXT',
  name: domainName,
  content: 'v=spf1 include:amazonses.com ~all',
  ttl: 300
});

// Setup mock Cloudflare HTTP server
const mockCfServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1:56325');
  const method = req.method;

  let body = '';
  for await (const chunk of req) body += chunk;
  const jsonBody = body ? JSON.parse(body) : null;

  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/client/v4/zones') {
    const requestedName = url.searchParams.get('name');
    if (requestedName === domainName) {
      return res.end(JSON.stringify({
        success: true,
        result: [{ id: zoneId, name: domainName, status: 'active', account: { id: 'cf-acc-1' } }]
      }));
    }
    return res.end(JSON.stringify({ success: true, result: [] }));
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
        ttl: jsonBody.ttl || 1
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
        dnsRecords[idx] = {
          ...dnsRecords[idx],
          type: jsonBody.type || dnsRecords[idx].type,
          name: jsonBody.name || dnsRecords[idx].name,
          content: jsonBody.content || dnsRecords[idx].content,
          priority: jsonBody.priority ?? dnsRecords[idx].priority,
          ttl: jsonBody.ttl ?? dnsRecords[idx].ttl
        };
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

await new Promise<void>(resolve => mockCfServer.listen(56325, '127.0.0.1', resolve));

const origin = 'http://127.0.0.1:56326';
const password = 'sync-test-password-123';
const sessionSecret = 'sync-test-session-secret-over-32-chars-long';
process.env.SESSION_SECRET = sessionSecret;

const server = spawn(process.execPath, ['dist/server.js'], {
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: sessionSecret,
    CLOUDFLARE_API_BASE: 'http://127.0.0.1:56325/client/v4',
    CLOUDFLARE_API_TOKEN: 'mock-cf-token-12345',
    PUBLIC_URL: origin,
    APP_PORT: '56326',
    PORT: '56326'
  },
  stdio: 'ignore'
});

try {
  // Wait for server to start with resilient timeout under parallel suite load
  let serverReady = false;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(origin + '/health');
      if (res.ok || res.status === 401) {
        serverReady = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert(serverReady, 'Server must start and respond on port 56326');

  // Admin login
  const loginRes = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password })
  });
  assert.equal(loginRes.status, 200, 'Login must succeed');
  const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Cookie required');
  const authHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };

  // -------------------------------------------------------------
  // 1. Create domain
  // -------------------------------------------------------------
  console.log('--- 1. Registering domain ' + domainName + ' ---');
  const addRes = await fetch(origin + '/api/domains', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: domainName })
  });
  assert.equal(addRes.status, 200, 'Domain registration must succeed');

  const { rows: [domainRow] } = await db.query('SELECT name, token, verified FROM domains WHERE name=$1', [domainName]);
  assert(domainRow, 'Domain must exist in database');
  assert.equal(domainRow.verified, false, 'Domain must start unverified');

  // -------------------------------------------------------------
  // 2. Preflight DNS Status Inspection
  // -------------------------------------------------------------
  console.log('--- 2. Testing Preflight DNS Status & Conflict Detection ---');
  const preflightRes = await fetch(origin + '/api/domains/' + domainName + '/cloudflare/dns', {
    headers: authHeaders
  });
  assert.equal(preflightRes.status, 200, 'Preflight query must succeed');
  const preflight = await preflightRes.json();

  assert.equal(preflight.domain, domainName);
  assert.equal(preflight.zoneId, zoneId);
  assert.equal(preflight.hasConflicts, true, 'Preflight must flag external MX conflict');
  assert.equal(preflight.conflicts.length, 1, 'Must report exactly 1 external MX conflict');
  assert.equal(preflight.conflicts[0].content, 'inbound-smtp.us-east-1.amazonaws.com');
  assert.equal(preflight.spf.status, 'needs_merge', 'Existing SPF must be flagged as needs_merge');
  assert.equal(preflight.dmarc.status, 'missing', 'DMARC must be flagged as missing');

  // -------------------------------------------------------------
  // 3. Conflict Safety Barrier (replaceConflictingMx: false)
  // -------------------------------------------------------------
  console.log('--- 3. Testing Safety Barrier when replaceConflictingMx=false ---');
  const conflictSyncRes = await fetch(origin + '/api/domains/' + domainName + '/cloudflare/dns/sync', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ replaceConflictingMx: false })
  });
  assert.equal(conflictSyncRes.status, 409, 'Must return 409 Conflict when external MX exists without explicit override');
  const conflictJson = await conflictSyncRes.json();
  assert(conflictJson.message.includes('Conflicting MX records detected'), 'Error must clearly state conflict');
  assert(dnsRecords.some(r => r.content === 'inbound-smtp.us-east-1.amazonaws.com'), 'External MX must remain preserved');

  // -------------------------------------------------------------
  // 4. 1-Click Sync Execution (replaceConflictingMx: true)
  // -------------------------------------------------------------
  console.log('--- 4. Executing 1-Click Cloudflare DNS Sync with Override & SPF Merge ---');
  const syncRes = await fetch(origin + '/api/domains/' + domainName + '/cloudflare/dns/sync', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      replaceConflictingMx: true,
      syncSpf: true,
      syncDmarc: true
    })
  });
  assert.equal(syncRes.status, 200, '1-Click sync must succeed with 200 OK');
  const syncReport = await syncRes.json();

  assert.equal(syncReport.ok, true);
  assert.equal(syncReport.verified, true, 'Sync report must flag domain as verified');
  assert(syncReport.removed.length >= 1, 'Must record removal of conflicting MX');
  assert.equal(syncReport.removed[0].content, 'inbound-smtp.us-east-1.amazonaws.com');

  // Verify records inside mock Cloudflare DNS
  assert(!dnsRecords.some(r => r.content === 'inbound-smtp.us-east-1.amazonaws.com'), 'External MX must be deleted');
  assert(dnsRecords.some(r => r.type === 'MX' && r.content === 'route1.mx.cloudflare.net' && r.priority === 49), 'Route 1 MX must exist');
  assert(dnsRecords.some(r => r.type === 'MX' && r.content === 'route2.mx.cloudflare.net' && r.priority === 78), 'Route 2 MX must exist');
  assert(dnsRecords.some(r => r.type === 'MX' && r.content === 'route3.mx.cloudflare.net' && r.priority === 41), 'Route 3 MX must exist');

  const txtRec = dnsRecords.find(r => r.type === 'TXT' && r.name.startsWith('_letterdock'));
  assert(txtRec, 'Verification TXT must exist');
  assert.equal(txtRec.content, 'letterdock=' + domainRow.token, 'Verification TXT token must match');

  const spfRec = dnsRecords.find(r => r.type === 'TXT' && r.name === domainName && r.content.startsWith('v=spf1'));
  assert(spfRec, 'SPF TXT must exist');
  assert(spfRec.content.includes('include:_spf.mx.cloudflare.net'), 'SPF must include Cloudflare SPF');
  assert(spfRec.content.includes('include:amazonses.com'), 'SPF merge must preserve existing amazonses include');

  const dmarcRec = dnsRecords.find(r => r.type === 'TXT' && r.name.startsWith('_dmarc'));
  assert(dmarcRec, 'DMARC TXT must exist');
  assert(dmarcRec.content.startsWith('v=DMARC1;'), 'DMARC must be valid');

  // -------------------------------------------------------------
  // 5. Re-check Postflight DNS Status
  // -------------------------------------------------------------
  console.log('--- 5. Verifying Post-Sync DNS Status is 100% Synced ---');
  const postflightRes = await fetch(origin + '/api/domains/' + domainName + '/cloudflare/dns', {
    headers: authHeaders
  });
  assert.equal(postflightRes.status, 200);
  const postflight = await postflightRes.json();

  assert.equal(postflight.hasConflicts, false, 'No conflicts must remain');
  assert.equal(postflight.spf.status, 'synced', 'SPF must be synced');
  assert.equal(postflight.dmarc.status, 'synced', 'DMARC must be synced');
  assert(postflight.records.every((r: any) => r.status === 'synced'), 'All individual records must be synced');

  // -------------------------------------------------------------
  // 6. Database Verification
  // -------------------------------------------------------------
  console.log('--- 6. Verifying PostgreSQL Domain Verification State ---');
  const { rows: [finalDomain] } = await db.query('SELECT verified FROM domains WHERE name=$1', [domainName]);
  assert.equal(finalDomain.verified, true, 'Database domain record must be verified: true');

  // -------------------------------------------------------------
  // 7. Negative Control Probes
  // -------------------------------------------------------------
  console.log('--- 7. Running Negative Controls ---');
  const missingDomainRes = await fetch(origin + '/api/domains/non-existent-domain.xyz/cloudflare/dns', {
    headers: authHeaders
  });
  assert.equal(missingDomainRes.status, 404, 'Non-existent domain must return 404');

  const missingSyncRes = await fetch(origin + '/api/domains/non-existent-domain.xyz/cloudflare/dns/sync', {
    method: 'POST',
    headers: authHeaders
  });
  assert.equal(missingSyncRes.status, 404, 'Non-existent domain sync must return 404');

  // -------------------------------------------------------------
  // 8. Memory Budget Verification
  // -------------------------------------------------------------
  console.log('--- 8. Checking Process Memory RSS Budget ---');
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log('Current Test Process RSS: ' + rssMB + ' MB');
  assert(rssMB < 150, 'Process memory RSS (' + rssMB + ' MB) must be below 150 MB ceiling');

  console.log('=== All 1-Click Cloudflare DNS Sync tests passed with 100% SUCCESS! ===');
} catch (err) {
  console.error('Test failed with error:', err);
  process.exit(1);
} finally {
  server.kill('SIGTERM');
  mockCfServer.close();
  await db.end();
}
