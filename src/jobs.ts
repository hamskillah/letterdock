import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList } from 'node:net';
import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import sanitize from 'sanitize-html';
import { managedIngress } from './cloudflare-ingress.js';
import { db } from './db.js';

const bucket = process.env.R2_BUCKET;
const s3 = bucket ? new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT }) : null;

export async function importMail(id: string, from: string, to: string, raw: Uint8Array) {
  const recipient = to.toLowerCase();
  const domain = recipient.slice(recipient.lastIndexOf('@') + 1);
  await db.query(`
    WITH decision AS (
      SELECT CASE WHEN NOT EXISTS (SELECT FROM domains WHERE name=$2 AND verified AND removed_at IS NULL) THEN 'unknown_domain'
             WHEN EXISTS (SELECT FROM blocks WHERE sender=lower($3)) THEN 'blocked' ELSE 'stored' END AS status
    ), logged AS (
      INSERT INTO ingest_log(id, recipient, status) SELECT $1,$4,status FROM decision
      ON CONFLICT DO NOTHING RETURNING status
    ), stored AS (
      INSERT INTO messages(id,domain,sender,recipient,raw)
      SELECT $1,$2,$3,$4,$5 FROM logged WHERE status='stored' RETURNING recipient
    ), updated AS (
      UPDATE domains SET last_received=now() WHERE name=$2 AND EXISTS (SELECT FROM stored)
    )
    INSERT INTO inboxes(address) SELECT recipient FROM stored ON CONFLICT DO NOTHING
  `, [id, domain, from, recipient, Buffer.from(raw)]);
}

export const stagingStatus = {
  configured: Boolean(s3 && bucket),
  lastChecked: null as string | null,
  moreWaiting: false,
  error: false
};
let continuation: string | undefined;
let workerCursor: string | null = null;

async function pullManaged() {
  const ingress=await managedIngress();
  if(!ingress?.url)return;
  stagingStatus.configured=true;
  const headers={ Authorization:'Bearer '+ingress.secret };
  const get=(path:string,method='GET')=>fetch(ingress.url+path,{
    method,headers,redirect:'error',signal:AbortSignal.timeout(20000)
  });
  const response=await get('/mail'+(workerCursor?'?cursor='+encodeURIComponent(workerCursor):''));
  if(!response.ok){workerCursor=null;throw Error('Staging list failed: '+response.status);}
  const page=await response.json() as {keys:string[];cursor:string|null};
  stagingStatus.lastChecked=new Date().toISOString();
  stagingStatus.moreWaiting=Boolean(page.cursor);
  stagingStatus.error=false;
  workerCursor=page.cursor;
  for(const key of page.keys){
    if(!/^mail\/[0-9a-f-]{36}$/.test(key))continue;
    try {
      const item=await get('/'+key);
      if(item.status===404)continue;
      const to=item.headers.get('x-letterdock-to');
      const from=item.headers.get('x-letterdock-from');
      if(!item.ok||!to||from===null)throw Error('Staging message could not be read');
      const recipient=decodeURIComponent(to);
      const name=recipient.split('@').at(-1)?.toLowerCase();
      const state=await db.query('SELECT verified,removed_at FROM domains WHERE name=$1',[name]);
      if(state.rows[0]&&!state.rows[0].verified&&!state.rows[0].removed_at){await item.body?.cancel();continue;}
      await importMail(key.slice(5),decodeURIComponent(from),recipient,new Uint8Array(await item.arrayBuffer()));
      const deleted=await get('/'+key,'DELETE');
      if(!deleted.ok)throw Error('Staging acknowledgement failed');
    } catch(error){stagingStatus.error=true;console.error('Managed import failed',key,error);}
  }
}

async function pull() {
  if (!s3 || !bucket) return pullManaged();
  const page = await s3.send(new ListObjectsV2Command({
    Bucket: bucket, Prefix: 'mail/', MaxKeys: 25, ContinuationToken: continuation
  }));
  stagingStatus.lastChecked = new Date().toISOString();
  stagingStatus.moreWaiting = Boolean(page.IsTruncated);
  stagingStatus.error = false;
  continuation = page.NextContinuationToken;
  for (const entry of page.Contents ?? []) {
    const key = entry.Key!;
    try {
      const item = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!item.Body || !item.Metadata?.to || item.Metadata.from === undefined) throw Error('Missing envelope');
      await importMail(key.slice(5), item.Metadata.from, item.Metadata.to, await item.Body.transformToByteArray());
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) { stagingStatus.error = true; console.error('Import failed', key, error); }
  }
}

export async function parseNext() {
  const client = await db.connect();
  let id: string | undefined;
  try {
    await client.query('BEGIN');
    const { rows: [message] } = await client.query("SELECT id, raw FROM messages WHERE state='pending' ORDER BY received LIMIT 1 FOR UPDATE SKIP LOCKED");
    if (!message) { await client.query('COMMIT'); return false; }
    id = message.id;
    const parsed = await simpleParser(message.raw, { skipImageLinks: true });
    const html = parsed.html ? sanitize(parsed.html, {
      allowedTags: sanitize.defaults.allowedTags.concat(['img']),
      allowedAttributes: { a: ['href'], img: ['alt'] }
    }) : '';
    await client.query("UPDATE messages SET subject=$2, body=$3, html=$4, headers=$5, message_id=$6, state='ready', error=NULL WHERE id=$1",
      [id, parsed.subject ?? '', parsed.text ?? '', html, JSON.stringify(Object.fromEntries(parsed.headers)), parsed.messageId ?? null]);
    for (const attachment of parsed.attachments) {
      await client.query('INSERT INTO attachments(message,filename,mime,data) VALUES($1,$2,$3,$4)',
        [id, attachment.filename ?? 'attachment', attachment.contentType, attachment.content]);
    }
    await client.query(`INSERT INTO deliveries(hook,message)
      SELECT h.id,m.id FROM hooks h JOIN messages m ON m.id=$1
      WHERE h.filter='' OR h.filter=m.domain OR h.filter=m.recipient ON CONFLICT DO NOTHING`, [id]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    if (id) await client.query("UPDATE messages SET state='failed', error='MIME processing failed' WHERE id=$1 AND state='pending'", [id]);
    console.error(error);
    return false;
  } finally { client.release(); }
}

const restricted = new BlockList();
for (const [address, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['224.0.0.0',3]] as const) {
  restricted.addSubnet(address, bits);
}

async function post(url: URL, headers: Record<string,string>, body: string) {
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Public HTTPS required');
  const resolved = await lookup(url.hostname, { family: 4 });
  if (restricted.check(resolved.address)) throw Error('Public IPv4 required');
  return new Promise<number>((resolve, reject) => {
    const req = request(url, {
      method: 'POST', headers, family: 4,
      lookup: (_name, _options, callback) => callback(null, resolved.address, 4)
    }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    req.setTimeout(5000, () => req.destroy(Error('Timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function deliver() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [job] } = await client.query(`
      SELECT d.*, h.url,h.secret,m.recipient,m.sender,m.subject,m.received,m.message_id
      FROM deliveries d JOIN hooks h ON h.id=d.hook JOIN messages m ON m.id=d.message
      WHERE d.status='pending' AND d.next_attempt<=now() ORDER BY d.next_attempt LIMIT 1 FOR UPDATE OF d SKIP LOCKED
    `);
    if (job) {
      const attachments = await client.query('SELECT id,filename,mime AS content_type FROM attachments WHERE message=$1', [job.message]);
      const body = JSON.stringify({ type:'email.received', created_at:job.received, data:{
        email_id:job.message, from:job.sender, to:[job.recipient], cc:[], bcc:[],
        subject:job.subject, created_at:job.received, message_id:job.message_id, attachments:attachments.rows
      } });
      const timestamp = String(Math.floor(Date.now()/1000));
      const sig = createHmac('sha256', Buffer.from(job.secret.slice(6), 'base64')).update(job.id+'.'+timestamp+'.'+body).digest('base64');
      let result: string;
      let success = false;
      try {
        const status = await post(new URL(job.url), {
          'content-type':'application/json','svix-id':job.id,'svix-timestamp':timestamp,'svix-signature':'v1,'+sig
        }, body);
        result = 'HTTP '+status;
        success = status >= 200 && status < 300;
      } catch (error) { result = String(error); }
      await client.query('INSERT INTO delivery_log(delivery,result) VALUES($1,$2)', [job.id,result]);
      await client.query(`UPDATE deliveries SET attempts=attempts+1,status=$2,
        next_attempt=now()+make_interval(secs => 60 * power(2, least(attempts, 8))) WHERE id=$1`,
        [job.id, success ? 'delivered' : job.attempts >= 7 ? 'failed' : 'pending']);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function runJobs() {
  await Promise.allSettled([
    pull().catch(error => { stagingStatus.error = true; continuation = undefined; throw error; }),
    (async () => { for (let n=0; n<25 && await parseNext(); n++) { /* drain bounded batch */ } })(),
    deliver(),
    db.query(`UPDATE messages m SET folder='trash' FROM domains d
      WHERE m.domain=d.name AND d.retention_days IS NOT NULL AND m.folder<>'trash'
      AND m.received < now()-make_interval(days => d.retention_days)`)
  ]).then(results => results.forEach(result => {
    if (result.status === 'rejected') console.error('Background job failed', result.reason);
  }));
}
