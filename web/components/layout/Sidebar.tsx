import React from 'react';
import {
  Inbox,
  Star,
  Archive,
  Trash2,
  Mail,
  Globe,
  Send,
  ShieldAlert,
  Key,
  Boxes,
  Radio,
  CircleGauge,
  BookOpen,
  LogOut,
  X,
  LayoutTemplate,
  Sliders,
  BarChart3,
  Layers
} from 'lucide-react';
import type { Domain, Address } from '../../types/index.js';

export interface SidebarProps {
  page: string;
  heading: string;
  folder: string;
  starOnly: boolean;
  domain: string;
  address: string;
  domains: Domain[];
  addresses: Address[];
  inboxUnread: number;
  mobileNav: boolean;
  closeMenuButtonRef: React.RefObject<HTMLButtonElement | null>;
  onCloseMobileNav: () => void;
  onMailbox: (folder?: string, domain?: string, address?: string, starOnly?: boolean) => void;
  onNavigate: (page: string) => void;
  onSignOut: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  page,
  heading,
  folder,
  starOnly,
  domain,
  address,
  domains,
  addresses,
  inboxUnread,
  mobileNav,
  closeMenuButtonRef,
  onCloseMobileNav,
  onMailbox,
  onNavigate,
  onSignOut
}) => {
  return (
    <>
      {mobileNav && (
        <div
          className="nav-scrim"
          aria-hidden="true"
          onClick={onCloseMobileNav}
        />
      )}
      <aside
        className="sidebar"
        id="workspace-navigation"
        role={mobileNav ? 'dialog' : undefined}
        aria-modal={mobileNav || undefined}
        aria-label="Letterdock navigation"
      >
        <div className="brand">
          <img
            className="brand-mark"
            src="/letterdock-mark.svg"
            width="36"
            height="36"
            alt=""
          />
          <span>Letterdock</span>
          <button
            className="icon mobile"
            aria-label="Close menu"
            ref={closeMenuButtonRef as any}
            onClick={onCloseMobileNav}
          >
            <X size={18} />
          </button>
        </div>

        <nav aria-label="Workspace">
          <span className="nav-caption">Mailbox</span>
          <button
            className={page === 'Inbox' && heading === 'Inbox' && !starOnly ? 'active' : ''}
            aria-current={page === 'Inbox' && heading === 'Inbox' && !starOnly ? 'page' : undefined}
            onClick={() => onMailbox('inbox')}
          >
            <Inbox size={17} />
            <span>Inbox</span>
            {inboxUnread > 0 && (
              <>
                <span className="inbox-badge" aria-hidden="true">
                  {inboxUnread > 99 ? '99+' : inboxUnread}
                </span>
                <span className="sr-only">, {inboxUnread} unread</span>
              </>
            )}
          </button>
          <button
            className={page === 'Inbox' && starOnly ? 'active' : ''}
            aria-current={page === 'Inbox' && starOnly ? 'page' : undefined}
            onClick={() => onMailbox('inbox', '', '', true)}
          >
            <Star size={17} />
            <span>Starred</span>
          </button>
          <button
            className={page === 'Inbox' && folder === 'archive' ? 'active' : ''}
            aria-current={page === 'Inbox' && folder === 'archive' ? 'page' : undefined}
            onClick={() => onMailbox('archive')}
          >
            <Archive size={17} />
            <span>Archive</span>
          </button>
          <button
            className={page === 'Inbox' && folder === 'trash' ? 'active' : ''}
            aria-current={page === 'Inbox' && folder === 'trash' ? 'page' : undefined}
            onClick={() => onMailbox('trash')}
          >
            <Trash2 size={17} />
            <span>Trash</span>
          </button>
          <button
            className={page === 'Addresses' ? 'active' : ''}
            aria-current={page === 'Addresses' ? 'page' : undefined}
            onClick={() => onNavigate('Addresses')}
          >
            <Mail size={17} />
            <span>Addresses</span>
          </button>

          <span className="nav-caption">Manage</span>
          <button
            className={page === 'ConnectedMailboxes' ? 'active' : ''}
            aria-current={page === 'ConnectedMailboxes' ? 'page' : undefined}
            onClick={() => onNavigate('ConnectedMailboxes')}
          >
            <Layers size={17} />
            <span>Connected Accounts</span>
          </button>
          <button
            className={page === 'Domains' ? 'active' : ''}
            aria-current={page === 'Domains' ? 'page' : undefined}
            onClick={() => onNavigate('Domains')}
          >
            <Globe size={17} />
            <span>Domains</span>
          </button>
          <button
            className={page === 'Outbound' ? 'active' : ''}
            aria-current={page === 'Outbound' ? 'page' : undefined}
            onClick={() => onNavigate('Outbound')}
          >
            <Send size={17} />
            <span>Outbound Relay</span>
          </button>
          <button
            className={page === 'Templates' ? 'active' : ''}
            aria-current={page === 'Templates' ? 'page' : undefined}
            onClick={() => onNavigate('Templates')}
          >
            <LayoutTemplate size={17} />
            <span>Templates</span>
          </button>
          <button
            className={page === 'Rules' ? 'active' : ''}
            aria-current={page === 'Rules' ? 'page' : undefined}
            onClick={() => onNavigate('Rules')}
          >
            <Sliders size={17} />
            <span>Rules</span>
          </button>
          <button
            className={page === 'Analytics' ? 'active' : ''}
            aria-current={page === 'Analytics' ? 'page' : undefined}
            onClick={() => onNavigate('Analytics')}
          >
            <BarChart3 size={17} />
            <span>Analytics</span>
          </button>
          <button
            className={page === 'Suppressions' ? 'active' : ''}
            aria-current={page === 'Suppressions' ? 'page' : undefined}
            onClick={() => onNavigate('Suppressions')}
          >
            <ShieldAlert size={17} />
            <span>Suppressions</span>
          </button>
          <button
            className={page === 'ApiKeys' ? 'active' : ''}
            aria-current={page === 'ApiKeys' ? 'page' : undefined}
            onClick={() => onNavigate('ApiKeys')}
          >
            <Key size={17} />
            <span>API Keys</span>
          </button>
          <button
            className={page === 'Integrations' ? 'active' : ''}
            aria-current={page === 'Integrations' ? 'page' : undefined}
            onClick={() => onNavigate('Integrations')}
          >
            <Boxes size={17} />
            <span>Integrations</span>
          </button>
          <button
            className={page === 'Tailscale' ? 'active' : ''}
            aria-current={page === 'Tailscale' ? 'page' : undefined}
            onClick={() => onNavigate('Tailscale')}
          >
            <Radio size={17} />
            <span>Tailscale</span>
          </button>
          <button
            className={page === 'Health' ? 'active' : ''}
            aria-current={page === 'Health' ? 'page' : undefined}
            onClick={() => onNavigate('Health')}
          >
            <CircleGauge size={17} />
            <span>Health</span>
          </button>

          <span className="nav-caption">Reference</span>
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="sidebar-link"
            title="Open interactive API documentation in new tab"
          >
            <BookOpen size={17} />
            <span>API Docs (/docs)</span>
          </a>

          {domains.length > 0 && <span className="nav-caption">Domains</span>}
          {domains.map(item => (
            <button
              title={item.name}
              key={item.name}
              className={domain === item.name && page === 'Inbox' ? 'active' : ''}
              aria-current={domain === item.name && page === 'Inbox' ? 'page' : undefined}
              onClick={() => onMailbox('inbox', item.name)}
            >
              <span className={'dot ' + (item.verified ? 'online' : '')} />
              <span className="ellipsis">{item.name}</span>
            </button>
          ))}

          {addresses.some(item => item.pinned) && (
            <span className="nav-caption">Pinned addresses</span>
          )}
          {addresses
            .filter(item => item.pinned)
            .map(item => (
              <button
                title={item.address}
                key={item.address}
                className={address === item.address && page === 'Inbox' ? 'active' : ''}
                aria-current={address === item.address && page === 'Inbox' ? 'page' : undefined}
                onClick={() => onMailbox('inbox', '', item.address)}
              >
                <Mail size={15} />
                <span className="ellipsis">{item.name || item.address}</span>
                {item.unread > 0 && <span className="address-count">{item.unread}</span>}
              </button>
            ))}
        </nav>

        <button className="signout" onClick={onSignOut}>
          <LogOut size={17} />
          <span>Sign out</span>
        </button>
      </aside>
    </>
  );
};
