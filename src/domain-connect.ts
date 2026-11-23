import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveTxt } from 'node:dns/promises';

const providerApi = 'https://api.cloudflare.com/client/v4/dns/domainconnect';
const providerUi = 'https://dash.cloudflare.com/domainconnect';
const templatePath = (providerId: string) => '/v2/domainTemplates/providers/' + encodeURIComponent(providerId) + '/services/letterdock-verification';
const keyLabel = '_dck1';

export function signedApplyUrl(providerId: string, domain: string, verification: string, redirect: string, pem: string) {
  const query = [
    ['domain', domain], ['redirect_uri', redirect], ['verification', verification]
  ].map(([name,value]) => name + '=' + encodeURIComponent(value)).join('&');
  const signature = sign('RSA-SHA256', Buffer.from(query), createPrivateKey(pem)).toString('base64');
  return providerUi + templatePath(providerId) + '/apply?' + query + '&key=' + keyLabel + '&sig=' + encodeURIComponent(signature);
}

export async function domainConnectLink(domain: string, verification: string) {
  const keyFile = process.env.DOMAIN_CONNECT_KEY_FILE;
  const origin = process.env.PUBLIC_URL;
  const providerId = process.env.DOMAIN_CONNECT_PROVIDER_ID;
  if (!keyFile || !origin || !providerId) return { available:false, message:'Cloudflare authorization is pending provider setup.' } as const;
  const discovery = await resolveTxt('_domainconnect.' + domain).catch(error => {
    if (['ENODATA','ENOTFOUND'].includes(error?.code)) return [];
    throw error;
  });
  if (!discovery.some(record => record.join('').replace(/^https:\/\//,'').replace(/\/$/,'') === providerApi.slice(8))) {
    return { available:false, message:'This domain does not advertise Cloudflare Domain Connect.' } as const;
  }
  const response = await fetch(providerApi + templatePath(providerId) + '?domain=' + encodeURIComponent(domain), {
    redirect:'error', signal:AbortSignal.timeout(8000)
  });
  if (response.status === 404) return { available:false, message:'Cloudflare has not activated the Letterdock template for this domain.' } as const;
  if (!response.ok) throw new Error('Domain Connect template lookup failed');
  const redirect = new URL('/', origin);
  redirect.searchParams.set('domainConnect', domain);
  return { available:true, url:signedApplyUrl(providerId, domain, verification, redirect.href, await readFile(keyFile,'utf8')) } as const;
}
