import React, { useState, useEffect } from 'react';
import { Copy, Check, RefreshCw, Zap, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { Domain, DnsStatusReport, SyncDnsReport } from '../../types/index.js';
import { api } from '../../api/client.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';

interface DnsRecordTableProps {
  domain: Domain;
  check?: import('../../types/index.js').CloudflareStatus;
  busy?: string;
  onCheckDns?: () => void;
  onSynced?: () => void;
}

interface RequiredRecord {
  type: 'TXT' | 'MX';
  host: string;
  fqdn: string;
  value: string;
  priority?: number;
  purpose: string;
}

export const DnsRecordTable: React.FC<DnsRecordTableProps> = ({ domain, check, busy, onCheckDns, onSynced }) => {
  const [status, setStatus] = useState<DnsStatusReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Sync options: explicitly default to false to protect existing mail delivery
  const [replaceConflictingMx, setReplaceConflictingMx] = useState(false);
  const [syncSpf, setSyncSpf] = useState(true);
  const [syncDmarc, setSyncDmarc] = useState(true);

  const requiredRecords: RequiredRecord[] = [
    {
      type: 'TXT',
      host: '_letterdock',
      fqdn: '_letterdock.' + domain.name,
      value: 'letterdock=' + domain.token,
      purpose: 'Domain Ownership Verification'
    },
    {
      type: 'MX',
      host: '@',
      fqdn: domain.name,
      value: 'route1.mx.cloudflare.net',
      priority: 49,
      purpose: 'Inbound Email Routing (Primary)'
    },
    {
      type: 'MX',
      host: '@',
      fqdn: domain.name,
      value: 'route2.mx.cloudflare.net',
      priority: 78,
      purpose: 'Inbound Email Routing (Secondary)'
    },
    {
      type: 'MX',
      host: '@',
      fqdn: domain.name,
      value: 'route3.mx.cloudflare.net',
      priority: 41,
      purpose: 'Inbound Email Routing (Tertiary)'
    },
    {
      type: 'TXT',
      host: '@',
      fqdn: domain.name,
      value: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
      purpose: 'SPF Sender Policy'
    },
    {
      type: 'TXT',
      host: '_dmarc',
      fqdn: '_dmarc.' + domain.name,
      value: 'v=DMARC1; p=none; rua=mailto:postmaster@' + domain.name,
      purpose: 'DMARC Security Policy'
    }
  ];

  async function fetchStatus() {
    setLoading(true);
    try {
      const res = await api<DnsStatusReport>('/domains/' + encodeURIComponent(domain.name) + '/cloudflare/dns');
      setStatus(res);
      // Explicit opt-in safety: NEVER automatically check replaceConflictingMx
    } catch (err) {
      // If we already have a success message from an immediate sync, keep it coherent
      const msg = err instanceof Error ? err.message : 'Could not query Cloudflare DNS';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchStatus();
  }, [domain.name]);

  async function handleCopy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setSuccess(null);
    try {
      const report = await api<SyncDnsReport>(
        '/domains/' + encodeURIComponent(domain.name) + '/cloudflare/dns/sync',
        'POST',
        {
          replaceConflictingMx,
          syncSpf,
          syncDmarc
        }
      );
      setError(null);
      setSuccess(
        report.message ||
        'Cloudflare DNS synchronized successfully. Public DNS propagation may take a few minutes.'
      );
      await fetchStatus();
      if (onSynced) onSynced();
    } catch (err) {
      setSuccess(null);
      setError(err instanceof Error ? err.message : 'DNS synchronization failed');
    } finally {
      setSyncing(false);
      // Restore focus to sync button after busy state ends
      setTimeout(() => {
        const btn = document.querySelector<HTMLButtonElement>('.dns-sync-button');
        btn?.focus();
      }, 50);
    }
  }

  function getRecordStatus(record: RequiredRecord): { variant: 'ok' | 'warn' | 'error' | 'neutral'; label: string } {
    if (!status) {
      return domain.verified && record.type === 'TXT' && record.host.startsWith('_letterdock')
        ? { variant: 'ok', label: 'Verified' }
        : { variant: 'neutral', label: 'Checking…' };
    }

    if (record.type === 'TXT' && record.host.startsWith('_letterdock')) {
      const found = status.records.find(r => r.type === 'TXT' && r.name.startsWith('_letterdock'));
      if (found?.status === 'synced') return { variant: 'ok', label: 'Synced' };
      if (found?.status === 'conflicted') return { variant: 'error', label: 'Conflict' };
      return { variant: 'warn', label: 'Missing' };
    }

    if (record.type === 'MX') {
      const found = status.records.find(
        r => r.type === 'MX' && r.expected === record.value && r.expectedPriority === record.priority
      );
      if (found?.status === 'synced') return { variant: 'ok', label: 'Synced' };
      return { variant: 'warn', label: 'Missing' };
    }

    if (record.type === 'TXT' && (record.host === '@' || record.fqdn === domain.name)) {
      if (status.spf.status === 'synced') return { variant: 'ok', label: 'Synced' };
      if (status.spf.status === 'needs_merge') return { variant: 'warn', label: 'Needs merge' };
      return { variant: 'warn', label: 'Missing' };
    }

    if (record.type === 'TXT' && record.host.startsWith('_dmarc')) {
      if (status.dmarc.status === 'synced') return { variant: 'ok', label: 'Synced' };
      return { variant: 'warn', label: 'Missing' };
    }

    return { variant: 'neutral', label: 'Pending' };
  }

  return (
    <div className="dns-sync-container">
      <div className="dns-sync-header">
        <div className="dns-sync-title">
          <ShieldCheck size={16} className="text-accent" />
          <h3>DNS records</h3>
        </div>
        <button
          type="button"
          className="button size-sm"
          disabled={loading || syncing || Boolean(busy)}
          onClick={() => {
            void fetchStatus();
            if (onCheckDns) onCheckDns();
          }}
          title="Check and refresh DNS status"
        >
          <RefreshCw size={13} className={loading || busy ? 'spin' : ''} />
          <span>Check DNS</span>
        </button>
      </div>

      {busy && <p role="status" className="dns-busy-hint">{busy}</p>}

      {!status && check?.message && (
        <p className="dns-check-message" role="status">
          {check.message}
        </p>
      )}

      {status?.hasConflicts && (
        <div className="dns-conflict-banner" role="alert">
          <AlertTriangle size={16} className="conflict-icon" />
          <div className="conflict-details">
            <strong>Conflicting Mail Service Detected</strong>
            <p>
              Existing external MX records found:{' '}
              <code>{status.conflicts.map(c => c.content + (c.priority ? ' (prio ' + c.priority + ')' : '')).join(', ')}</code>.
              Check &quot;Replace conflicting external MX records&quot; below only if you wish to route all inbound emails to LetterDock.
            </p>
          </div>
        </div>
      )}

      {error && !success && (
        <div className="dns-status-alert error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="dns-status-alert success" role="status">
          <Check size={15} />
          <span>{success}</span>
        </div>
      )}

      <div className="table-responsive dns-table-wrapper">
        <table className="dns-record-table">
          <thead>
            <tr>
              <th scope="col" style={{ width: '60px' }}>Type</th>
              <th scope="col" style={{ width: '150px' }}>Host / Name</th>
              <th scope="col">Value / Target</th>
              <th scope="col" style={{ width: '65px' }}>Prio</th>
              <th scope="col" style={{ width: '110px' }}>Status</th>
              <th scope="col" style={{ width: '70px', textAlign: 'center' }}>Copy</th>
            </tr>
          </thead>
          <tbody>
            {requiredRecords.map((rec, idx) => {
              const statusBadge = getRecordStatus(rec);
              const copyId = rec.type + '-' + idx;
              const isCopied = copiedKey === copyId;

              return (
                <tr key={idx}>
                  <td>
                    <span className="record-type-tag">{rec.type}</span>
                  </td>
                  <td>
                    <div className="record-host-cell">
                      <code className="record-mono host-tag" title={rec.fqdn}>{rec.host}</code>
                      <span className="record-fqdn">{rec.fqdn}</span>
                    </div>
                  </td>
                  <td>
                    <div className="record-value-cell">
                      <code className="record-mono" title={rec.value}>{rec.value}</code>
                      <span className="record-purpose">{rec.purpose}</span>
                    </div>
                  </td>
                  <td className="text-center">
                    <span className="record-prio">{rec.priority ?? '—'}</span>
                  </td>
                  <td>
                    <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
                  </td>
                  <td className="text-center">
                    <button
                      type="button"
                      className="button icon size-sm dns-copy-btn"
                      onClick={() => handleCopy(copyId, rec.value)}
                      title="Copy record value"
                      aria-label={'Copy ' + rec.host + ' value'}
                    >
                      {isCopied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="dns-sync-toolbar">
        <div className="dns-sync-options">
          {status?.hasConflicts && (
            <label className="dns-option-label danger-option">
              <input
                type="checkbox"
                checked={replaceConflictingMx}
                onChange={e => setReplaceConflictingMx(e.target.checked)}
              />
              <span>Replace conflicting external MX records (permanent: inbound mail switches to LetterDock)</span>
            </label>
          )}
          <label className="dns-option-label">
            <input
              type="checkbox"
              checked={syncSpf}
              onChange={e => setSyncSpf(e.target.checked)}
            />
            <span>Include SPF</span>
          </label>
          <label className="dns-option-label">
            <input
              type="checkbox"
              checked={syncDmarc}
              onChange={e => setSyncDmarc(e.target.checked)}
            />
            <span>Include DMARC</span>
          </label>
        </div>

        <Button
          variant="primary"
          size="sm"
          busy={syncing}
          onClick={handleSync}
          className="dns-sync-button"
        >
          <Zap size={14} />
          <span>1-Click Cloudflare DNS Sync</span>
        </Button>
      </div>
    </div>
  );
};
