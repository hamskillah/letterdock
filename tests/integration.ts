import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { Resend } from 'resend';
import { cloudflareToken, connectCloudflare } from '../src/cloudflare.js';
import { db, migrate } from '../src/db.js';
import { importMail, parseNext } from '../src/jobs.js';

const origin='http://127.0.0.1:56314';
const password='integration-secret-password';
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

await migrate();
const server=spawn(process.execPath,['--import','tsx','src/server.ts'],{
  env:{...process.env,ADMIN_PASSWORD:password,SESSION_SECRET:'integration-session-secret-over-32',PUBLIC_URL:origin,PORT:'56314'},
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
  assert.match(preflight.message,/requires a server-side Cloudflare token/);
  const refused=await fetch(origin+'/api/domains/'+domain+'/cloudflare',{method:'POST',headers,body:'{}'});
  assert.equal(refused.status,409);
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
  const key=await fetch(origin+'/api/keys',{method:'POST',headers,body:JSON.stringify({name:'integration test'})}).then(response=>response.json());
  const sdk=new Resend(key.secret,{baseUrl:origin});
  const email=await sdk.emails.receiving.get(id);
  assert.equal(email.data?.id,id,JSON.stringify(email.error));
  const attachments=await sdk.emails.receiving.attachments.list({emailId:id});
  assert.equal(attachments.data?.data[0]?.filename,'receipt.txt',JSON.stringify(attachments.error));
  const attachment=await sdk.emails.receiving.attachments.get({emailId:id,id:record.attachments[0].id});
  assert(attachment.data?.download_url,JSON.stringify(attachment.error));
  assert.equal((await fetch(attachment.data.download_url).then(response=>response.text())).trim(),'paid');
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
      await page.getByRole('button',{name:'Domains',exact:true}).click();
      await page.getByRole('heading',{name:'Domains',exact:true}).waitFor();
      await page.getByRole('heading',{name:'DNS records'}).first().waitFor();
      if(size.width===390){
        await page.getByRole('button',{name:'Remove '+domain}).click();
        await page.getByRole('dialog').getByRole('button',{name:'Remove domain'}).click();
        await page.getByText('Domain removed',{exact:true}).waitFor();
        assert.equal(await page.getByRole('button',{name:'Remove '+domain}).count(),0);
      }
      await page.close();
    }
  } finally { await browser.close(); }
  const retained=await sdk.emails.receiving.get(id);
  assert.equal(retained.data?.id,id);
  const ignored=randomUUID();
  await importMail(ignored,'sender@example.net',recipient,raw);
  const rejection=await db.query('SELECT status FROM ingest_log WHERE id=$1',[ignored]);
  assert.equal(rejection.rows[0].status,'unknown_domain');
  const readded=await fetch(origin+'/api/domains',{method:'POST',headers,body:JSON.stringify({name:domain})});
  assert.equal(readded.status,200);
  const restored=await db.query('SELECT verified,removed_at FROM domains WHERE name=$1',[domain]);
  assert.deepEqual(restored.rows[0],{verified:false,removed_at:null});
  process.env.SESSION_SECRET='integration-session-secret-over-32';
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
  console.log('Passed: catch-all, duplicate ingest, BCC, sanitization, labels/search, SDK and attachment download');
} finally {
  server.kill();
  await db.end();
}
