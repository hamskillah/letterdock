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
let addressHookId:string|undefined;
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
  const addressHookUrl='https://127.0.0.1/'+id;
  const createRuleHook=await fetch(origin+'/api/hooks',{method:'POST',headers,
    body:JSON.stringify({url:addressHookUrl,addressOnly:true})});
  assert.equal(createRuleHook.status,200);
  const ruleHooks=await fetch(origin+'/api/inbox-rule-hooks',{headers}).then(response=>response.json());
  addressHookId=ruleHooks.find((hook:{url:string})=>hook.url===addressHookUrl)?.id;
  assert(addressHookId);
  assert(!ruleHooks.some((hook:{id:string})=>hook.id===legacyHookId));
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
  const expiredTrash=randomUUID(), existingTrash=randomUUID(), retentionMail=randomUUID();
  const trashDomain='trash-'+id+'.integration.example';
  await db.query('INSERT INTO domains(name,verified,retention_days) VALUES($1,true,7)',[trashDomain]);
  try {
    await db.query(`INSERT INTO messages(id,domain,recipient,sender,raw,received,folder,state,trashed_at) VALUES
      ($1,$4,'expired@'||$4,'sender@example.net',$5,now()-interval '60 days','trash','ready',now()-interval '31 days'),
      ($2,$4,'legacy@'||$4,'sender@example.net',$5,now()-interval '60 days','trash','ready',NULL),
      ($3,$4,'retention@'||$4,'sender@example.net',$5,now()-interval '60 days','inbox','ready',NULL)`,
      [expiredTrash,existingTrash,retentionMail,trashDomain,raw]);
    await db.query("INSERT INTO attachments(message,filename,mime,data) VALUES($1,'fixture.txt','text/plain',$2)",[expiredTrash,raw]);
    await migrate();
    for(let attempt=0;attempt<70;attempt++){
      const progress=await db.query("SELECT id FROM messages WHERE id=$1 OR (id=$2 AND folder<>'trash')",[expiredTrash,retentionMail]);
      if(!progress.rowCount)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal((await db.query('SELECT 1 FROM messages WHERE id=$1',[expiredTrash])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM attachments WHERE message=$1',[expiredTrash])).rowCount,0);
    assert.equal((await db.query(`SELECT id FROM messages WHERE id=ANY($1::uuid[]) AND folder='trash'
      AND trashed_at>now()-interval '1 hour'`,[[existingTrash,retentionMail]])).rowCount,2);
  } finally {
    await db.query('DELETE FROM messages WHERE domain=$1',[trashDomain]);
    await db.query('DELETE FROM domains WHERE name=$1',[trashDomain]);
  }
  const bulkSubject='bulkfixture'+id.replaceAll('-','');
  const browser=await chromium.launch();
  try {
    for(const size of [{width:1440,height:900},{width:1024,height:800},{width:768,height:850},{width:390,height:844}]){
      if(size.width===390)await db.query('UPDATE messages SET unread=true WHERE id=$1',[id]);
      const page=await browser.newPage({viewport:size,hasTouch:size.width===390});
      await page.goto(origin);
      await page.getByLabel('Admin password').fill(password);
      await page.getByRole('button',{name:'Sign in'}).click();
      const searchBox=page.getByRole('textbox',{name:'Search messages'});
      await searchBox.waitFor();
      assert.equal(await page.locator('.sidebar .brand-mark').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0),true);
      if(size.width===1440){
        await page.locator('body').click({position:{x:720,y:25}});
        await page.keyboard.press('/');
        assert.equal(await searchBox.evaluate(element=>element===document.activeElement),true);
        await searchBox.fill('nonexistent fixture');
        await page.getByRole('button',{name:'Clear search',exact:true}).click();
        assert.equal(await searchBox.inputValue(),'');
        await db.query(`INSERT INTO messages(id,domain,recipient,sender,raw,subject,state)
          SELECT gen_random_uuid(),$1,$2,'sender@example.net',$3,$4,'ready'
          FROM generate_series(1,101)`,[domain,recipient,raw,bulkSubject]);
        await searchBox.fill(bulkSubject);
        const selectAll=page.getByRole('checkbox',{name:'Select all',exact:true});
        const rows=page.locator('.message-row input[type="checkbox"]');
        const bulkRows=page.getByRole('button',{name:new RegExp(bulkSubject)});
        await bulkRows.nth(99).waitFor();
        assert.equal(await rows.count(),0);
        await page.getByRole('button',{name:'Load older messages'}).click();
        await bulkRows.nth(100).waitFor();
        await bulkRows.first().click({delay:550});
        await rows.first().waitFor();
        assert.equal(await rows.first().isChecked(),true);
        assert.equal(await selectAll.evaluate((input:HTMLInputElement)=>input.indeterminate),true);
        await selectAll.check();
        assert.equal(await page.locator('.message-row input:checked').count(),await rows.count());
        await selectAll.click();
        assert.equal(await page.locator('.message-row input:checked').count(),0);
        assert.equal(await rows.count(),0);
        await bulkRows.first().press('Shift+Enter');
        await selectAll.check();
        await page.locator('.bulk-toolbar').getByRole('button',{name:'Trash',exact:true}).click();
        const bulkTrash=page.getByRole('dialog',{name:'Move 101 messages to Trash?'});
        await bulkTrash.getByRole('button',{name:'Cancel'}).click();
        await page.getByRole('button',{name:'Mark read',exact:true}).click();
        await page.getByText('101 selected',{exact:true}).waitFor({state:'hidden'});
        assert.equal((await db.query('SELECT 1 FROM messages WHERE subject=$1 AND unread',[bulkSubject])).rowCount,0);
        await db.query('DELETE FROM messages WHERE subject=$1',[bulkSubject]);
      }
      await searchBox.fill(recipient);
      const mailRow=page.getByRole('button',{name:/Invoice 42/}).first();
      await mailRow.waitFor();
      if(size.width===1440||size.width===390)await mailRow.locator('.unread-dot').waitFor();
      if(size.width===390){
        await page.locator('.mobile-unread-dot').waitFor();
        const client=await page.context().newCDPSession(page);
        const bounds=(await mailRow.boundingBox())!;
        await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}]});
        await page.getByRole('checkbox',{name:'Select all',exact:true}).waitFor();
        await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        const checked=page.locator('.message-row input:checked');
        assert.equal(await checked.count(),1);
        await checked.click();
        await checked.waitFor({state:'detached'});
        await client.detach();
      }
      const badge=page.locator('.inbox-badge');
      const unreadBefore=size.width===1440?await badge.textContent():null;
      await mailRow.click();
      await page.getByRole('heading',{name:'Invoice 42'}).waitFor();
      await mailRow.locator('.unread-dot').waitFor({state:'hidden'});
      if(unreadBefore==='1')await badge.waitFor({state:'hidden'});
      else if(unreadBefore&&unreadBefore!=='99+'){
        await page.waitForFunction(count=>document.querySelector('.inbox-badge')?.textContent===count,
          String(Number(unreadBefore)-1));
      }
      await page.getByRole('button',{name:'Headers'}).click();
      await page.getByText(/different@example.org/).first().waitFor();
      if(size.width===1440){
        const trashButton=page.getByRole('region',{name:'Message reader'}).getByRole('button',{name:'Trash',exact:true});
        await trashButton.click();
        const prompt=page.getByRole('dialog',{name:'Move message to Trash?'});
        assert.match(await prompt.innerText(),/30 days/);
        await prompt.getByRole('button',{name:'Cancel'}).click();
        assert.equal((await db.query('SELECT folder FROM messages WHERE id=$1',[id])).rows[0].folder,'inbox');
        await trashButton.click();
        await prompt.getByRole('button',{name:'Move to Trash'}).click();
        await mailRow.waitFor({state:'detached'});
        const trashed=await db.query('SELECT folder,trashed_at FROM messages WHERE id=$1',[id]);
        assert.equal(trashed.rows[0].folder,'trash');
        assert(trashed.rows[0].trashed_at);
        await fetch(origin+'/api/messages',{method:'PATCH',headers,body:JSON.stringify({ids:[id],folder:'trash'})});
        assert.deepEqual((await db.query('SELECT trashed_at FROM messages WHERE id=$1',[id])).rows[0].trashed_at,trashed.rows[0].trashed_at);
        await fetch(origin+'/api/messages',{method:'PATCH',headers,body:JSON.stringify({ids:[id],folder:'inbox'})});
        assert.equal((await db.query('SELECT trashed_at FROM messages WHERE id=$1',[id])).rows[0].trashed_at,null);
      }

      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if(size.width<=860)await page.getByRole('button',{name:'Back to messages'}).click();
      if(size.width===1440){
        await page.getByRole('button',{name:'Integrations',exact:true}).click();
        const scope=page.getByLabel('Receive events from');
        await scope.selectOption('filter');
        await page.getByLabel('Domain or address',{exact:true}).waitFor();
        await scope.selectOption('selected');
        assert.equal(await page.getByLabel('Domain or address',{exact:true}).count(),0);
        await page.getByText('Assign this webhook from the settings of each address.').waitFor();
      }
      if(size.width<=860)await page.getByRole('button',{name:'Open menu'}).click();
      await page.getByRole('button',{name:'Addresses',exact:true}).click();
      await page.getByRole('heading',{name:'Addresses',exact:true}).waitFor();
      if(size.width===390){
        const removeLocal='remove+'+id.slice(0,8);
        const removeAddress=removeLocal+'@'+domain;
        const oldId=randomUUID();
        await importMail(oldId,'sender@example.net',removeAddress,raw);
        await parseNext();
        await page.getByRole('button',{name:'Open menu'}).click();
        await page.getByRole('button',{name:'Addresses',exact:true}).click();
        await page.getByRole('searchbox',{name:'Find an address'}).fill(removeLocal);
        const row=page.getByRole('heading',{name:removeAddress,exact:true}).locator('xpath=ancestor::article[1]');
        await row.getByRole('button',{name:'Settings',exact:true}).click();
        await row.getByRole('button',{name:'Remove address'}).click();
        const dialog=page.getByRole('dialog',{name:'Remove address?'});
        await dialog.getByRole('button',{name:'Cancel'}).click();
        await row.getByRole('button',{name:'Remove address'}).click();
        await dialog.getByRole('button',{name:'Remove address'}).click();
        await page.getByText('Address removed',{exact:true}).waitFor();
        await row.waitFor({state:'detached'});
        assert.equal((await fetch(origin+'/api/messages/'+oldId,{headers})).status,200);
        await importMail(randomUUID(),'sender@example.net',removeAddress,raw);
        const recreated=await fetch(origin+'/api/inboxes',{headers}).then(response=>response.json());
        assert.equal(recreated.find((inbox:{address:string})=>inbox.address===removeAddress).removed_at,null);
      }
      await page.getByRole('searchbox',{name:'Find an address'}).fill(manual);
      const addressCard=page.getByText(manual+'@'+domain,{exact:true}).locator('xpath=ancestor::article[1]');
      if(size.width===1440){
        const address=manual+'@'+domain;
        const invalidRule=await fetch(origin+'/api/inbox-rules',{method:'PATCH',headers,
          body:JSON.stringify({address,label:'Invoices',webhookId:legacyHookId})});
        assert.equal(invalidRule.status,422);
        await addressCard.getByRole('button',{name:'Settings',exact:true}).click();
        await addressCard.getByLabel('Display name').fill('Accounts payable');
        await addressCard.getByLabel('Automatic label').fill('Invoices');
        await addressCard.getByLabel('Webhook for new mail').selectOption(addressHookId);
        await addressCard.getByRole('button',{name:'Save settings'}).click();
        await addressCard.getByText('Auto-label: Invoices · Webhook assigned',{exact:true}).waitFor();
        await addressCard.getByRole('heading',{name:'Accounts payable'}).waitFor();
        const ruleMailId=randomUUID();
        await importMail(ruleMailId,'sender@example.net',address,raw);
        await parseNext();
        const applied=await db.query('SELECT labels FROM messages WHERE id=$1',[ruleMailId]);
        assert.deepEqual(applied.rows[0]?.labels,['Invoices']);
        const routed=await db.query('SELECT message FROM deliveries WHERE hook=$1',[addressHookId]);
        assert.deepEqual(routed.rows,[{message:ruleMailId}]);
      }
      if(size.width===390){
        await addressCard.getByRole('button',{name:'Settings',exact:true}).click();
        assert.equal(await addressCard.getByLabel('Display name').inputValue(),'Accounts payable');
        assert.equal(await addressCard.getByLabel('Automatic label').inputValue(),'Invoices');
        assert.equal(await addressCard.getByLabel('Webhook for new mail').inputValue(),addressHookId);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await addressCard.getByRole('button',{name:'Cancel',exact:true}).click();
      }
      await addressCard.getByRole('button',{name:'Pin',exact:true}).click();
      await addressCard.getByRole('button',{name:'Unpin',exact:true}).waitFor();
      await addressCard.getByRole('button',{name:'Unpin',exact:true}).click();
      await addressCard.getByRole('button',{name:'Open inbox'}).click();
      await page.getByRole('heading',{name:manual+'@'+domain,exact:true}).waitFor();
      if(size.width<=860)await page.getByRole('button',{name:'Open menu'}).click();
      await page.getByRole('button',{name:'Domains',exact:true}).click();
      await page.getByRole('heading',{name:'Domains',exact:true}).waitFor();
      await page.getByRole('heading',{name:'DNS records'}).first().waitFor();
      const card=page.getByRole('heading',{name:domain,exact:true}).locator('xpath=ancestor::section[1]');
      if(size.width===1440){
        await card.getByRole('button',{name:/Start (delivery|new) test/}).click();
        await card.getByText('Waiting for test email',{exact:true}).waitFor();
        const path=origin+'/api/domains/'+domain+'/delivery-health';
        assert.equal((await fetch(path)).status,401);
        const pending=await fetch(path,{headers}).then(response=>response.json());
        assert.equal(pending.delivery_verified_at,null);
        assert.match(pending.delivery_test_address,/^ld-[a-f0-9]{16}@/);
        const testId=randomUUID();
        await importMail(testId,'sender@example.net',pending.delivery_test_address,raw);
        await parseNext();
        await card.getByText(/^Test email verified/).waitFor({timeout:12000});
        const confirmed=await fetch(path,{headers}).then(response=>response.json());
        assert(confirmed.delivery_verified_at);
        assert.equal((await db.query('SELECT 1 FROM deliveries WHERE hook=$1 AND message=$2',[addressHookId,testId])).rowCount,0);
        assert.equal(confirmed.activity.find((event:{id:string})=>event.id===testId)?.status,'ready');
        await card.getByText('Recent delivery activity',{exact:true}).click();
        await card.getByText('In inbox',{exact:true}).first().waitFor();
      }

      await card.getByRole('button',{name:'Check DNS'}).click();
      await card.getByText(/uses another DNS provider/).waitFor();
      await card.getByText('Advanced settings',{exact:true}).click();
      await card.getByRole('button',{name:'Re-run setup'}).click();
      await card.getByRole('button',{name:'Verify DNS',exact:true}).waitFor();
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
  } finally {
    await browser.close();
    await db.query('DELETE FROM messages WHERE subject=$1',[bulkSubject]);
  }
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
  const removal=await fetch(origin+'/api/integrations/hook/'+addressHookId,{method:'DELETE',headers:{cookie,origin}});
  assert.equal(removal.status,200);
  const savedRule=await db.query('SELECT auto_label,webhook_id FROM inboxes WHERE address=$1',[manual+'@'+domain]);
  assert.deepEqual(savedRule.rows[0],{auto_label:'Invoices',webhook_id:null});
  console.log('Passed: exact-recipient rules, automatic labels, webhook queue and rule cleanup');
  const resetHealth=await fetch(origin+'/api/domains/'+domain+'/delivery-health',{headers}).then(response=>response.json());
  assert.equal(resetHealth.delivery_test_address,null);
  assert.equal(resetHealth.delivery_verified_at,null);
  console.log('Passed: delivery test, parsed receipt, activity, and reset on removal');
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
  await db.query('DELETE FROM hooks WHERE id=ANY($1::uuid[])',[[legacyHookId,...(addressHookId?[addressHookId]:[])]]);
  await db.end();
}
