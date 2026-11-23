import Fastify from 'fastify';
import cookies from '@fastify/cookie';
import files from '@fastify/static';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { resolve } from 'node:path';
import { domainToASCII } from 'node:url';
import { domainConnectLink } from './domain-connect.js';
import { connectCloudflare, connectionStatus, domainSetup, SetupConflict } from './cloudflare.js';
import { db, migrate } from './db.js';
import { runJobs, stagingStatus } from './jobs.js';

const app = Fastify({ logger: true });
const password = process.env.ADMIN_PASSWORD;
const secret = process.env.SESSION_SECRET;
if (!password || password.length < 16 || !secret || secret.length < 32) throw Error('Configure ADMIN_PASSWORD and SESSION_SECRET');
await app.register(cookies, { secret });
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
    if (auth?.startsWith('Bearer ') && (await db.query('SELECT 1 FROM api_keys WHERE hash=$1', [digest(auth.slice(7))])).rowCount) return;
    return res.code(401).send({ name:'validation_error', statusCode:401, message:'Invalid API key' });
  }
  if (!['GET','HEAD'].includes(req.method) && req.headers.origin !== process.env.PUBLIC_URL) {
    return res.code(403).send({ message:'Origin rejected' });
  }
  if (path === '/api/login') return;
  const session = req.unsignCookie(req.cookies.session ?? '');
  if (!session.valid || Number(session.value) < Date.now()) return res.code(401).send({ message:'Sign in required' });
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
  return res.setCookie('session', String(Date.now()+86400000), {
    signed:true,httpOnly:true,sameSite:'strict',secure:process.env.PUBLIC_URL?.startsWith('https:'),path:'/',maxAge:86400
  }).send({ok:true});
});
app.post('/api/logout', async (_req,res) => res.clearCookie('session',{path:'/'}).send({ok:true}));

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
    db.query('SELECT id,filename,mime,octet_length(data) AS bytes FROM attachments WHERE message=$1',[req.params.id])
  ]);
  if(!data.rowCount) return res.code(404).send();
  return {...data.rows[0],attachments:attachments.rows};
});
app.patch<{Body:{ids:string[],folder?:string,unread?:boolean,starred?:boolean,label?:string,removeLabel?:string,retry?:boolean}}>('/api/messages', async (req,res) => {
  const b=req.body;
  if(!Array.isArray(b?.ids)||!b.ids.length||b.ids.length>100||!b.ids.every(id=>uuid.test(id))) return res.code(400).send({message:'Select valid messages'});
  if(b.folder && !['inbox','archive','trash'].includes(b.folder)) return res.code(400).send({message:'Invalid folder'});
  await db.query(`UPDATE messages SET folder=coalesce($2,folder), unread=coalesce($3,unread),
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
  const {rows:[row]}=await db.query('SELECT raw FROM messages WHERE id=$1',[req.params.id]);
  if(!row) return res.code(404).send();
  return res.header('Content-Disposition',safeName(req.params.id+'.eml')).type('application/octet-stream').send(row.raw);
});
app.get<{Params:{id:string}}>('/api/files/:id',async(req,res)=>{
  if(!uuid.test(req.params.id)) return res.code(404).send();
  const {rows:[row]}=await db.query('SELECT filename,data FROM attachments WHERE id=$1',[req.params.id]);
  if(!row) return res.code(404).send();
  return res.header('Content-Disposition',safeName(row.filename)).type('application/octet-stream').send(row.data);
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
  if (process.env.CLOUDFLARE_API_TOKEN) return res.code(409).send({message:'The Cloudflare token is managed by the server environment.'});
  await db.query("DELETE FROM settings WHERE key='cloudflare_token'");
  return connectionStatus();
});
app.get('/api/domains',async()=> (await db.query('SELECT name,token,verified,last_received,retention_days FROM domains WHERE removed_at IS NULL ORDER BY name')).rows);
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
app.delete<{Params:{name:string}}>('/api/domains/:name', async (req,res) => {
  const removed=await db.query(
    'UPDATE domains SET removed_at=now(), verified=false, last_received=NULL WHERE name=$1 AND removed_at IS NULL',
    [req.params.name]
  );
  if(!removed.rowCount) return res.code(404).send({message:'Domain not found'});
  return {ok:true};
});
app.get<{Params:{name:string}}>('/api/domains/:name/domain-connect',async(req,res)=>{
  const {rows:[domain]}=await db.query('SELECT name,token FROM domains WHERE name=$1 AND removed_at IS NULL',[req.params.name]);
  if(!domain)return res.code(404).send({message:'Domain not found'});
  try { return await domainConnectLink(domain.name,domain.token); }
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
      req.log.warn('Cloudflare setup could not be checked');
      return res.code(502).send({message:'Cloudflare or DNS could not be reached. Try again.'});
    }
  }
});
app.get('/api/inboxes',async()=> (await db.query('SELECT * FROM inboxes ORDER BY pinned DESC,address')).rows);
app.patch<{Body:{address:string,name:string,pinned:boolean}}>('/api/inboxes',async req=>{
  const b=req.body;
  await db.query('UPDATE inboxes SET name=$2,pinned=$3 WHERE address=$1',[b.address,String(b.name).slice(0,120),b.pinned===true]);
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
  keys:(await db.query('SELECT id,name FROM api_keys ORDER BY name')).rows,
  hooks:(await db.query('SELECT id,url,filter FROM hooks ORDER BY url')).rows,
  deliveries:(await db.query(`SELECT d.id,d.status,d.attempts,h.url,l.result,l.attempted FROM delivery_log l
    JOIN deliveries d ON d.id=l.delivery JOIN hooks h ON h.id=d.hook ORDER BY l.id DESC LIMIT 100`)).rows
}));
app.post<{Body:{name:string}}>('/api/keys',async req=>{
  const key='re_'+randomBytes(32).toString('hex');
  await db.query('INSERT INTO api_keys(name,hash) VALUES($1,$2)',[String(req.body?.name||'API key').slice(0,120),digest(key)]);
  return {secret:key};
});
app.post<{Body:{url:string,filter?:string}}>('/api/hooks',async(req,res)=>{
  let url:URL;
  try { url=new URL(req.body?.url); if(url.protocol!=='https:'||url.username||url.password) throw Error(); }
  catch{return res.code(400).send({message:'Enter a public HTTPS URL'});}
  const secret='whsec_'+randomBytes(32).toString('base64');
  await db.query('INSERT INTO hooks(url,secret,filter) VALUES($1,$2,$3)',[url.href,secret,String(req.body.filter??'').trim().toLowerCase()]);
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
  await db.query("UPDATE deliveries SET status='pending',next_attempt=now(),attempts=0 WHERE id=$1",[req.params.id]);
  return {ok:true};
});
app.get('/api/health',async()=>{
  const {statfs}=await import('node:fs/promises');
  const disk=await statfs(process.env.DISK_PATH||'.');
  return {
    free:disk.bavail*disk.bsize,
    staging:stagingStatus,
    queues:(await db.query('SELECT state,count(*)::int AS count,min(received) AS oldest FROM messages GROUP BY state')).rows,
    ingest:(await db.query('SELECT * FROM ingest_log ORDER BY time DESC LIMIT 50')).rows,
    deliveries:(await db.query('SELECT status,count(*)::int AS count FROM deliveries GROUP BY status')).rows
  };
});

const wire = "id,sender AS \"from\",ARRAY[recipient] AS \"to\",subject,received AS created_at,ARRAY[]::text[] AS cc,ARRAY[]::text[] AS bcc,message_id";
const list = (rows:unknown[],limit:number) => ({object:'list',data:rows.slice(0,limit),has_more:rows.length>limit});
function pagination(q:Record<string,string>) {
  return {limit:Math.max(1,Math.min(100,Math.trunc(Number(q.limit)||20))), cursor:uuid.test(q.after||q.before||'')?q.after||q.before:null, before:!!q.before};
}
app.get<{Querystring:Record<string,string>}>('/emails/receiving',async req=>{
  const {limit,cursor,before}=pagination(req.query);
  const {rows}=await db.query(`SELECT ${wire} FROM messages WHERE state='ready'
    AND ($1::uuid IS NULL OR (received,id) ${before?'>':'<'} (SELECT received,id FROM messages WHERE id=$1))
    ORDER BY received ${before?'ASC':'DESC'},id ${before?'ASC':'DESC'} LIMIT $2`,[cursor,limit+1]);
  const result=list(rows,limit);
  if(before) result.data.reverse();
  return result;
});
app.get<{Params:{id:string}}>('/emails/receiving/:id',async(req,res)=>{
  const {rows:[row]}=uuid.test(req.params.id)?await db.query(`SELECT ${wire},html,body AS text,headers FROM messages WHERE id=$1 AND state='ready'`,[req.params.id]):{rows:[]};
  if(!row) return res.code(404).send({name:'not_found',statusCode:404,message:'Email not found'});
  const {rows}=await db.query('SELECT id,filename,mime AS content_type FROM attachments WHERE message=$1',[row.id]);
  return {object:'email',...row,attachments:rows};
});
const attachmentWire="id,filename,mime AS content_type,octet_length(data) AS size,'attachment' AS content_disposition,NULL AS content_id";
app.get<{Params:{id:string},Querystring:Record<string,string>}>('/emails/receiving/:id/attachments',async(req,res)=>{
  if(!uuid.test(req.params.id))return res.code(404).send({name:'not_found',statusCode:404,message:'Email not found'});
  const {limit,cursor,before}=pagination(req.query);
  const {rows}=await db.query(`SELECT ${attachmentWire} FROM attachments WHERE message=$1
    AND ($2::uuid IS NULL OR id ${before?'>':'<'} $2) ORDER BY id ${before?'ASC':'DESC'} LIMIT $3`,[req.params.id,cursor,limit+1]);
  const result=list(rows,limit);
  if(before)result.data.reverse();
  return result;
});
app.get<{Params:{id:string,attachment:string}}>('/emails/receiving/:id/attachments/:attachment',async(req,res)=>{
  const {id,attachment}=req.params;
  const {rows:[row]}=uuid.test(id)&&uuid.test(attachment)?await db.query(`SELECT ${attachmentWire} FROM attachments WHERE message=$1 AND id=$2`,[id,attachment]):{rows:[]};
  if(!row)return res.code(404).send({name:'not_found',statusCode:404,message:'Attachment not found'});
  const ttl=Date.now()+900000;
  const token=app.signCookie(attachment+':'+ttl);
  return {object:'attachment',...row,expires_at:new Date(ttl).toISOString(),download_url:process.env.PUBLIC_URL+'/download/'+encodeURIComponent(token)};
});
app.get<{Params:{token:string}}>('/download/:token',async(req,res)=>{
  const token=app.unsignCookie(req.params.token);
  const [id,expires]=token.value?.split(':')??[];
  if(!token.valid||!uuid.test(id)||Number(expires)<=Date.now())return res.code(404).send();
  const {rows:[row]}=await db.query('SELECT filename,data FROM attachments WHERE id=$1',[id]);
  if(!row)return res.code(404).send();
  return res.header('Cache-Control','no-store').header('Content-Disposition',safeName(row.filename)).type('application/octet-stream').send(row.data);
});

await migrate();
await app.listen({port:Number(process.env.PORT||3000),host:'0.0.0.0'});
async function tick() {
  await runJobs();
  setTimeout(tick, 3000);
}
void tick();
