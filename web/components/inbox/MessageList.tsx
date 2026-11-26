import React from 'react';
import { Search, Filter, X, Inbox, Mail, Star, Settings2, ArrowUpRight } from 'lucide-react';
import type { Message, Detail, Domain, Address } from '../../types/index.js';
import { emailDate, senderName } from '../../api/client.js';
import { trashRetentionDays } from '../../../src/trash-policy.js';

export interface MessageListProps {
  heading: string;
  folder: string;
  domain: string;
  address: string;
  starOnly: boolean;
  unreadOnly: boolean;
  query: string;
  filters: Record<string, string>;
  advanced: boolean;
  loading: boolean;
  messages: Message[];
  detail: Detail | null;
  selected: string[];
  bulkUpdating: boolean;
  more: boolean;
  domains: Domain[];
  visibleAddresses: Address[];
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onQueryChange: (q: string) => void;
  onClearQuery: () => void;
  onToggleAdvanced: () => void;
  onFiltersChange: (filters: Record<string, string>) => void;
  onClearFilters: () => void;
  onSetUnreadOnly: (unread: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onToggleSelect: (id: string) => void;
  onClearSelection: () => void;
  onBulkUpdate: (patch: { folder?: string; unread?: boolean }) => void;
  onPromptTrash: (ids: string[], bulk: boolean) => void;
  onOpenMessage: (message: Message) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onLoadOlder: () => void;
  onNavigate: (page: string) => void;
  onOpenAddressSettings?: (address: string) => void;
  startPress: (event: React.PointerEvent<HTMLButtonElement>, id: string) => void;
  movePress: (event: React.PointerEvent<HTMLButtonElement>) => void;
  cancelPress: () => void;
  heldMessageRef: React.MutableRefObject<string | null>;
}

export const MessageList: React.FC<MessageListProps> = ({
  heading,
  folder,
  domain,
  address,
  starOnly,
  unreadOnly,
  query,
  filters,
  advanced,
  loading,
  messages,
  detail,
  selected,
  bulkUpdating,
  more,
  domains,
  visibleAddresses,
  searchInputRef,
  onQueryChange,
  onClearQuery,
  onToggleAdvanced,
  onFiltersChange,
  onClearFilters,
  onSetUnreadOnly,
  onSelectAll,
  onToggleSelect,
  onClearSelection,
  onBulkUpdate,
  onPromptTrash,
  onOpenMessage,
  onToggleStar,
  onLoadOlder,
  onNavigate,
  onOpenAddressSettings,
  startPress,
  movePress,
  cancelPress,
  heldMessageRef
}) => {
  const allMessagesSelected = messages.length > 0 && selected.length === messages.length;
  const selectedIds = new Set(selected);
  const filtered = Boolean(query.trim() || unreadOnly || Object.values(filters).some(Boolean));

  return (
    <section className="message-list" aria-label="Message list">
      <div className="list-head">
        <div className="list-title">
          <h1>{heading}</h1>
          {!loading && messages.length > 0 && selected.length === 0 && (
            <span className="selection-hint" title="Hold a message or use Shift+Enter">
              Hold to select
            </span>
          )}
        </div>

        {address && visibleAddresses.some(item => item.address === address) && onOpenAddressSettings && (
          <button
            className="inbox-settings-link"
            onClick={() => onOpenAddressSettings(address)}
          >
            <Settings2 size={14} /> Address settings
          </button>
        )}

        {folder === 'trash' && (
          <p className="trash-note">
            Messages and attachments are permanently deleted after {trashRetentionDays} days in Trash.
          </p>
        )}

        <div className="search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchInputRef as any}
            aria-label="Search messages"
            aria-keyshortcuts="/"
            placeholder="Search messages…"
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.currentTarget.blur();
              }
            }}
          />
          {query ? (
            <button
              className="icon"
              aria-label="Clear search"
              onClick={onClearQuery}
            >
              <X size={15} />
            </button>
          ) : (
            <kbd aria-hidden="true">/</kbd>
          )}
          <button
            className={'icon ' + (advanced ? 'filter-active' : '')}
            aria-label="Search filters"
            aria-expanded={advanced}
            onClick={onToggleAdvanced}
          >
            <Filter size={17} />
          </button>
        </div>

        <div className="inbox-scope" aria-label="Read status">
          <button
            aria-pressed={!unreadOnly}
            onClick={() => onSetUnreadOnly(false)}
          >
            All messages
          </button>
          <button
            aria-pressed={unreadOnly}
            onClick={() => onSetUnreadOnly(true)}
          >
            Unread
          </button>
        </div>

        {advanced && (
          <div className="filters">
            {Object.entries(filters)
              .filter(([key]) => key !== 'attachment')
              .map(([key, value]) => (
                <label key={key}>
                  {key}
                  <input
                    type={['since', 'until'].includes(key) ? 'date' : 'text'}
                    value={value}
                    onChange={e => onFiltersChange({ ...filters, [key]: e.target.value })}
                  />
                </label>
              ))}
            <label className="check">
              <input
                type="checkbox"
                checked={filters.attachment === 'true'}
                onChange={e =>
                  onFiltersChange({ ...filters, attachment: e.target.checked ? 'true' : '' })
                }
              />
              Has attachment
            </label>
            <button onClick={onClearFilters}>Clear filters</button>
          </div>
        )}

        {!loading && selected.length > 0 && (
          <div className="bulk-toolbar">
            <label title="Select all loaded messages">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allMessagesSelected}
                disabled={bulkUpdating}
                ref={input => {
                  if (input) input.indeterminate = selected.length > 0 && !allMessagesSelected;
                }}
                onChange={e => onSelectAll(e.target.checked)}
              />
              Select all
            </label>
            <div className="compact">
              <span role="status">{selected.length} selected</span>
              <button
                className="clear-selection"
                disabled={bulkUpdating}
                onClick={onClearSelection}
              >
                Clear selection
              </button>
              <button
                disabled={bulkUpdating}
                onClick={() =>
                  onBulkUpdate({ folder: folder === 'inbox' ? 'archive' : 'inbox' })
                }
              >
                {folder === 'inbox' ? 'Archive' : 'Restore'}
              </button>
              <button
                disabled={bulkUpdating}
                onClick={() => onBulkUpdate({ unread: false })}
              >
                Mark read
              </button>
              {folder !== 'trash' && (
                <button
                  disabled={bulkUpdating}
                  onClick={() => onPromptTrash(selected, true)}
                >
                  Trash
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className={selected.length ? 'rows selecting' : 'rows'}>
        {loading ? (
          <p className="list-empty" role="status">
            Loading messages…
          </p>
        ) : messages.length === 0 ? (
          <div className="list-empty">
            <span>
              <Inbox size={22} />
            </span>
            <strong>
              {filtered
                ? 'No matching messages'
                : starOnly
                ? 'No starred messages'
                : folder === 'archive'
                ? 'Archive is empty'
                : folder === 'trash'
                ? 'Trash is empty'
                : 'No messages here'}
            </strong>
            {filtered && (
              <button onClick={onClearFilters}>Clear search and filters</button>
            )}
            {!filtered && folder === 'inbox' && !domains.length && (
              <button onClick={() => onNavigate('Domains')}>
                Connect a domain <ArrowUpRight size={14} />
              </button>
            )}
          </div>
        ) : (
          messages.map(message => (
            <div
              className={
                'message-row ' +
                (detail?.id === message.id ? 'chosen ' : '') +
                (message.unread ? 'unread' : '')
              }
              key={message.id}
            >
              {selected.length > 0 && (
                <input
                  type="checkbox"
                  aria-label={'Select ' + (message.subject || 'message')}
                  checked={selectedIds.has(message.id)}
                  disabled={bulkUpdating}
                  onChange={() => onToggleSelect(message.id)}
                />
              )}
              <button
                className="message-link"
                aria-current={detail?.id === message.id ? 'true' : undefined}
                aria-keyshortcuts="Shift+Enter"
                onPointerDown={event => startPress(event, message.id)}
                onPointerMove={movePress}
                onPointerUp={cancelPress}
                onPointerCancel={cancelPress}
                onPointerLeave={cancelPress}
                onContextMenu={event => event.preventDefault()}
                onKeyDown={event => {
                  if (event.key === 'Enter' && event.shiftKey && !bulkUpdating) {
                    event.preventDefault();
                    if (!event.repeat) onToggleSelect(message.id);
                  }
                  if (event.key === 'Escape' && selected.length && !bulkUpdating) {
                    event.preventDefault();
                    onClearSelection();
                  }
                }}
                onClick={event => {
                  if (event.detail > 0 && heldMessageRef.current === message.id) {
                    heldMessageRef.current = null;
                    return;
                  }
                  if (bulkUpdating) return;
                  if (selected.length) onToggleSelect(message.id);
                  else onOpenMessage(message);
                }}
              >
                <span className="row-meta">
                  <span className="row-sender">
                    <span className="unread-dot" aria-hidden="true" />
                    {message.unread && <span className="sr-only">Unread: </span>}
                    <span className="ellipsis" title={senderName(message.sender)}>
                      {senderName(message.sender)}
                    </span>
                  </span>
                  <time dateTime={message.received}>
                    {emailDate.format(new Date(message.received))}
                  </time>
                </span>
                <strong className="ellipsis">{message.subject || '(No subject)'}</strong>
                <small className="ellipsis">{message.recipient}</small>
              </button>

              <button
                className={'icon ' + (message.starred ? 'starred' : '')}
                aria-label={message.starred ? 'Remove star' : 'Star message'}
                onClick={() => onToggleStar(message.id, !message.starred)}
              >
                <Star
                  size={16}
                  fill={message.starred ? 'currentColor' : 'none'}
                />
              </button>
            </div>
          ))
        )}

        {more && (
          <button className="load-more" onClick={onLoadOlder}>
            Load older messages
          </button>
        )}
      </div>
    </section>
  );
};
