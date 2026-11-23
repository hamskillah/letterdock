import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, ArrowLeft, ArrowDownToLine, ArrowUpRight, Boxes, ChevronRight, CircleGauge, Filter, Globe, Inbox, LogOut, Mail, Menu, Paperclip, Search, Star, Trash2, X } from 'lucide-react';
import './style.css';

type Message = {id:string;recipient:string;sender:string;subject:string;received:string;unread:boolean;starred:boolean;folder:string;labels:string[];state:string};
type Detail = Message & {body:string;html:string;headers:Record<string,unknown>;error:string;attachments:{id:string;filename:string;mime:string;bytes:number}[]};
type Domain = {name:string;token:string;verified:boolean;last_received:string|null;retention_days:number|null};
type Address = {address:string;name:string;pinned:boolean};
type Integration = {keys:{id:string;name:string}[];hooks:{id:string;url:string;filter:string}[];deliveries:{id:string;url:string;status:string;result:string;attempted:string}[]};
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
const blankFilters={from:'',to:'',subject:'',label:'',since:'',until:'',attachment:''};
const logo=<span className="brand-mark"><Mail size={19}/></span>;

function App(){
  const [authorized,setAuthorized]=useState<boolean|null>(null);
  const [password,setPassword]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [page,setPage]=useState('Inbox');
  const [folder,setFolder]=useState('inbox');
  const [starOnly,setStarOnly]=useState(false);
  const [unreadOnly,setUnreadOnly]=useState(false);
  const [domains,setDomains]=useState<Domain[]>([]);
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
  async function directory(){
    const [registered,inboxes]=await Promise.all([api<Domain[]>('/domains'),api<Address[]>('/inboxes')]);
    setDomains(registered);setAddresses(inboxes);
  }
  function searchPath(cursor=''){
    const params=new URLSearchParams({folder,domain,address,q:query,starred:String(starOnly),unread:String(unreadOnly),cursor,...filters});
    return '/messages?'+params;
  }
  useEffect(()=>{
    directory().then(()=>setAuthorized(true)).catch(cause=>{
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
    if(!authorized)return;
    const timer=setInterval(()=>{
      if(document.hidden)return;
      directory().catch(fail);
      if(page==='Inbox'&&!selected.length)api<Message[]>(searchPath()).then(rows=>{
        setMessages(current=>current.length>100?current:rows);
        setMore(current=>messages.length>100?current:rows.length===100);
      }).catch(fail);
    },10000);
    return ()=>clearInterval(timer);
  },[authorized,page,folder,domain,address,query,filters,starOnly,unreadOnly,selected.length,messages.length]);

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
  async function open(message:Message){
    await action(async()=>{
      const result=await api<Detail>('/messages/'+message.id);
      setView('Message');setDetail({...result,unread:false});
      if(message.unread){
        await api('/messages','PATCH',{ids:[message.id],unread:false});
        setMessages(rows=>rows.map(row=>row.id===message.id?{...row,unread:false}:row));
      }
    });
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

  const heading=address||domain||(starOnly?'Starred':folder==='inbox'?'Inbox':folder==='archive'?'Archive':'Trash');
  return <div className={'app '+(mobileNav?'show-nav ':'')+(detail&&page==='Inbox'?'show-detail':'')}>
    <aside className="sidebar">
      <div className="brand">{logo}<span>Letterdock</span><button className="icon mobile" aria-label="Close menu" onClick={()=>setMobileNav(false)}><X size={18}/></button></div>
      <nav aria-label="Workspace">
        <span className="nav-caption">WORKSPACE</span>
        <button className={page==='Inbox'&&heading==='Inbox'?'active':''} onClick={()=>mailbox()}><Inbox size={17}/>Inbox</button>
        <button className={page==='Inbox'&&starOnly?'active':''} onClick={()=>mailbox('inbox','','',true)}><Star size={17}/>Starred</button>
        <button className={page==='Inbox'&&folder==='archive'?'active':''} onClick={()=>mailbox('archive')}><Archive size={17}/>Archive</button>
        <button className={page==='Inbox'&&folder==='trash'?'active':''} onClick={()=>mailbox('trash')}><Trash2 size={17}/>Trash</button>
        <span className="nav-caption">CONFIGURATION</span>
        {[['Domains',Globe],['Integrations',Boxes],['Health',CircleGauge]].map(([name,Icon])=>{
          const Glyph=Icon as typeof Globe;
          return <button key={String(name)} className={page===name?'active':''} onClick={()=>void navigate(String(name))}><Glyph size={17}/>{String(name)}</button>;
        })}
        {domains.length>0&&<span className="nav-caption">DOMAINS</span>}
        {domains.map(item=><button title={item.name} key={item.name} className={domain===item.name&&page==='Inbox'?'active':''} onClick={()=>mailbox('inbox',item.name)}><span className={'dot '+(item.verified?'online':'')}/><span className="ellipsis">{item.name}</span></button>)}
        {addresses.length>0&&<span className="nav-caption">ADDRESSES</span>}
        {addresses.map(item=><button title={item.address} key={item.address} className={address===item.address&&page==='Inbox'?'active':''} onClick={()=>mailbox('inbox','',item.address)}><Mail size={15}/><span className="ellipsis">{item.name||item.address}</span>{item.pinned&&<Star size={12}/>}</button>)}
      </nav>
      <button className="signout" onClick={()=>void action(async()=>{await api('/logout','POST');setAuthorized(false);setDetail(null);setMessages([]);})}><LogOut size={17}/>Sign out</button>
    </aside>
    <main className="workspace">
      <header className="topbar"><button className="icon mobile" aria-label="Open menu" onClick={()=>setMobileNav(true)}><Menu size={20}/></button><span>Workspace</span><ChevronRight size={13}/><strong>{page}</strong></header>
      {(error||notice)&&<div className={error?'banner error':'banner'} role={error?'alert':'status'}>{error||notice}<button className="icon" aria-label="Dismiss" onClick={()=>{setError('');setNotice('');}}><X size={16}/></button></div>}
      {page==='Inbox'&&<div className="mail-layout">
        <section className="message-list" aria-label="Message list">
          <div className="list-head"><h1>{heading}</h1>
            {address&&<form className="compact" onSubmit={event=>submit(event,async data=>{
              await api('/inboxes','PATCH',{address,name:data.get('name'),pinned:data.has('pinned')});
            })} key={address}><input name="name" aria-label="Inbox name" placeholder="Inbox name" defaultValue={addresses.find(a=>a.address===address)?.name}/><label className="check"><input type="checkbox" name="pinned" defaultChecked={addresses.find(a=>a.address===address)?.pinned}/>Pin</label><button>Save</button></form>}
            <div className="search"><Search size={17}/><input aria-label="Search messages" placeholder="Search messages…" value={query} onChange={e=>setQuery(e.target.value)}/><button className="icon" aria-label="Search filters" aria-expanded={advanced} onClick={()=>setAdvanced(!advanced)}><Filter size={17}/></button></div>
            {advanced&&<div className="filters">{Object.entries(filters).filter(([key])=>key!=='attachment').map(([key,value])=><label key={key}>{key}<input type={['since','until'].includes(key)?'date':'text'} value={value} onChange={e=>setFilters({...filters,[key]:e.target.value})}/></label>)}
              <label className="check"><input type="checkbox" checked={filters.attachment==='true'} onChange={e=>setFilters({...filters,attachment:e.target.checked?'true':''})}/>Has attachment</label>
              <label className="check"><input type="checkbox" checked={unreadOnly} onChange={e=>setUnreadOnly(e.target.checked)}/>Unread</label>
              <button onClick={()=>{setFilters(blankFilters);setUnreadOnly(false);}}>Clear filters</button>
            </div>}
            {selected.length>0&&<div className="compact"><span>{selected.length} selected</span><button onClick={()=>void update(selected,{folder:folder==='inbox'?'archive':'inbox'})}>{folder==='inbox'?'Archive':'Restore'}</button><button onClick={()=>void update(selected,{unread:false})}>Mark read</button>{folder!=='trash'&&<button onClick={()=>void update(selected,{folder:'trash'})}>Trash</button>}</div>}
          </div>
          <div className="rows">
            {loading?<p className="list-empty" role="status">Loading messages…</p>:messages.length===0?<div className="list-empty"><Inbox size={23}/><strong>{query?'No matching messages':'No messages here'}</strong>{!query&&folder==='inbox'&&!domains.length&&<button onClick={()=>void navigate('Domains')}>Connect a domain <ArrowUpRight size={14}/></button>}</div>:messages.map(message=>
              <div className={'message-row '+(detail?.id===message.id?'chosen ':'')+(message.unread?'unread':'')} key={message.id}>
                <input type="checkbox" aria-label={'Select '+(message.subject||'message')} checked={selected.includes(message.id)} onChange={e=>setSelected(e.target.checked?[...selected,message.id]:selected.filter(id=>id!==message.id))}/>
                <button className="message-link" onClick={()=>void open(message)}><span className="row-meta"><span className="ellipsis">{message.sender||'Unknown sender'}</span><time dateTime={message.received}>{new Date(message.received).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</time></span><strong className="ellipsis">{message.subject||'(No subject)'}</strong><small className="ellipsis">{message.recipient}</small></button>
                <button className={'icon '+(message.starred?'starred':'')} aria-label={message.starred?'Remove star':'Star message'} onClick={()=>void update([message.id],{starred:!message.starred})}><Star size={16} fill={message.starred?'currentColor':'none'}/></button>
              </div>)}
            {more&&<button className="load-more" onClick={()=>void action(async()=>{const rows=await api<Message[]>(searchPath(messages.at(-1)?.id));setMessages([...messages,...rows]);setMore(rows.length===100);})}>Load older messages</button>}
          </div>
        </section>
        <section className="reader" aria-label="Message reader">
          {!detail?<div className="reader-empty"><span><Mail size={28}/></span><h2>Select a message</h2><p>Open an email to read it and view its attachments.</p></div>:
          <article>
            <div className="reader-actions">
              <button className="icon mobile" aria-label="Back to messages" onClick={()=>setDetail(null)}><ArrowLeft size={19}/></button>
              <button onClick={()=>void update([detail.id],{unread:!detail.unread})}>{detail.unread?'Mark read':'Mark unread'}</button>
              <button onClick={()=>void update([detail.id],{folder:detail.folder==='inbox'?'archive':'inbox'})}>{detail.folder==='inbox'?'Archive':'Restore'}</button>
              {detail.folder!=='trash'?<button onClick={()=>void update([detail.id],{folder:'trash'})}>Trash</button>:<button onClick={()=>{if(confirm('Permanently delete this message?'))void action(async()=>{await api('/messages/'+detail.id,'DELETE');setDetail(null);await refresh();});}}>Delete permanently</button>}
              <a className="button" href={'/api/raw/'+detail.id}><ArrowDownToLine size={15}/>.eml</a>
            </div>
            <h2 className="subject">{detail.subject||'(No subject)'}</h2>
            <dl className="message-meta"><dt>From</dt><dd>{detail.sender||'Unknown sender'}</dd><dt>Delivered to</dt><dd>{detail.recipient}</dd><dt>Received</dt><dd>{when(detail.received)}</dd></dl>
            <div className="label-list">{detail.labels.map(label=><button key={label} onClick={()=>void update([detail.id],{removeLabel:label})}>{label}<X size={12}/></button>)}
            <form className="compact" onSubmit={e=>{e.preventDefault();const value=new FormData(e.currentTarget).get('label');e.currentTarget.reset();void update([detail.id],{label:value});}}><input name="label" aria-label="New label" placeholder="Add label" required maxLength={60}/><button>Add</button></form></div>
            <div className="tabs" aria-label="Message format">{['Message','Plain text','Headers'].map(tab=><button key={tab} aria-pressed={view===tab} onClick={()=>setView(tab)}>{tab}</button>)}</div>
            {detail.state==='failed'?<div className="error"><p>{detail.error}</p><button onClick={()=>void update([detail.id],{retry:true})}>Retry parsing</button></div>:detail.state==='pending'?<button onClick={()=>void open(detail)}>Refresh processing status</button>:view==='Headers'?<pre>{JSON.stringify(detail.headers,null,2)}</pre>:view==='Plain text'||!detail.html?<pre>{detail.body}</pre>:<iframe title="Email body" sandbox="" referrerPolicy="no-referrer" srcDoc={'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:15px system-ui;line-height:1.65;margin:0;color:#252e29;overflow-wrap:anywhere}table{max-width:100%}</style>'+detail.html}/>}
            {detail.attachments.length>0&&<section className="attachments"><h3>Attachments</h3>{detail.attachments.map(item=><div className="file" key={item.id}><Paperclip size={17}/><span className="ellipsis">{item.filename}</span><small>{Math.ceil(item.bytes/1024)} KB</small>{/^image\/(png|jpeg|gif|webp)$/.test(item.mime)&&<button onClick={()=>void action(async()=>{
              const response=await fetch('/api/files/'+item.id);
              if(!response.ok)throw Error('Preview unavailable');
              setPreview({name:item.filename,url:URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:item.mime}))});
            })}>Preview</button>}<a className="button" href={'/api/files/'+item.id}>Download</a></div>)}</section>}
          </article>}
        </section>
      </div>}
      {page==='Domains'&&<section className="settings"><h1>Domains</h1><p>Connect a Cloudflare domain to receive mail at any address.</p>
        <form className="settings-form" onSubmit={e=>submit(e,data=>api('/domains','POST',{name:data.get('name')}))}><label>Domain<input name="name" placeholder="example.com" required/></label><button className="primary">Add domain</button></form>
        {domains.length===0&&<p className="empty-state">No domains connected yet.</p>}
        {domains.map(item=><section className="settings-row" key={item.name}><h2>{item.name}</h2><span className={'status '+(item.verified?'ok':'')}>{item.last_received?'Receiving':item.verified?'DNS verified · awaiting test mail':'Setup required'}</span>
          <ol><li>Add TXT <code>_letterdock.{item.name}</code> with value <code>letterdock={item.token}</code>.</li><li>Enable Email Routing in Cloudflare. Review existing MX records before authorizing any change.</li><li>Set catch-all action to your Letterdock Worker, verify DNS, then send a test message from an external mailbox.</li></ol>
          {item.last_received&&<p>Last received {when(item.last_received)}</p>}
          <div className="compact"><button onClick={()=>void action(async()=>{await api('/domains/'+item.name,'POST');await refresh();},'DNS verified')}>Verify DNS</button>
          <form className="compact" onSubmit={e=>submit(e,data=>api('/domains/'+item.name,'POST',{retention:data.get('days')?Number(data.get('days')):null}))}><label>Retention days<input name="days" type="number" min="1" max="3650" defaultValue={item.retention_days??''} placeholder="Keep indefinitely"/></label><button>Save</button></form></div></section>)}
      </section>}
      {page==='Integrations'&&<section className="settings"><h1>Integrations</h1>
        {credential&&<div className="secret"><strong>Copy this secret now</strong><code>{credential}</code><button onClick={()=>void action(()=>navigator.clipboard.writeText(credential),'Copied')}>Copy</button><button onClick={()=>setCredential('')}>Dismiss</button></div>}
        <h2>Read-only API keys</h2><form className="settings-form" onSubmit={e=>submit(e,async data=>setCredential((await api<{secret:string}>('/keys','POST',{name:data.get('name')})).secret))}><label>Key name<input name="name" required/></label><button className="primary">Create key</button></form>
        {integration?.keys.map(item=><div className="settings-row compact" key={item.id}><strong>{item.name}</strong><button onClick={()=>{if(confirm('Revoke this API key?'))void action(async()=>{await api('/integrations/key/'+item.id,'DELETE');await refresh();});}}>Revoke</button></div>)}
        <h2>Webhooks</h2><form className="settings-form" onSubmit={e=>submit(e,async data=>setCredential((await api<{secret:string}>('/hooks','POST',{url:data.get('url'),filter:data.get('filter')})).secret))}><label>Public HTTPS endpoint<input name="url" type="url" required/></label><label>Domain or address filter<input name="filter" placeholder="All addresses"/></label><button className="primary">Add webhook</button></form>
        {integration?.hooks.map(item=><div className="settings-row compact" key={item.id}><span>{item.url}</span><small>{item.filter||'All addresses'}</small><button onClick={()=>{if(confirm('Remove this webhook?'))void action(async()=>{await api('/integrations/hook/'+item.id,'DELETE');await refresh();});}}>Remove</button></div>)}
        <h2>Delivery attempts</h2><button onClick={()=>void action(refresh)}>Refresh history</button>
        {integration?.deliveries.length===0&&<p className="empty-state">No deliveries yet.</p>}
        {integration?.deliveries.map((item,index)=><div className="settings-row compact" key={item.id+index}><span>{item.url}</span><small>{when(item.attempted)} · {item.result}</small><button onClick={()=>void action(async()=>{await api('/replay/'+item.id,'POST');await refresh();},'Replay queued')}>Replay</button></div>)}
      </section>}
      {page==='Health'&&<section className="settings"><h1>Health</h1><button onClick={()=>void action(refresh)}>Refresh</button>
        {health&&<><dl className="stats"><div><dt>Free disk space</dt><dd>{(health.free/1024**3).toFixed(1)} GiB</dd></div><div><dt>Pending parsing</dt><dd>{health.queues.find(row=>row.state==='pending')?.count??0}</dd></div><div><dt>Failed webhooks</dt><dd>{health.deliveries.find(row=>row.status==='failed')?.count??0}</dd></div></dl>
        {health.queues.filter(row=>row.state!=='ready').map(row=><p key={row.state}>Oldest {row.state} message · {when(row.oldest)}</p>)}
        <h2>Staging connection</h2>
        <p>{!health.staging.configured?'R2 configuration required':health.staging.error?'Staging error. Check application logs.':health.staging.moreWaiting?'Importing staged messages':'Connected'}{health.staging.lastChecked&&' · '+when(health.staging.lastChecked)}</p>
        <h2>Recent ingest</h2>{health.ingest.length===0&&<p className="empty-state">No ingest activity yet.</p>}{health.ingest.map(item=><div className="settings-row compact" key={item.id}><span>{item.recipient}</span><small>{item.status} · {when(item.time)}</small></div>)}</>}
        <h2>Blocked envelope senders</h2><form className="settings-form" onSubmit={e=>submit(e,data=>api('/blocks','POST',{sender:data.get('sender')}))}><label>Sender<input name="sender" type="email" placeholder="sender@example.com" required/></label><button className="primary">Block</button></form>
        {blocks.map(item=><div className="settings-row compact" key={item.sender}><span>{item.sender}</span><button onClick={()=>void action(async()=>{await api('/blocks','POST',{sender:item.sender,remove:true});await refresh();})}>Unblock</button></div>)}
      </section>}
    </main>
    {preview&&<dialog ref={element=>{if(element&&!element.open)element.showModal();}} onClose={()=>{URL.revokeObjectURL(preview.url);setPreview(null);}}><form method="dialog"><button aria-label="Close attachment preview"><X size={19}/></button></form><img src={preview.url} alt={preview.name}/></dialog>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
