import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { Resend } from 'resend';
import { signedApplyUrl } from '../src/domain-connect.js';
import { cloudflareToken, connectCloudflare, decryptSecret } from '../src/cloudflare.js';
import { db, migrate } from '../src/db.js';
import { importMail, parseNext } from '../src/jobs.js';

const origin='http://localhost:56314';
const password='integration-secret-password';
const sessionSecret='integration-session-secret-over-32';
process.env.SESSION_SECRET=sessionSecret;
const id=randomUUID();
const domain='inbox.integration.example';
const recipient='bcc+'+id.slice(0,8)+'@'+domain;
const raw=Buffer.from([
  'From: Example <sender@example.net>', 'To: different@example.org', 'Subject: Invoice 42',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test"', '', '--test',
  'Content-Type: text/html', '', '<p>Payment received</p><img src="https://example.net/tracker">',
  '--test', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="receipt.txt"',
  '', 'paid', '--test--', ''
].join('\r\n'));

const signingKeys=generateKeyPairSync('rsa',{modulusLength:2048});
const pem=signingKeys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const apply=new URL(signedApplyUrl('provider.example',domain,id,origin+'/?domainConnect='+domain,pem));
assert.equal(apply.hostname,'dash.cloudflare.com');
assert.equal(apply.searchParams.get('domain'),domain);
assert.equal(apply.searchParams.get('redirect_uri'),origin+'/?domainConnect='+domain);
assert(verify('RSA-SHA256',Buffer.from(apply.search.slice(1).split('&key=')[0]),signingKeys.publicKey,
  Buffer.from(apply.searchParams.get('sig')!,'base64')));

await migrate();
const legacyWebhook='whsec_'+Buffer.alloc(32,3).toString('base64');
const legacyHookId=randomUUID();
await db.query('INSERT INTO hooks(id,url,secret,filter) VALUES($1,$2,$3,$4)',
  [legacyHookId,'https://example.net',legacyWebhook,'unused.integration.example']);
const server=spawn(process.execPath,['--import','tsx','src/server.ts'],{
  env:{...process.env,ADMIN_PASSWORD:password,SESSION_SECRET:sessionSecret,PUBLIC_URL:'',APP_PORT:'56314',PORT:'56314'},
  stdio:'ignore'
});
try {
  await db.query('INSERT INTO domains(name,verified) VALUES($1,true) ON CONFLICT(name) DO UPDATE SET verified=true',[domain]);
  await importMail(id,'sender@example.net',recipient,raw);
  await importMail(id,'sender@example.net',recipient,raw);
  await parseNext();
  for(let i=0;i<50;i++){
    try { if((await fetch(origin)).ok)break; }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const login=await fetch(origin+'/api/login',{
    method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})
  });
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const headers={cookie,origin,'content-type':'application/json'};
  const preflight=await fetch(origin+'/api/domains/'+domain+'/cloudflare',{headers}).then(response=>response.json());
  assert.equal(preflight.ready,false);
  assert.match(preflight.message,/uses another DNS provider/);
  const refused=await fetch(origin+'/api/domains/'+domain+'/cloudflare',{method:'POST',headers,body:'{}'});
  assert.equal(refused.status,409);
  const unsignedApply=await fetch(origin+'/api/cloudflare/oauth/apply',{method:'POST',headers,body:JSON.stringify({name:domain})});
  assert.equal(unsignedApply.status,403);
  const manual='billing+'+id.slice(0,8);
  const createAddress=()=>fetch(origin+'/api/inboxes',{method:'POST',headers,body:JSON.stringify({local:manual,domain,name:'Billing'})});
  assert.equal((await createAddress()).status,201);
  assert.equal((await createAddress()).status,409);
  assert.equal((await fetch(origin+'/api/inboxes',{method:'POST',headers,body:JSON.stringify({local:'bad..name',domain})})).status,400);
  const inboxes=await fetch(origin+'/api/inboxes',{headers}).then(response=>response.json());
  assert.equal(inboxes.filter((row:{address:string})=>row.address===recipient).length,1);
  const record=await fetch(origin+'/api/messages/'+id,{headers}).then(response=>response.json());
  assert.equal(record.recipient,recipient);
  assert.equal(record.subject,'Invoice 42');
  assert(!record.html.includes('tracker'));
  assert.equal(record.attachments.length,1);
  const mutation=await fetch(origin+'/api/messages',{method:'PATCH',headers,body:JSON.stringify({ids:[id],label:'Paid',starred:true})});
  assert.equal(mutation.status,200);
  const found=await fetch(origin+'/api/messages?label=Paid&starred=true&q=Invoice',{headers}).then(response=>response.json());
  assert(found.some((row:{id:string})=>row.id===id));
  const unscoped=await fetch(origin+'/api/keys',{method:'POST',headers,body:JSON.stringify({name:'unscoped'})});
  assert.equal(unscoped.status,400);
  const key=await fetch(origin+'/api/keys',{method:'POST',headers,body:JSON.stringify({name:'integration test '+id,domain})}).then(response=>response.json());
  const sdk=new Resend(key.secret,{baseUrl:origin});
  const email=await sdk.emails.receiving.get(id);
  assert.equal(email.data?.id,id,JSON.stringify(email.error));
  const attachments=await sdk.emails.receiving.attachments.list({emailId:id});
  assert.equal(attachments.data?.data[0]?.filename,'receipt.txt',JSON.stringify(attachments.error));
  const attachment=await sdk.emails.receiving.attachments.get({emailId:id,id:record.attachments[0].id});
  assert(attachment.data?.download_url,JSON.stringify(attachment.error));
  assert.equal((await fetch(attachment.data.download_url).then(response=>response.text())).trim(),'paid');
  await db.query("UPDATE messages SET folder='trash' WHERE id=$1",[id]);
  try {
    assert.equal((await sdk.emails.receiving.get(id)).data,null);
    assert.equal((await sdk.emails.receiving.attachments.get({emailId:id,id:record.attachments[0].id})).data,null);
    assert.equal((await fetch(attachment.data.download_url)).status,404);
  } finally {
    await db.query("UPDATE messages SET folder='inbox' WHERE id=$1",[id]);
  }
  const scopedDomain='other.integration.example';
  await db.query('INSERT INTO domains(name,verified) VALUES($1,true) ON CONFLICT(name) DO NOTHING',[scopedDomain]);
  const otherKey=await fetch(origin+'/api/keys',{method:'POST',headers,body:JSON.stringify({name:'other domain',domain:scopedDomain})}).then(r=>r.json());
  const otherSdk=new Resend(otherKey.secret,{baseUrl:origin});
  assert.equal((await otherSdk.emails.receiving.get(id)).data,null);
  assert.deepEqual((await otherSdk.emails.receiving.attachments.list({emailId:id})).data?.data,[]);
  const storedHook=await db.query('SELECT secret FROM hooks WHERE id=$1',[legacyHookId]);
  assert.notEqual(storedHook.rows[0].secret,legacyWebhook);
  assert.equal(decryptSecret(storedHook.rows[0].secret,'webhook'),legacyWebhook);
  const oversized=randomUUID();
  await importMail(oversized,'sender@example.net',recipient,new Uint8Array(20*1024**2+1));
  assert.equal((await db.query('SELECT status FROM ingest_log WHERE id=$1',[oversized])).rows[0].status,'message_too_large');
  const pruneDomain='prune-'+id+'.integration.example';
  await db.query('INSERT INTO domains(name,verified) VALUES($1,true)',[pruneDomain]);
  const oldMail=randomUUID(), freshMail=randomUUID(), unrelatedMail=randomUUID();
  await db.query(`INSERT INTO messages(id,domain,recipient,sender,raw,received,folder,state) VALUES
    ($1,$4,'old@'||$4,'sender@example.net',$6,now()-interval '31 days','trash','ready'),
    ($2,$4,'fresh@'||$4,'sender@example.net',$6,now(),'inbox','ready'),
    ($3,$5,'old@'||$5,'sender@example.net',$6,now()-interval '31 days','archive','ready')`,
    [oldMail,freshMail,unrelatedMail,pruneDomain,scopedDomain,raw]);
  await db.query("INSERT INTO attachments(message,filename,mime,data) VALUES($1,'fixture.txt','text/plain',$2)",[oldMail,raw]);
  const savePrune=(days:unknown)=>fetch(origin+'/api/domains/'+pruneDomain+'/auto-prune',{
    method:'PATCH',headers,body:JSON.stringify({days})
  });
  try {
    assert.equal((await savePrune(0)).status,400);
    assert.equal((await savePrune(30)).status,200);
    assert.equal((await fetch(origin+'/api/domains',{headers}).then(r=>r.json())).find((d:{name:string})=>d.name===pruneDomain).prune_days,30);
    for(let attempt=0;attempt<70;attempt++){
      if(!(await db.query('SELECT 1 FROM messages WHERE id=$1',[oldMail])).rowCount)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal((await db.query('SELECT 1 FROM messages WHERE id=$1',[oldMail])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM attachments WHERE message=$1',[oldMail])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM messages WHERE id IN ($1,$2)',[freshMail,unrelatedMail])).rowCount,2);
    assert.equal((await savePrune(null)).status,200);
  } finally {
    await db.query('DELETE FROM messages WHERE id IN ($1,$2,$3)',[oldMail,freshMail,unrelatedMail]);
    await db.query('DELETE FROM domains WHERE name=$1',[pruneDomain]);
  }
  const browser=await chromium.launch();
  try {
    for(const size of [{width:1440,height:900},{width:390,height:844}]){
      const page=await browser.newPage({viewport:size});
      await page.goto(origin);
      await page.getByLabel('Admin password').fill(password);
      await page.getByRole('button',{name:'Sign in'}).click();
      await page.getByRole('textbox',{name:'Search messages'}).fill(recipient);
      await page.getByRole('button',{name:/Invoice 42/}).first().click();
      await page.getByRole('heading',{name:'Invoice 42'}).waitFor();
      await page.getByRole('button',{name:'Headers'}).click();
      await page.getByText(/different@example.org/).first().waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(size.width<700)await page.getByRole('button',{name:'Back to messages'}).click();
      if(size.width<700)await page.getByRole('button',{name:'Open menu'}).click();
      await page.getByRole('button',{name:'Addresses',exact:true}).click();
      await page.getByRole('heading',{name:'Addresses',exact:true}).waitFor();
      await page.getByRole('searchbox',{name:'Find an address'}).fill(manual);
      const addressCard=page.getByText(manual+'@'+domain,{exact:true}).locator('xpath=ancestor::article[1]');
      await addressCard.getByRole('button',{name:'Pin',exact:true}).click();
      await addressCard.getByRole('button',{name:'Unpin',exact:true}).waitFor();
      await addressCard.getByRole('button',{name:'Unpin',exact:true}).click();
      await addressCard.getByRole('button',{name:'Open inbox'}).click();
      await page.getByRole('heading',{name:manual+'@'+domain,exact:true}).waitFor();
      if(size.width<700)await page.getByRole('button',{name:'Open menu'}).click();
      await page.getByRole('button',{name:'Domains',exact:true}).click();
      await page.getByRole('heading',{name:'Domains',exact:true}).waitFor();
      await page.getByRole('heading',{name:'DNS records'}).first().waitFor();
      const card=page.getByRole('heading',{name:domain,exact:true}).locator('xpath=ancestor::section[1]');
      await card.getByRole('button',{name:'Set up domain'}).click();
      await card.getByText(/uses another DNS provider/).waitFor();
      await card.locator('details[open]').waitFor();
      const off=card.getByText('Auto-prune · Off',{exact:true});
      await off.click();
      await card.getByRole('spinbutton',{name:'Delete email older than (days)'}).fill('3650');
      await card.getByRole('button',{name:'Review schedule'}).click();
      const pruneDialog=page.getByRole('dialog',{name:'Enable auto-prune?'});
      await pruneDialog.getByRole('button',{name:'Cancel'}).click();
      await off.waitFor();
      await card.getByRole('button',{name:'Review schedule'}).click();
      await pruneDialog.getByRole('button',{name:'Confirm auto-prune'}).click();
      await card.getByText('Auto-prune · After 3650 days',{exact:true}).waitFor();
      await card.getByRole('button',{name:'Turn off'}).click();
      await off.waitFor();
      if(size.width===390){
        await page.getByRole('button',{name:'Remove '+domain}).click();
        await page.getByRole('dialog').getByRole('button',{name:'Remove domain'}).click();
        await page.getByText('Domain removed',{exact:true}).waitFor();
        assert.equal(await page.getByRole('button',{name:'Remove '+domain}).count(),0);
      }
      await page.close();
    }
  } finally { await browser.close(); }
  assert.equal((await sdk.emails.receiving.get(id)).data?.id,id);
  await db.query("UPDATE domains SET retention_days=1 WHERE name=$1",[domain]);
  await db.query("UPDATE messages SET received=now()-interval '2 days' WHERE id=$1",[id]);
  try {
    assert.equal((await sdk.emails.receiving.get(id)).data,null);
    assert.equal((await fetch(attachment.data.download_url)).status,404);
  } finally {
    await db.query("UPDATE domains SET retention_days=NULL WHERE name=$1",[domain]);
    await db.query("UPDATE messages SET received=now() WHERE id=$1",[id]);
  }
  const integrations=await fetch(origin+'/api/integrations',{headers}).then(r=>r.json());
  const scopedKey=integrations.keys.find((item:{name:string;domain:string})=>item.name==='integration test '+id);
  assert(scopedKey);
  assert.equal((await fetch(origin+'/api/integrations/key/'+scopedKey.id,{method:'DELETE',headers:{cookie,origin}})).status,200);
  assert.equal((await fetch(attachment.data.download_url)).status,404);
  const ignored=randomUUID();
  await importMail(ignored,'sender@example.net',recipient,raw);
  const rejection=await db.query('SELECT status FROM ingest_log WHERE id=$1',[ignored]);
  assert.equal(rejection.rows[0].status,'unknown_domain');
  const readded=await fetch(origin+'/api/domains',{method:'POST',headers,body:JSON.stringify({name:domain})});
  assert.equal(readded.status,200);
  const restored=await db.query('SELECT verified,removed_at FROM domains WHERE name=$1',[domain]);
  assert.deepEqual(restored.rows[0],{verified:false,removed_at:null});
  const testToken='cloudflare_test_token_123456789';
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (input,options)=>{
    assert.equal(input,'https://api.cloudflare.com/client/v4/zones?per_page=5');
    assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+testToken);
    return Response.json({success:true,result:[{id:'test-zone',status:'active'}]});
  };
  try {await connectCloudflare(testToken);} finally {globalThis.fetch=originalFetch;}
  assert.equal(await cloudflareToken(),testToken);
  const encoded=await db.query("SELECT value FROM settings WHERE key='cloudflare_token'");
  assert(!encoded.rows[0].value.includes(testToken));
  const status=await fetch(origin+'/api/cloudflare',{headers}).then(response=>response.json());
  assert.equal(status.configured,true);
  assert(!JSON.stringify(status).includes(testToken));
  const disconnect=await fetch(origin+'/api/cloudflare',{method:'DELETE',headers:{cookie,origin}});
  assert.equal(disconnect.status,200);
  assert.equal(await cloudflareToken(),undefined);
  console.log('Passed: desktop/mobile navigation, login, search, reader and domain view');
  console.log('Passed: auto-prune policy, scheduled cleanup, attachment cascade, domain isolation, and confirmation UI');
  console.log('Passed: catch-all, duplicate ingest, BCC, sanitization, labels/search, SDK and attachment download');
} finally {
  server.kill();
  await db.query('DELETE FROM hooks WHERE id=$1',[legacyHookId]);
  await db.end();
}
