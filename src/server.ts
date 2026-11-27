import Fastify, { type FastifyRequest } from 'fastify';
import cookies, { Signer } from '@fastify/cookie';
import files from '@fastify/static';
import scalar from '@scalar/fastify-api-reference';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { storage } from './storage.js';
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { resolve } from 'node:path';
import { domainToASCII } from 'node:url';
import { completeOAuth, startOAuth, type OAuthState } from './cloudflare-oauth.js';
import { domainConnectLink } from './domain-connect.js';
import { connectCloudflare, connectionStatus, encryptSecret, domainSetup, getDomainDnsStatus, syncDomainDns, SetupConflict } from './cloudflare.js';
import { db, migrate } from './db.js';
import { importMail, deliver, runJobs, stagingStatus } from './jobs.js';
import { workerPool } from './worker.js';
import { openApiSpec } from './openapi.js';
import { sendEmail, extractEmailAddress, normalizeAddressList, checkSuppression, addSuppression, removeSuppression, OutboundError } from './outbound.js';
import {
  isAllowedTailscaleOrigin,
  getTailscaleSettings,
  saveTailscaleSettings,
  getTailscaleStatus,
  detectTailscaleHost,
  type TailscaleSettings,
  type TailscaleHostInfo
} from './tailscale.js';
import { renderTemplate, extractVariables } from './templates.js';
import { parseSearchQuery, getConversationThread } from './threads.js';
import {
  TRANSPARENT_GIF_BUFFER,
  verifyTrackingToken,
  recordEmailEvent,
  getAnalyticsOverview
} from './analytics.js';
import { evaluateRule, type InboundRule } from './rules.js';

const app = Fastify({
  logger: true,
  disableRequestLogging: true,
  bodyLimit: 25 * 1024 * 1024,
  routerOptions: { maxParamLength: 253 }
});

app.addContentTypeParser(['message/rfc822', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => {
  done(null, body);
});

app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const str = typeof body === 'string' ? body : body ? body.toString('utf8') : '';
  if (!str || str.trim().length === 0) {
    done(null, {});
  } else {
    try {
      done(null, JSON.parse(str));
    } catch (err) {
      done(err as Error, undefined);
    }
  }
});
const password = process.env.ADMIN_PASSWORD;
const secret = process.env.SESSION_SECRET;
const listenPort = Number(process.env.PORT || 3000);
const publicOrigin = new URL(process.env.PUBLIC_URL || 'http://localhost:'+(process.env.APP_PORT || listenPort)).origin;

let cachedTailscaleSettings: TailscaleSettings = {
  enabled: process.env.TAILSCALE_ENABLED === 'true',
  configuredOrigin: process.env.TAILSCALE_ORIGIN || null,
  mode: (process.env.TAILSCALE_MODE as any) || 'serve'
};
let cachedTailscaleHost: TailscaleHostInfo = {
  installed: false,
  running: false,
  backendState: 'Not initialized',
  ips: [],
  ipv4: null,
  ipv6: null,
  hostname: null,
  magicDns: null
};

export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return false;
  if (origin === publicOrigin) return true;
  try {
    const o = new URL(origin);
    const p = new URL(publicOrigin);
    if (
      (o.hostname === 'localhost' || o.hostname === '127.0.0.1') &&
      (p.hostname === 'localhost' || p.hostname === '127.0.0.1') &&
      o.port === p.port &&
      o.protocol === p.protocol
    ) {
      return true;
    }
  } catch {}

  // Check Tailscale origin authorization
  if (cachedTailscaleSettings.enabled) {
    const tsCheck = isAllowedTailscaleOrigin(origin, cachedTailscaleSettings, cachedTailscaleHost);
    if (tsCheck.allowed) return true;
  }

  return false;
};
if (!password || password.length < 16 || !secret || secret.length < 32) throw Error('Configure ADMIN_PASSWORD and SESSION_SECRET');
const signingKey = (purpose: string) => createHmac('sha256', secret).update('letterdock:'+purpose).digest();
await app.register(cookies, { secret: signingKey('browser') });
const downloads = new Signer(signingKey('downloads'));
const apiScope = new WeakMap<object, { id: string; domain: string | null; workspace_id: string }>();
await app.register(files, { root: resolve('dist') });

await app.register(scalar, {
  routePrefix: '/docs',
  configuration: {
    content: openApiSpec
  }
});

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeName = (name: string) => "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/['()]/g, '_');

async function getSessionFromCookie(req: FastifyRequest) {
  const rawCookie = req.cookies.session;
  if (!rawCookie) return null;
  const unsigned = req.unsignCookie(rawCookie);
  // Strict signature verification: tampered or unsigned cookies are rejected immediately
  if (!unsigned.valid || !unsigned.value) return null;
  const sessionVal = unsigned.value.startsWith('session:')
    ? unsigned.value.slice(8)
    : unsigned.value;
  if (!uuid.test(sessionVal)) return null;
  const { rows: [session] } = await db.query(
    'SELECT id, workspace_id FROM sessions WHERE id=$1 AND expires_at > now()',
    [sessionVal]
  );
  return session || null;
}

app.addHook('preHandler', async (req, res) => {
  const path = req.url.split('?')[0];

  // Public docs and OpenAPI schema
  if (path === '/docs' || path.startsWith('/docs/') || path === '/api/openapi.json') {
    return;
  }

  // Public open/click tracking endpoints
  if (path.startsWith('/t/o/') || path.startsWith('/t/c/')) {
    return;
  }

  // Resend API endpoints (/emails, /domains, /api-keys, /templates) - accessible via Bearer API Key OR active admin session
  if (path.startsWith('/emails') || path.startsWith('/domains') || path.startsWith('/api-keys') || path.startsWith('/templates')) {
    res.header('Cache-Control', 'no-store');
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const { rows: [key] } = await db.query(
        'SELECT id, domain, workspace_id FROM api_keys WHERE hash=$1',
        [digest(auth.slice(7))]
      );
      if (key) {
        apiScope.set(req, key);
        return;
      }
    }

    const session = await getSessionFromCookie(req);
    if (session) {
      // Enforce strict Origin check on cookie-authenticated mutations to prevent CSRF
      if (!['GET', 'HEAD'].includes(req.method) && !isAllowedOrigin(req.headers.origin)) {
        return res.code(403).send({ name: 'forbidden', statusCode: 403, message: 'Origin rejected' });
      }
      apiScope.set(req, { id: session.id, workspace_id: session.workspace_id, domain: null });
      return;
    }

    return res.code(401).send({ name: 'validation_error', statusCode: 401, message: 'Invalid API key or session required' });
  }

  // Webhook endpoints for bounces & complaints (authenticated via secret, API key, or session)
  if (path.startsWith('/api/webhooks/')) {
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const incomingSecret = (req.headers['x-webhook-secret'] as string) || (req.query as any)?.secret;
    const auth = req.headers.authorization;
    const bearerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    if (webhookSecret && (incomingSecret === webhookSecret || bearerToken === webhookSecret)) {
      apiScope.set(req, { id: 'webhook-secret', workspace_id: 'default', domain: null });
      return;
    }

    if (bearerToken) {
      const { rows: [key] } = await db.query(
        'SELECT id, domain, workspace_id FROM api_keys WHERE hash=$1',
        [digest(bearerToken)]
      );
      if (key) {
        apiScope.set(req, key);
        return;
      }
    }

    const session = await getSessionFromCookie(req);
    if (session) {
      apiScope.set(req, { id: session.id, workspace_id: session.workspace_id, domain: null });
      return;
    }

    return res.code(401).send({
      name: 'unauthorized',
      statusCode: 401,
      message: 'Unauthorized webhook request. Provide a valid API key, active session, or webhook secret.'
    });
  }

  // Administrative APIs allow Bearer API keys as well as browser session
  if (
    path.startsWith('/api/outbound/') ||
    path.startsWith('/api/suppressions') ||
    path.startsWith('/api/templates') ||
    path.startsWith('/api/rules') ||
    path.startsWith('/api/analytics') ||
    path.startsWith('/api/threads')
  ) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const { rows: [key] } = await db.query(
        'SELECT id, domain, workspace_id FROM api_keys WHERE hash=$1',
        [digest(auth.slice(7))]
      );
      if (key) {
        apiScope.set(req, key);
        return;
      }
    }
  }

  if (path.startsWith('/api/ingress/')) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      if (process.env.INGRESS_KEY && timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(process.env.INGRESS_KEY)))) {
        return;
      }
      const { rows: [key] } = await db.query('SELECT id, domain, workspace_id FROM api_keys WHERE hash=$1', [digest(token)]);
      if (key) {
        apiScope.set(req, key);
        return;
      }
    }
    return res.code(401).send({ ok: false, error: 'unauthorized', message: 'Invalid or missing Ingress authentication' });
  }

  if (!path.startsWith('/api/')) return;
  res.header('Cache-Control', 'no-store');

  if (!['GET','HEAD'].includes(req.method) && !isAllowedOrigin(req.headers.origin)) {
    return res.code(403).send({ message: 'Origin rejected' });
  }
  if (path === '/api/login') return;
  const session = req.unsignCookie(req.cookies.session ?? '');
  if (!session.valid || !session.value) return res.code(401).send({ message: 'Sign in required' });

  if (session.value.startsWith('session:')) {
    const sessionVal = session.value.slice(8);
    if (uuid.test(sessionVal)) {
      const { rows: [activeSession] } = await db.query(
        'SELECT id, workspace_id FROM sessions WHERE id=$1 AND expires_at > now()',
        [sessionVal]
      );
      if (!activeSession) return res.code(401).send({ message:'Sign in required' });
      return;
    }
    if (/^\d{13}$/.test(sessionVal) && Number(sessionVal) > Date.now()) {
      return;
    }
  }
  return res.code(401).send({ message:'Sign in required' });
});

let denied = 0;
let nextAttempt = 0;
app.post<{Body:{password?:string}}>('/api/login', async (req,res) => {
  if (Date.now() < nextAttempt) return res.code(429).send({message:'Try again shortly'});
  if (!timingSafeEqual(Buffer.from(digest(String(req.body?.password ?? ''))), Buffer.from(digest(password)))) {
    denied++;
    if (denied % 5 === 0) nextAttempt = Date.now()+15000;
    return res.code(401).send({message:'Invalid password'});
  }
  denied=0;
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 86400000);
  const ip = req.ip || req.socket.remoteAddress || null;
  const ua = (req.headers['user-agent'] as string) || null;
  await db.query(
    'INSERT INTO sessions(id, expires_at, ip_address, user_agent) VALUES($1, $2, $3, $4)',
    [sessionId, expiresAt, ip, ua]
  );
  const originStr = req.headers.origin || '';
  const isTailscaleHttp = originStr.startsWith('http://') && (
    originStr.startsWith('http://100.') ||
    originStr.includes('.ts.net') ||
    originStr.includes('fd7a:115c:a1e0')
  );
  const isSecure = (publicOrigin.startsWith('https:') && !isTailscaleHttp) || req.protocol === 'https';

  return res.setCookie('session', 'session:'+sessionId, {
    signed:true,httpOnly:true,sameSite:'lax',secure:isSecure,path:'/',maxAge:86400
  }).send({ok:true});
});
app.post('/api/logout', async (req,res) => {
  const session = req.unsignCookie(req.cookies.session ?? '');
  if (session.valid && session.value?.startsWith('session:')) {
    const sessionId = session.value.slice(8);
    if (uuid.test(sessionId)) {
      await db.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
    }
  }
  return res.clearCookie('session',{path:'/'}).send({ok:true});
});

const summary = 'id,recipient,sender,subject,received,unread,starred,folder,labels,state,thread_id';
app.get<{Querystring:Record<string,string>}>('/api/messages', async req => {
  const q = req.query;
  const parsedSearch = q.q ? parseSearchQuery(q.q) : null;
  const targetFolder = parsedSearch?.folder || q.folder;

  const filters: string[] = [];
  const values: unknown[] = [];
  function filter(sql: string, value: unknown) { values.push(value); filters.push(sql.replace('?', '$'+values.length)); }

  if (targetFolder && targetFolder !== 'all') {
    filter('folder=?', targetFolder);
  } else if (!targetFolder && !q.q) {
    filter('folder=?', 'inbox');
  }

  const fromVal = parsedSearch?.from || q.from;
  const toVal = parsedSearch?.to || q.to;
  const subjectVal = parsedSearch?.subject || q.subject;
  const hasAttachment = parsedSearch?.hasAttachment || q.attachment === 'true';
  const isUnread = parsedSearch?.isUnread || q.unread === 'true';
  const isStarred = parsedSearch?.isStarred || q.starred === 'true';

  if (q.domain) filter('domain=?', q.domain);
  if (q.address) filter('recipient=?', q.address);
  if (fromVal) filter('sender ILIKE ?', '%' + fromVal + '%');
  if (toVal) filter('recipient ILIKE ?', '%' + toVal + '%');
  if (subjectVal) filter('subject ILIKE ?', '%' + subjectVal + '%');
  if (q.label) filter('? = ANY(labels)', q.label);
  if (q.since && /^\d{4}-\d{2}-\d{2}$/.test(q.since)) filter('received >= ?::date', q.since);
  if (q.until && /^\d{4}-\d{2}-\d{2}$/.test(q.until)) filter("received < ?::date + interval '1 day'", q.until);
  if (hasAttachment) filters.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message=messages.id)');
  if (isUnread) filters.push('unread');
  if (isStarred) filters.push('starred');

  const textToSearch = parsedSearch ? parsedSearch.plainText : q.q;
  if (textToSearch) {
    filter("to_tsvector('simple', sender || ' ' || recipient || ' ' || subject || ' ' || body) @@ websearch_to_tsquery('simple', ?)", textToSearch);
  }

  if (q.cursor && uuid.test(q.cursor)) filter('(received,id) < (SELECT received,id FROM messages WHERE id=?)', q.cursor);
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  return (await db.query(`SELECT ${summary} FROM messages ${whereClause}
    ORDER BY received DESC,id DESC LIMIT 100`, values)).rows;
});
app.get<{Params:{id:string}}>('/api/messages/:id', async (req,res) => {
  if(!uuid.test(req.params.id)) return res.code(404).send();
  const [data, attachments] = await Promise.all([
    db.query(`SELECT ${summary},body,html,headers,error FROM messages WHERE id=$1`,[req.params.id]),
    db.query('SELECT id,filename,mime,coalesce(size_bytes, octet_length(data), 0) AS bytes FROM attachments WHERE message=$1',[req.params.id])
  ]);
  if(!data.rowCount) return res.code(404).send();
  return {...data.rows[0],attachments:attachments.rows};
});
app.patch<{Body:{ids:string[],folder?:string,unread?:boolean,starred?:boolean,label?:string,removeLabel?:string,retry?:boolean}}>('/api/messages', async (req,res) => {
  const b=req.body;
  if(!Array.isArray(b?.ids)||!b.ids.length||b.ids.length>100||!b.ids.every(id=>uuid.test(id))) return res.code(400).send({message:'Select valid messages'});
  if(b.folder && !['inbox','archive','trash'].includes(b.folder)) return res.code(400).send({message:'Invalid folder'});
  await db.query(`UPDATE messages SET folder=coalesce($2,folder), unread=coalesce($3,unread),
    trashed_at=CASE WHEN $2 IS NULL THEN trashed_at
      WHEN $2='trash' THEN coalesce(trashed_at,now()) ELSE NULL END,
    retention_exempt=CASE WHEN $2 IN ('inbox','archive') AND folder='trash' THEN true ELSE retention_exempt END,
    starred=coalesce($4,starred), labels=CASE WHEN $5::text IS NOT NULL AND NOT ($5=ANY(labels)) THEN labels||ARRAY[$5]
    WHEN $6::text IS NOT NULL THEN array_remove(labels,$6) ELSE labels END,
    state=CASE WHEN $7 AND state='failed' THEN 'pending' ELSE state END WHERE id=ANY($1::uuid[])`,
    [b.ids,b.folder??null,b.unread??null,b.starred??null,b.label?.trim().slice(0,60)||null,b.removeLabel??null,b.retry===true]);
  return {ok:true};
});
app.delete<{Params:{id:string}}>('/api/messages/:id',async(req,res)=>{
  if(!uuid.test(req.params.id)) return res.code(404).send();
  await db.query("DELETE FROM messages WHERE id=$1 AND folder='trash'",[req.params.id]);
  return {ok:true};
});
app.get<{Params:{id:string}}>('/api/raw/:id', async(req,res)=>{
  if(!uuid.test(req.params.id)) return res.code(404).send();
  const {rows:[row]}=await db.query('SELECT raw, raw_storage_key FROM messages WHERE id=$1',[req.params.id]);
  if(!row) return res.code(404).send();
  let payload: Buffer | null = null;
  if (row.raw_storage_key) {
    const blob = await storage.get(row.raw_storage_key);
    if (blob) payload = blob.data;
  }
  if (!payload && row.raw) {
    payload = Buffer.isBuffer(row.raw) ? row.raw : Buffer.from(row.raw);
  }
  if (!payload) return res.code(404).send();
  return res.header('Content-Disposition',safeName(req.params.id+'.eml')).type('application/octet-stream').send(payload);
});
app.get<{Params:{id:string}}>('/api/files/:id',async(req,res)=>{
  if(!uuid.test(req.params.id)) return res.code(404).send();
  const {rows:[row]}=await db.query('SELECT filename,data,storage_key,mime FROM attachments WHERE id=$1',[req.params.id]);
  if(!row) return res.code(404).send();
  let payload: Buffer | null = null;
  if (row.storage_key) {
    const blob = await storage.get(row.storage_key);
    if (blob) payload = blob.data;
  }
  if (!payload && row.data) {
    payload = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  }
  if (!payload) return res.code(404).send();
  return res.header('Content-Disposition',safeName(row.filename)).type(row.mime || 'application/octet-stream').send(payload);
});

function extractHeader(rawText: string, headerName: string): string | null {
  const match = rawText.match(new RegExp('^' + headerName + ':\\s*([^\\r\\n]+)', 'mi'));
  if (!match) return null;
  const emailMatch = match[1].match(/<([^>]+)>/);
  return (emailMatch ? emailMatch[1] : match[1]).trim().toLowerCase();
}

app.post<{Querystring:{to?:string,from?:string}}>('/api/ingress/raw', async (req, res) => {
  let rawBuf: Buffer | null = null;
  let to: string | undefined = (req.headers['x-letterdock-to'] as string) || req.query.to;
  let from: string | undefined = (req.headers['x-letterdock-from'] as string) || req.query.from;

  if (Buffer.isBuffer(req.body)) {
    rawBuf = req.body;
  } else if (typeof req.body === 'object' && req.body !== null) {
    const b = req.body as Record<string, any>;
    if (b.to && typeof b.to === 'string') to = b.to;
    if (b.from && typeof b.from === 'string') from = b.from;
    if (typeof b.raw === 'string') {
      const rawStr = b.raw.trim();
      const isPlainMime = /^(From|Received|Return-Path|To|Subject|Date|MIME-Version):/im.test(rawStr);
      if (isPlainMime) {
        rawBuf = Buffer.from(rawStr, 'utf8');
      } else {
        const cleanB64 = rawStr.replace(/\s+/g, '');
        rawBuf = Buffer.from(cleanB64, 'base64');
      }
    } else if (typeof b.eml === 'string') {
      rawBuf = Buffer.from(b.eml, 'utf8');
    }
  } else if (typeof req.body === 'string') {
    rawBuf = Buffer.from(req.body, 'utf8');
  }

  if (!rawBuf || rawBuf.length === 0) {
    return res.code(400).send({ ok: false, error: 'empty_payload', message: 'Payload is empty' });
  }

  const rawHead = rawBuf.subarray(0, Math.min(rawBuf.length, 4096)).toString('utf8');
  if (!to) to = extractHeader(rawHead, 'to') ?? undefined;
  if (!from) from = extractHeader(rawHead, 'from') ?? undefined;

  if (!to || !to.includes('@')) {
    return res.code(400).send({ ok: false, error: 'invalid_recipient', message: 'Valid recipient email required' });
  }
  to = to.toLowerCase();
  from = (from || 'unknown@unknown').toLowerCase();
  const domain = to.slice(to.lastIndexOf('@') + 1);

  const scoped = apiScope.get(req);
  if (scoped && scoped.domain && scoped.domain !== domain) {
    return res.code(403).send({ ok: false, error: 'forbidden', message: 'API key not authorized for domain: ' + domain });
  }

  const id = randomUUID();
  const imported = await importMail(id, from, to, rawBuf);

  const { rows: [log] } = await db.query('SELECT status FROM ingest_log WHERE id=$1', [id]);
  const status = log?.status ?? (imported ? 'stored' : 'rejected');

  if (status !== 'stored') {
    await storage.delete('messages/raw/' + id + '.eml').catch(() => {});
    switch (status) {
      case 'unknown_domain':
        return res.code(404).send({ ok: false, error: 'unknown_domain', message: 'Domain not registered or unverified' });
      case 'blocked':
        return res.code(403).send({ ok: false, error: 'blocked', message: 'Sender is blocked' });
      case 'message_too_large':
        return res.code(413).send({ ok: false, error: 'message_too_large', message: 'Message exceeds maximum size' });
      case 'domain_quota':
        return res.code(429).send({ ok: false, error: 'domain_quota', message: 'Domain daily quota exceeded' });
      case 'storage_quota':
        return res.code(507).send({ ok: false, error: 'storage_quota', message: 'Storage quota exceeded' });
      default:
        return res.code(400).send({ ok: false, error: status, message: 'Message rejected: ' + status });
    }
  }

  await workerPool.enqueue('parse_email', { messageId: id });
  workerPool.wake();

  return res.code(201).send({
    ok: true,
    id,
    status: 'stored',
    recipient: to,
    domain
  });
});

app.post<{Body:{domain?:string}}>('/api/cloudflare/oauth/start', async (req,res) => {
  try {
    const origin = new URL(publicOrigin);
    if (origin.protocol!=='https:' && !['127.0.0.1','localhost'].includes(origin.hostname)) {
      return res.code(400).send({message:'Use localhost or HTTPS for Cloudflare authorization.'});
    }
    const name=req.body?.domain;
    if (name && !(await db.query('SELECT 1 FROM domains WHERE name=$1 AND removed_at IS NULL',[name])).rowCount) {
      return res.code(404).send({message:'Domain not found'});
    }
    const {pending,url}=await startOAuth(new URL('/oauth/cloudflare/callback',origin).href,name);
    res.setCookie('cf_pending',JSON.stringify(pending),{
      signed:true,httpOnly:true,sameSite:'lax',secure:origin.protocol==='https:',
      path:'/oauth/cloudflare/callback',maxAge:600
    });
    return {url};
  } catch { return res.code(502).send({message:'Cloudflare could not start authorization. Try again.'}); }
});
app.get<{Querystring:{code?:string;state?:string;iss?:string}}>('/oauth/cloudflare/callback', async(req,res)=>{
  const state=req.unsignCookie(req.cookies.cf_pending??'');
  res.clearCookie('cf_pending',{path:'/oauth/cloudflare/callback'});
  res.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
  try {
    if(!state.valid || !state.value) throw Error();
    const pending=JSON.parse(state.value) as OAuthState;
    if(Date.now()>pending.expires || req.query.state!==pending.state || req.query.iss!=='https://mcp.cloudflare.com' || !req.query.code) throw Error();
    await completeOAuth(pending,req.query.code);
    if(pending.domain)res.setCookie('cf_apply',JSON.stringify({name:pending.domain,expires:Date.now()+120000}),{
      signed:true,httpOnly:true,sameSite:'lax',secure:new URL(pending.redirect).protocol==='https:',
      path:'/api/cloudflare/oauth/apply',maxAge:120
    });
    return res.redirect('/?cloudflare=connected'+(pending.domain?'&setupDomain='+encodeURIComponent(pending.domain):''),303);
  } catch {
    return res.redirect('/?cloudflare=authorization-failed',303);
  }
});
app.post<{Body:{name:string}}>('/api/cloudflare/oauth/apply',async(req,res)=>{
  const ticket=req.unsignCookie(req.cookies.cf_apply??'');
  res.clearCookie('cf_apply',{path:'/api/cloudflare/oauth/apply'});
  if(!ticket.valid||!ticket.value)return res.code(403).send({message:'Start setup from the domain card.'});
  const pending=JSON.parse(ticket.value) as {name:string;expires:number};
  if(Date.now()>pending.expires||pending.name!==req.body?.name)return res.code(403).send({message:'Setup approval expired. Retry from the domain card.'});
  const {rows:[domain]}=await db.query('SELECT name,token FROM domains WHERE name=$1 AND removed_at IS NULL',[pending.name]);
  if(!domain)return res.code(404).send({message:'Domain not found'});
  try {
    const result=await domainSetup(domain.name,domain.token,true);
    return result.ready?result:res.code(409).send(result);
  } catch(error) {
    return res.code(502).send({message:error instanceof SetupConflict ? error.message : 'Cloudflare setup failed. Retry from the domain card.'});
  }
});
app.get('/api/cloudflare', async () => connectionStatus());
app.post<{Body:{token:string}}>('/api/cloudflare', async (req,res) => {
  if (process.env.CLOUDFLARE_API_TOKEN) return res.code(409).send({message:'The Cloudflare token is managed by the server environment.'});
  const token=String(req.body?.token??'').trim();
  if (!/^[a-zA-Z0-9_-]{20,256}$/.test(token)) return res.code(400).send({message:'Enter a valid Cloudflare API token.'});
  try { await connectCloudflare(token); return connectionStatus(); }
  catch(error) {
    if (error instanceof SetupConflict) return res.code(422).send({message:error.message});
    return res.code(502).send({message:'Could not connect to Cloudflare. Try again.'});
  }
});
app.delete('/api/cloudflare', async (_req,res) => {
  await db.query("DELETE FROM settings WHERE key IN ('cloudflare_token','cloudflare_oauth')");
  return connectionStatus();
});
app.get('/api/domains',async()=> (await db.query('SELECT name,token,verified,last_received,retention_days,prune_days,delivery_test_address,delivery_test_expires,delivery_verified_at,delivery_test_expires<=now() AS test_expired FROM domains WHERE removed_at IS NULL ORDER BY name')).rows);
app.post<{Body:{name:string}}>('/api/domains',async(req,res)=>{
  const name=domainToASCII(String(req.body?.name??'').trim().toLowerCase());
  if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(name)||name.length>253) return res.code(400).send({message:'Enter a valid domain'});
  await db.query('INSERT INTO domains(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET removed_at=NULL WHERE domains.removed_at IS NOT NULL',[name]);
  return {ok:true,name};
});
app.post<{Params:{name:string},Body:{retention?:number|null}}>('/api/domains/:name',async(req,res)=>{
  const name=req.params.name;
  const {rows:[domain]}=await db.query('SELECT * FROM domains WHERE name=$1 AND removed_at IS NULL',[name]);
  if(!domain) return res.code(404).send();
  if(req.body && 'retention' in req.body) {
    const days=req.body.retention;
    if(days!==null && (!Number.isInteger(days)||Number(days)<1||Number(days)>3650)) return res.code(400).send({message:'Retention must be 1–3650 days'});
    await db.query('UPDATE domains SET retention_days=$2 WHERE name=$1',[name,days]);
    return {ok:true};
  }
  const [txt,mx]=await Promise.all([resolveTxt('_letterdock.'+name).catch(()=>[]),resolveMx(name).catch(()=>[])]);
  const dns=txt.some(record=>record.join('')==='letterdock='+domain.token);
  const routing=mx.length>0 && mx.every(r=>/^route[1-3]\.mx\.cloudflare\.net\.?$/i.test(r.exchange));
  if(!dns||!routing) return res.code(422).send({message:!dns?'Verification TXT missing':'Cloudflare MX records are missing or conflict'});
  await db.query('UPDATE domains SET verified=true WHERE name=$1',[name]);
  return {ok:true};
});
app.get<{Params:{name:string}}>('/api/domains/:name/delivery-health',async(req,res)=>{
  const name=req.params.name;
  const {rows:[domain]}=await db.query(`SELECT verified,last_received,delivery_test_address,
    delivery_test_expires,delivery_verified_at,delivery_test_expires<=now() AS test_expired
    FROM domains WHERE name=$1 AND removed_at IS NULL`,[name]);
  if(!domain)return res.code(404).send({message:'Domain not found'});
  const {rows:activity}=await db.query(`SELECT l.id,l.recipient,l.time,
    CASE WHEN l.status='stored' THEN coalesce(m.state,'stored') ELSE l.status END AS status
    FROM ingest_log l LEFT JOIN messages m ON m.id=l.id
    WHERE l.domain=$1 ORDER BY l.time DESC,l.id DESC LIMIT 12`,[name]);
  return {...domain,activity,staging_error:stagingStatus.error};
});
app.post<{Params:{name:string}}>('/api/domains/:name/delivery-health',async(req,res)=>{
  const name=req.params.name;
  const address='ld-'+randomBytes(8).toString('hex')+'@'+name;
  if(address.length>254)return res.code(422).send({message:'This domain is too long for a generated test address.'});
  const result=await db.query(`UPDATE domains SET delivery_test_address=$2,
    delivery_test_expires=now()+interval '30 minutes',delivery_verified_at=NULL
    WHERE name=$1 AND verified AND removed_at IS NULL`,[name,address]);
  if(!result.rowCount)return res.code(422).send({message:'Verify DNS before starting a delivery test.'});
  return res.code(201).send({address});
});
app.patch<{Params:{name:string},Body:{days:number|null}}>('/api/domains/:name/auto-prune',async(req,res)=>{
  const days=req.body?.days;
  if(days!==null && (typeof days!=='number'||!Number.isInteger(days)||days<1||days>3650)) {
    return res.code(400).send({message:'Auto-prune must be off or set to 1–3650 days.'});
  }
  const result=await db.query('UPDATE domains SET prune_days=$2 WHERE name=$1 AND removed_at IS NULL',
    [req.params.name,days]);
  if(!result.rowCount)return res.code(404).send({message:'Domain not found'});
  return {ok:true,prune_days:days};
});
app.delete<{Params:{name:string}}>('/api/domains/:name', async (req,res) => {
  const removed=await db.query(
    `UPDATE domains SET removed_at=now(), verified=false, last_received=NULL, prune_days=NULL,
    delivery_test_address=NULL,delivery_test_expires=NULL,delivery_verified_at=NULL WHERE name=$1 AND removed_at IS NULL`,
    [req.params.name]
  );
  if(!removed.rowCount) return res.code(404).send({message:'Domain not found'});
  return {ok:true};
});
app.get<{Params:{name:string}}>('/api/domains/:name/domain-connect',async(req,res)=>{
  const {rows:[domain]}=await db.query('SELECT name,token FROM domains WHERE name=$1 AND removed_at IS NULL',[req.params.name]);
  if(!domain)return res.code(404).send({message:'Domain not found'});
  try { return await domainConnectLink(domain.name,domain.token,publicOrigin); }
  catch { return res.code(502).send({message:'Cloudflare authorization could not be prepared. Try again.'}); }
});
app.route<{Params:{name:string}, Body?:{replaceMx?:boolean}}>({
  method:['GET','POST'], url:'/api/domains/:name/cloudflare',
  async handler(req,res) {
    const {rows:[domain]}=await db.query('SELECT name,token FROM domains WHERE name=$1 AND removed_at IS NULL',[req.params.name]);
    if(!domain) return res.code(404).send({message:'Domain not found'});
    try {
      const replaceMx = Boolean((req.body as any)?.replaceMx);
      const result=await domainSetup(domain.name,domain.token,req.method==='POST', { replaceMx });
      return req.method==='POST'&&!result.ready ? res.code(409).send(result) : result;
    } catch(error) {
      if(error instanceof SetupConflict) return res.code(409).send({message:error.message});
      const status=error instanceof Error ? error.message.match(/HTTP (400|401|403|404|409|422|5\d\d)/)?.[1] : undefined;
      req.log.warn({status},'Cloudflare setup could not be completed');
      return res.code(502).send({message:status
        ? 'Cloudflare setup returned HTTP '+status+'. Check access to Email Routing, Workers and R2, then retry.'
        : 'Cloudflare or DNS could not complete setup. Try again.'});
    }
  }
});
app.get<{Params:{name:string}, Querystring:{token?:string}}>('/api/domains/:name/cloudflare/dns', async (req, res) => {
  const { rows: [domain] } = await db.query('SELECT name, token FROM domains WHERE name=$1 AND removed_at IS NULL', [req.params.name]);
  if (!domain) return res.code(404).send({ message: 'Domain not found' });
  try {
    const status = await getDomainDnsStatus(domain.name, domain.token, req.query?.token);
    return status;
  } catch (error) {
    if (error instanceof SetupConflict) return res.code(409).send({ message: error.message });
    req.log.warn({ error }, 'Failed to fetch Cloudflare DNS status');
    return res.code(502).send({
      message: error instanceof Error ? error.message : 'Could not query Cloudflare DNS. Check credentials.'
    });
  }
});
app.post<{Params:{name:string}, Body?:{replaceConflictingMx?:boolean; syncSpf?:boolean; syncDmarc?:boolean; apiToken?:string}}>('/api/domains/:name/cloudflare/dns/sync', async (req, res) => {
  const { rows: [domain] } = await db.query('SELECT name, token FROM domains WHERE name=$1 AND removed_at IS NULL', [req.params.name]);
  if (!domain) return res.code(404).send({ message: 'Domain not found' });
  try {
    const report = await syncDomainDns(domain.name, domain.token, req.body || {});
    return report;
  } catch (error) {
    if (error instanceof SetupConflict) return res.code(409).send({ message: error.message });
    req.log.warn({ error }, 'Failed to sync Cloudflare DNS records');
    return res.code(502).send({
      message: error instanceof Error ? error.message : 'Could not synchronize Cloudflare DNS records. Check credentials.'
    });
  }
});

// Tailscale Configuration & Dashboard Access
app.get('/api/settings/tailscale', async () => {
  return await getTailscaleStatus(listenPort);
});

app.post<{Body?: {enabled?: boolean; configuredOrigin?: string | null; mode?: 'serve' | 'direct' | 'sidecar' | 'custom'}}>('/api/settings/tailscale', async (req, res) => {
  const body = req.body || {};
  if (body.configuredOrigin) {
    try {
      new URL(body.configuredOrigin);
    } catch {
      return res.code(400).send({ message: 'Invalid URL format for configuredOrigin' });
    }
  }
  if (body.mode && !['serve', 'direct', 'sidecar', 'custom'].includes(body.mode)) {
    return res.code(400).send({ message: 'Invalid Tailscale mode' });
  }
  cachedTailscaleSettings = await saveTailscaleSettings(body);
  cachedTailscaleHost = await detectTailscaleHost();
  return await getTailscaleStatus(listenPort);
});

app.post<{Body?: {origin?: string}}>('/api/settings/tailscale/verify-origin', async (req) => {
  const targetOrigin = req.body?.origin || req.headers.origin || '';
  const result = isAllowedTailscaleOrigin(targetOrigin, cachedTailscaleSettings, cachedTailscaleHost);
  const isDirectAllowed = isAllowedOrigin(targetOrigin);
  return {
    origin: targetOrigin,
    allowed: isDirectAllowed,
    reason: isDirectAllowed
      ? (targetOrigin === publicOrigin ? 'Matches Public URL origin' : (result.reason || 'Allowed origin'))
      : (result.reason || 'Origin rejected under current policy')
  };
});

app.get('/api/inboxes', async () => (await db.query(`
  SELECT i.address,i.name,i.pinned,i.auto_label,i.webhook_id,i.removed_at,coalesce(counts.unread,0) AS unread
  FROM inboxes i LEFT JOIN (
    SELECT recipient,count(*)::int AS unread FROM messages
    WHERE folder='inbox' AND unread GROUP BY recipient
  ) counts ON counts.recipient=i.address
  ORDER BY i.pinned DESC,i.address
`)).rows);
app.post<{Body:{local:string;domain:string;name?:string}}>('/api/inboxes',async(req,res)=>{
  const local=String(req.body?.local??'').trim().toLowerCase();
  const domain=String(req.body?.domain??'').trim().toLowerCase();
  if(local.length>64||!/^[-a-z0-9!#$%&'*+/=?^_`{|}~]+(?:\.[-a-z0-9!#$%&'*+/=?^_`{|}~]+)*$/.test(local)) {
    return res.code(400).send({message:'Enter the part before @, such as billing or invoices+shop.'});
  }
  const address=local+'@'+domain;
  if(address.length>254)return res.code(400).send({message:'Email address is too long.'});
  const result=await db.query(`INSERT INTO inboxes(address,name)
    SELECT $1,$2 FROM domains WHERE name=$3 AND verified AND removed_at IS NULL
    ON CONFLICT(address) DO UPDATE SET removed_at=NULL,name=excluded.name
    WHERE inboxes.removed_at IS NOT NULL RETURNING address`,[address,String(req.body?.name??'').trim().slice(0,120),domain]);
  if(result.rowCount)return res.code(201).send({address});
  const existing=await db.query('SELECT 1 FROM inboxes WHERE address=$1 AND removed_at IS NULL',[address]);
  if(existing.rowCount)return res.code(409).send({message:'This address already has an inbox.'});
  return res.code(422).send({message:'Select a verified receiving domain.'});
});
app.patch<{Body:{address:string,name?:string,pinned:boolean}}>('/api/inboxes',async(req,res)=>{
  const b=req.body;
  const result=await db.query('UPDATE inboxes SET name=coalesce($2,name),pinned=$3 WHERE address=$1 AND removed_at IS NULL',
    [b?.address,b?.name===undefined?null:String(b.name??'').trim().slice(0,120),b?.pinned===true]);
  if(!result.rowCount)return res.code(404).send({message:'Inbox not found.'});
  return {ok:true};
});
app.delete<{Querystring:{address:string}}>('/api/inboxes',async(req,res)=>{
  const {address}=req.query;
  if(typeof address!=='string'||!address||address.includes('\0'))return res.code(400).send({message:'Select an address.'});
  const result=await db.query(`UPDATE inboxes SET removed_at=now(),name='',pinned=false,auto_label=NULL,webhook_id=NULL
    WHERE address=$1 AND removed_at IS NULL`,[address]);
  if(!result.rowCount)return res.code(404).send({message:'Address not found.'});
  return {ok:true};
});
app.get('/api/inbox-rule-hooks',async()=> (await db.query(
  'SELECT id,url FROM hooks WHERE address_only ORDER BY url,id'
)).rows);
app.patch<{Body:{address:string;label:string;webhookId:string|null;name?:string}}>('/api/inbox-rules',async(req,res)=>{
  const {address,label,webhookId,name}=req.body??{};
  if(typeof address!=='string'||address.length>254||typeof label!=='string'||label.trim().length>60||label.includes('\0')
    ||(name!==undefined&&(typeof name!=='string'||name.trim().length>120||name.includes('\0')))
    ||(webhookId!==null&&(typeof webhookId!=='string'||!uuid.test(webhookId)))) {
    return res.code(400).send({message:'Select an address, a label up to 60 characters, and an optional webhook.'});
  }
  const result=await db.query(`UPDATE inboxes SET auto_label=$2,webhook_id=$3,name=coalesce($4,name) WHERE address=$1 AND removed_at IS NULL
    AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM hooks WHERE id=$3 AND address_only FOR KEY SHARE))`,
    [address,label.trim()||null,webhookId,name?.trim()??null]);
  if(!result.rowCount)return res.code(422).send({message:'The address or selected webhook is no longer available.'});
  return {ok:true};
});
app.get('/api/blocks',async()=> (await db.query('SELECT sender FROM blocks ORDER BY sender')).rows);
app.post<{Body:{sender:string,remove?:boolean}}>('/api/blocks',async(req,res)=>{
  const sender=String(req.body?.sender??'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+$/.test(sender)) return res.code(400).send({message:'Enter a sender email address'});
  await db.query(req.body.remove?'DELETE FROM blocks WHERE sender=$1':'INSERT INTO blocks(sender) VALUES($1) ON CONFLICT DO NOTHING',[sender]);
  return {ok:true};
});
app.get('/api/integrations',async()=>({
  keys:(await db.query('SELECT id,name,domain FROM api_keys ORDER BY name')).rows,
  hooks:(await db.query('SELECT id,url,filter,address_only FROM hooks ORDER BY url')).rows,
  deliveries:(await db.query(`SELECT d.id,d.status,d.attempts,d.message IS NOT NULL AS replayable,h.url,l.result,l.attempted FROM delivery_log l
    JOIN deliveries d ON d.id=l.delivery JOIN hooks h ON h.id=d.hook ORDER BY l.id DESC LIMIT 100`)).rows
}));
app.post<{Body:{name:string;domain:string}}>('/api/keys',async (req,res)=>{
  const domain=req.body?.domain;
  if(typeof domain!=='string'||!domain)return res.code(400).send({message:'Select a verified domain.'});
  const key='re_'+randomBytes(32).toString('hex');
  const result=await db.query(`INSERT INTO api_keys(name,hash,domain)
    SELECT $1,$2,name FROM domains WHERE name=$3 AND verified AND removed_at IS NULL`,
    [String(req.body?.name||'API key').slice(0,120),digest(key),domain]);
  if(!result.rowCount)return res.code(422).send({message:'Select a verified domain.'});
  return {secret:key};
});
app.post<{Body:{url:string,filter?:string,addressOnly?:boolean}}>('/api/hooks',async(req,res)=>{
  let url:URL;
  try { url=new URL(req.body?.url); if(url.protocol!=='https:'||url.username||url.password) throw Error(); }
  catch{return res.code(400).send({message:'Enter a public HTTPS URL'});}
  const secret='whsec_'+randomBytes(32).toString('base64');
  const addressOnly=req.body.addressOnly===true;
  await db.query('INSERT INTO hooks(url,secret,filter,address_only) VALUES($1,$2,$3,$4)',
    [url.href,encryptSecret(secret,'webhook'),addressOnly?'':String(req.body.filter??'').trim().toLowerCase(),addressOnly]);
  return {secret};
});
app.delete<{Params:{type:string,id:string}}>('/api/integrations/:type/:id',async(req,res)=>{
  const table=req.params.type==='key'?'api_keys':req.params.type==='hook'?'hooks':null;
  if(!table||!uuid.test(req.params.id)) return res.code(404).send();
  await db.query(`DELETE FROM ${table} WHERE id=$1`,[req.params.id]);
  return {ok:true};
});
app.post<{Params:{id:string}}>('/api/replay/:id',async(req,res)=>{
  if(!uuid.test(req.params.id)) return res.code(404).send();
  const result=await db.query("UPDATE deliveries SET status='pending',next_attempt=now(),attempts=0 WHERE id=$1 AND message IS NOT NULL",[req.params.id]);
  if(!result.rowCount)return res.code(404).send({message:'Delivery or original message is no longer available.'});
  return {ok:true};
});
app.get('/health',async()=>({status:'ok',timestamp:new Date().toISOString()}));
app.get('/metrics', async (req, res) => {
  const { statfs } = await import('node:fs/promises');
  const disk = await statfs(process.env.DISK_PATH || '.').catch(() => ({ bavail: 0, bsize: 0 }));
  const freeBytes = Number(disk.bavail || 0) * Number(disk.bsize || 0);

  const { rows: queueRows } = await db.query(
    'SELECT state, count(*)::int AS count FROM messages GROUP BY state'
  ).catch(() => ({ rows: [] as any[] }));

  const { rows: outboundRows } = await db.query(
    'SELECT status, count(*)::int AS count FROM outbound_messages GROUP BY status'
  ).catch(() => ({ rows: [] as any[] }));

  const { rows: [{ count: totalMessages }] } = await db.query(
    'SELECT count(*)::int AS count FROM messages'
  ).catch(() => ({ rows: [{ count: 0 }] }));

  const pendingWorkerJobs = queueRows.find(r => r.state === 'pending')?.count || 0;
  const processRssBytes = process.memoryUsage().rss;

  const lines = [
    '# HELP letterdock_up Whether Letterdock server is running',
    '# TYPE letterdock_up gauge',
    'letterdock_up 1',
    '',
    '# HELP letterdock_process_resident_memory_bytes Process RSS memory in bytes',
    '# TYPE letterdock_process_resident_memory_bytes gauge',
    `letterdock_process_resident_memory_bytes ${processRssBytes}`,
    '',
    '# HELP letterdock_messages_total Total messages received and stored',
    '# TYPE letterdock_messages_total counter',
    `letterdock_messages_total ${totalMessages}`,
    '',
    '# HELP letterdock_worker_queue_depth Pending worker jobs count',
    '# TYPE letterdock_worker_queue_depth gauge',
    `letterdock_worker_queue_depth ${pendingWorkerJobs}`,
    '',
    '# HELP letterdock_storage_free_bytes Free filesystem disk space in bytes',
    '# TYPE letterdock_storage_free_bytes gauge',
    `letterdock_storage_free_bytes ${freeBytes}`,
    '',
    '# HELP letterdock_outbound_messages_total Total outbound messages by status',
    '# TYPE letterdock_outbound_messages_total counter',
    ...outboundRows.map(r => `letterdock_outbound_messages_total{status="${r.status}"} ${r.count}`),
    ''
  ];

  res.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  return lines.join('\n');
});
app.get('/api/health',async()=>{
  const {statfs}=await import('node:fs/promises');
  const disk=await statfs(process.env.DISK_PATH||'.');
  return {
    free:disk.bavail*disk.bsize,
    staging:stagingStatus,
    deferred:(await db.query(`SELECT status,count(*)::int AS count FROM ingest_log
      WHERE status IN ('domain_quota','storage_quota') AND time>=now()-interval '7 days' GROUP BY status`)).rows,
    queues:(await db.query('SELECT state,count(*)::int AS count,min(received) AS oldest FROM messages GROUP BY state')).rows,
    ingest:(await db.query('SELECT * FROM ingest_log ORDER BY time DESC LIMIT 50')).rows,
    deliveries:(await db.query('SELECT status,count(*)::int AS count FROM deliveries GROUP BY status')).rows
  };
});

const wire = "m.id,sender AS \"from\",ARRAY[recipient] AS \"to\",subject,received AS created_at,ARRAY[]::text[] AS cc,ARRAY[]::text[] AS bcc,message_id";
const list = (rows:unknown[],limit:number) => ({object:'list',data:rows.slice(0,limit),has_more:rows.length>limit});
function pagination(q:Record<string,string>) {
  return {limit:Math.max(1,Math.min(100,Math.trunc(Number(q.limit)||20))), cursor:uuid.test(q.after||q.before||'')?q.after||q.before:null, before:!!q.before};
}
const visible = `m.state='ready' AND m.folder<>'trash' AND EXISTS (
  SELECT 1 FROM domains d WHERE d.name=m.domain
  AND (m.retention_exempt OR d.retention_days IS NULL OR m.received >= now()-make_interval(days => d.retention_days))
)`;
const notFound = (message:string) => ({name:'not_found',statusCode:404,message});
app.get<{Querystring:Record<string,string>}>('/emails/receiving',async req=>{
  const {domain}=apiScope.get(req)!;
  const {limit,cursor,before}=pagination(req.query);
  const {rows}=await db.query(`SELECT ${wire} FROM messages m WHERE m.domain=$3 AND ${visible}
    AND ($1::uuid IS NULL OR (m.received,m.id) ${before?'>':'<'} (
      SELECT m.received,m.id FROM messages m WHERE m.id=$1 AND m.domain=$3 AND ${visible}))
    ORDER BY m.received ${before?'ASC':'DESC'},m.id ${before?'ASC':'DESC'} LIMIT $2`,[cursor,limit+1,domain]);
  const result=list(rows,limit);
  if(before) result.data.reverse();
  return result;
});
app.get<{Params:{id:string}}>('/emails/receiving/:id',async(req,res)=>{
  const {domain}=apiScope.get(req)!;
  const {rows:[row]}=uuid.test(req.params.id)?await db.query(`SELECT ${wire},html,body AS text,headers
    FROM messages m WHERE m.id=$1 AND m.domain=$2 AND ${visible}`,[req.params.id,domain]):{rows:[]};
  if(!row) return res.code(404).send(notFound('Email not found'));
  const {rows}=await db.query('SELECT id,filename,mime AS content_type FROM attachments WHERE message=$1',[row.id]);
  return {object:'email',...row,attachments:rows};
});
const attachmentWire="a.id,a.filename,a.mime AS content_type,coalesce(a.size_bytes, octet_length(a.data), 0) AS size,'attachment' AS content_disposition,NULL AS content_id";
app.get<{Params:{id:string},Querystring:Record<string,string>}>('/emails/receiving/:id/attachments',async(req,res)=>{
  if(!uuid.test(req.params.id))return res.code(404).send(notFound('Email not found'));
  const {domain}=apiScope.get(req)!;
  const {limit,cursor,before}=pagination(req.query);
  const {rows}=await db.query(`SELECT ${attachmentWire} FROM attachments a JOIN messages m ON m.id=a.message
    WHERE m.id=$1 AND m.domain=$4 AND ${visible}
    AND ($2::uuid IS NULL OR a.id ${before?'>':'<'} $2) ORDER BY a.id ${before?'ASC':'DESC'} LIMIT $3`,[req.params.id,cursor,limit+1,domain]);
  const result=list(rows,limit);
  if(before)result.data.reverse();
  return result;
});
app.get<{Params:{id:string,attachment:string}}>('/emails/receiving/:id/attachments/:attachment',async(req,res)=>{
  const {id,attachment}=req.params;
  const key=apiScope.get(req)!;
  const {rows:[row]}=uuid.test(id)&&uuid.test(attachment)?await db.query(`SELECT ${attachmentWire}
    FROM attachments a JOIN messages m ON m.id=a.message
    WHERE m.id=$1 AND a.id=$2 AND m.domain=$3 AND ${visible}`,[id,attachment,key.domain]):{rows:[]};
  if(!row)return res.code(404).send(notFound('Attachment not found'));
  const ttl=Date.now()+900000;
  const token=downloads.sign(attachment+':'+key.id+':'+ttl);
  return {object:'attachment',...row,expires_at:new Date(ttl).toISOString(),download_url:publicOrigin+'/download/'+encodeURIComponent(token)};
});
app.get<{Params:{token:string}}>('/download/:token',async(req,res)=>{
  const token=downloads.unsign(req.params.token);
  const [id,key,expires]=token.value?.split(':')??[];
  if(!token.valid||!uuid.test(id)||!uuid.test(key)||!/^\d{13}$/.test(expires)||Number(expires)<=Date.now())return res.code(404).send();
  const {rows:[row]}=await db.query(`SELECT a.filename,a.data,a.storage_key,a.mime FROM attachments a JOIN messages m ON m.id=a.message
    JOIN api_keys k ON k.id=$2 AND k.domain=m.domain WHERE a.id=$1 AND ${visible}`,[id,key]);
  if(!row)return res.code(404).send();
  let payload: Buffer | null = null;
  if (row.storage_key) {
    const blob = await storage.get(row.storage_key);
    if (blob) payload = blob.data;
  }
  if (!payload && row.data) {
    payload = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  }
  if (!payload) return res.code(404).send();
  return res.header('Cache-Control','no-store').header('Content-Disposition',safeName(row.filename)).type(row.mime || 'application/octet-stream').send(payload);
});

// -------------------------------------------------------------
// OpenAPI 3.1 Definition Endpoint
// -------------------------------------------------------------
app.get('/api/openapi.json', async () => openApiSpec);

// -------------------------------------------------------------
// Resend REST API Parity (Outbound Emails)
// -------------------------------------------------------------
app.post('/emails', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const body = req.body as any;

  if (!body || typeof body !== 'object') {
    return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Invalid email payload' });
  }

  if (scoped?.domain) {
    try {
      const fromParsed = extractEmailAddress(body.from || '');
      if (fromParsed.domain !== scoped.domain) {
        return res.code(403).send({
          name: 'forbidden',
          statusCode: 403,
          message: `API key is restricted to domain '${scoped.domain}'. Cannot send from '${fromParsed.domain}'.`
        });
      }
    } catch {
      return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Invalid from address' });
    }
  }

  const idempotencyKey = (req.headers['idempotency-key'] as string) || undefined;

  try {
    const result = await sendEmail({
      workspaceId,
      from: body.from,
      to: body.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.reply_to || body.replyTo,
      headers: body.headers,
      attachments: body.attachments,
      tags: body.tags,
      idempotencyKey,
      template: body.template,
      variables: body.variables,
      trackOpens: body.track_opens !== undefined ? Boolean(body.track_opens) : (body.trackOpens !== undefined ? Boolean(body.trackOpens) : undefined),
      trackClicks: body.track_clicks !== undefined ? Boolean(body.track_clicks) : (body.trackClicks !== undefined ? Boolean(body.trackClicks) : undefined),
      threadId: body.thread_id || body.threadId,
      inReplyTo: body.in_reply_to || body.inReplyTo
    });

    return res.code(200).send({ id: result.id });
  } catch (err: any) {
    if (err instanceof OutboundError) {
      return res.code(err.statusCode).send({
        name: err.name,
        statusCode: err.statusCode,
        message: err.message
      });
    }
    return res.code(500).send({
      name: 'internal_server_error',
      statusCode: 500,
      message: err.message || 'Failed to dispatch email'
    });
  }
});

app.post('/emails/batch', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const list = req.body as any[];

  if (!Array.isArray(list) || list.length === 0) {
    return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Batch payload must be a non-empty array' });
  }

  if (list.length > 100) {
    return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Batch size cannot exceed 100 emails' });
  }

  // Pre-validate all items upfront to prevent partial execution failures
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') {
      return res.code(422).send({ name: 'validation_error', statusCode: 422, message: `Invalid batch item at index ${i}` });
    }
    try {
      const fromParsed = extractEmailAddress(item.from || '');
      if (scoped?.domain && fromParsed.domain !== scoped.domain) {
        return res.code(403).send({
          name: 'forbidden',
          statusCode: 403,
          message: `API key is restricted to domain '${scoped.domain}'. Cannot send from '${fromParsed.domain}' at index ${i}.`
        });
      }
    } catch {
      return res.code(422).send({ name: 'validation_error', statusCode: 422, message: `Invalid from address at batch index ${i}` });
    }

    const toRecipients = normalizeAddressList(item.to);
    if (toRecipients.length === 0) {
      return res.code(422).send({ name: 'validation_error', statusCode: 422, message: `At least one valid recipient is required at index ${i}` });
    }

    const allRecipients = Array.from(new Set([...toRecipients, ...normalizeAddressList(item.cc), ...normalizeAddressList(item.bcc)]));
    for (const recipient of allRecipients) {
      const isSuppressed = await checkSuppression(workspaceId, recipient);
      if (isSuppressed) {
        return res.code(422).send({
          name: 'validation_error',
          statusCode: 422,
          message: `Recipient '${recipient}' at batch index ${i} is on the suppression list.`
        });
      }
    }
  }

  const results: Array<{ id: string }> = [];

  for (const item of list) {
    try {
      const result = await sendEmail({
        workspaceId,
        from: item.from,
        to: item.to,
        subject: item.subject,
        html: item.html,
        text: item.text,
        cc: item.cc,
        bcc: item.bcc,
        replyTo: item.reply_to || item.replyTo,
        headers: item.headers,
        attachments: item.attachments,
        tags: item.tags,
        template: item.template,
        variables: item.variables,
        trackOpens: item.track_opens !== undefined ? Boolean(item.track_opens) : (item.trackOpens !== undefined ? Boolean(item.trackOpens) : undefined),
        trackClicks: item.track_clicks !== undefined ? Boolean(item.track_clicks) : (item.trackClicks !== undefined ? Boolean(item.trackClicks) : undefined),
        threadId: item.thread_id || item.threadId,
        inReplyTo: item.in_reply_to || item.inReplyTo
      });
      results.push({ id: result.id });
    } catch (err: any) {
      if (err instanceof OutboundError) {
        return res.code(err.statusCode).send({
          name: err.name,
          statusCode: err.statusCode,
          message: err.message
        });
      }
      return res.code(500).send({
        name: 'internal_server_error',
        statusCode: 500,
        message: err.message || 'Batch item failed'
      });
    }
  }

  return res.code(200).send({ data: results });
});

app.get<{ Params: { id: string } }>('/emails/:id', async (req, res) => {
  const { id } = req.params;
  if (!uuid.test(id)) {
    return res.code(404).send(notFound('Email not found'));
  }
  const scoped = apiScope.get(req);

  const { rows: [outRow] } = await db.query(
    'SELECT * FROM outbound_messages WHERE id = $1',
    [id]
  );
  if (outRow) {
    if (scoped?.workspace_id && outRow.workspace_id !== scoped.workspace_id) {
      return res.code(404).send(notFound('Email not found'));
    }
    if (scoped?.domain && outRow.domain !== scoped.domain) {
      return res.code(404).send(notFound('Email not found'));
    }
    return {
      object: 'email',
      id: outRow.id,
      to: outRow.to_address,
      from: outRow.from_address,
      created_at: outRow.created_at,
      subject: outRow.subject,
      html: outRow.html_body,
      text: outRow.text_body,
      bcc: outRow.bcc || [],
      cc: outRow.cc || [],
      reply_to: outRow.reply_to || [],
      last_event: outRow.status
    };
  }

  const { rows: [inRow] } = await db.query(
    'SELECT id, domain, workspace_id, sender, recipient, subject, body, html, received FROM messages WHERE id = $1',
    [id]
  );
  if (inRow) {
    if (scoped?.workspace_id && inRow.workspace_id !== scoped.workspace_id) {
      return res.code(404).send(notFound('Email not found'));
    }
    if (scoped?.domain && inRow.domain !== scoped.domain) {
      return res.code(404).send(notFound('Email not found'));
    }
    return {
      object: 'email',
      id: inRow.id,
      to: [inRow.recipient],
      from: inRow.sender,
      created_at: inRow.received,
      subject: inRow.subject,
      html: inRow.html,
      text: inRow.body,
      bcc: [],
      cc: [],
      reply_to: [],
      last_event: 'delivered'
    };
  }

  return res.code(404).send(notFound('Email not found'));
});

// -------------------------------------------------------------
// Resend REST API Parity (Domains & API Keys)
// -------------------------------------------------------------
app.post('/domains', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const body = req.body as any;
  const rawName = String(body?.name || '').trim().toLowerCase();
  if (!rawName || !rawName.includes('.')) {
    return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Valid domain name required' });
  }

  const { rows: [domain] } = await db.query(`
    INSERT INTO domains (name, verified, workspace_id)
    VALUES ($1, false, $2)
    ON CONFLICT (name) DO UPDATE SET removed_at = NULL, workspace_id = EXCLUDED.workspace_id
    RETURNING name, token, verified, retention_days, workspace_id
  `, [rawName, workspaceId]);

  return res.code(201).send({
    id: domain.name,
    name: domain.name,
    status: domain.verified ? 'verified' : 'not_started',
    created_at: new Date().toISOString(),
    region: body.region || 'us-east-1',
    records: [
      {
        record: 'MX',
        name: domain.name,
        type: 'MX',
        value: 'inbound.letterdock.com',
        ttl: 'Auto',
        status: domain.verified ? 'verified' : 'not_started',
        priority: 10
      },
      {
        record: 'TXT',
        name: domain.name,
        type: 'TXT',
        value: 'v=spf1 include:letterdock.com ~all',
        ttl: 'Auto',
        status: domain.verified ? 'verified' : 'not_started'
      }
    ]
  });
});

app.get('/domains', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const params: any[] = [workspaceId];
  let query = 'SELECT name, token, verified FROM domains WHERE removed_at IS NULL AND (workspace_id = $1 OR workspace_id IS NULL) ';
  if (scoped?.domain) {
    params.push(scoped.domain);
    query += `AND name = $${params.length} `;
  }
  query += 'ORDER BY name ASC';
  const { rows } = await db.query(query, params);

  return {
    data: rows.map(r => ({
      id: r.name,
      name: r.name,
      status: r.verified ? 'verified' : 'not_started',
      created_at: new Date().toISOString(),
      region: 'us-east-1'
    }))
  };
});

app.get<{ Params: { id: string } }>('/domains/:id', async (req, res) => {
  const { id } = req.params;
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows: [domain] } = await db.query(
    'SELECT name, token, verified FROM domains WHERE (name = $1 OR token::text = $1) AND removed_at IS NULL AND (workspace_id = $2 OR workspace_id IS NULL) LIMIT 1',
    [id, workspaceId]
  );
  if (!domain) return res.code(404).send(notFound('Domain not found'));

  return {
    id: domain.name,
    name: domain.name,
    status: domain.verified ? 'verified' : 'not_started',
    created_at: new Date().toISOString(),
    region: 'us-east-1',
    records: [
      {
        record: 'MX',
        name: domain.name,
        type: 'MX',
        value: 'inbound.letterdock.com',
        ttl: 'Auto',
        status: domain.verified ? 'verified' : 'not_started',
        priority: 10
      },
      {
        record: 'TXT',
        name: domain.name,
        type: 'TXT',
        value: 'v=spf1 include:letterdock.com ~all',
        ttl: 'Auto',
        status: domain.verified ? 'verified' : 'not_started'
      }
    ]
  };
});

app.post<{ Params: { id: string } }>('/domains/:id/verify', async (req, res) => {
  const { id } = req.params;
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows: [domain] } = await db.query(
    'SELECT name, verified FROM domains WHERE (name = $1 OR token::text = $1) AND removed_at IS NULL AND (workspace_id = $2 OR workspace_id IS NULL) LIMIT 1',
    [id, workspaceId]
  );
  if (!domain) return res.code(404).send(notFound('Domain not found'));

  return {
    object: 'domain',
    id: domain.name,
    status: domain.verified ? 'verified' : 'not_started'
  };
});

app.post('/api-keys', async (req, res) => {
  const body = req.body as any;
  const name = String(body?.name || 'API Key').slice(0, 120);
  const domain = body?.domain || body?.domain_id || null;
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';

  if (domain) {
    const { rows: [d] } = await db.query(
      'SELECT name FROM domains WHERE name = $1 AND verified AND removed_at IS NULL',
      [domain]
    );
    if (!d) {
      return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Domain must be verified' });
    }
  }

  const rawToken = 're_' + randomBytes(32).toString('hex');
  const tokenHash = digest(rawToken);

  const { rows: [keyRow] } = await db.query(`
    INSERT INTO api_keys (name, hash, domain, workspace_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, name, created_at
  `, [name, tokenHash, domain, workspaceId]);

  return res.code(201).send({
    id: keyRow.id,
    name: keyRow.name,
    token: rawToken,
    created_at: keyRow.created_at
  });
});

app.get('/api-keys', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows } = await db.query(
    'SELECT id, name, created_at FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC',
    [workspaceId]
  );
  return {
    data: rows.map(r => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at
    }))
  };
});

app.delete<{ Params: { id: string } }>('/api-keys/:id', async (req, res) => {
  const { id } = req.params;
  if (!uuid.test(id)) {
    return res.code(404).send(notFound('API key not found'));
  }
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';

  const resDel = await db.query(
    'DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId]
  );
  if (!resDel.rowCount) {
    return res.code(404).send(notFound('API key not found'));
  }
  return {
    object: 'api_key',
    id,
    deleted: true
  };
});

// -------------------------------------------------------------
// Outbound Relay Profiles & Abuse Suppression APIs
// -------------------------------------------------------------
app.get('/api/outbound/profiles', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows } = await db.query(
    'SELECT id, workspace_id, domain, provider, from_name, from_email, is_default, created_at, updated_at FROM outbound_profiles WHERE workspace_id = $1 ORDER BY domain ASC',
    [workspaceId]
  );
  return { profiles: rows };
});

app.post<{ Body: { domain: string; provider: 'smtp' | 'resend' | 'ses' | 'brevo' | 'mock'; credentials?: any; from_name?: string; from_email?: string; is_default?: boolean } }>('/api/outbound/profiles', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { domain, provider, credentials, from_name = '', from_email = '', is_default = false } = req.body || {};
  if (!domain || !provider) {
    return res.code(400).send({ message: 'domain and provider are required' });
  }
  const encryptedCreds = encryptSecret(JSON.stringify(credentials || {}), 'outbound');

  await db.query(`
    INSERT INTO outbound_profiles (workspace_id, domain, provider, credentials_encrypted, from_name, from_email, is_default)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (workspace_id, domain) DO UPDATE
    SET provider = EXCLUDED.provider,
        credentials_encrypted = EXCLUDED.credentials_encrypted,
        from_name = EXCLUDED.from_name,
        from_email = EXCLUDED.from_email,
        is_default = EXCLUDED.is_default,
        updated_at = now()
  `, [workspaceId, domain, provider, encryptedCreds, from_name, from_email, is_default]);

  return { ok: true };
});

app.delete<{ Params: { domain: string } }>('/api/outbound/profiles/:domain', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  await db.query('DELETE FROM outbound_profiles WHERE workspace_id = $1 AND domain = $2', [workspaceId, req.params.domain]);
  return { ok: true };
});

app.get('/api/suppressions', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows } = await db.query(
    'SELECT id, email, domain, reason, details, created_at FROM suppressions WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 500',
    [workspaceId]
  );
  return { suppressions: rows };
});

app.post<{ Body: { email: string; reason?: 'bounce' | 'complaint' | 'manual'; details?: string; domain?: string } }>('/api/suppressions', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { email, reason = 'manual', details = '', domain } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.code(400).send({ message: 'Valid email address required' });
  }
  await addSuppression(workspaceId, email, reason, details, domain);
  return { ok: true };
});

app.delete<{ Params: { email: string } }>('/api/suppressions/:email', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const deleted = await removeSuppression(workspaceId, req.params.email);
  return { ok: true, deleted };
});

app.post<{ Body: { email: string; reason?: string; details?: string; domain?: string } }>('/api/webhooks/bounces', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { email, reason = 'hard_bounce', details = '', domain } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.code(400).send({ ok: false, message: 'Valid email address required' });
  }
  await addSuppression(workspaceId, email, 'bounce', details || reason, domain);
  return { ok: true, suppressed: true };
});

app.post<{ Body: { email: string; details?: string; domain?: string } }>('/api/webhooks/complaints', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { email, details = '', domain } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.code(400).send({ ok: false, message: 'Valid email address required' });
  }
  await addSuppression(workspaceId, email, 'complaint', details || 'spam complaint', domain);
  return { ok: true, suppressed: true };
});

// -------------------------------------------------------------
// Public Open & Click Tracking Endpoints
// -------------------------------------------------------------
app.get<{ Params: { '*': string } }>('/t/o/*', async (req, res) => {
  let rawToken = req.params['*'] || '';
  if (rawToken.endsWith('.gif')) {
    rawToken = rawToken.slice(0, -4);
  }
  const payload = verifyTrackingToken(rawToken);
  if (payload) {
    await recordEmailEvent({
      workspaceId: payload.wid,
      messageId: payload.mid,
      outboundId: payload.oid,
      recipient: payload.rcpt,
      eventType: 'opened',
      metadata: {
        userAgent: req.headers['user-agent'],
        ip: req.ip
      }
    }).catch(err => console.error('[Tracking Open Error]:', err));
  }
  res.header('Content-Type', 'image/gif');
  res.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  return res.send(TRANSPARENT_GIF_BUFFER);
});

app.get<{ Params: { '*': string } }>('/t/c/*', async (req, res) => {
  const token = req.params['*'] || '';
  const payload = verifyTrackingToken(token);
  if (!payload || !payload.url) {
    return res.code(400).send({ message: 'Invalid or expired tracking link' });
  }
  await recordEmailEvent({
    workspaceId: payload.wid,
    messageId: payload.mid,
    outboundId: payload.oid,
    recipient: payload.rcpt,
    eventType: 'clicked',
    metadata: {
      targetUrl: payload.url,
      userAgent: req.headers['user-agent'],
      ip: req.ip
    }
  }).catch(err => console.error('[Tracking Click Error]:', err));
  return res.redirect(payload.url, 302);
});

// -------------------------------------------------------------
// Transactional Email Templates API
// -------------------------------------------------------------
const handleListTemplates = async (req: FastifyRequest) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows } = await db.query(
    `SELECT id, name, slug, description, subject, variables, sample_data, created_at, updated_at
     FROM templates WHERE workspace_id = $1 ORDER BY updated_at DESC`,
    [workspaceId]
  );
  return { data: rows };
};
app.get('/templates', handleListTemplates);
app.get('/api/templates', handleListTemplates);

const handleCreateTemplate = async (req: FastifyRequest, res: any) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const body = req.body as any;

  if (!body || !body.name) {
    return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Template name is required' });
  }

  const slug = (body.slug || body.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const subject = body.subject || '';
  const htmlContent = body.html_content || body.html || '';
  const textContent = body.text_content || body.text || '';
  const description = body.description || '';
  const sampleData = body.sample_data || body.sampleData || {};

  // Automatically extract variables from subject, HTML, and text
  const combined = `${subject} ${htmlContent} ${textContent}`;
  const extracted = extractVariables(combined);
  const variables = body.variables && Array.isArray(body.variables) ? body.variables : extracted;

  try {
    const { rows: [created] } = await db.query(
      `INSERT INTO templates (
        workspace_id, name, slug, description, subject, html_content, text_content, variables, sample_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, name, slug, description, subject, html_content, text_content, variables, sample_data, created_at, updated_at`,
      [workspaceId, body.name, slug, description, subject, htmlContent, textContent, JSON.stringify(variables), JSON.stringify(sampleData)]
    );
    return res.code(201).send(created);
  } catch (err: any) {
    if (err?.code === '23505') {
      return res.code(409).send({ name: 'conflict', statusCode: 409, message: `Template with slug '${slug}' already exists` });
    }
    throw err;
  }
};
app.post('/templates', handleCreateTemplate);
app.post('/api/templates', handleCreateTemplate);

const handleGetTemplate = async (req: FastifyRequest<{ Params: { id: string } }>, res: any) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { id } = req.params;

  const { rows: [tpl] } = await db.query(
    `SELECT id, name, slug, description, subject, html_content, text_content, variables, sample_data, created_at, updated_at
     FROM templates WHERE workspace_id = $1 AND (id::text = $2 OR slug = $2) LIMIT 1`,
    [workspaceId, id]
  );
  if (!tpl) return res.code(404).send({ name: 'not_found', statusCode: 404, message: 'Template not found' });
  return tpl;
};
app.get<{ Params: { id: string } }>('/templates/:id', handleGetTemplate);
app.get<{ Params: { id: string } }>('/api/templates/:id', handleGetTemplate);

const handleUpdateTemplate = async (req: FastifyRequest<{ Params: { id: string } }>, res: any) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { id } = req.params;
  const body = req.body as any;

  const { rows: [existing] } = await db.query(
    `SELECT id, name, slug, description, subject, html_content, text_content, variables, sample_data
     FROM templates WHERE workspace_id = $1 AND (id::text = $2 OR slug = $2) LIMIT 1`,
    [workspaceId, id]
  );
  if (!existing) return res.code(404).send({ name: 'not_found', statusCode: 404, message: 'Template not found' });

  const name = body.name ?? existing.name;
  const slug = body.slug ?? existing.slug;
  const description = body.description ?? existing.description;
  const subject = body.subject ?? existing.subject;
  const htmlContent = body.html_content ?? body.html ?? existing.html_content;
  const textContent = body.text_content ?? body.text ?? existing.text_content;
  const sampleData = body.sample_data ?? body.sampleData ?? existing.sample_data;

  const combined = `${subject} ${htmlContent} ${textContent}`;
  const extracted = extractVariables(combined);
  const variables = body.variables && Array.isArray(body.variables) ? body.variables : extracted;

  const { rows: [updated] } = await db.query(
    `UPDATE templates
     SET name = $3, slug = $4, description = $5, subject = $6, html_content = $7, text_content = $8,
         variables = $9, sample_data = $10, updated_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, name, slug, description, subject, html_content, text_content, variables, sample_data, created_at, updated_at`,
    [workspaceId, existing.id, name, slug, description, subject, htmlContent, textContent, JSON.stringify(variables), JSON.stringify(sampleData)]
  );
  return updated;
};
app.put<{ Params: { id: string } }>('/templates/:id', handleUpdateTemplate);
app.put<{ Params: { id: string } }>('/api/templates/:id', handleUpdateTemplate);

const handleDeleteTemplate = async (req: FastifyRequest<{ Params: { id: string } }>, res: any) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { id } = req.params;

  const result = await db.query(
    `DELETE FROM templates WHERE workspace_id = $1 AND (id::text = $2 OR slug = $2)`,
    [workspaceId, id]
  );
  if (result.rowCount === 0) {
    return res.code(404).send({ name: 'not_found', statusCode: 404, message: 'Template not found' });
  }
  return { ok: true, deleted: true };
};
app.delete<{ Params: { id: string } }>('/templates/:id', handleDeleteTemplate);
app.delete<{ Params: { id: string } }>('/api/templates/:id', handleDeleteTemplate);

const handlePreviewTemplate = async (req: FastifyRequest<{ Params: { id: string } }>, res: any) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { id } = req.params;
  const body = (req.body as any) || {};

  const { rows: [tpl] } = await db.query(
    `SELECT id, name, slug, subject, html_content, text_content, sample_data
     FROM templates WHERE workspace_id = $1 AND (id::text = $2 OR slug = $2) LIMIT 1`,
    [workspaceId, id]
  );
  if (!tpl) return res.code(404).send({ name: 'not_found', statusCode: 404, message: 'Template not found' });

  const testData = { ...(tpl.sample_data || {}), ...(body.variables || body.data || {}) };
  const rendered = renderTemplate(tpl, testData);
  return {
    template: { id: tpl.id, name: tpl.name, slug: tpl.slug },
    rendered,
    variablesUsed: testData
  };
};
app.post<{ Params: { id: string } }>('/templates/:id/preview', handlePreviewTemplate);
app.post<{ Params: { id: string } }>('/api/templates/:id/preview', handlePreviewTemplate);

// -------------------------------------------------------------
// Inbound Automation Rules API
// -------------------------------------------------------------
app.get('/api/rules', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows } = await db.query(
    `SELECT id, name, priority, enabled, match_all, conditions, actions, created_at, updated_at
     FROM inbound_rules WHERE workspace_id = $1 ORDER BY priority ASC, created_at ASC`,
    [workspaceId]
  );
  return { data: rows };
});

app.post('/api/rules', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const body = req.body as any;

  if (!body || !body.name) {
    return res.code(422).send({ name: 'validation_error', statusCode: 422, message: 'Rule name is required' });
  }

  const priority = typeof body.priority === 'number' ? body.priority : 100;
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;
  const matchAll = body.match_all !== undefined ? Boolean(body.match_all) : true;
  const conditions = Array.isArray(body.conditions) ? body.conditions : [];
  const actions = Array.isArray(body.actions) ? body.actions : [];

  const { rows: [rule] } = await db.query(
    `INSERT INTO inbound_rules (workspace_id, name, priority, enabled, match_all, conditions, actions)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, priority, enabled, match_all, conditions, actions, created_at, updated_at`,
    [workspaceId, body.name, priority, enabled, matchAll, JSON.stringify(conditions), JSON.stringify(actions)]
  );
  return res.code(201).send(rule);
});

app.get<{ Params: { id: string } }>('/api/rules/:id', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows: [rule] } = await db.query(
    `SELECT id, name, priority, enabled, match_all, conditions, actions, created_at, updated_at
     FROM inbound_rules WHERE workspace_id = $1 AND id::text = $2`,
    [workspaceId, req.params.id]
  );
  if (!rule) return res.code(404).send({ name: 'not_found', statusCode: 404, message: 'Rule not found' });
  return rule;
});

app.put<{ Params: { id: string } }>('/api/rules/:id', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const body = req.body as any;

  const { rows: [existing] } = await db.query(
    `SELECT id, name, priority, enabled, match_all, conditions, actions
     FROM inbound_rules WHERE workspace_id = $1 AND id::text = $2`,
    [workspaceId, req.params.id]
  );
  if (!existing) return res.code(404).send({ name: 'not_found', statusCode: 404, message: 'Rule not found' });

  const name = body.name ?? existing.name;
  const priority = typeof body.priority === 'number' ? body.priority : existing.priority;
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled;
  const matchAll = body.match_all !== undefined ? Boolean(body.match_all) : existing.match_all;
  const conditions = Array.isArray(body.conditions) ? body.conditions : existing.conditions;
  const actions = Array.isArray(body.actions) ? body.actions : existing.actions;

  const { rows: [updated] } = await db.query(
    `UPDATE inbound_rules
     SET name = $3, priority = $4, enabled = $5, match_all = $6, conditions = $7, actions = $8, updated_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING id, name, priority, enabled, match_all, conditions, actions, created_at, updated_at`,
    [workspaceId, existing.id, name, priority, enabled, matchAll, JSON.stringify(conditions), JSON.stringify(actions)]
  );
  return updated;
});

app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const result = await db.query(
    `DELETE FROM inbound_rules WHERE workspace_id = $1 AND id::text = $2`,
    [workspaceId, req.params.id]
  );
  if (result.rowCount === 0) {
    return res.code(404).send({ name: 'not_found', statusCode: 404, message: 'Rule not found' });
  }
  return { ok: true, deleted: true };
});

app.post('/api/rules/test', async (req, res) => {
  const body = req.body as any;
  const rule: InboundRule = body?.rule;
  const sampleMessage = body?.message || {
    id: randomUUID(),
    workspaceId: 'default',
    domain: 'example.com',
    sender: 'user@example.com',
    recipient: 'hello@example.com',
    subject: 'Test Subject',
    body: 'Sample message body',
    headers: {},
    hasAttachments: false
  };

  if (!rule || !Array.isArray(rule.conditions)) {
    return res.code(422).send({ message: 'Invalid rule payload' });
  }

  const matches = evaluateRule(rule, sampleMessage);
  return {
    matches,
    simulatedActions: matches ? rule.actions : []
  };
});

// -------------------------------------------------------------
// Conversation Threading API
// -------------------------------------------------------------
app.get<{ Params: { id: string } }>('/api/threads/:id', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const thread = await getConversationThread(workspaceId, req.params.id);
  return { thread_id: req.params.id, count: thread.length, messages: thread };
});

app.get<{ Params: { id: string } }>('/api/messages/:id/thread', async (req, res) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { id } = req.params;

  const { rows: [msg] } = await db.query(
    `SELECT id, thread_id FROM messages WHERE workspace_id = $1 AND id::text = $2 LIMIT 1`,
    [workspaceId, id]
  );

  const targetThreadId = msg?.thread_id || id;
  const thread = await getConversationThread(workspaceId, targetThreadId);
  return { thread_id: targetThreadId, count: thread.length, messages: thread };
});

// -------------------------------------------------------------
// Analytics & Deliverability API
// -------------------------------------------------------------
app.get('/api/analytics/overview', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  return await getAnalyticsOverview(workspaceId);
});

app.get('/api/analytics/events', async (req) => {
  const scoped = apiScope.get(req);
  const workspaceId = scoped?.workspace_id || 'default';
  const { rows } = await db.query(
    `SELECT id, message_id, outbound_id, recipient, event_type, metadata, created_at
     FROM email_events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId]
  );
  return { events: rows };
});

await migrate();
const migration = await db.connect();
try {
  await migration.query('BEGIN');
  const {rows} = await migration.query("SELECT id,secret FROM hooks WHERE starts_with(secret,'whsec_') FOR UPDATE");
  for(const hook of rows) {
    await migration.query('UPDATE hooks SET secret=$2 WHERE id=$1',[hook.id,encryptSecret(hook.secret,'webhook')]);
  }
  await migration.query('COMMIT');
} catch(error) {
  await migration.query('ROLLBACK');
  throw error;
} finally { migration.release(); }

try {
  cachedTailscaleSettings = await getTailscaleSettings();
  cachedTailscaleHost = await detectTailscaleHost();
} catch (err) {
  app.log.warn({ err }, 'Failed to initialize Tailscale cache');
}

await app.listen({port:listenPort,host:'0.0.0.0'});

// Start concurrent worker pool for high-throughput job leasing and delivery
workerPool.start();

// Background recurring maintenance loop (R2 staging pull, storage migration, retention)
let maintenanceTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

async function maintenanceTick() {
  if (shuttingDown) return;
  try {
    await runJobs();
  } catch (error) {
    console.error('Maintenance background job failed', error);
  } finally {
    if (!shuttingDown) {
      maintenanceTimer = setTimeout(maintenanceTick, 3000);
    }
  }
}
void maintenanceTick();

const shutdown = async () => {
  shuttingDown = true;
  if (maintenanceTimer) clearTimeout(maintenanceTimer);
  await workerPool.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
