import Fastify from 'fastify';
import cookies, { Signer } from '@fastify/cookie';
import files from '@fastify/static';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { storage } from './storage.js';
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { resolve } from 'node:path';
import { domainToASCII } from 'node:url';
import { completeOAuth, startOAuth, type OAuthState } from './cloudflare-oauth.js';
import { domainConnectLink } from './domain-connect.js';
import { connectCloudflare, connectionStatus, encryptSecret, domainSetup, SetupConflict } from './cloudflare.js';
import { db, migrate } from './db.js';
import { deliver, runJobs, stagingStatus } from './jobs.js';

const app = Fastify({ logger: true, disableRequestLogging: true, routerOptions: { maxParamLength: 253 } });
const password = process.env.ADMIN_PASSWORD;
const secret = process.env.SESSION_SECRET;
const listenPort = Number(process.env.PORT || 3000);
const publicOrigin = new URL(process.env.PUBLIC_URL || 'http://localhost:'+(process.env.APP_PORT || listenPort)).origin;
if (!password || password.length < 16 || !secret || secret.length < 32) throw Error('Configure ADMIN_PASSWORD and SESSION_SECRET');
const signingKey = (purpose: string) => createHmac('sha256', secret).update('letterdock:'+purpose).digest();
await app.register(cookies, { secret: signingKey('browser') });
const downloads = new Signer(signingKey('downloads'));
const apiScope = new WeakMap<object, {id:string;domain:string}>();
await app.register(files, { root: resolve('dist') });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeName = (name: string) => "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/['()]/g, '_');

app.addHook('preHandler', async (req, res) => {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/') && !path.startsWith('/emails/receiving')) return;
  res.header('Cache-Control', 'no-store');
  if (path.startsWith('/emails/receiving')) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const {rows:[key]}=await db.query('SELECT id,domain FROM api_keys WHERE hash=$1 AND domain IS NOT NULL',[digest(auth.slice(7))]);
      if(key){apiScope.set(req,key);return;}
    }
    return res.code(401).send({ name:'validation_error', statusCode:401, message:'Invalid API key' });
  }
  if (!['GET','HEAD'].includes(req.method) && req.headers.origin !== publicOrigin) {
    return res.code(403).send({ message:'Origin rejected' });
  }
  if (path === '/api/login') return;
  const session = req.unsignCookie(req.cookies.session ?? '');
  if (!session.valid || !session.value) return res.code(401).send({ message:'Sign in required' });

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
  return res.setCookie('session', 'session:'+sessionId, {
    signed:true,httpOnly:true,sameSite:'strict',secure:publicOrigin.startsWith('https:'),path:'/',maxAge:86400
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

const summary = 'id,recipient,sender,subject,received,unread,starred,folder,labels,state';
app.get<{Querystring:Record<string,string>}>('/api/messages', async req => {
  const q = req.query;
  const filters = [`folder=$1`];
  const values: unknown[] = [q.folder || 'inbox'];
  function filter(sql: string, value: unknown) { values.push(value); filters.push(sql.replace('?', '$'+values.length)); }
  if(q.domain) filter('domain=?',q.domain);
  if(q.address) filter('recipient=?',q.address);
  if(q.q) filter("to_tsvector('simple', sender || ' ' || recipient || ' ' || subject || ' ' || body) @@ websearch_to_tsquery('simple', ?)",q.q);
  if(q.from) filter('sender ILIKE ?', '%'+q.from+'%');
  if(q.to) filter('recipient ILIKE ?', '%'+q.to+'%');
  if(q.subject) filter('subject ILIKE ?', '%'+q.subject+'%');
  if(q.label) filter('? = ANY(labels)',q.label);
  if(q.since && /^\d{4}-\d{2}-\d{2}$/.test(q.since)) filter('received >= ?::date',q.since);
  if(q.until && /^\d{4}-\d{2}-\d{2}$/.test(q.until)) filter("received < ?::date + interval '1 day'",q.until);
  if(q.attachment==='true') filters.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message=messages.id)');
  if(q.unread==='true') filters.push('unread');
  if(q.starred==='true') filters.push('starred');
  if(q.cursor && uuid.test(q.cursor)) filter('(received,id) < (SELECT received,id FROM messages WHERE id=?)',q.cursor);
  return (await db.query(`SELECT ${summary} FROM messages WHERE ${filters.join(' AND ')}
    ORDER BY received DESC,id DESC LIMIT 100`,values)).rows;
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
app.route<{Params:{name:string}}>({
  method:['GET','POST'], url:'/api/domains/:name/cloudflare',
  async handler(req,res) {
    const {rows:[domain]}=await db.query('SELECT name,token FROM domains WHERE name=$1 AND removed_at IS NULL',[req.params.name]);
    if(!domain) return res.code(404).send({message:'Domain not found'});
    try {
      const result=await domainSetup(domain.name,domain.token,req.method==='POST');
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
await app.listen({port:listenPort,host:'0.0.0.0'});
async function tick() {
  await runJobs();
  setTimeout(tick, 3000);
}
void tick();
async function webhookTick() {
  try {await deliver();}
  catch(error){console.error('Webhook delivery failed',error);}
  finally {setTimeout(webhookTick,3000);}
}
void webhookTick();
