import React from 'react';
import { Mail, Star, Settings2, ArrowUpRight, Trash2, Copy } from 'lucide-react';
import type { Address, Domain } from '../../types/index.js';

export interface AddressListProps {
  addresses: Address[];
  domains: Domain[];
  addressQuery: string;
  addressDomain: string;
  ruleAddress: string;
  ruleHooks: { id: string; url: string }[];
  onSetAddressQuery: (q: string) => void;
  onSetAddressDomain: (d: string) => void;
  onNavigate: (page: string) => void;
  onAddAddress: (e: React.FormEvent<HTMLFormElement>) => void;
  onTogglePin: (address: string, pinned: boolean) => void;
  onOpenSettings: (address: string) => void;
  onCloseSettings: () => void;
  onSaveSettings: (e: React.FormEvent<HTMLFormElement>, address: string) => void;
  onRequestRemoveAddress: (address: string) => void;
  onCopyAddress: (address: string) => void;
  onOpenInbox: (address: string) => void;
}

export const AddressList: React.FC<AddressListProps> = ({
  addresses,
  domains,
  addressQuery,
  addressDomain,
  ruleAddress,
  ruleHooks,
  onSetAddressQuery,
  onSetAddressDomain,
  onNavigate,
  onAddAddress,
  onTogglePin,
  onOpenSettings,
  onCloseSettings,
  onSaveSettings,
  onRequestRemoveAddress,
  onCopyAddress,
  onOpenInbox
}) => {
  const visibleAddresses = addresses.filter(item => !item.removed_at);
  const matchingAddresses = visibleAddresses.filter(item => {
    if (addressDomain && !item.address.endsWith('@' + addressDomain)) return false;
    if (!addressQuery) return true;
    const query = addressQuery.toLowerCase();
    return item.address.toLowerCase().includes(query) || item.name?.toLowerCase().includes(query);
  });

  return (
    <section className="settings addresses-page">
      <header className="settings-heading">
        <span className="section-icon">
          <Mail size={21} />
        </span>
        <div>
          <h1>Addresses</h1>
          <p>Create an inbox address or manage addresses discovered by catch-all.</p>
        </div>
      </header>

      {domains.some(item => item.verified) ? (
        <form className="address-add" onSubmit={onAddAddress}>
          <label>
            Address prefix
            <input
              name="local"
              placeholder="billing"
              required
              maxLength={64}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label>
            Receiving domain
            <select
              name="domain"
              required
              defaultValue={domains.find(item => item.verified)?.name}
            >
              {domains
                .filter(item => item.verified)
                .map(item => (
                  <option key={item.name}>{item.name}</option>
                ))}
            </select>
          </label>
          <label>
            Name <span className="optional">(optional)</span>
            <input name="name" placeholder="Billing" maxLength={120} />
          </label>
          <button className="primary">Add address</button>
        </form>
      ) : (
        <div className="domain-empty">
          <h2>Connect a receiving domain</h2>
          <p>Verify a domain before you add addresses.</p>
          <button onClick={() => onNavigate('Domains')}>
            Open Domains <ArrowUpRight size={14} />
          </button>
        </div>
      )}

      {visibleAddresses.length > 0 && (
        <div className="address-tools">
          <label>
            Find an address
            <input
              type="search"
              placeholder="Search by address or name"
              value={addressQuery}
              onChange={e => onSetAddressQuery(e.target.value)}
            />
          </label>
          <label>
            Domain
            <select
              value={addressDomain}
              onChange={e => onSetAddressDomain(e.target.value)}
            >
              <option value="">All domains</option>
              {[
                ...new Set([
                  ...domains.map(item => item.name),
                  ...visibleAddresses.map(item => item.address.split('@').at(-1)!)
                ])
              ]
                .sort()
                .map(item => (
                  <option key={item}>{item}</option>
                ))}
            </select>
          </label>
        </div>
      )}

      <div className="address-list">
        {matchingAddresses.map(item => (
          <article className="address-row" key={item.address}>
            <div className="address-identity">
              <Mail size={17} />
              <div>
                <h2>{item.name || item.address}</h2>
                {item.name && <p>{item.address}</p>}
                {(item.auto_label || item.webhook_id) && (
                  <p>
                    {[
                      item.auto_label && 'Auto-label: ' + item.auto_label,
                      item.webhook_id && 'Webhook assigned'
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
            </div>

            <div className="compact address-actions">
              {item.unread > 0 && (
                <span className="address-count">{item.unread} unread</span>
              )}
              <button
                className="icon"
                aria-label={item.pinned ? 'Unpin' : 'Pin'}
                title={item.pinned ? 'Unpin' : 'Pin'}
                aria-pressed={item.pinned}
                onClick={() => onTogglePin(item.address, !item.pinned)}
              >
                <Star size={16} fill={item.pinned ? 'currentColor' : 'none'} />
              </button>
              <button
                aria-expanded={ruleAddress === item.address}
                aria-controls={ruleAddress === item.address ? 'address-settings' : undefined}
                onClick={() => {
                  if (ruleAddress === item.address) onCloseSettings();
                  else onOpenSettings(item.address);
                }}
              >
                <Settings2 size={15} /> Settings
              </button>
              <button onClick={() => onOpenInbox(item.address)}>
                Open inbox <ArrowUpRight size={14} />
              </button>
            </div>

            {ruleAddress === item.address && (
              <form
                id="address-settings"
                aria-label={'Settings for ' + item.address}
                className="address-rules"
                onSubmit={e => onSaveSettings(e, item.address)}
              >
                <div className="address-settings-fields">
                  <label htmlFor="address-name">
                    Display name
                    <input
                      id="address-name"
                      name="name"
                      maxLength={120}
                      defaultValue={item.name}
                    />
                  </label>
                  <label htmlFor="rule-label">
                    Automatic label
                    <input
                      id="rule-label"
                      name="label"
                      maxLength={60}
                      defaultValue={item.auto_label ?? ''}
                      placeholder="None"
                    />
                  </label>
                  <label htmlFor="rule-webhook">
                    Webhook for new mail
                    <select
                      id="rule-webhook"
                      name="webhook"
                      defaultValue={item.webhook_id ?? ''}
                    >
                      <option value="">None</option>
                      {ruleHooks.map(hook => (
                        <option key={hook.id} value={hook.id}>
                          {hook.url}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="address-settings-footer">
                  <div className="compact">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => onRequestRemoveAddress(item.address)}
                    >
                      <Trash2 size={14} /> Remove address
                    </button>
                    <button
                      type="button"
                      onClick={() => onCopyAddress(item.address)}
                    >
                      <Copy size={14} /> Copy address
                    </button>
                    {ruleHooks.length === 0 && (
                      <button
                        type="button"
                        onClick={() => onNavigate('Integrations')}
                      >
                        Set up a webhook <ArrowUpRight size={14} />
                      </button>
                    )}
                  </div>
                  <div className="compact">
                    <button type="button" onClick={onCloseSettings}>
                      Cancel
                    </button>
                    <button type="submit" className="primary">
                      Save settings
                    </button>
                  </div>
                </div>
              </form>
            )}
          </article>
        ))}

        {matchingAddresses.length === 0 && (
          <p className="empty-state">
            {visibleAddresses.length
              ? 'No addresses match these filters.'
              : addresses.some(item => item.removed_at)
              ? 'No active addresses. Email from removed addresses is still available in the mailbox.'
              : 'No addresses yet. Add one above or receive an email at a new address.'}
          </p>
        )}
      </div>
    </section>
  );
};
