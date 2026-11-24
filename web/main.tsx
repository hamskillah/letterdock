import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, ArrowLeft, ArrowDownToLine, ArrowUpRight, Boxes, ChevronLeft, ChevronRight, CircleGauge, Copy, Filter, Globe, Inbox, LogOut, Mail, Menu, Paperclip, Search, Settings2, Star, Trash2, X } from 'lucide-react';
import './style.css';

type Message = {id:string;recipient:string;sender:string;subject:string;received:string;unread:boolean;starred:boolean;folder:string;labels:string[];state:string};
type Detail = Message & {body:string;html:string;headers:Record<string,unknown>;error:string;attachments:{id:string;filename:string;mime:string;bytes:number}[]};
type Domain = {name:string;token:string;verified:boolean;last_received:string|null;retention_days:number|null;prune_days:number|null} & DeliveryTest;
type CloudflareConnection = {canProvision:boolean;oauthConnected:boolean;configured:boolean;fromEnvironment:boolean;workerConfigured:boolean;stagingConfigured:boolean};
type CloudflareStatus = {detected:boolean;ready:boolean;message:string;applied?:boolean;dns:{nameservers:string[];mx:string[];txtVerified:boolean}};
type Address = {address:string;name:string;pinned:boolean;unread:number;auto_label:string|null;webhook_id:string|null};
type Integration = {keys:{id:string;name:string;domain:string|null}[];hooks:{id:string;url:string;filter:string;address_only:boolean}[];deliveries:{id:string;url:string;status:string;result:string;attempted:string}[]};
type Health = {free:number;staging:{configured:boolean;lastChecked:string|null;moreWaiting:boolean;error:boolean};queues:{state:string;count:number;oldest:string}[];ingest:{id:string;recipient:string;status:string;time:string}[];deliveries:{status:string;count:number}[]};

class AccessError extends Error {}
async function api<T>(path:string, method='GET', data?:unknown): Promise<T> {
  const response=await fetch('/api'+path,{method,headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const result=await response.json().catch(()=>null);
  if(response.status===401) throw new AccessError(result?.message ?? 'Sign in required');
  if(!response.ok) throw Error(result?.message ?? 'Request failed. Try again.');
  return result as T;
}
const when=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const returningDomain = new URLSearchParams(location.search).get('domainConnect');
const cloudflareReturn = new URLSearchParams(location.search).get('cloudflare');
const setupDomain = new URLSearchParams(location.search).get('setupDomain');
const blankFilters={from:'',to:'',subject:'',label:'',since:'',until:'',attachment:''};
const senderName=(value:string)=>value.match(/^(.+?)\s*<[^>]+>$/)?.[1].replace(/^"|"$/g,'')||value||'Unknown sender';
const emailDate=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'});
const logo=<img className="brand-mark" src="/letterdock-mark.svg" width="36" height="36" alt=""/>;

type DeliveryTest = {
  delivery_test_address:string|null;
  delivery_test_expires:string|null;
  delivery_verified_at:string|null;
  test_expired:boolean|null;
};
type DeliveryHealth = DeliveryTest & {
  last_received:string|null;
  staging_error:boolean;
  activity:{id:string;recipient:string;time:string;status:string}[];
};

const inboundStatus:Record<string,string> = {
  ready:'In inbox', pending:'Queued for processing', failed:'MIME processing failed',
  stored:'Previously stored', unknown_domain:'Domain was inactive or unverified',
  blocked:'Sender blocked', message_too_large:'Message exceeds 20 MB',
  domain_quota:'Daily domain quota exceeded', storage_quota:'Storage limit reached. Check Health.'
};

function DeliveryPanel({domain}:{domain:Domain}){
  const [health,setHealth]=useState<DeliveryHealth|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [copied,setCopied]=useState(false);
  const path='/domains/'+encodeURIComponent(domain.name)+'/delivery-health';
  const test=health??domain;
  const address=test.delivery_test_address;
  const pending=Boolean(address&&!test.delivery_verified_at&&!test.test_expired);

  useEffect(()=>{
    if(busy||!pending)return;
    let current=true;
    let timer:number;
    async function check(){
      if(!document.hidden){
        try {
          const result=await api<DeliveryHealth>(path);
          if(current){setHealth(result);setError('');}
        } catch(cause){
          if(current)setError(cause instanceof Error?cause.message:'Could not check delivery.');
        }
      }
      if(current)timer=window.setTimeout(check,5000);
    }
    timer=window.setTimeout(check,5000);
    return ()=>{current=false;window.clearTimeout(timer);};
  },[path,pending,busy]);

  async function load(start=false){
    setBusy(true);setError('');setCopied(false);
    try {
      if(start)await api(path,'POST');
      setHealth(await api<DeliveryHealth>(path));
    }catch(cause){setError(cause instanceof Error?cause.message:'Could not check delivery.');}
    finally{setBusy(false);}
  }

  const verified=test.delivery_verified_at;
  const lastReceived=health?.last_received??domain.last_received;
  const testState=verified?'Test email verified':test.test_expired?'Test expired':pending?'Waiting for test email':'';
  return <section className="dns-panel delivery-panel">
    <div className="dns-heading"><h3>Delivery health</h3><button disabled={busy} onClick={()=>void load()}>{health?'Refresh activity':'Check delivery'}</button></div>
    <p>{lastReceived?'Last received '+when(lastReceived):'No email received yet.'}</p>
    {!domain.verified&&<p>Verify DNS before starting a delivery test.</p>}
    {domain.verified&&!pending&&<button disabled={busy} onClick={()=>void load(true)}>{address?'Start new test':'Start delivery test'}</button>}
    <p role="status">{testState}{verified&&' · '+when(verified)}</p>
    {error&&<p role="alert">{error}</p>}
    {pending&&address&&<>
      <p>Send an email from your usual mail app before {test.delivery_test_expires&&when(test.delivery_test_expires)}. Use any subject.</p>
      <div className="compact"><code>{address}</code>{navigator.clipboard&&<button onClick={async()=>{
        try {await navigator.clipboard.writeText(address);setCopied(true);}
        catch {setError('Select the address and copy it manually.');}
      }}>{copied?'Copied':'Copy address'}</button>}</div>
      <p>Cloudflare must route this address to Letterdock. If the test stays pending, check the catch-all rule and recent activity.</p>
    </>}
    {health?.staging_error&&<p>Staging reported an issue. Check the Health page for details.</p>}
    {health&&<details>
      <summary>Recent delivery activity</summary>
      {health.activity.length?<ul className="delivery-activity">{health.activity.map(event=><li key={event.id}>
        <strong>{inboundStatus[event.status]??event.status}</strong>
        <span>{event.recipient} · {when(event.time)}</span>
      </li>)}</ul>:<p>No activity recorded for this domain.</p>}
    </details>}
  </section>;
}

function App(){
  const [authorized,setAuthorized]=useState<boolean|null>(null);
  const [password,setPassword]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [page,setPage]=useState('Inbox');
  const [folder,setFolder]=useState('inbox');
  const [starOnly,setStarOnly]=useState(false);
  const [unreadOnly,setUnreadOnly]=useState(false);
  const [connection,setConnection]=useState<CloudflareConnection|null>(null);
  const [connecting,setConnecting]=useState(false);
  const [cloudflare,setCloudflare]=useState<Record<string,CloudflareStatus>>({});
  const [manualDomain,setManualDomain]=useState('');
  const [pruning,setPruning]=useState<{name:string;days:number}|null>(null);
  const [removing,setRemoving]=useState<string|null>(null);
  const [domainBusy,setDomainBusy]=useState<Record<string,string>>({});
  const [domains,setDomains]=useState<Domain[]>([]);
  const [addressDomain,setAddressDomain]=useState('');
  const [addressQuery,setAddressQuery]=useState('');
  const [ruleAddress,setRuleAddress]=useState('');
  const [ruleHooks,setRuleHooks]=useState<{id:string;url:string}[]>([]);
  const [webhookScope,setWebhookScope]=useState('all');
  const [addresses,setAddresses]=useState<Address[]>([]);
  const [domain,setDomain]=useState('');
  const [address,setAddress]=useState('');
  const [messages,setMessages]=useState<Message[]>([]);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [loading,setLoading]=useState(false);
  const [query,setQuery]=useState('');
  const [filters,setFilters]=useState(blankFilters);
  const [advanced,setAdvanced]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const [more,setMore]=useState(false);
  const [mobileNav,setMobileNav]=useState(false);
  const searchInput=useRef<HTMLInputElement>(null);
  const menuButton=useRef<HTMLButtonElement>(null);
  const closeMenuButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!mobileNav)return;
    closeMenuButton.current?.focus();
    const media=matchMedia('(max-width: 860px)');
    const onResize=()=>{if(!media.matches)setMobileNav(false);};
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();setMobileNav(false);}
    };
    media.addEventListener('change',onResize);
    document.addEventListener('keydown',onKey);
    return ()=>{
      media.removeEventListener('change',onResize);
      document.removeEventListener('keydown',onKey);
      if(media.matches)requestAnimationFrame(()=>menuButton.current?.focus());
    };
  },[mobileNav]);

  useEffect(()=>{
    if(!authorized||page!=='Inbox'||mobileNav)return;
    const focusSearch=(event:KeyboardEvent)=>{
      if(event.key!=='/'||event.ctrlKey||event.metaKey||event.altKey||
        document.querySelector('dialog[open]')||
        (event.target instanceof HTMLElement&&event.target.closest('input,textarea,select,button,a,[contenteditable]'))||
        !searchInput.current?.getClientRects().length)return;
      event.preventDefault();
      searchInput.current.focus();
    };
    document.addEventListener('keydown',focusSearch);
    return ()=>document.removeEventListener('keydown',focusSearch);
  },[authorized,page,mobileNav]);

  const [view,setView]=useState('Message');
  const [integration,setIntegration]=useState<Integration>();
  const [health,setHealth]=useState<Health>();
  const [blocks,setBlocks]=useState<{sender:string}[]>([]);
  const [credential,setCredential]=useState('');
  const [preview,setPreview]=useState<{name:string;url:string}|null>(null);

  function fail(cause:unknown) {
    if(cause instanceof AccessError) setAuthorized(false);
    setError(cause instanceof Error?cause.message:'Something went wrong');
  }
  async function checkCloudflare(name:string,method='GET'){
    setDomainBusy(previous=>({...previous,[name]:method==='POST'?'Applying setup…':'Checking DNS…'}));
    try {
      const status=await api<CloudflareStatus>('/domains/'+encodeURIComponent(name)+'/cloudflare',method);
      setCloudflare(previous=>({...previous,[name]:{...status,applied:method==='POST'||previous[name]?.applied}}));
      return status;
    } finally {
      setDomainBusy(previous=>({...previous,[name]:''}));
    }
  }
  async function setupDomainFromDashboard(name:string){
    const check=await checkCloudflare(name);
    if(!check.detected){setManualDomain(name);return;}
    if(check.ready){await checkCloudflare(name,'POST');return;}
    if(check.message.startsWith('Connect or reconnect')){
      const {url}=await api<{url:string}>('/cloudflare/oauth/start','POST',{domain:name});
      location.assign(url);
    }
  }
  async function directory(){
    const [registered,inboxes]=await Promise.all([api<Domain[]>('/domains'),api<Address[]>('/inboxes')]);
    setDomains(registered);setAddresses(inboxes);
  }
  function searchPath(cursor=''){
    const params=new URLSearchParams({folder,domain,address,q:query,starred:String(starOnly),unread:String(unreadOnly),cursor,...filters});
    return '/messages?'+params;
  }
  useEffect(()=>{
    directory().then(()=>{setAuthorized(true);if(returningDomain||cloudflareReturn)void navigate('Domains');}).catch(cause=>{
      setAuthorized(false);
      if(!(cause instanceof AccessError))fail(cause);
    });
  },[]);
  useEffect(()=>{
    if(!authorized||page!=='Inbox')return;
    let current=true;
    setLoading(true);
    const timer=setTimeout(()=>{
      api<Message[]>(searchPath()).then(rows=>{
        if(current){setMessages(rows);setMore(rows.length===100);setSelected([]);}
      }).catch(cause=>{if(current)fail(cause);}).finally(()=>{if(current)setLoading(false);});
    },220);
    return ()=>{current=false;clearTimeout(timer);};
  },[authorized,page,folder,domain,address,query,filters,starOnly,unreadOnly]);
  useEffect(()=>{
    if(!authorized||page!=='Inbox')return;
    const timer=setInterval(()=>{
      if(document.hidden)return;
      if(page==='Inbox'&&!selected.length)api<Message[]>(searchPath()).then(rows=>{
        setMessages(current=>current.length>100?current:rows);
        setMore(current=>messages.length>100?current:rows.length===100);
      }).catch(fail);
    },10000);
    return ()=>clearInterval(timer);
  },[authorized,page,folder,domain,address,query,filters,starOnly,unreadOnly,selected.length,messages.length]);

  useEffect(()=>{
    if(!authorized)return;
    let active=true;
    let running=false;
    async function updateUnread(){
      if(document.hidden||running)return;
      running=true;
      try {
        const inboxes=await api<Address[]>('/inboxes');
        if(active)setAddresses(inboxes);
      } catch(cause){
        if(active&&cause instanceof AccessError)fail(cause);
      } finally {running=false;}
    }
    const timer=window.setInterval(updateUnread,10000);
    document.addEventListener('visibilitychange',updateUnread);
    return ()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',updateUnread);};
  },[authorized]);

  useEffect(()=>{
    if(!authorized||page!=='Domains')return;
    const waiting=domains.filter(item=>!item.verified&&cloudflare[item.name]?.applied);
    if(!waiting.length)return;
    let running=false;
    const timer=setInterval(async()=>{
      if(running)return;
      running=true;
      try {
        for(const item of waiting) {
          try { await api('/domains/'+encodeURIComponent(item.name),'POST'); }
          catch(cause) { if(cause instanceof AccessError) { fail(cause); return; } }
        }
        await directory();
      } catch(cause) { fail(cause); }
      finally { running=false; }
    },10000);
    return ()=>clearInterval(timer);
  },[authorized,page,domains,cloudflare]);

  async function refresh(){
    await directory();
    if(page==='Inbox'){
      const rows=await api<Message[]>(searchPath());
      setMessages(rows);setMore(rows.length===100);
    }
    if(page==='Integrations')setIntegration(await api('/integrations'));
    if(page==='Health'){
      const [stats,rules]=await Promise.all([api<Health>('/health'),api<{sender:string}[]>('/blocks')]);
      setHealth(stats);setBlocks(rules);
    }
  }
  async function action(fn:()=>Promise<unknown>, success=''){
    setError('');setNotice('');
    try {await fn();setNotice(success);}catch(cause){fail(cause);}
  }
  async function signIn(event:React.FormEvent){
    event.preventDefault();
    await action(async()=>{await api('/login','POST',{password});await directory();setPassword('');setAuthorized(true);});
  }
  async function navigate(next:string){
    setPage(next);setMobileNav(false);setCredential('');setError('');
    if(next==='Addresses')await action(directory);
    if(next==='Domains')await action(async()=>{
      setConnection(await api<CloudflareConnection>('/cloudflare'));
      if(cloudflareReturn&&new URLSearchParams(location.search).has('cloudflare')){
        history.replaceState(null,'',location.pathname);
        if(cloudflareReturn==='authorization-failed') throw Error('Cloudflare authorization failed or was canceled. Try connecting again.');
        if(setupDomain) {
          const status=await api<CloudflareStatus>('/cloudflare/oauth/apply','POST',{name:setupDomain});
          setCloudflare(previous=>({...previous,[setupDomain]:{...status,applied:true}}));
          setConnection(await api<CloudflareConnection>('/cloudflare'));
        }
      }
      if(returningDomain&&new URLSearchParams(location.search).has('domainConnect')){
        history.replaceState(null,'',location.pathname);
        await checkCloudflare(returningDomain);
      }
      await Promise.allSettled(domains.filter(item=>!cloudflare[item.name]).map(item=>checkCloudflare(item.name)));
    });
    if(next==='Integrations')await action(async()=>setIntegration(await api('/integrations')));
    if(next==='Health')await action(async()=>{
      const [stats,rules]=await Promise.all([api<Health>('/health'),api<{sender:string}[]>('/blocks')]);
      setHealth(stats);setBlocks(rules);
    });
  }
  function mailbox(nextFolder='inbox',nextDomain='',nextAddress='',stars=false){
    setFolder(nextFolder);setDomain(nextDomain);setAddress(nextAddress);setStarOnly(stars);setDetail(null);
    setSelected([]);void navigate('Inbox');
  }
  async function openAddressSettings(name:string){
    setRuleHooks(await api('/inbox-rule-hooks'));
    setRuleAddress(name);
  }
  async function open(message:Message){
    await action(async()=>{
      const result=await api<Detail>('/messages/'+message.id);
      setView('Message');setDetail({...result,unread:false});
      if(message.unread){
        await api('/messages','PATCH',{ids:[message.id],unread:false});
        setMessages(rows=>unreadOnly?rows.filter(row=>row.id!==message.id):rows.map(row=>row.id===message.id?{...row,unread:false}:row));
        setAddresses(await api<Address[]>('/inboxes'));
      }
    });
  }
  async function savePrune(name:string,days:number|null){
    await api('/domains/'+encodeURIComponent(name)+'/auto-prune','PATCH',{days});
    setDomains(rows=>rows.map(item=>item.name===name?{...item,prune_days:days}:item));
  }
  async function update(ids:string[], patch:Record<string,unknown>){
    await action(async()=>{
      await api('/messages','PATCH',{ids,...patch});
      if(detail&&ids.includes(detail.id)){
        if(patch.folder&&patch.folder!==folder)setDetail(null);
        else setDetail(await api('/messages/'+detail.id));
      }
      setSelected([]);await refresh();
    });
  }
  function submit<T>(event:React.FormEvent<HTMLFormElement>, handler:(data:FormData)=>Promise<T>){
    event.preventDefault();
    const form=event.currentTarget;
    const data=new FormData(form);
    void action(async()=>{await handler(data);form.reset();await refresh();});
  }

  if(authorized===null)return <main className="auth"><p role="status">Opening Letterdock…</p></main>;
  if(!authorized)return <main className="auth"><div className="login">{logo}<h1>Letterdock</h1><p>Sign in to your inbound mail workspace.</p>
    <form onSubmit={signIn}><label>Admin password<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="primary">Sign in <ArrowUpRight size={16}/></button></form>
    {error&&<p role="alert" className="error">{error}</p>}</div></main>;

  const matchingAddresses = addresses.filter(item=>(!addressDomain||item.address.endsWith('@'+addressDomain))&&
    (item.name+' '+item.address).toLowerCase().includes(addressQuery.trim().toLowerCase()));
  const messageIndex=detail?messages.findIndex(message=>message.id===detail.id):-1;
  const previous=messageIndex>0?messages[messageIndex-1]:undefined;
  const next=messageIndex>=0?messages[messageIndex+1]:undefined;
  const inboxUnread=addresses.reduce((count,item)=>count+item.unread,0);
  const filtered=Boolean(query.trim()||unreadOnly||Object.values(filters).some(Boolean));
  const heading=address||domain||(starOnly?'Starred':folder==='inbox'?'Inbox':folder==='archive'?'Archive':'Trash');
  return <div className={'app '+(mobileNav?'show-nav ':'')+(detail&&page==='Inbox'?'show-detail':'')}>
    {mobileNav&&<div className="nav-scrim" aria-hidden="true" onClick={()=>setMobileNav(false)}/>}
    <aside className="sidebar" id="workspace-navigation" role={mobileNav?'dialog':undefined} aria-modal={mobileNav||undefined} aria-label="Letterdock navigation">
      <div className="brand">{logo}<span>Letterdock</span><button className="icon mobile" aria-label="Close menu" ref={closeMenuButton} onClick={()=>setMobileNav(false)}><X size={18}/></button></div>
      <nav aria-label="Workspace">
        <span className="nav-caption">Mailbox</span>
        <button className={page==='Inbox'&&heading==='Inbox'?'active':''} onClick={()=>mailbox()}><Inbox size={17}/>Inbox{inboxUnread>0&&<><span className="inbox-badge" aria-hidden="true">{inboxUnread>99?'99+':inboxUnread}</span><span className="sr-only">, {inboxUnread} unread</span></>}</button>
        <button className={page==='Inbox'&&starOnly?'active':''} onClick={()=>mailbox('inbox','','',true)}><Star size={17}/>Starred</button>
        <button className={page==='Inbox'&&folder==='archive'?'active':''} onClick={()=>mailbox('archive')}><Archive size={17}/>Archive</button>
        <button className={page==='Inbox'&&folder==='trash'?'active':''} onClick={()=>mailbox('trash')}><Trash2 size={17}/>Trash</button>
        <button className={page==='Addresses'?'active':''} aria-current={page==='Addresses'?'page':undefined} onClick={()=>void navigate('Addresses')}><Mail size={17}/>Addresses</button>
        <span className="nav-caption">Manage</span>
        {[['Domains',Globe],['Integrations',Boxes],['Health',CircleGauge]].map(([name,Icon])=>{
          const Glyph=Icon as typeof Globe;
          return <button key={String(name)} className={page===name?'active':''} onClick={()=>void navigate(String(name))}><Glyph size={17}/>{String(name)}</button>;
        })}
        {domains.length>0&&<span className="nav-caption">Domains</span>}
        {domains.map(item=><button title={item.name} key={item.name} className={domain===item.name&&page==='Inbox'?'active':''} onClick={()=>mailbox('inbox',item.name)}><span className={'dot '+(item.verified?'online':'')}/><span className="ellipsis">{item.name}</span></button>)}
        {addresses.some(item=>item.pinned)&&<span className="nav-caption">Pinned addresses</span>}
        {addresses.filter(item=>item.pinned).map(item=><button title={item.address} key={item.address} className={address===item.address&&page==='Inbox'?'active':''} onClick={()=>mailbox('inbox','',item.address)}><Mail size={15}/><span className="ellipsis">{item.name||item.address}</span>{item.unread>0&&<span className="address-count">{item.unread}</span>}</button>)}
      </nav>
      <button className="signout" onClick={()=>void action(async()=>{await api('/logout','POST');setAuthorized(false);setDetail(null);setMessages([]);})}><LogOut size={17}/>Sign out</button>
    </aside>
    <main className="workspace" inert={mobileNav||undefined}>
      <header className="topbar"><button className="icon mobile" aria-label="Open menu" aria-controls="workspace-navigation" aria-expanded={mobileNav} ref={menuButton} onClick={()=>setMobileNav(true)}><Menu size={20}/>{inboxUnread>0&&<span className="mobile-unread-dot" aria-hidden="true"/>}</button><span>Workspace</span><ChevronRight size={13} aria-hidden="true"/><strong>{page}</strong><span className="sr-only" role="status">{inboxUnread>0?inboxUnread+' unread inbox messages':'No unread inbox messages'}</span></header>
      {(error||notice)&&<div className={error?'banner error':'banner'} role={error?'alert':'status'}>{error||notice}<button className="icon" aria-label="Dismiss" onClick={()=>{setError('');setNotice('');}}><X size={16}/></button></div>}
      {page==='Inbox'&&<div className="mail-layout">
        <section className="message-list" aria-label="Message list">
          <div className="list-head">
            <div className="list-title"><h1>{heading}</h1></div>
            {address&&<button className="inbox-settings-link" onClick={()=>void action(async()=>{await openAddressSettings(address);setAddressQuery(address);setAddressDomain('');await navigate('Addresses');})}><Settings2 size={14}/> Address settings</button>}
            <div className="search"><Search size={17} aria-hidden="true"/><input ref={searchInput} aria-label="Search messages" aria-keyshortcuts="/" placeholder="Search messages…" value={query} onChange={e=>setQuery(e.target.value)}/>
              {query?<button className="icon" aria-label="Clear search" onClick={()=>{setQuery('');searchInput.current?.focus();}}><X size={15}/></button>:<kbd aria-hidden="true">/</kbd>}
              <button className={'icon '+(advanced?'filter-active':'')} aria-label="Search filters" aria-expanded={advanced} onClick={()=>setAdvanced(!advanced)}><Filter size={17}/></button>
            </div>
            <div className="inbox-scope" aria-label="Read status">
              <button aria-pressed={!unreadOnly} onClick={()=>setUnreadOnly(false)}>All messages</button>
              <button aria-pressed={unreadOnly} onClick={()=>setUnreadOnly(true)}>Unread</button>
            </div>
            {advanced&&<div className="filters">{Object.entries(filters).filter(([key])=>key!=='attachment').map(([key,value])=><label key={key}>{key}<input type={['since','until'].includes(key)?'date':'text'} value={value} onChange={e=>setFilters({...filters,[key]:e.target.value})}/></label>)}
              <label className="check"><input type="checkbox" checked={filters.attachment==='true'} onChange={e=>setFilters({...filters,attachment:e.target.checked?'true':''})}/>Has attachment</label>
              <button onClick={()=>{setFilters(blankFilters);setUnreadOnly(false);}}>Clear filters</button>
            </div>}
            {selected.length>0&&<div className="compact"><span>{selected.length} selected</span><button onClick={()=>void update(selected,{folder:folder==='inbox'?'archive':'inbox'})}>{folder==='inbox'?'Archive':'Restore'}</button><button onClick={()=>void update(selected,{unread:false})}>Mark read</button>{folder!=='trash'&&<button onClick={()=>void update(selected,{folder:'trash'})}>Trash</button>}</div>}
          </div>
          <div className="rows">
            {loading?<p className="list-empty" role="status">Loading messages…</p>:messages.length===0?<div className="list-empty"><span><Inbox size={22}/></span><strong>{filtered?'No matching messages':'No messages here'}</strong>{filtered&&<button onClick={()=>{setQuery('');setFilters(blankFilters);setUnreadOnly(false);}}>Clear search and filters</button>}{!filtered&&folder==='inbox'&&!domains.length&&<button onClick={()=>void navigate('Domains')}>Connect a domain <ArrowUpRight size={14}/></button>}</div>:messages.map(message=>
              <div className={'message-row '+(detail?.id===message.id?'chosen ':'')+(message.unread?'unread':'')} key={message.id}>
                <input type="checkbox" aria-label={'Select '+(message.subject||'message')} checked={selected.includes(message.id)} onChange={e=>setSelected(e.target.checked?[...selected,message.id]:selected.filter(id=>id!==message.id))}/>
                <button className="message-link" aria-current={detail?.id===message.id?'true':undefined} onClick={()=>void open(message)}><span className="row-meta"><span className="row-sender"><span className="unread-dot" aria-hidden="true"/>{message.unread&&<span className="sr-only">Unread: </span>}<span className="ellipsis">{senderName(message.sender)}</span></span><time dateTime={message.received}>{emailDate.format(new Date(message.received))}</time></span><strong className="ellipsis">{message.subject||'(No subject)'}</strong><small className="ellipsis">{message.recipient}</small></button>
                <button className={'icon '+(message.starred?'starred':'')} aria-label={message.starred?'Remove star':'Star message'} onClick={()=>void update([message.id],{starred:!message.starred})}><Star size={16} fill={message.starred?'currentColor':'none'}/></button>
              </div>)}
            {more&&<button className="load-more" onClick={()=>void action(async()=>{const rows=await api<Message[]>(searchPath(messages.at(-1)?.id));setMessages([...messages,...rows]);setMore(rows.length===100);})}>Load older messages</button>}
          </div>
        </section>
        <section className="reader" aria-label="Message reader">
          {!detail?<div className="reader-empty"><span><Mail size={26}/></span><h2>Select a message</h2><p>Open an email to read it and view its attachments.</p></div>:
          <article>
            <div className="reader-actions">
              <button className="icon mobile" aria-label="Back to messages" onClick={()=>setDetail(null)}><ArrowLeft size={19}/></button>
              <button onClick={()=>void update([detail.id],{unread:!detail.unread})}>{detail.unread?'Mark read':'Mark unread'}</button>
              <button onClick={()=>void update([detail.id],{folder:detail.folder==='inbox'?'archive':'inbox'})}>{detail.folder==='inbox'?'Archive':'Restore'}</button>
              {detail.folder!=='trash'?<button onClick={()=>void update([detail.id],{folder:'trash'})}>Trash</button>:<button onClick={()=>{if(confirm('Permanently delete this message?'))void action(async()=>{await api('/messages/'+detail.id,'DELETE');setDetail(null);await refresh();});}}>Delete permanently</button>}
              <a className="button" href={'/api/raw/'+detail.id}><ArrowDownToLine size={15}/>.eml</a>
              <div className="reader-navigation" aria-label="Message navigation">
                <button className="icon" aria-label="Previous message" disabled={!previous} onClick={()=>{if(previous)void open(previous);}}><ChevronLeft size={17}/></button>
                <button className="icon" aria-label="Next message" disabled={!next} onClick={()=>{if(next)void open(next);}}><ChevronRight size={17}/></button>
              </div>
            </div>
            <h2 className="subject">{detail.subject||'(No subject)'}</h2>
            <dl className="message-meta"><dt>From</dt><dd>{detail.sender||'Unknown sender'}</dd><dt>Delivered to</dt><dd>{detail.recipient}</dd><dt>Received</dt><dd>{when(detail.received)}</dd></dl>
            <div className="label-list">{detail.labels.map(label=><button key={label} onClick={()=>void update([detail.id],{removeLabel:label})}>{label}<X size={12}/></button>)}
            <form className="compact" onSubmit={e=>{e.preventDefault();const value=new FormData(e.currentTarget).get('label');e.currentTarget.reset();void update([detail.id],{label:value});}}><input name="label" aria-label="New label" placeholder="Add label" required maxLength={60}/><button>Add</button></form></div>
            {detail.attachments.length>0&&<section className="attachments"><h3>Attachments</h3>{detail.attachments.map(item=><div className="file" key={item.id}><Paperclip size={17}/><span className="ellipsis">{item.filename}</span><small>{Math.ceil(item.bytes/1024)} KB</small>{/^image\/(png|jpeg|gif|webp)$/.test(item.mime)&&<button onClick={()=>void action(async()=>{
              const response=await fetch('/api/files/'+item.id);
              if(!response.ok)throw Error('Preview unavailable');
              setPreview({name:item.filename,url:URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:item.mime}))});
            })}>Preview</button>}<a className="button" href={'/api/files/'+item.id}>Download</a></div>)}</section>}
            <div className="tabs" aria-label="Message format">{['Message','Plain text','Headers'].map(tab=><button key={tab} aria-pressed={view===tab} onClick={()=>setView(tab)}>{tab}</button>)}</div>
            {detail.state==='failed'?<div className="error"><p>{detail.error}</p><button onClick={()=>void update([detail.id],{retry:true})}>Retry parsing</button></div>:detail.state==='pending'?<button onClick={()=>void open(detail)}>Refresh processing status</button>:view==='Headers'?<pre>{JSON.stringify(detail.headers,null,2)}</pre>:view==='Plain text'||!detail.html?<pre>{detail.body}</pre>:<iframe title="Email body" sandbox="" referrerPolicy="no-referrer" srcDoc={'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:15px system-ui;line-height:1.65;margin:0;color:#252e29;overflow-wrap:anywhere}table{max-width:100%}</style>'+detail.html}/>}
          </article>}
        </section>
      </div>}
      {page==='Addresses'&&<section className="settings addresses-page">
        <header className="settings-heading"><span className="section-icon"><Mail size={21}/></span><div><h1>Addresses</h1><p>Create an inbox address or manage addresses discovered by catch-all.</p></div></header>
        {domains.some(item=>item.verified)?<form className="address-add" onSubmit={event=>submit(event,data=>api('/inboxes','POST',{
          local:data.get('local'),domain:data.get('domain'),name:data.get('name')
        }))}>
          <label>Address prefix<input name="local" placeholder="billing" required maxLength={64} autoCapitalize="none" spellCheck={false}/></label>
          <label>Receiving domain<select name="domain" required defaultValue={domains.find(item=>item.verified)?.name}>
            {domains.filter(item=>item.verified).map(item=><option key={item.name}>{item.name}</option>)}
          </select></label>
          <label>Name <span className="optional">(optional)</span><input name="name" placeholder="Billing" maxLength={120}/></label>
          <button className="primary">Add address</button>
        </form>:<div className="domain-empty"><h2>Connect a receiving domain</h2><p>Verify a domain before you add addresses.</p><button onClick={()=>void navigate('Domains')}>Open Domains <ArrowUpRight size={14}/></button></div>}
        <div className="address-tools">
          <label>Find an address<input type="search" placeholder="Search by address or name" value={addressQuery} onChange={e=>setAddressQuery(e.target.value)}/></label>
          <label>Domain<select value={addressDomain} onChange={e=>setAddressDomain(e.target.value)}>
            <option value="">All domains</option>
            {[...new Set([...domains.map(item=>item.name),...addresses.map(item=>item.address.split('@').at(-1)!)])].sort().map(item=><option key={item}>{item}</option>)}
          </select></label>
        </div>
        <div className="address-list">
          {matchingAddresses.map(item=><article className="address-row" key={item.address}>
            <div className="address-identity"><Mail size={17}/><div><h2>{item.name||item.address}</h2>{item.name&&<p>{item.address}</p>}
              {(item.auto_label||item.webhook_id)&&<p>{[item.auto_label&&'Auto-label: '+item.auto_label,item.webhook_id&&'Webhook assigned'].filter(Boolean).join(' · ')}</p>}
            </div></div>
            <div className="compact address-actions">
              {item.unread>0&&<span className="address-count">{item.unread} unread</span>}
              <button className="icon" aria-label={item.pinned?'Unpin':'Pin'} title={item.pinned?'Unpin':'Pin'} aria-pressed={item.pinned} onClick={()=>void action(async()=>{
                await api('/inboxes','PATCH',{address:item.address,pinned:!item.pinned});await directory();
              })}><Star size={16} fill={item.pinned?'currentColor':'none'}/></button>
              <button aria-expanded={ruleAddress===item.address} aria-controls={ruleAddress===item.address?'address-settings':undefined} onClick={()=>void action(async()=>{
                if(ruleAddress===item.address){setRuleAddress('');return;}
                await openAddressSettings(item.address);
              })}><Settings2 size={15}/> Settings</button>
              <button onClick={()=>mailbox('inbox','',item.address)}>Open inbox <ArrowUpRight size={14}/></button>
            </div>
            {ruleAddress===item.address&&<form id="address-settings" aria-label={'Settings for '+item.address} className="address-rules" onSubmit={event=>submit(event,async data=>{
              await api('/inbox-rules','PATCH',{address:item.address,name:data.get('name'),label:data.get('label'),webhookId:data.get('webhook')||null});
              setRuleAddress('');
              setNotice('Address settings saved');
            })}>
              <div className="address-settings-fields">
                <label htmlFor="address-name">Display name<input id="address-name" name="name" maxLength={120} defaultValue={item.name}/></label>
                <label htmlFor="rule-label">Automatic label<input id="rule-label" name="label" maxLength={60} defaultValue={item.auto_label??''} placeholder="None"/></label>
                <label htmlFor="rule-webhook">Webhook for new mail<select id="rule-webhook" name="webhook" defaultValue={item.webhook_id??''}>
                  <option value="">None</option>
                  {ruleHooks.map(hook=><option key={hook.id} value={hook.id}>{hook.url}</option>)}
                </select></label>
              </div>
              <div className="address-settings-footer">
                <div className="compact">
                  <button type="button" onClick={()=>void action(()=>navigator.clipboard.writeText(item.address),'Address copied')}><Copy size={14}/> Copy address</button>
                  {ruleHooks.length===0&&<button type="button" onClick={()=>{setWebhookScope('selected');void navigate('Integrations');}}>Set up a webhook <ArrowUpRight size={14}/></button>}
                </div>
                <div className="compact"><button type="button" onClick={()=>setRuleAddress('')}>Cancel</button><button type="submit" className="primary">Save settings</button></div>
              </div>
            </form>}
          </article>)}
          {matchingAddresses.length===0&&
            <p className="empty-state">{addresses.length?'No addresses match these filters.':'No addresses yet. Add one above or receive an email at a new address.'}</p>}
        </div>
      </section>}
      {page==='Domains'&&<section className="settings domains-page">
        <header className="settings-heading"><span className="section-icon"><Globe size={21}/></span><div><h1>Domains</h1><p>Connect domains you own and receive mail at any address.</p></div></header>
        {connection&&<section className="domain-card connection-card" aria-labelledby="cloudflare-connection">
          <div className="domain-title"><div><h2 id="cloudflare-connection">Cloudflare connection</h2>
            <p>Connect once to set up DNS and catch-all from Letterdock.</p></div>
            <span className={'status '+(connection.configured?'ok':'')}>{connection.oauthConnected?'OAuth connected':connection.configured?'Token connected':'Connect required'}</span>
          </div>
          <dl className="connection-checks">
            <div><dt>API access</dt><dd>{connection.configured?'Configured':'Authorize access'}</dd></div>
            <div><dt>Email Worker</dt><dd>{connection.workerConfigured?'Configured':'Deploy Worker'}</dd></div>
            <div><dt>Private R2 staging</dt><dd>{connection.stagingConfigured?'Configured':'Configure R2'}</dd></div>
          </dl>
          <div className="compact">
            <button className="primary" disabled={connecting} onClick={()=>void action(async()=>{
              setConnecting(true);
              try {
                const {url}=await api<{url:string}>('/cloudflare/oauth/start','POST');
                location.assign(url);
              } finally {setConnecting(false);}
            })}>{connection.oauthConnected?'Reconnect Cloudflare':'Connect Cloudflare'} <ArrowUpRight size={15}/></button>
            {connection.oauthConnected&&<button onClick={()=>void action(async()=>{
              setConnection(await api<CloudflareConnection>('/cloudflare','DELETE'));
              setCloudflare({});
            },'Cloudflare disconnected')}>Disconnect</button>}
          </div>
          {!connection.fromEnvironment&&<details>
            <summary>{connection.configured&&!connection.oauthConnected?'Manage API token':'Use API token instead'}</summary>
            <p>Create a token scoped to your inbound zones with Zone Read, DNS Edit, Zone Settings Edit, and Email Routing Rules Edit.</p>
            <a className="button" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Open Cloudflare API Tokens <ArrowUpRight size={14}/></a>
            <form className="settings-form token-form" onSubmit={event=>{
              event.preventDefault();
              const form=event.currentTarget;
              const token=new FormData(form).get('token');
              void action(async()=>{
                setConnecting(true);
                try {
                  setConnection(await api<CloudflareConnection>('/cloudflare','POST',{token}));
                  form.reset();
                  await Promise.allSettled(domains.map(item=>checkCloudflare(item.name)));
                } finally {setConnecting(false);}
              },'Cloudflare connected');
            }}>
              <label>Cloudflare API token<input name="token" type="password" autoComplete="off" required minLength={20} maxLength={256}/></label>
              <button className="primary" disabled={connecting}>{connecting?'Connecting…':connection.configured?'Replace token':'Save connection'}</button>
              {connection.configured&&<button type="button" disabled={connecting} onClick={()=>void action(async()=>{
                setConnection(await api<CloudflareConnection>('/cloudflare','DELETE'));
                setCloudflare({});
              },'Cloudflare disconnected')}>Disconnect</button>}
            </form>
          </details>}
          {(!connection.workerConfigured||!connection.stagingConfigured)&&<p className="setup-hint">Cloudflare domains can provision a Worker and R2 automatically during setup. <a href="https://github.com/hamskillah/letterdock#receive-mail" target="_blank" rel="noreferrer">Deployment guide</a></p>}
        </section>}
        <form className="settings-form domain-add" onSubmit={e=>submit(e,async data=>{
          const {name}=await api<{name:string}>('/domains','POST',{name:data.get('name')});
          await directory();
          await checkCloudflare(name);
        })}><label>Domain name<input name="name" placeholder="example.com" required/></label><button className="primary">Add domain <ArrowUpRight size={15}/></button></form>
        {domains.length===0&&<div className="domain-empty"><Globe size={22}/><h2>No domains connected</h2><p>Add a domain to check its DNS and set up inbound mail.</p></div>}
        {domains.map(item=>{
          const check=cloudflare[item.name];
          const busy=domainBusy[item.name];
          return <section className="domain-card" key={item.name}>
            <div className="domain-title"><div><h2>{item.name}</h2><span className={'status '+(item.verified?'ok':'')}>{item.last_received?'Receiving':item.verified?'DNS verified':'Setup required'}</span></div>
            <button className="icon danger" type="button" aria-label={'Remove '+item.name} onClick={()=>setRemoving(item.name)}><Trash2 size={17}/></button></div>
            <div className="dns-panel">
              <div className="dns-heading"><h3>DNS records</h3><button disabled={Boolean(busy)} onClick={()=>void action(()=>checkCloudflare(item.name))}>Check DNS</button></div>
              {busy&&<p role="status">{busy}</p>}
              {check&&<><p role="status">{check.applied?(item.verified?'DNS verified. Send a test email.':'Waiting for DNS. Letterdock will retry automatically.'):check.message}</p>
              <details className="dns-record-details"><summary>Show record values</summary><dl className="dns-data">
                <dt>Nameservers</dt><dd>{check.detected&&<strong>Cloudflare · </strong>}{check.dns.nameservers.join(', ')||'None found'}</dd>
                <dt>MX</dt><dd>{check.dns.mx.join(', ')||'No MX records found'}</dd>
                <dt>Verification TXT</dt><dd>{check.dns.txtVerified?'Verified':'Pending'}</dd>
              </dl></details></>}
            </div>
            <div className="compact domain-actions">
              {item.verified&&<button onClick={()=>{setAddressDomain(item.name);setAddressQuery('');void navigate('Addresses');}}>Manage addresses <ArrowUpRight size={14}/></button>}
              {check?.detected&&!check.dns.txtVerified&&<button onClick={()=>void action(async()=>{
                const result=await api<{available:boolean;url?:string;message?:string}>('/domains/'+encodeURIComponent(item.name)+'/domain-connect');
                if(!result.available||!result.url)throw Error(result.message||'Cloudflare authorization is unavailable.');
                location.assign(result.url);
              })}>Authorize verification DNS <ArrowUpRight size={14}/></button>}
              {!item.verified&&<button className="primary" disabled={Boolean(busy)||Boolean(check?.applied)} onClick={()=>void action(()=>setupDomainFromDashboard(item.name))}>Set up domain</button>}
            </div>
            <DeliveryPanel domain={item}/>
            <details className="prune-settings">
              <summary>Auto-prune · {item.prune_days===null?'Off':`After ${item.prune_days} days`}</summary>
              <p>Permanently deletes older email and attachments across all folders for this domain.</p>
              <form className="settings-form" onSubmit={event=>{
                event.preventDefault();
                const days=Number(new FormData(event.currentTarget).get('days'));
                if(days!==item.prune_days)setPruning({name:item.name,days});
              }}>
                <label>Delete email older than (days)<input key={item.prune_days??'off'} type="number" name="days" min="1" max="3650" defaultValue={item.prune_days??''} placeholder="30" required/></label>
                <button>Review schedule</button>
                {item.prune_days!==null&&<button type="button" onClick={()=>void action(()=>savePrune(item.name,null),'Auto-prune turned off')}>Turn off</button>}
              </form>
            </details>
            <details open={manualDomain===item.name||undefined}><summary>Advanced settings</summary>
              <ol><li>Add TXT <code>_letterdock.{item.name}</code> with value <code>letterdock={item.token}</code>.</li><li>Configure an inbound route with your DNS and mail provider. This installation can verify Cloudflare Email Routing MX records.</li><li>Verify DNS, then send a test email.</li></ol>
              <div className="compact">
                {item.verified&&<button disabled={Boolean(busy)} onClick={()=>void action(()=>setupDomainFromDashboard(item.name))}>Re-run setup</button>}
                <button onClick={()=>void action(async()=>{await api('/domains/'+item.name,'POST');await refresh();},'DNS verified')}>Verify DNS</button>
              </div>
              <form className="settings-form" onSubmit={e=>submit(e,data=>api('/domains/'+item.name,'POST',{retention:data.get('days')?Number(data.get('days')):null}))}><label>Move to Trash after (days)<input name="days" type="number" min="1" max="3650" defaultValue={item.retention_days??''} placeholder="Keep indefinitely"/></label><button>Save</button></form>
            </details>
          </section>;
        })}
      </section>}
      {page==='Integrations'&&<section className="settings"><header className="settings-heading"><span className="section-icon"><Boxes size={21}/></span><h1>Integrations</h1></header>
        {credential&&<div className="secret"><strong>Copy this secret now</strong><code>{credential}</code><button onClick={()=>void action(()=>navigator.clipboard.writeText(credential),'Copied')}>Copy</button><button onClick={()=>setCredential('')}>Dismiss</button></div>}
        <section className="settings-panel"><h2 id="api-key-heading">Read-only API keys</h2>
        <form className="settings-form" aria-labelledby="api-key-heading" onSubmit={e=>submit(e,async data=>setCredential((await api<{secret:string}>('/keys','POST',{name:data.get('name'),domain:data.get('domain')})).secret))}>
          <label htmlFor="key-name">Key name<input id="key-name" name="name" required maxLength={120}/></label>
          <label htmlFor="key-domain">Domain<select id="key-domain" name="domain" required defaultValue="">
            <option value="" disabled>Select a verified domain</option>
            {domains.filter(item=>item.verified).map(item=><option key={item.name}>{item.name}</option>)}
          </select></label>
          <button className="primary">Create key</button>
        </form>
        {integration?.keys.map(item=><div className="settings-row compact" key={item.id}><span><strong>{item.name}</strong><small>{item.domain??'Disabled · Create a domain-scoped key'}</small></span><button onClick={()=>{if(confirm('Revoke this API key?'))void action(async()=>{await api('/integrations/key/'+item.id,'DELETE');await refresh();});}}>Revoke</button></div>)}
        </section><section className="settings-panel"><h2 id="webhook-heading">Webhooks</h2>
        <form className="settings-form" aria-labelledby="webhook-heading" onSubmit={e=>submit(e,async data=>{
          const hook=await api<{secret:string}>('/hooks','POST',{
            url:data.get('url'),filter:webhookScope==='filter'?data.get('filter'):null,addressOnly:webhookScope==='selected'
          });
          setCredential(hook.secret);setWebhookScope('all');
        })}>
          <label>Public HTTPS endpoint<input name="url" type="url" required/></label>
          <label>Receive events from<select name="scope" aria-describedby={webhookScope==='selected'?'webhook-scope-help':undefined} value={webhookScope} onChange={e=>setWebhookScope(e.target.value)}>
            <option value="all">All addresses</option>
            <option value="filter">One domain or address</option>
            <option value="selected">Selected addresses</option>
          </select></label>
          {webhookScope==='filter'&&<label>Domain or address<input name="filter" required placeholder="example.com"/></label>}
          <button type="submit" className="primary">Add webhook</button>
        </form>
        {webhookScope==='selected'&&<p id="webhook-scope-help" className="webhook-scope-help">Assign this webhook from the settings of each address.</p>}
        {integration?.hooks.map(item=><div className="settings-row compact" key={item.id}><span>{item.url}</span><small>{item.address_only?'Selected addresses':item.filter||'All addresses'}</small><button onClick={()=>{if(confirm('Remove this webhook?'))void action(async()=>{await api('/integrations/hook/'+item.id,'DELETE');await refresh();});}}>Remove</button></div>)}
        </section><section className="settings-panel"><div className="dns-heading"><h2>Delivery attempts</h2><button onClick={()=>void action(refresh)}>Refresh history</button></div>
        {integration?.deliveries.length===0&&<p className="empty-state">No deliveries yet.</p>}
        {integration?.deliveries.map((item,index)=><div className="settings-row compact" key={item.id+index}><span>{item.url}</span><small>{when(item.attempted)} · {item.result}</small><button onClick={()=>void action(async()=>{await api('/replay/'+item.id,'POST');await refresh();},'Replay queued')}>Replay</button></div>)}
        </section>
      </section>}
      {page==='Health'&&<section className="settings"><header className="settings-heading health-heading"><span className="section-icon"><CircleGauge size={21}/></span><h1>Health</h1><button onClick={()=>void action(refresh)}>Refresh</button></header>
        {health&&<><dl className="stats"><div><dt>Free disk space</dt><dd>{(health.free/1024**3).toFixed(1)} GiB</dd></div><div><dt>Pending parsing</dt><dd>{health.queues.find(row=>row.state==='pending')?.count??0}</dd></div><div><dt>Failed webhooks</dt><dd>{health.deliveries.find(row=>row.status==='failed')?.count??0}</dd></div></dl>
        {health.queues.filter(row=>row.state!=='ready').map(row=><p key={row.state}>Oldest {row.state} message · {when(row.oldest)}</p>)}
        <section className="settings-panel"><h2>Staging connection</h2>
        <p>{!health.staging.configured?'R2 configuration required':health.staging.error?'Staging error. Check application logs.':health.staging.moreWaiting?'Importing staged messages':'Connected'}{health.staging.lastChecked&&' · '+when(health.staging.lastChecked)}</p>
        </section><section className="settings-panel"><h2>Recent ingest</h2>{health.ingest.length===0&&<p className="empty-state">No ingest activity yet.</p>}{health.ingest.map(item=><div className="settings-row compact" key={item.id}><span>{item.recipient}</span><small>{item.status} · {when(item.time)}</small></div>)}
        </section></>}<section className="settings-panel"><h2>Blocked envelope senders</h2><form className="settings-form" onSubmit={e=>submit(e,data=>api('/blocks','POST',{sender:data.get('sender')}))}><label>Sender<input name="sender" type="email" placeholder="sender@example.com" required/></label><button className="primary">Block</button></form>
        {blocks.map(item=><div className="settings-row compact" key={item.sender}><span>{item.sender}</span><button onClick={()=>void action(async()=>{await api('/blocks','POST',{sender:item.sender,remove:true});await refresh();})}>Unblock</button></div>)}
        </section>
      </section>}
    </main>
    {pruning&&<dialog className="remove-dialog" aria-labelledby="prune-title" aria-describedby="prune-description"
      ref={element=>{if(element&&!element.open)element.showModal();}} onClose={event=>{
        const dialog=event.currentTarget;
        const confirmed=dialog.returnValue==='confirm';
        dialog.returnValue='';
        setPruning(null);
        if(confirmed)void action(()=>savePrune(pruning.name,pruning.days),'Auto-prune schedule saved');
      }}>
      <h2 id="prune-title">Enable auto-prune?</h2>
      <p id="prune-description">Email and attachments older than {pruning.days} days on <strong>{pruning.name}</strong> will be permanently deleted from all folders, including Archive and Trash. This applies to existing and future email.</p>
      <form method="dialog" className="compact">
        <button value="cancel" autoFocus>Cancel</button>
        <button value="confirm" className="danger-action">Confirm auto-prune</button>
      </form>
    </dialog>}
    {removing&&<dialog className="remove-dialog" aria-labelledby="remove-title" ref={element=>{if(element&&!element.open)element.showModal();}} onClose={()=>setRemoving(null)}>
      <h2 id="remove-title">Remove {removing}?</h2>
      <p>Letterdock stops accepting new messages for this domain. Existing messages and Cloudflare records stay in place.</p>
      <form method="dialog" className="compact">
        <button autoFocus>Cancel</button>
        <button type="button" className="danger-action" onClick={()=>void action(async()=>{
          await api('/domains/'+encodeURIComponent(removing),'DELETE');
          setCloudflare(previous=>Object.fromEntries(Object.entries(previous).filter(([name])=>name!==removing)));
          setRemoving(null);await refresh();
        },'Domain removed')}>Remove domain</button>
      </form>
    </dialog>}
    {preview&&<dialog ref={element=>{if(element&&!element.open)element.showModal();}} onClose={()=>{URL.revokeObjectURL(preview.url);setPreview(null);}}><form method="dialog"><button aria-label="Close attachment preview"><X size={19}/></button></form><img src={preview.url} alt={preview.name}/></dialog>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
