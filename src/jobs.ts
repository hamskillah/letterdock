import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { storage } from './storage.js';
import { statfs } from 'node:fs/promises';
import { request } from 'node:https';
import { BlockList } from 'node:net';
import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import sanitize from 'sanitize-html';
import { managedIngress } from './cloudflare-ingress.js';
import { decryptSecret } from './cloudflare.js';
import { db } from './db.js';
import { trashRetentionDays } from './trash-policy.js';

const bucket = process.env.R2_BUCKET;
const s3 = bucket ? new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT }) : null;

const maxMessageBytes = 20 * 1024 ** 2;
function positiveLimit(name: string, fallback: number) {
  const limit = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error(name+' must be a positive integer');
  return limit;
}
const dailyDomainBytes = positiveLimit('INBOUND_DOMAIN_DAILY_BYTES', 512 * 1024 ** 2);
const maxDatabaseBytes = positiveLimit('INBOUND_DATABASE_BYTES', 10 * 1024 ** 3);
const minFreeBytes = positiveLimit('INBOUND_MIN_FREE_BYTES', 1024 ** 3);

export async function importMail(id: string, from: string, to: string, raw: Uint8Array) {
  const recipient = to.toLowerCase();
  const domain = recipient.slice(recipient.lastIndexOf('@') + 1);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('letterdock-ingest'))");
    const disk = await statfs(process.env.DISK_PATH || '.');

    // Hybrid storage: stream raw MIME to blob storage
    const rawKey = 'messages/raw/' + id + '.eml';
    const rawBuf = Buffer.from(raw);
    const storedRaw = await storage.put(rawKey, rawBuf, { contentType: 'message/rfc822' });

    const {rows:[outcome]} = await client.query(`
      WITH pending AS (
        SELECT coalesce(sum(coalesce(raw_size_bytes, octet_length(raw))),0) * 3 AS promised FROM messages WHERE state='pending'
      ), decision AS (
        SELECT CASE WHEN NOT EXISTS (SELECT FROM domains WHERE name=$2 AND verified AND removed_at IS NULL) THEN 'unknown_domain'
          WHEN EXISTS (SELECT FROM blocks WHERE sender=lower($3)) THEN 'blocked'
          WHEN $6::bigint > $7 THEN 'message_too_large'
          WHEN $6::bigint + (SELECT coalesce(sum(bytes),0) FROM ingest_log
            WHERE domain=$2 AND status='stored' AND time >= now()-interval '24 hours') > $8 THEN 'domain_quota'
          WHEN pg_database_size(current_database()) + promised + $6::bigint*4 > $9
            OR $10::bigint-promised-$6::bigint*4 < $11 THEN 'storage_quota'
          ELSE 'stored' END AS status FROM pending
      ), logged AS (
        INSERT INTO ingest_log(id,recipient,status,domain,bytes) SELECT $1,$4,status,$2,$6 FROM decision
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,time=now()
          WHERE ingest_log.status IN ('storage_quota','domain_quota') RETURNING status
      ), stored AS (
        INSERT INTO messages(id,domain,sender,recipient,raw,raw_storage_key,raw_checksum_sha256,raw_size_bytes)
        SELECT $1,$2,$3,$4,$5,$12,$13,$14 FROM logged WHERE status='stored' RETURNING recipient
      ), updated AS (
        UPDATE domains SET last_received=now() WHERE name=$2 AND EXISTS (SELECT FROM stored)
      ), inbox AS (
        INSERT INTO inboxes(address) SELECT recipient FROM stored
        ON CONFLICT(address) DO UPDATE SET removed_at=NULL WHERE inboxes.removed_at IS NOT NULL
      )
      SELECT status FROM logged
    `, [id,domain,from,recipient,raw.byteLength<=maxMessageBytes?rawBuf:null,raw.byteLength,
      maxMessageBytes,dailyDomainBytes,maxDatabaseBytes,disk.bavail*disk.bsize,minFreeBytes,
      storedRaw.key, storedRaw.sha256, storedRaw.size]);
    await client.query('COMMIT');
    return outcome?.status !== 'storage_quota' && outcome?.status !== 'domain_quota';
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export const stagingStatus = {
  configured: Boolean(s3 && bucket),
  lastChecked: null as string | null,
  moreWaiting: false,
  error: false
};
let continuation: string | undefined;
let workerCursor: string | null = null;

async function waitingForVerification(recipient:string) {
  const name=recipient.slice(recipient.lastIndexOf('@')+1).toLowerCase();
  const {rows:[domain]}=await db.query('SELECT verified,removed_at FROM domains WHERE name=$1',[name]);
  return Boolean(domain&&!domain.verified&&!domain.removed_at);
}

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
      if(await waitingForVerification(recipient)){await item.body?.cancel();continue;}
      if (!await importMail(key.slice(5),decodeURIComponent(from),recipient,new Uint8Array(await item.arrayBuffer()))) {
        stagingStatus.error=true;
        continue;
      }
      const deleted=await get('/'+key,'DELETE');
      if(!deleted.ok)throw Error('Staging acknowledgement failed');
    } catch(error){stagingStatus.error=true;console.error('Managed import failed',key,error);}
  }
}

async function pull() {
  if (!s3 || !bucket) return pullManaged();
  const page = await s3.send(new ListObjectsV2Command({
    Bucket: bucket, Prefix: 'mail/', MaxKeys: 25, ContinuationToken: continuation
  }),{abortSignal:AbortSignal.timeout(20000)});
  stagingStatus.lastChecked = new Date().toISOString();
  stagingStatus.moreWaiting = Boolean(page.IsTruncated);
  stagingStatus.error = false;
  continuation = page.NextContinuationToken;
  for (const entry of page.Contents ?? []) {
    const key = entry.Key!;
    try {
      const item = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }),{abortSignal:AbortSignal.timeout(20000)});
      if (!item.Body || !item.Metadata?.to || item.Metadata.from === undefined) throw Error('Missing envelope');
      if(await waitingForVerification(item.Metadata.to)){await item.Body.transformToWebStream().cancel();continue;}
      if (!await importMail(key.slice(5), item.Metadata.from, item.Metadata.to, await item.Body.transformToByteArray())) {
        stagingStatus.error=true;
        continue;
      }
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }),{abortSignal:AbortSignal.timeout(20000)});
    } catch (error) { stagingStatus.error = true; console.error('Import failed', key, error); }
  }
}

export async function parseNext() {
  const client = await db.connect();
  let id: string | undefined;
  try {
    await client.query('BEGIN');
    const { rows: [message] } = await client.query("SELECT id, raw, raw_storage_key FROM messages WHERE state='pending' ORDER BY received LIMIT 1 FOR UPDATE SKIP LOCKED");
    if (!message) { await client.query('COMMIT'); return false; }
    id = message.id;

    // Dual-read raw MIME: check blob storage first, fallback to PostgreSQL bytea
    let rawMime: Buffer | null = null;
    if (message.raw_storage_key) {
      const blob = await storage.get(message.raw_storage_key);
      if (blob) rawMime = blob.data;
    }
    if (!rawMime && message.raw) {
      rawMime = Buffer.isBuffer(message.raw) ? message.raw : Buffer.from(message.raw);
    }
    if (!rawMime) {
      throw new Error('Raw email MIME payload missing for message: ' + id);
    }

    const parsed = await simpleParser(rawMime, { skipImageLinks: true });
    const html = parsed.html ? sanitize(parsed.html, {
      allowedTags: sanitize.defaults.allowedTags.concat(['img']),
      allowedAttributes: { a: ['href'], img: ['alt'] }
    }) : '';
    await client.query("UPDATE messages SET subject=$2, body=$3, html=$4, headers=$5, message_id=$6, state='ready', error=NULL WHERE id=$1",
      [id, parsed.subject ?? '', parsed.text ?? '', html, JSON.stringify(Object.fromEntries(parsed.headers)), parsed.messageId ?? null]);
    for (const attachment of parsed.attachments) {
      const attId = randomUUID();
      const safeName = (attachment.filename ?? 'attachment')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .replace(/\.{2,}/g, '_');
      const attKey = 'attachments/' + id + '/' + attId + '-' + safeName;
      const attBuf = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content);
      const stored = await storage.put(attKey, attBuf, { contentType: attachment.contentType });

      await client.query('INSERT INTO attachments(id,message,filename,mime,data,storage_key,checksum_sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [attId, id, attachment.filename ?? 'attachment', attachment.contentType, attBuf, stored.key, stored.sha256, stored.size]);
    }
    await client.query(`UPDATE domains d SET delivery_verified_at=m.received
      FROM messages m WHERE m.id=$1 AND d.name=m.domain AND d.removed_at IS NULL
      AND d.verified AND d.delivery_test_address=m.recipient AND d.delivery_verified_at IS NULL
      AND m.received BETWEEN d.delivery_test_expires - interval '30 minutes' AND d.delivery_test_expires`, [id]);
    await client.query(`
      WITH rule AS (
        SELECT m.id,m.domain,m.recipient,i.auto_label,i.webhook_id
        FROM messages m LEFT JOIN inboxes i ON i.address=m.recipient WHERE m.id=$1
      ), labeled AS (
        UPDATE messages m SET labels=array_append(m.labels,r.auto_label)
        FROM rule r WHERE m.id=r.id AND r.auto_label IS NOT NULL AND NOT (r.auto_label=ANY(m.labels))
      )
      INSERT INTO deliveries(hook,message)
      SELECT h.id,r.id FROM hooks h CROSS JOIN rule r
      WHERE (h.address_only AND h.id=r.webhook_id)
         OR (NOT h.address_only AND h.filter IN ('',r.domain,r.recipient))
      FOR KEY SHARE OF h
      ON CONFLICT DO NOTHING`, [id]);
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
  const controller=new AbortController();
  const {signal}=controller;
  const timer=setTimeout(()=>controller.abort(new Error('Webhook deadline exceeded')),10000);
  try {
    return await new Promise<number>((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      void lookup(url.hostname,{family:4}).then(resolved=>{
        signal.throwIfAborted();
        if(restricted.check(resolved.address))throw Error('Public IPv4 required');
        const req=request(url,{
          method:'POST',headers,family:4,signal,
          lookup:(_name,_options,callback)=>callback(null,resolved.address,4)
        },response=>{
          response.destroy();
          resolve(response.statusCode??0);
        });
        req.on('error',reject);
        req.end(body);
      }).catch(reject);
    });
  } finally {clearTimeout(timer);}
}

export async function deliver() {
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
      const sig = createHmac('sha256', Buffer.from(decryptSecret(job.secret,'webhook').slice(6), 'base64')).update(job.id+'.'+timestamp+'.'+body).digest('base64');
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

async function applyRetention() {
  await db.query(`
    WITH expired AS (
      SELECT id FROM messages
      WHERE folder='trash' AND trashed_at<=now()-($1 * interval '24 hours')
      ORDER BY trashed_at,id
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM messages m USING expired WHERE m.id=expired.id
  `,[trashRetentionDays]);
  await db.query(`
    WITH eligible AS (
      SELECT m.id FROM messages m JOIN domains d ON d.name=m.domain
      WHERE d.removed_at IS NULL AND d.prune_days IS NOT NULL
        AND m.received < now()-make_interval(days => d.prune_days)
      ORDER BY m.received, m.id
      LIMIT 100
      FOR SHARE OF d SKIP LOCKED
      FOR UPDATE OF m SKIP LOCKED
    )
    DELETE FROM messages m USING eligible WHERE m.id=eligible.id
  `);
  await db.query(`UPDATE messages m SET folder='trash',trashed_at=now() FROM domains d
    WHERE m.domain=d.name AND d.removed_at IS NULL AND d.retention_days IS NOT NULL
    AND m.folder<>'trash' AND NOT m.retention_exempt
    AND m.received < now()-make_interval(days => d.retention_days)`);
}

export async function runJobs() {
  await Promise.allSettled([
    pull().catch(error => { stagingStatus.error = true; continuation = undefined; workerCursor = null; throw error; }),
    (async () => { for (let n=0; n<25 && await parseNext(); n++) { /* drain bounded batch */ } })(),
    migrateLegacyStorage(10),
    db.query("DELETE FROM ingest_log WHERE time < now()-interval '30 days' AND status <> 'stored'"),
    db.query("DELETE FROM sessions WHERE expires_at < now()"),
    db.query(`DELETE FROM deliveries WHERE id IN (
      SELECT id FROM deliveries WHERE message_removed_at<now()-interval '30 days' LIMIT 100
    )`),
    applyRetention()
  ]).then(results => results.forEach(result => {
    if (result.status === 'rejected') console.error('Background job failed', result.reason);
  }));
}

export async function migrateLegacyStorage(limit = 50): Promise<{ migratedAttachments: number, migratedMessages: number }> {
  let migratedAttachments = 0;
  let migratedMessages = 0;

  // 1. Migrate attachments where storage_key IS NULL and data IS NOT NULL
  const { rows: atts } = await db.query(
    'SELECT id, message, filename, mime, data FROM attachments WHERE storage_key IS NULL AND data IS NOT NULL LIMIT $1',
    [limit]
  );
  for (const att of atts) {
    const safeName = (att.filename ?? 'attachment')
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .replace(/\.{2,}/g, '_');
    const attKey = 'attachments/' + att.message + '/' + att.id + '-' + safeName;
    const attBuf = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data);
    const stored = await storage.put(attKey, attBuf, { contentType: att.mime });
    await db.query(
      'UPDATE attachments SET storage_key=$1, checksum_sha256=$2, size_bytes=$3 WHERE id=$4',
      [stored.key, stored.sha256, stored.size, att.id]
    );
    migratedAttachments++;
  }

  // 2. Migrate messages where raw_storage_key IS NULL and raw IS NOT NULL
  const { rows: msgs } = await db.query(
    'SELECT id, raw FROM messages WHERE raw_storage_key IS NULL AND raw IS NOT NULL LIMIT $1',
    [limit]
  );
  for (const msg of msgs) {
    const rawKey = 'messages/raw/' + msg.id + '.eml';
    const rawBuf = Buffer.isBuffer(msg.raw) ? msg.raw : Buffer.from(msg.raw);
    const stored = await storage.put(rawKey, rawBuf, { contentType: 'message/rfc822' });
    await db.query(
      'UPDATE messages SET raw_storage_key=$1, raw_checksum_sha256=$2, raw_size_bytes=$3 WHERE id=$4',
      [stored.key, stored.sha256, stored.size, msg.id]
    );
    migratedMessages++;
  }

  return { migratedAttachments, migratedMessages };
}

