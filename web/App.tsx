import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Boxes,
  CircleGauge,
  Globe,
  Inbox,
  LogOut,
  Mail,
  Send,
  ShieldAlert,
  Key,
  X
} from 'lucide-react';
import { api, AccessError } from './api/client.js';
import type {
  Message,
  Detail,
  Domain,
  CloudflareConnection,
  CloudflareStatus,
  Address,
  Integration,
  Health
} from './types/index.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { Header } from './components/layout/Header.js';
import { ShortcutsModal } from './components/layout/ShortcutsModal.js';
import { MessageList } from './components/inbox/MessageList.js';
import { MessageDetail } from './components/inbox/MessageDetail.js';
import { DomainList } from './components/domains/DomainList.js';
import { OutboundConfig } from './components/outbound/OutboundConfig.js';
import { ComposeModal } from './components/outbound/ComposeModal.js';
import { SuppressionList } from './components/suppressions/SuppressionList.js';
import { ApiKeyManager } from './components/apikeys/ApiKeyManager.js';
import { AddressList } from './components/addresses/AddressList.js';
import { IntegrationsView } from './components/integrations/IntegrationsView.js';
import { HealthView } from './components/health/HealthView.js';
import { useDensity } from './context/DensityContext.js';
import { trashRetentionDays } from '../src/trash-policy.js';

const blankFilters = {
  from: '',
  to: '',
  subject: '',
  label: '',
  since: '',
  until: '',
  attachment: ''
};

const logo = (
  <img
    className="brand-mark"
    src="/letterdock-mark.svg"
    width="36"
    height="36"
    alt=""
  />
);

export function App() {
  const { toggleDensity } = useDensity();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState('Inbox');
  const [folder, setFolder] = useState('inbox');
  const [starOnly, setStarOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [connection, setConnection] = useState<CloudflareConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [cloudflare, setCloudflare] = useState<Record<string, CloudflareStatus>>({});
  const [manualDomain, setManualDomain] = useState('');
  const [trashPrompt, setTrashPrompt] = useState<{ ids: string[]; bulk: boolean } | null>(null);
  const [pruning, setPruning] = useState<{ name: string; days: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [domainBusy, setDomainBusy] = useState<Record<string, string>>({});
  const [domains, setDomains] = useState<Domain[]>([]);
  const [addressDomain, setAddressDomain] = useState('');
  const [addressQuery, setAddressQuery] = useState('');
  const [ruleAddress, setRuleAddress] = useState('');
  const [removingAddress, setRemovingAddress] = useState<string | null>(null);
  const [addressRemovalPending, setAddressRemovalPending] = useState(false);
  const [ruleHooks, setRuleHooks] = useState<{ id: string; url: string }[]>([]);
  const [integrationForm, setIntegrationForm] = useState<'key' | 'hook' | null>(null);
  const [webhookScope, setWebhookScope] = useState('all');
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [domain, setDomain] = useState('');
  const [address, setAddress] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>(blankFilters);
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [more, setMore] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  // New Phase 4 state modals
  const [composeOpen, setComposeOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const press = useRef<{ timer: number; x: number; y: number; pointer: number } | null>(null);
  const heldMessage = useRef<string | null>(null);

  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }
  useEffect(() => cancelPress, []);

  function toggleMessage(id: string) {
    setSelected(current =>
      current.includes(id) ? current.filter(value => value !== id) : [...current, id]
    );
  }

  function startPress(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    if (!event.isPrimary || event.button !== 0) return;
    heldMessage.current = null;
    if (selected.length || bulkUpdating) return;
    cancelPress();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      pointer: event.pointerId,
      timer: window.setTimeout(() => {
        heldMessage.current = id;
        setSelected([id]);
        cancelPress();
      }, 500)
    };
  }

  function movePress(event: React.PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    if (
      current &&
      event.pointerId === current.pointer &&
      Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10
    )
      cancelPress();
  }

  const searchInput = useRef<HTMLInputElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMenuButton = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (authorized && workspaceRef.current) {
      workspaceRef.current.focus({ preventScroll: true });
    }
  }, [page, authorized]);

  useEffect(() => {
    if (!mobileNav) return;
    closeMenuButton.current?.focus();
    const media = matchMedia('(max-width: 860px)');
    const onResize = () => {
      if (!media.matches) setMobileNav(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileNav(false);
      }
    };
    media.addEventListener('change', onResize);
    document.addEventListener('keydown', onKey);
    return () => {
      media.removeEventListener('change', onResize);
      document.removeEventListener('keydown', onKey);
      if (media.matches) requestAnimationFrame(() => menuButton.current?.focus());
    };
  }, [mobileNav]);

  // Global Keyboard Shortcuts (j/k, e, #, c, /, d, ?, Escape)
  useEffect(() => {
    if (!authorized) return;

    const handleGlobalKeys = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea/select/modal dialog
      const target = e.target as HTMLElement;
      const isInput = target.closest('input, textarea, select, [contenteditable="true"]');
      const hasOpenDialog = Boolean(document.querySelector('dialog[open]'));

      if (e.key === 'Escape') {
        if (composeOpen) {
          setComposeOpen(false);
          return;
        }
        if (shortcutsOpen) {
          setShortcutsOpen(false);
          return;
        }
        if (detail) {
          setDetail(null);
          return;
        }
        if (selected.length) {
          setSelected([]);
          return;
        }
        return;
      }

      if (isInput || hasOpenDialog) return;

      // Strict modifier guard: never intercept native browser shortcuts (e.g. Cmd+C, Ctrl+C, Ctrl+D)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === '/') {
        if (page === 'Inbox' && searchInput.current) {
          e.preventDefault();
          searchInput.current.focus();
        }
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (e.key === 'd') {
        e.preventDefault();
        toggleDensity();
        return;
      }

      if (e.key === 'c') {
        e.preventDefault();
        setComposeOpen(true);
        return;
      }

      if (page === 'Inbox' && messages.length > 0) {
        const currentIndex = detail ? messages.findIndex(m => m.id === detail.id) : -1;

        if (e.key === 'j' || e.key === 'ArrowDown') {
          // Next message
          e.preventDefault();
          const nextIndex = currentIndex < messages.length - 1 ? currentIndex + 1 : 0;
          void open(messages[nextIndex]);
          return;
        }

        if (e.key === 'k' || e.key === 'ArrowUp') {
          // Previous message
          e.preventDefault();
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : messages.length - 1;
          void open(messages[prevIndex]);
          return;
        }

        if (e.key === 'e') {
          // Archive
          e.preventDefault();
          if (detail) {
            void update([detail.id], { folder: 'archive' });
          } else if (selected.length) {
            void updateSelection({ folder: 'archive' });
          }
          return;
        }

        if (e.key === '#' || e.key === 'Delete') {
          // Move to Trash
          e.preventDefault();
          if (detail) {
            setTrashPrompt({ ids: [detail.id], bulk: false });
          } else if (selected.length) {
            setTrashPrompt({ ids: selected, bulk: true });
          }
          return;
        }

        if (e.key === 's') {
          // Toggle star
          e.preventDefault();
          if (detail) {
            void update([detail.id], { starred: !detail.starred });
          } else if (selected.length) {
            void updateSelection({ starred: true });
          }
          return;
        }

        if (e.key === 'u') {
          // Toggle unread
          e.preventDefault();
          if (detail) {
            void update([detail.id], { unread: !detail.unread });
          } else if (selected.length) {
            void updateSelection({ unread: true });
          }
          return;
        }
      }
    };

    document.addEventListener('keydown', handleGlobalKeys);
    return () => document.removeEventListener('keydown', handleGlobalKeys);
  }, [
    authorized,
    page,
    detail,
    messages,
    selected,
    composeOpen,
    shortcutsOpen,
    toggleDensity
  ]);

  const [integration, setIntegration] = useState<Integration>();
  const [health, setHealth] = useState<Health>();
  const [blocks, setBlocks] = useState<{ sender: string }[]>([]);
  const [credential, setCredential] = useState('');

  function fail(cause: unknown) {
    if (cause instanceof AccessError) setAuthorized(false);
    setError(cause instanceof Error ? cause.message : 'Something went wrong');
  }

  async function checkCloudflare(name: string, method = 'GET') {
    setDomainBusy(previous => ({
      ...previous,
      [name]: method === 'POST' ? 'Applying setup…' : 'Checking DNS…'
    }));
    try {
      const status = await api<CloudflareStatus>(
        '/domains/' + encodeURIComponent(name) + '/cloudflare',
        method
      );
      setCloudflare(previous => ({
        ...previous,
        [name]: { ...status, applied: method === 'POST' || previous[name]?.applied }
      }));
      return status;
    } finally {
      setDomainBusy(previous => ({ ...previous, [name]: '' }));
    }
  }

  async function setupDomainFromDashboard(name: string) {
    const check = await checkCloudflare(name);
    if (!check.detected) {
      setManualDomain(name);
      return;
    }
    if (check.ready) {
      await checkCloudflare(name, 'POST');
      return;
    }
    if (check.message.startsWith('Connect or reconnect')) {
      const { url } = await api<{ url: string }>('/cloudflare/oauth/start', 'POST', {
        domain: name
      });
      location.assign(url);
    }
  }

  async function directory() {
    const [registered, inboxes] = await Promise.all([
      api<Domain[]>('/domains'),
      api<Address[]>('/inboxes')
    ]);
    setDomains(registered);
    setAddresses(inboxes);
  }

  function searchPath(cursor = '') {
    const params = new URLSearchParams({
      folder,
      domain,
      address,
      q: query,
      starred: String(starOnly),
      unread: String(unreadOnly),
      cursor,
      ...filters
    });
    return '/messages?' + params;
  }

  useEffect(() => {
    directory()
      .then(() => {
        setAuthorized(true);
        const returningDomain = new URLSearchParams(location.search).get('domainConnect');
        const cloudflareReturn = new URLSearchParams(location.search).get('cloudflare');
        if (returningDomain || cloudflareReturn) void navigate('Domains');
      })
      .catch(cause => {
        setAuthorized(false);
        if (!(cause instanceof AccessError)) fail(cause);
      });
  }, []);

  useEffect(() => {
    if (!authorized || page !== 'Inbox') return;
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api<Message[]>(searchPath())
        .then(rows => {
          if (current) {
            setMessages(rows);
            setMore(rows.length === 100);
            setSelected([]);
          }
        })
        .catch(cause => {
          if (current) fail(cause);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 220);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [authorized, page, folder, domain, address, query, filters, starOnly, unreadOnly]);

  useEffect(() => {
    if (!authorized || page !== 'Inbox') return;
    if (selected.length || messages.length > 100) return;
    const controller = new AbortController();
    const { signal } = controller;
    let pending = false;
    const timer = setInterval(async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const rows = await api<Message[]>(searchPath(), 'GET', undefined, {
          signal,
          priority: 'low'
        });
        if (signal.aborted) return;
        setMessages(rows);
        setMore(rows.length === 100);
      } catch (cause) {
        if (!signal.aborted) fail(cause);
      } finally {
        pending = false;
      }
    }, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [
    authorized,
    page,
    folder,
    domain,
    address,
    query,
    filters,
    starOnly,
    unreadOnly,
    selected.length,
    messages.length
  ]);

  useEffect(() => {
    if (!authorized) return;
    let active = true;
    let running = false;
    async function updateUnread() {
      if (document.hidden || running) return;
      running = true;
      try {
        const inboxes = await api<Address[]>('/inboxes');
        if (active) setAddresses(inboxes);
      } catch (cause) {
        if (active && cause instanceof AccessError) fail(cause);
      } finally {
        running = false;
      }
    }
    const timer = window.setInterval(updateUnread, 10000);
    document.addEventListener('visibilitychange', updateUnread);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', updateUnread);
    };
  }, [authorized]);

  useEffect(() => {
    if (!authorized || page !== 'Domains') return;
    const waiting = domains.filter(item => !item.verified && cloudflare[item.name]?.applied);
    if (!waiting.length) return;
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (const item of waiting) {
          try {
            await api('/domains/' + encodeURIComponent(item.name), 'POST');
          } catch (cause) {
            if (cause instanceof AccessError) {
              fail(cause);
              return;
            }
          }
        }
        await directory();
      } catch (cause) {
        fail(cause);
      } finally {
        running = false;
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [authorized, page, domains, cloudflare]);

  async function refresh() {
    await directory();
    if (page === 'Inbox') {
      const rows = await api<Message[]>(searchPath());
      setMessages(rows);
      setMore(rows.length === 100);
    }
    if (page === 'Integrations') setIntegration(await api('/integrations'));
    if (page === 'Health') {
      const [stats, rules] = await Promise.all([
        api<Health>('/health'),
        api<{ sender: string }[]>('/blocks')
      ]);
      setHealth(stats);
      setBlocks(rules);
    }
  }

  async function action(fn: () => Promise<unknown>, success = '') {
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice(success);
    } catch (cause) {
      fail(cause);
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      await api('/login', 'POST', { password });
      await directory();
      setPassword('');
      setAuthorized(true);
    });
  }

  async function navigate(next: string) {
    setPage(next);
    setMobileNav(false);
    setCredential('');
    setError('');
    if (next === 'Addresses') await action(directory);
    if (next === 'Domains') {
      await action(async () => {
        setConnection(await api<CloudflareConnection>('/cloudflare'));
        const returningDomain = new URLSearchParams(location.search).get('domainConnect');
        const cloudflareReturn = new URLSearchParams(location.search).get('cloudflare');
        const setupDomain = new URLSearchParams(location.search).get('setupDomain');

        if (cloudflareReturn && new URLSearchParams(location.search).has('cloudflare')) {
          history.replaceState(null, '', location.pathname);
          if (cloudflareReturn === 'authorization-failed')
            throw Error('Cloudflare authorization failed or was canceled. Try connecting again.');
          if (setupDomain) {
            const status = await api<CloudflareStatus>('/cloudflare/oauth/apply', 'POST', {
              name: setupDomain
            });
            setCloudflare(previous => ({
              ...previous,
              [setupDomain]: { ...status, applied: true }
            }));
            setConnection(await api<CloudflareConnection>('/cloudflare'));
          }
        }
        if (returningDomain && new URLSearchParams(location.search).has('domainConnect')) {
          history.replaceState(null, '', location.pathname);
          await checkCloudflare(returningDomain);
        }
        await Promise.allSettled(
          domains.filter(item => !cloudflare[item.name]).map(item => checkCloudflare(item.name))
        );
      });
    }
    if (next === 'Integrations')
      await action(async () => setIntegration(await api('/integrations')));
    if (next === 'Health') {
      await action(async () => {
        const [stats, rules] = await Promise.all([
          api<Health>('/health'),
          api<{ sender: string }[]>('/blocks')
        ]);
        setHealth(stats);
        setBlocks(rules);
      });
    }
  }

  function mailbox(
    nextFolder = 'inbox',
    nextDomain = '',
    nextAddress = '',
    stars = false
  ) {
    setFolder(nextFolder);
    setDomain(nextDomain);
    setAddress(nextAddress);
    setStarOnly(stars);
    setDetail(null);
    setSelected([]);
    void navigate('Inbox');
  }

  async function openAddressSettings(name: string) {
    setRuleHooks(await api('/inbox-rule-hooks'));
    setRuleAddress(name);
  }

  async function open(message: Message) {
    await action(async () => {
      const result = await api<Detail>('/messages/' + message.id);
      setDetail({ ...result, unread: false });
      if (message.unread) {
        await api('/messages', 'PATCH', { ids: [message.id], unread: false });
        setMessages(rows =>
          unreadOnly
            ? rows.filter(row => row.id !== message.id)
            : rows.map(row => (row.id === message.id ? { ...row, unread: false } : row))
        );
        setAddresses(await api<Address[]>('/inboxes'));
      }
    });
  }

  async function savePrune(name: string, days: number | null) {
    await api('/domains/' + encodeURIComponent(name) + '/auto-prune', 'PATCH', { days });
    setDomains(rows => rows.map(item => (item.name === name ? { ...item, prune_days: days } : item)));
  }

  async function update(ids: string[], patch: Record<string, unknown>) {
    await action(async () => {
      let completed = 0;
      try {
        while (completed < ids.length) {
          const batch = ids.slice(completed, completed + 100);
          await api('/messages', 'PATCH', { ids: batch, ...patch });
          completed += batch.length;
        }
      } catch (cause) {
        if (!completed || cause instanceof AccessError) throw cause;
        setSelected([]);
        await refresh();
        throw Error(
          `Updated ${completed} of ${ids.length} messages. Select the remaining messages and try again.`
        );
      }
      if (detail && ids.includes(detail.id)) {
        if (patch.folder && patch.folder !== folder) setDetail(null);
        else setDetail(await api('/messages/' + detail.id));
      }
      setSelected([]);
      await refresh();
    });
  }

  async function updateSelection(patch: Record<string, unknown>, ids = selected) {
    if (bulkUpdating) return;
    setBulkUpdating(true);
    try {
      await update(ids, patch);
    } finally {
      setBulkUpdating(false);
    }
  }

  function submit<T>(
    event: React.FormEvent<HTMLFormElement>,
    handler: (data: FormData) => Promise<T>
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void action(async () => {
      await handler(data);
      form.reset();
      await refresh();
    });
  }

  if (authorized === null) {
    return (
      <main className="auth">
        <p role="status">Opening Letterdock…</p>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="auth">
        <div className="login">
          {logo}
          <h1>Letterdock</h1>
          <p>Sign in to your inbound mail workspace.</p>
          <form onSubmit={signIn}>
            <label>
              Admin password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="primary">
              Sign in <ArrowUpRight size={16} />
            </button>
          </form>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      </main>
    );
  }

  const visibleAddresses = addresses.filter(item => !item.removed_at);
  const messageIndex = detail ? messages.findIndex(m => m.id === detail.id) : -1;
  const previous = messageIndex > 0 ? messages[messageIndex - 1] : undefined;
  const next = messageIndex >= 0 ? messages[messageIndex + 1] : undefined;
  const inboxUnread = addresses.reduce((count, item) => count + item.unread, 0);
  const heading =
    address ||
    domain ||
    (starOnly
      ? 'Starred'
      : folder === 'inbox'
      ? 'Inbox'
      : folder === 'archive'
      ? 'Archive'
      : 'Trash');

  const cloudflarePanel = connection && (
    <details
      className="domain-card connection-card"
      open={!connection.configured || undefined}
    >
      <summary className="connection-summary">
        <strong>Cloudflare connection</strong>
        <span className={'status ' + (connection.configured ? 'ok' : '')}>
          {connection.oauthConnected
            ? 'OAuth connected'
            : connection.configured
            ? 'Token connected'
            : 'Connect required'}
        </span>
      </summary>
      <div className="connection-options">
        <dl className="connection-checks">
          <div>
            <dt>API access</dt>
            <dd>{connection.configured ? 'Configured' : 'Authorize access'}</dd>
          </div>
          <div>
            <dt>Email Worker</dt>
            <dd>{connection.workerConfigured ? 'Configured' : 'Deploy Worker'}</dd>
          </div>
          <div>
            <dt>Private R2 staging</dt>
            <dd>{connection.stagingConfigured ? 'Configured' : 'Configure R2'}</dd>
          </div>
        </dl>
        <div className="compact">
          <button
            className="primary"
            disabled={connecting}
            onClick={() =>
              void action(async () => {
                setConnecting(true);
                try {
                  const { url } = await api<{ url: string }>('/cloudflare/oauth/start', 'POST');
                  location.assign(url);
                } finally {
                  setConnecting(false);
                }
              })
            }
          >
            {connection.oauthConnected ? 'Reconnect Cloudflare' : 'Connect Cloudflare'}{' '}
            <ArrowUpRight size={15} />
          </button>
          {connection.oauthConnected && (
            <button
              onClick={() =>
                void action(async () => {
                  setConnection(await api<CloudflareConnection>('/cloudflare', 'DELETE'));
                  setCloudflare({});
                }, 'Cloudflare disconnected')
              }
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
    </details>
  );

  return (
    <div
      className={
        'app ' +
        (mobileNav ? 'show-nav ' : '') +
        (detail && page === 'Inbox' ? 'show-detail' : '')
      }
    >
      <Sidebar
        page={page}
        heading={heading}
        folder={folder}
        starOnly={starOnly}
        domain={domain}
        address={address}
        domains={domains}
        addresses={addresses}
        inboxUnread={inboxUnread}
        mobileNav={mobileNav}
        closeMenuButtonRef={closeMenuButton}
        onCloseMobileNav={() => setMobileNav(false)}
        onMailbox={mailbox}
        onNavigate={navigate}
        onSignOut={() =>
          void action(async () => {
            await api('/logout', 'POST');
            setAuthorized(false);
            setDetail(null);
            setMessages([]);
          })
        }
      />

      <main ref={workspaceRef} tabIndex={-1} className="workspace" inert={mobileNav || undefined}>
        <Header
          page={page}
          heading={heading}
          inboxUnread={inboxUnread}
          mobileNav={mobileNav}
          menuButtonRef={menuButton}
          onOpenMobileNav={() => setMobileNav(true)}
          onOpenCompose={() => setComposeOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />

        {(error || notice) && (
          <div
            className={error ? 'banner error' : 'banner'}
            role={error ? 'alert' : 'status'}
          >
            {error || notice}
            <button
              className="icon"
              aria-label="Dismiss"
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {page === 'Inbox' && (
          <div className="mail-layout">
            <MessageList
              heading={heading}
              folder={folder}
              domain={domain}
              address={address}
              starOnly={starOnly}
              unreadOnly={unreadOnly}
              query={query}
              filters={filters}
              advanced={advanced}
              loading={loading}
              messages={messages}
              detail={detail}
              selected={selected}
              bulkUpdating={bulkUpdating}
              more={more}
              domains={domains}
              visibleAddresses={visibleAddresses}
              searchInputRef={searchInput}
              onQueryChange={setQuery}
              onClearQuery={() => {
                setQuery('');
                searchInput.current?.focus();
              }}
              onToggleAdvanced={() => setAdvanced(!advanced)}
              onFiltersChange={setFilters}
              onClearFilters={() => {
                setFilters(blankFilters);
                setUnreadOnly(false);
              }}
              onSetUnreadOnly={setUnreadOnly}
              onSelectAll={checked =>
                setSelected(checked ? messages.map(m => m.id) : [])
              }
              onToggleSelect={toggleMessage}
              onClearSelection={() => setSelected([])}
              onBulkUpdate={updateSelection}
              onPromptTrash={(ids, bulk) => setTrashPrompt({ ids, bulk })}
              onOpenMessage={open}
              onToggleStar={(id, starred) => void update([id], { starred })}
              onLoadOlder={() =>
                void action(async () => {
                  const rows = await api<Message[]>(searchPath(messages.at(-1)?.id));
                  setMessages([...messages, ...rows]);
                  setMore(rows.length === 100);
                })
              }
              onNavigate={navigate}
              onOpenAddressSettings={async name => {
                await openAddressSettings(name);
                setAddressQuery(name);
                setAddressDomain('');
                await navigate('Addresses');
              }}
              startPress={startPress}
              movePress={movePress}
              cancelPress={cancelPress}
              heldMessageRef={heldMessage}
            />

            <section className="reader" aria-label="Message reader">
              {!detail ? (
                <div className="reader-empty">
                  <span>
                    <Mail size={26} />
                  </span>
                  <h2>Select a message</h2>
                  <p>Open an email to read it and view its attachments.</p>
                </div>
              ) : (
                <MessageDetail
                  detail={detail}
                  onBack={() => setDetail(null)}
                  onPrev={() => previous && void open(previous)}
                  onNext={() => next && void open(next)}
                  hasPrev={Boolean(previous)}
                  hasNext={Boolean(next)}
                  onArchive={id => void update([id], { folder: 'archive' })}
                  onTrash={id => setTrashPrompt({ ids: [id], bulk: false })}
                  onToggleStar={(id, starred) => void update([id], { starred })}
                  onToggleUnread={(id, unread) => void update([id], { unread })}
                  onBlockSender={sender =>
                    void action(async () => {
                      await api('/blocks', 'POST', { sender });
                      await refresh();
                    }, 'Sender blocked')
                  }
                  onUpdateLabels={(id, label, remove) =>
                    void update([id], remove ? { removeLabel: label } : { label })
                  }
                  onPermanentlyDelete={id =>
                    void action(async () => {
                      await api('/messages/' + id, 'DELETE');
                      setDetail(null);
                      await refresh();
                    })
                  }
                  onRetryParsing={id => void update([id], { retry: true })}
                  onRefreshStatus={msg => void open(msg)}
                />
              )}
            </section>
          </div>
        )}

        {page === 'Addresses' && (
          <AddressList
            addresses={addresses}
            domains={domains}
            addressQuery={addressQuery}
            addressDomain={addressDomain}
            ruleAddress={ruleAddress}
            ruleHooks={ruleHooks}
            onSetAddressQuery={setAddressQuery}
            onSetAddressDomain={setAddressDomain}
            onNavigate={navigate}
            onAddAddress={e =>
              submit(e, data =>
                api('/inboxes', 'POST', {
                  local: data.get('local'),
                  domain: data.get('domain'),
                  name: data.get('name')
                })
              )
            }
            onTogglePin={(addr, pinned) =>
              void action(async () => {
                await api('/inboxes', 'PATCH', { address: addr, pinned });
                await directory();
              })
            }
            onOpenSettings={openAddressSettings}
            onCloseSettings={() => setRuleAddress('')}
            onSaveSettings={(e, addr) =>
              submit(e, async data => {
                await api('/inbox-rules', 'PATCH', {
                  address: addr,
                  name: data.get('name'),
                  label: data.get('label'),
                  webhookId: data.get('webhook') || null
                });
                setRuleAddress('');
                setNotice('Address settings saved');
              })
            }
            onRequestRemoveAddress={setRemovingAddress}
            onCopyAddress={addr =>
              void action(() => navigator.clipboard.writeText(addr), 'Address copied')
            }
            onOpenInbox={addr => mailbox('inbox', '', addr)}
          />
        )}

        {page === 'Domains' && (
          <DomainList
            domains={domains}
            connection={connection}
            cloudflare={cloudflare}
            domainBusy={domainBusy}
            manualDomain={manualDomain}
            cloudflarePanel={cloudflarePanel}
            onAddDomain={e =>
              submit(e, async data => {
                const { name } = await api<{ name: string }>('/domains', 'POST', {
                  name: data.get('name')
                });
                await directory();
                await checkCloudflare(name);
              })
            }
            onCheckCloudflare={checkCloudflare}
            onSetupDomain={setupDomainFromDashboard}
            onAuthorizeDomainConnect={name =>
              void action(async () => {
                const result = await api<{ available: boolean; url?: string; message?: string }>(
                  '/domains/' + encodeURIComponent(name) + '/domain-connect'
                );
                if (!result.available || !result.url)
                  throw Error(result.message || 'Cloudflare authorization is unavailable.');
                location.assign(result.url);
              })
            }
            onVerifyDns={name =>
              void action(async () => {
                await api('/domains/' + name, 'POST');
                await refresh();
              }, 'DNS verified')
            }
            onRefresh={() => void directory()}
            onSaveRetention={(e, name) =>
              submit(e, data =>
                api('/domains/' + name, 'POST', {
                  retention: data.get('days') ? Number(data.get('days')) : null
                })
              )
            }
            onRequestPrune={(name, days) => setPruning({ name, days })}
            onTurnOffPrune={name =>
              void action(() => savePrune(name, null), 'Auto-prune turned off')
            }
            onRequestRemoveDomain={setRemoving}
            onManageAddresses={dom => {
              setAddressDomain(dom);
              setAddressQuery('');
              void navigate('Addresses');
            }}
          />
        )}

        {page === 'Outbound' && (
          <OutboundConfig
            domains={domains}
            onError={fail}
            onNotice={msg => setNotice(msg)}
          />
        )}

        {page === 'Suppressions' && (
          <SuppressionList
            onError={fail}
            onNotice={msg => setNotice(msg)}
          />
        )}

        {page === 'ApiKeys' && (
          <ApiKeyManager
            domains={domains}
            onError={fail}
            onNotice={msg => setNotice(msg)}
          />
        )}

        {page === 'Integrations' && (
          <IntegrationsView
            integration={integration}
            domains={domains}
            credential={credential}
            integrationForm={integrationForm}
            webhookScope={webhookScope}
            onSetCredential={setCredential}
            onSetIntegrationForm={setIntegrationForm}
            onSetWebhookScope={setWebhookScope}
            onCreateKey={e =>
              submit(e, async data => {
                const key = await api<{ secret: string }>('/keys', 'POST', {
                  name: data.get('name'),
                  domain: data.get('domain')
                });
                setCredential(key.secret);
                setIntegrationForm(null);
              })
            }
            onRevokeKey={id => {
              if (confirm('Revoke this API key?'))
                void action(async () => {
                  await api('/integrations/key/' + id, 'DELETE');
                  await refresh();
                });
            }}
            onCreateHook={e =>
              submit(e, async data => {
                const hook = await api<{ secret: string }>('/hooks', 'POST', {
                  url: data.get('url'),
                  filter: webhookScope === 'filter' ? data.get('filter') : null,
                  addressOnly: webhookScope === 'selected'
                });
                setCredential(hook.secret);
                setWebhookScope('all');
                setIntegrationForm(null);
              })
            }
            onRemoveHook={id => {
              if (confirm('Remove this webhook?'))
                void action(async () => {
                  await api('/integrations/hook/' + id, 'DELETE');
                  await refresh();
                });
            }}
            onReplay={id =>
              void action(async () => {
                await api('/replay/' + id, 'POST');
                await refresh();
              }, 'Replay queued')
            }
            onRefresh={() => void action(refresh)}
            onCopyCredential={() =>
              void action(() => navigator.clipboard.writeText(credential), 'Copied')
            }
          />
        )}

        {page === 'Health' && (
          <HealthView
            health={health}
            blocks={blocks}
            onRefresh={() => void action(refresh)}
            onBlockSender={e =>
              submit(e, data => api('/blocks', 'POST', { sender: data.get('sender') }))
            }
            onUnblockSender={sender =>
              void action(async () => {
                await api('/blocks', 'POST', { sender, remove: true });
                await refresh();
              })
            }
          />
        )}
      </main>

      {/* Trash confirmation dialog */}
      {trashPrompt && (
        <dialog
          className="remove-dialog"
          aria-labelledby="trash-title"
          aria-describedby="trash-description"
          ref={element => {
            if (element && !element.open) element.showModal();
          }}
          onClose={event => {
            const confirmed = event.currentTarget.returnValue === 'confirm';
            setTrashPrompt(null);
            if (!confirmed) return;
            if (trashPrompt.bulk) void updateSelection({ folder: 'trash' }, trashPrompt.ids);
            else void update(trashPrompt.ids, { folder: 'trash' });
          }}
        >
          <h2 id="trash-title">
            Move {trashPrompt.ids.length === 1 ? 'message' : trashPrompt.ids.length + ' messages'}{' '}
            to Trash?
          </h2>
          <p id="trash-description">
            You can restore messages from Trash before they are permanently deleted. Trash is
            cleared automatically after {trashRetentionDays} days. A domain’s Auto-prune schedule
            can delete messages sooner.
          </p>
          <form method="dialog" className="compact">
            <button value="cancel" autoFocus>
              Cancel
            </button>
            <button value="confirm" className="danger-action">
              Move to Trash
            </button>
          </form>
        </dialog>
      )}

      {/* Auto-prune confirmation dialog */}
      {pruning && (
        <dialog
          className="remove-dialog"
          aria-labelledby="prune-title"
          aria-describedby="prune-description"
          ref={element => {
            if (element && !element.open) element.showModal();
          }}
          onClose={event => {
            const dialog = event.currentTarget;
            const confirmed = dialog.returnValue === 'confirm';
            dialog.returnValue = '';
            setPruning(null);
            if (confirmed)
              void action(() => savePrune(pruning.name, pruning.days), 'Auto-prune schedule saved');
          }}
        >
          <h2 id="prune-title">Enable auto-prune?</h2>
          <p id="prune-description">
            Email and attachments older than {pruning.days} days on{' '}
            <strong>{pruning.name}</strong> will be permanently deleted from all folders,
            including Archive and Trash. This applies to existing and future email.
          </p>
          <form method="dialog" className="compact">
            <button value="cancel" autoFocus>
              Cancel
            </button>
            <button value="confirm" className="danger-action">
              Confirm auto-prune
            </button>
          </form>
        </dialog>
      )}

      {/* Remove address dialog */}
      {removingAddress && (
        <dialog
          className="remove-dialog"
          aria-labelledby="remove-address-title"
          aria-describedby="remove-address-description"
          ref={element => {
            if (element && !element.open) element.showModal();
          }}
          onClose={() => setRemovingAddress(null)}
        >
          <h2 id="remove-address-title">Remove address?</h2>
          <p id="remove-address-description">
            <strong>{removingAddress}</strong> will be removed from Addresses and its settings
            cleared. Existing email stays in your inbox. The address will reappear if it receives
            new mail.
          </p>
          <form
            method="dialog"
            className="compact"
            onSubmit={event => {
              if (
                (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') !== 'remove'
              )
                return;
              event.preventDefault();
              if (addressRemovalPending) return;
              setAddressRemovalPending(true);
              void action(async () => {
                try {
                  await api(
                    '/inboxes?' + new URLSearchParams({ address: removingAddress }),
                    'DELETE'
                  );
                  setRuleAddress('');
                  setRemovingAddress(null);
                  await directory();
                } catch (cause) {
                  setRemovingAddress(null);
                  throw cause;
                } finally {
                  setAddressRemovalPending(false);
                }
              }, 'Address removed');
            }}
          >
            <button autoFocus disabled={addressRemovalPending}>
              Cancel
            </button>
            <button
              value="remove"
              className="danger-action"
              disabled={addressRemovalPending}
            >
              Remove address
            </button>
          </form>
        </dialog>
      )}

      {/* Remove domain dialog */}
      {removing && (
        <dialog
          className="remove-dialog"
          aria-labelledby="remove-title"
          ref={element => {
            if (element && !element.open) element.showModal();
          }}
          onClose={() => setRemoving(null)}
        >
          <h2 id="remove-title">Remove {removing}?</h2>
          <p>
            Letterdock stops accepting new messages for this domain. Existing messages and
            Cloudflare records stay in place.
          </p>
          <form method="dialog" className="compact">
            <button autoFocus>Cancel</button>
            <button
              type="button"
              className="danger-action"
              onClick={() =>
                void action(async () => {
                  await api('/domains/' + encodeURIComponent(removing), 'DELETE');
                  setCloudflare(previous =>
                    Object.fromEntries(
                      Object.entries(previous).filter(([name]) => name !== removing)
                    )
                  );
                  setRemoving(null);
                  await refresh();
                }, 'Domain removed')
              }
            >
              Remove domain
            </button>
          </form>
        </dialog>
      )}

      {/* Outbound Email Compose Modal */}
      <ComposeModal
        isOpen={composeOpen}
        onClose={() => setComposeOpen(false)}
        domains={domains}
        onNotice={msg => setNotice(msg)}
        onError={msg => setError(msg)}
      />

      {/* Keyboard Shortcuts Reference Modal */}
      <ShortcutsModal
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
    </div>
  );
}
