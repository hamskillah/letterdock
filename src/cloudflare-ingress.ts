import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readCredential, saveCredential, SetupConflict } from './cloudflare.js';
import { mcpRequest, uploadWorker } from './cloudflare-oauth.js';

type Ingress = { account: string; worker: string; bucket: string; secret: string; url?: string };
const key = 'cloudflare_ingress';

export async function managedIngress() {
  const value=await readCredential(key);
  return value ? JSON.parse(value) as Ingress : undefined;
}

let provisioning: Promise<Ingress> | undefined;

export async function provisionIngress(account: string) {
  if(provisioning) throw new SetupConflict('Cloudflare setup is already running. Try again shortly.');
  provisioning=provision(account);
  try {return await provisioning;}
  finally {provisioning=undefined;}
}

async function provision(account: string) {
  let ingress=await managedIngress();
  if(ingress && ingress.account!==account) throw new SetupConflict('This Letterdock installation is connected to a different Cloudflare account.');
  if(ingress?.url)return ingress;
  if(!ingress){
    const worker='letterdock-'+randomBytes(8).toString('hex');
    ingress={account,worker,bucket:worker+'-staging',secret:randomBytes(32).toString('base64url')};
    await saveCredential(key,JSON.stringify(ingress));
  }
  const base='/accounts/'+account;
  const existing=await mcpRequest<{buckets:{name:string}[]}>(base+'/r2/buckets?name_contains='+ingress.bucket);
  if(!existing.buckets.some(item=>item.name===ingress!.bucket))await mcpRequest(base+'/r2/buckets','POST',{name:ingress.bucket});
  let subdomain=await mcpRequest<{subdomain?:string}>(base+'/workers/subdomain').catch((error:Error)=>{
    if(error.message.includes('HTTP 404'))return {subdomain:undefined};
    throw error;
  });
  if(!subdomain.subdomain)subdomain=await mcpRequest(base+'/workers/subdomain','PUT',{subdomain:ingress.worker});
  if(!subdomain.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain))throw new Error('Cloudflare did not return a valid Workers subdomain.');
  const path=base+'/workers/scripts/'+ingress.worker;
  const script=await readFile('cloudflare/worker.js','utf8');
  await uploadWorker(path,script,{
    main_module:'worker.js',compatibility_date:'2026-11-23',
    bindings:[{type:'r2_bucket',name:'STAGING',bucket_name:ingress.bucket},
      {type:'secret_text',name:'PULL_SECRET',text:ingress.secret}]
  });
  await mcpRequest(path+'/subdomain','POST',{enabled:true,previews_enabled:false});
  const url='https://'+ingress.worker+'.'+subdomain.subdomain+'.workers.dev';
  let ready=false;
  for(let attempt=0;attempt<6&&!ready;attempt++){
    if(attempt)await new Promise(resolve=>setTimeout(resolve,1500));
    const response=await fetch(url+'/mail',{headers:{Authorization:'Bearer '+ingress.secret},redirect:'error',signal:AbortSignal.timeout(5000)}).catch(()=>undefined);
    ready=response?.ok===true;
    await response?.body?.cancel();
  }
  if(!ready)throw new SetupConflict('The Cloudflare Worker is still starting. Retry setup shortly.');
  ingress.url=url;
  await saveCredential(key,JSON.stringify(ingress));
  return ingress;
}
