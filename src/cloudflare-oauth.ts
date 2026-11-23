import { createHash, randomBytes } from 'node:crypto';
import { readCredential, saveCredential } from './cloudflare.js';

const issuer = 'https://mcp.cloudflare.com';
const resource = issuer + '/mcp';
const scopes = [
  'account:read', 'zone.read', 'dns.read', 'dns.write', 'zone-settings.read', 'zone-settings.write',
  'email-routing-rule.read', 'email-routing-rule.write', 'workers-scripts.read', 'workers-scripts.write',
  'workers-r2.read', 'workers-r2.write', 'offline_access'
];

export type OAuthState = { client: string; state: string; verifier: string; redirect: string; expires: number; domain?: string };
type Credential = { client: string; access: string; refresh?: string; expires: number; scopes?: string[] };

async function post(path: string, body: string | URLSearchParams, type: string) {
  const response = await fetch(issuer + path, {
    method: 'POST', headers: { 'Content-Type': type }, body,
    redirect: 'error', signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Cloudflare OAuth returned HTTP ' + response.status);
  return response.json();
}

export async function startOAuth(redirect: string, domain?: string) {
  const registration = await post('/register', JSON.stringify({
    client_name: 'Letterdock', redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'
  }), 'application/json');
  if (typeof registration.client_id !== 'string') throw new Error('Cloudflare did not register the client');

  const pending: OAuthState = {
    client: registration.client_id, state: randomBytes(24).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'), redirect, expires: Date.now() + 600000, domain
  };
  const url = new URL('/authorize', issuer);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: pending.client, redirect_uri: redirect, state: pending.state,
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    code_challenge_method: 'S256', scope: scopes.join(' '), resource
  }).toString();
  return { pending, url: url.href };
}

async function exchange(client: string, values: Record<string,string>, previous?: Credential) {
  const result = await post('/token', new URLSearchParams({
    client_id: client, resource, ...values
  }), 'application/x-www-form-urlencoded');
  if (typeof result.access_token !== 'string') throw new Error('Missing Cloudflare access token');
  return {
    client, access: result.access_token, refresh: result.refresh_token || previous?.refresh,
    scopes: typeof result.scope==='string' ? result.scope.split(' ') : previous?.scopes,
    expires: Date.now() + (Number(result.expires_in) || 3600)*1000
  } satisfies Credential;
}

export async function completeOAuth(pending: OAuthState, code: string) {
  const credential = await exchange(pending.client,{
    grant_type: 'authorization_code', redirect_uri: pending.redirect, code_verifier: pending.verifier, code
  });
  await execute(credential.access, {method:'GET',path:'/zones',query:{per_page:'5'}});
  await saveCredential('cloudflare_oauth', JSON.stringify(credential));
}

let refreshing: Promise<Credential> | undefined;
async function activeCredential() {
  const value = await readCredential('cloudflare_oauth');
  if (!value) throw new Error('Connect Cloudflare first');
  const saved = JSON.parse(value) as Credential;
  if (saved.expires > Date.now() + 60000) return saved;
  if (!saved.refresh) throw new Error('Cloudflare authorization expired. Reconnect Cloudflare.');
  refreshing ??= exchange(saved.client, { grant_type:'refresh_token', refresh_token:saved.refresh },saved)
    .then(async credential => {
      if (await readCredential('cloudflare_oauth') === value) await saveCredential('cloudflare_oauth',JSON.stringify(credential));
      return credential;
    }).finally(() => { refreshing = undefined; });
  return refreshing;
}

type RequestInput = { method: string; path: string; query?: Record<string,string>; body?: unknown };
function resultEnvelope(input: unknown): { success?: boolean; result?: unknown } {
  if (Array.isArray(input)) {
    const first = input.find(item => item?.type === 'text' && typeof item.text === 'string');
    if (first) return JSON.parse(first.text);
  }
  return input as { success?: boolean; result?: unknown };
}

async function execute(accessToken: string, input: RequestInput, upload?: {script: string; metadata: object}) {
  const request = upload
    ? 'async () => { const upload='+JSON.stringify(upload)+';const body=new FormData();body.append(\'metadata\',new Blob([JSON.stringify(upload.metadata)],{type:\'application/json\'}));body.append(\'worker.js\',new Blob([upload.script],{type:\'application/javascript+module\'}),\'worker.js\');return cloudflare.request({...'+JSON.stringify(input)+',body}); }'
    : 'async () => cloudflare.request('+JSON.stringify(input)+')';
  const response = await fetch(resource, {
    method:'POST', headers:{
      Authorization:'Bearer '+accessToken, 'Content-Type':'application/json', Accept:'application/json, text/event-stream'
    },
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{
      name:'execute', arguments:{code:request}
    }}), redirect:'error', signal:AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Cloudflare connection failed (HTTP '+response.status+'). Reconnect Cloudflare.');
  const raw = await response.text();
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? raw.split('\n').find(line => line.startsWith('data: '))?.slice(6)
    : raw;
  if (!json) throw new Error('Cloudflare did not return a response');
  const packet = JSON.parse(json);
  if (packet.error || packet.result?.isError) {
    const reported = JSON.stringify(packet.result?.content ?? packet.error);
    const status = reported.match(/(?:401|403|404|409|5\d\d)/)?.[0];
    throw new Error(status ? 'Cloudflare action returned HTTP '+status : 'Cloudflare denied the action. Check the connection permissions.');
  }
  const data = resultEnvelope(packet.result?.structuredContent ?? packet.result?.content);
  if (!data?.success) throw new Error('Cloudflare could not complete the request.');
  return data.result;
}

export async function mcpRequest<T>(path: string, method = 'GET', body?: unknown) {
  const url = new URL(path,'https://api.cloudflare.com');
  const {access} = await activeCredential();
  return await execute(access,{method,path:url.pathname,query:Object.fromEntries(url.searchParams),body}) as T;
}

export async function uploadWorker(path: string, script: string, metadata: object) {
  const {access}=await activeCredential();
  return execute(access,{method:'PUT',path},{script,metadata});
}

export async function oauthCapabilities() {
  const value = await readCredential('cloudflare_oauth');
  if(!value)return false;
  const granted=(JSON.parse(value) as Credential).scopes??[];
  return ['workers-scripts.write','workers-r2.write'].every(scope=>granted.includes(scope));
}
