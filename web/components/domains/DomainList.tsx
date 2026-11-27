import React from 'react';
import { Globe, Trash2, ArrowUpRight } from 'lucide-react';
import type { Domain, CloudflareConnection, CloudflareStatus } from '../../types/index.js';
import { DeliveryPanel } from './DeliveryPanel.js';
import { DnsRecordTable } from './DnsRecordTable.js';

export interface DomainListProps {
  domains: Domain[];
  connection: CloudflareConnection | null;
  cloudflare: Record<string, CloudflareStatus>;
  domainBusy: Record<string, string>;
  manualDomain: string;
  cloudflarePanel: React.ReactNode;
  onAddDomain: (e: React.FormEvent<HTMLFormElement>) => void;
  onCheckCloudflare: (name: string) => void;
  onSetupDomain: (name: string) => void;
  onAuthorizeDomainConnect: (name: string) => void;
  onVerifyDns: (name: string) => void;
  onRefresh?: () => void;
  onSaveRetention: (e: React.FormEvent<HTMLFormElement>, name: string) => void;
  onRequestPrune: (name: string, days: number) => void;
  onTurnOffPrune: (name: string) => void;
  onRequestRemoveDomain: (name: string) => void;
  onManageAddresses: (domainName: string) => void;
}

export const DomainList: React.FC<DomainListProps> = ({
  domains,
  connection,
  cloudflare,
  domainBusy,
  manualDomain,
  cloudflarePanel,
  onAddDomain,
  onCheckCloudflare,
  onSetupDomain,
  onAuthorizeDomainConnect,
  onVerifyDns,
  onRefresh,
  onSaveRetention,
  onRequestPrune,
  onTurnOffPrune,
  onRequestRemoveDomain,
  onManageAddresses
}) => {
  return (
    <section className="settings domains-page">
      <header className="settings-heading">
        <span className="section-icon">
          <Globe size={21} />
        </span>
        <div>
          <h1>Domains</h1>
          <p>Connect domains you own and receive mail at any address.</p>
        </div>
      </header>

      {connection && !connection.configured && cloudflarePanel}

      <details className="domain-create" open={domains.length === 0 || undefined}>
        <summary>Add a domain</summary>
        <form className="settings-form domain-add" onSubmit={onAddDomain}>
          <label>
            Domain name
            <input name="name" placeholder="example.com" required />
          </label>
          <button className="primary">
            Add domain <ArrowUpRight size={15} />
          </button>
        </form>
      </details>

      {domains.length === 0 && (
        <div className="domain-empty">
          <Globe size={22} />
          <h2>No domains connected</h2>
          <p>Add a domain to check its DNS and set up inbound mail.</p>
        </div>
      )}

      {domains.map(item => {
        const check = cloudflare[item.name];
        const busy = domainBusy[item.name];

        return (
          <section className="domain-card" key={item.name}>
            <div className="domain-title">
              <div>
                <h2>{item.name}</h2>
                <span className={'status ' + (item.verified ? 'ok' : '')}>
                  {item.last_received
                    ? 'Receiving'
                    : item.verified
                    ? 'DNS verified'
                    : 'Setup required'}
                </span>
              </div>
              <button
                className="icon danger"
                type="button"
                aria-label={'Remove ' + item.name}
                onClick={() => onRequestRemoveDomain(item.name)}
              >
                <Trash2 size={17} />
              </button>
            </div>

            <DeliveryPanel domain={item} />

            <DnsRecordTable
              domain={item}
              check={check}
              busy={busy}
              onCheckDns={() => onCheckCloudflare(item.name)}
              onSynced={() => {
                if (onRefresh) onRefresh();
              }}
            />

            {check && (
              <div className="dns-panel public-dns-inspection">
                <div className="dns-heading">
                  <h3>Public DNS Resolution</h3>
                  <span className={`badge ${check.detected ? 'badge-ok' : 'badge-neutral'}`}>
                    {check.detected ? 'Cloudflare NS Active' : 'External / Pending NS'}
                  </span>
                </div>
                <p className="dns-status-note">
                  {check.detected
                    ? 'Authoritative public nameservers point to Cloudflare.'
                    : 'Public authoritative nameservers currently point to external DNS or are propagating. If you just synchronized records via Cloudflare, public DNS propagation typically completes within a few minutes.'}
                </p>
                <dl className="dns-data">
                  <dt>Public Nameservers</dt>
                  <dd>{check.dns.nameservers.join(', ') || 'None detected'}</dd>
                  <dt>Public MX</dt>
                  <dd>{check.dns.mx.join(', ') || 'No public MX found'}</dd>
                  <dt>Public Verification TXT</dt>
                  <dd>{check.dns.txtVerified ? 'Verified' : 'Pending resolution'}</dd>
                </dl>
              </div>
            )}

            <div className="compact domain-actions">
              {item.verified && (
                <button onClick={() => onManageAddresses(item.name)}>
                  Manage addresses <ArrowUpRight size={14} />
                </button>
              )}
              {check?.detected && !check.dns.txtVerified && (
                <button onClick={() => onAuthorizeDomainConnect(item.name)}>
                  Authorize verification DNS <ArrowUpRight size={14} />
                </button>
              )}
              {!item.verified && (
                <button
                  className="primary"
                  disabled={Boolean(busy) || Boolean(check?.applied)}
                  onClick={() => onSetupDomain(item.name)}
                >
                  Set up domain
                </button>
              )}
            </div>

            <details className="prune-settings">
              <summary>
                Auto-prune ·{' '}
                {item.prune_days === null ? 'Off' : `After ${item.prune_days} days`}
              </summary>
              <p>
                Permanently deletes older email and attachments across all folders for this domain.
              </p>
              <form
                className="settings-form"
                onSubmit={event => {
                  event.preventDefault();
                  const days = Number(new FormData(event.currentTarget).get('days'));
                  if (days !== item.prune_days) onRequestPrune(item.name, days);
                }}
              >
                <label>
                  Delete email older than (days)
                  <input
                    key={item.prune_days ?? 'off'}
                    type="number"
                    name="days"
                    min="1"
                    max="3650"
                    defaultValue={item.prune_days ?? ''}
                    placeholder="30"
                    required
                  />
                </label>
                <button>Review schedule</button>
                {item.prune_days !== null && (
                  <button
                    type="button"
                    onClick={() => onTurnOffPrune(item.name)}
                  >
                    Turn off
                  </button>
                )}
              </form>
            </details>

            <details open={manualDomain === item.name || undefined}>
              <summary>Advanced settings</summary>
              <ol>
                <li>
                  Add TXT <code>_letterdock.{item.name}</code> with value{' '}
                  <code>letterdock={item.token}</code>.
                </li>
                <li>
                  Configure an inbound route with your DNS and mail provider. This installation can verify Cloudflare Email Routing MX records.
                </li>
                <li>Verify DNS, then send a test email.</li>
              </ol>
              <div className="compact">
                {item.verified && (
                  <button
                    disabled={Boolean(busy)}
                    onClick={() => onSetupDomain(item.name)}
                  >
                    Re-run setup
                  </button>
                )}
                <button onClick={() => onVerifyDns(item.name)}>Verify DNS</button>
              </div>
              <form
                className="settings-form"
                onSubmit={e => onSaveRetention(e, item.name)}
              >
                <label>
                  Move to Trash after (days)
                  <input
                    name="days"
                    type="number"
                    min="1"
                    max="3650"
                    defaultValue={item.retention_days ?? ''}
                    placeholder="Keep indefinitely"
                  />
                </label>
                <button>Save</button>
              </form>
            </details>
          </section>
        );
      })}

      {connection?.configured && cloudflarePanel}
    </section>
  );
};
