import React, { useEffect, useState } from 'react';
import {
  Mail,
  ShieldCheck,
  RefreshCw,
  Plus,
  Trash2,
  Pause,
  Play,
  Check,
  Copy,
  ExternalLink,
  AlertTriangle,
  Lock,
  Layers,
  Info
} from 'lucide-react';
import type { ConnectedMailbox, OAuthProvidersResponse } from '../../types/index.js';

interface Props {
  api: <T = any>(path: string, method?: string, body?: any) => Promise<T>;
}

export const ConnectedMailboxesView: React.FC<Props> = ({ api }) => {
  const [providers, setProviders] = useState<OAuthProvidersResponse | null>(null);
  const [mailboxes, setMailboxes] = useState<ConnectedMailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [setupProvider, setSetupProvider] = useState<'google' | 'microsoft' | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [copiedUri, setCopiedUri] = useState<string | null>(null);
  const [disconnectPrompt, setDisconnectPrompt] = useState<{ id: string; email: string } | null>(null);
  const [deleteLocalData, setDeleteLocalData] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const redirectUri = typeof window !== 'undefined'
    ? `${window.location.origin}/api/oauth/${setupProvider || 'google'}/callback`
    : '';

  async function loadData() {
    setLoading(true);
    try {
      const [provData, mbData] = await Promise.all([
        api<OAuthProvidersResponse>('/oauth/providers'),
        api<ConnectedMailbox[]>('/connected-mailboxes')
      ]);
      setProviders(provData);
      setMailboxes(mbData);
    } catch (err: any) {
      setError(err.message || 'Failed to load mailboxes');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();

    // Check query params for OAuth return messages
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const connected = urlParams.get('connected');
      const err = urlParams.get('error');
      if (connected) {
        setNotice(`Successfully connected ${connected} in read-only mode.`);
        window.history.replaceState(null, '', window.location.pathname);
      }
      if (err) {
        setError(err);
        window.history.replaceState(null, '', window.location.pathname);
      }
    }
  }, []);

  async function handleConnect(provider: 'google' | 'microsoft') {
    if (!providers?.[provider]?.configured) {
      setSetupProvider(provider);
      setClientId('');
      setClientSecret('');
      return;
    }
    try {
      const { url } = await api<{ url: string }>(`/oauth/${provider}/authorize`);
      window.location.assign(url);
    } catch (err: any) {
      setError(err.message || 'Failed to initiate OAuth flow');
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!setupProvider) return;
    setSavingConfig(true);
    setError('');
    try {
      await api(`/oauth/providers/${setupProvider}`, 'POST', {
        clientId,
        clientSecret
      });
      setNotice(`${setupProvider === 'google' ? 'Google' : 'Microsoft'} OAuth credentials saved successfully.`);
      setSetupProvider(null);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to save credentials');
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleSync(id: string) {
    setSyncingId(id);
    setError('');
    try {
      const res = await api<{ ok: boolean; ingested: number; skipped: number }>(`/connected-mailboxes/${id}/sync`, 'POST');
      setNotice(`Sync completed: ${res.ingested} new message(s) ingested, ${res.skipped} skipped.`);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Sync failed');
    } finally {
      setSyncingId(null);
    }
  }

  async function handleToggleStatus(id: string) {
    try {
      await api(`/connected-mailboxes/${id}/toggle`, 'POST');
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to toggle mailbox status');
    }
  }

  async function handleConfirmDisconnect() {
    if (!disconnectPrompt) return;
    setDisconnecting(true);
    try {
      await api(`/connected-mailboxes/${disconnectPrompt.id}?deleteLocalData=${deleteLocalData ? 'true' : 'false'}`, 'DELETE');
      setNotice(`Disconnected mailbox ${disconnectPrompt.email}.`);
      setDisconnectPrompt(null);
      setDeleteLocalData(false);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect mailbox');
    } finally {
      setDisconnecting(false);
    }
  }

  function copyText(text: string) {
    void navigator.clipboard.writeText(text);
    setCopiedUri(text);
    setTimeout(() => setCopiedUri(null), 2500);
  }

  return (
    <div className="settings connected-mailboxes-view">
      <div className="settings-heading">
        <div>
          <h1>Connected Mailboxes</h1>
          <p>
            Connect Gmail and Outlook accounts via OAuth 2.0. Emails are ingested automatically into your workspace in <strong>read-only</strong> mode. Outbound sending from connected external mailboxes is strictly prevented.
          </p>
        </div>
      </div>

      {notice && (
        <div className="banner" role="status">
          {notice}
          <button className="icon" onClick={() => setNotice('')} aria-label="Dismiss">✕</button>
        </div>
      )}

      {error && (
        <div className="banner error" role="alert">
          {error}
          <button className="icon" onClick={() => setError('')} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Security Barrier Callout */}
      <div className="settings-panel security-callout-panel">
        <div className="panel-header-row">
          <div className="title-with-badge">
            <Lock size={18} className="text-accent" />
            <strong style={{ fontSize: '1rem' }}>Inbound-Only Security Assurance</strong>
            <span className="badge badge-success">Cryptographically Enforced</span>
          </div>
        </div>
        <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', margin: '0.5rem 0 0 0' }}>
          This integration requests only the <code>gmail.readonly</code> and <code>Mail.Read</code> scopes. The token endpoints actively verify that no compose or send privileges exist. Outbound relay remains available exclusively for your verified sovereign domains.
        </p>
      </div>

      {/* OAuth Providers Quick Connect Grid */}
      <div className="tailscale-status-grid">
        {/* Google Card */}
        <div className="status-metric" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              <span style={{ fontSize: '1.25rem' }}>🇬</span>
              <strong style={{ fontSize: '1.05rem' }}>Google Gmail</strong>
            </div>
            <span className={`badge ${providers?.google?.configured ? 'badge-success' : 'badge-neutral'}`}>
              {providers?.google?.configured ? 'Ready to Connect' : 'Needs Setup'}
            </span>
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.65rem 0 1rem 0' }}>
            Auto-sync emails from @gmail.com or Google Workspace via Google Identity OAuth 2.0.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="primary"
              onClick={() => handleConnect('google')}
              style={{ flex: 1, minWidth: '140px' }}
            >
              {providers?.google?.configured ? 'Connect Gmail' : 'Setup Credentials'}
            </button>
            {providers?.google?.configured && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  setSetupProvider('google');
                  setClientId(providers.google.clientId);
                  setClientSecret('');
                }}
                title="Edit Client ID / Secret"
              >
                Configure
              </button>
            )}
          </div>
        </div>

        {/* Microsoft Card */}
        <div className="status-metric" style={{ padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              <span style={{ fontSize: '1.25rem' }}>🇲</span>
              <strong style={{ fontSize: '1.05rem' }}>Microsoft Outlook</strong>
            </div>
            <span className={`badge ${providers?.microsoft?.configured ? 'badge-success' : 'badge-neutral'}`}>
              {providers?.microsoft?.configured ? 'Ready to Connect' : 'Needs Setup'}
            </span>
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.65rem 0 1rem 0' }}>
            Auto-sync emails from Outlook, Hotmail, or Microsoft 365 via Microsoft Entra ID.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="primary"
              onClick={() => handleConnect('microsoft')}
              style={{ flex: 1, minWidth: '140px' }}
            >
              {providers?.microsoft?.configured ? 'Connect Outlook' : 'Setup Credentials'}
            </button>
            {providers?.microsoft?.configured && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  setSetupProvider('microsoft');
                  setClientId(providers.microsoft.clientId);
                  setClientSecret('');
                }}
                title="Edit Client ID / Secret"
              >
                Configure
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Connected Mailboxes List */}
      <div className="settings-panel" style={{ marginTop: '1.5rem' }}>
        <div className="panel-header-row">
          <div>
            <h2>Active Connected Accounts ({mailboxes.length})</h2>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.88rem', color: 'var(--text-muted)' }}>
              Inbound emails received by these accounts appear seamlessly in your Letterdock Inbox.
            </p>
          </div>
          <button
            type="button"
            className="button"
            onClick={loadData}
            title="Refresh mailboxes"
            aria-label="Refresh connected mailboxes"
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        {mailboxes.length === 0 ? (
          <div className="empty-state" style={{ marginTop: '1rem', textAlign: 'center', padding: '2.5rem 1rem' }}>
            <Mail size={36} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', opacity: 0.6 }} />
            <h3 style={{ margin: '0 0 0.4rem 0' }}>No external mailboxes connected</h3>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', maxWidth: '420px', margin: '0 auto 1.25rem auto' }}>
              Connect your personal or work Gmail or Outlook account above to start receiving emails directly into Letterdock.
            </p>
          </div>
        ) : (
          <div className="table-responsive" style={{ marginTop: '1rem', overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '0.75rem 0.6rem' }}>Account</th>
                  <th style={{ textAlign: 'left', padding: '0.75rem 0.6rem' }}>Provider</th>
                  <th style={{ textAlign: 'left', padding: '0.75rem 0.6rem' }}>Policy</th>
                  <th style={{ textAlign: 'left', padding: '0.75rem 0.6rem' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '0.75rem 0.6rem' }}>Messages</th>
                  <th style={{ textAlign: 'left', padding: '0.75rem 0.6rem' }}>Last Synced</th>
                  <th style={{ textAlign: 'right', padding: '0.75rem 0.6rem' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map(mb => (
                  <tr key={mb.id} style={{ borderBottom: '1px solid var(--divider)' }}>
                    <td style={{ padding: '0.85rem 0.6rem' }}>
                      <div style={{ fontWeight: 600 }}>{mb.email}</div>
                      {mb.display_name && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{mb.display_name}</div>
                      )}
                      {mb.last_error && (
                        <div style={{ fontSize: '0.78rem', color: 'var(--danger)', marginTop: '0.2rem' }}>
                          {mb.last_error}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '0.85rem 0.6rem' }}>
                      <span className="badge badge-neutral" style={{ textTransform: 'capitalize' }}>
                        {mb.provider === 'google' ? 'Gmail' : 'Outlook'}
                      </span>
                    </td>
                    <td style={{ padding: '0.85rem 0.6rem' }}>
                      <span className="badge badge-success" title="Cannot be used for outbound sending">
                        Inbound Only
                      </span>
                    </td>
                    <td style={{ padding: '0.85rem 0.6rem' }}>
                      <span className={`badge ${
                        mb.status === 'active' ? 'badge-success' :
                        mb.status === 'paused' ? 'badge-warning' : 'badge-danger'
                      }`}>
                        {mb.status}
                      </span>
                    </td>
                    <td style={{ padding: '0.85rem 0.6rem' }}>
                      <strong>{mb.message_count ?? 0}</strong>
                    </td>
                    <td style={{ padding: '0.85rem 0.6rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {mb.last_synced_at ? new Date(mb.last_synced_at).toLocaleTimeString() : 'Pending'}
                    </td>
                    <td style={{ padding: '0.85rem 0.6rem', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="button icon"
                          title="Sync messages now"
                          disabled={syncingId === mb.id || mb.status === 'paused'}
                          onClick={() => handleSync(mb.id)}
                          aria-label="Sync now"
                        >
                          <RefreshCw size={15} className={syncingId === mb.id ? 'spin' : ''} />
                        </button>
                        <button
                          type="button"
                          className="button icon"
                          title={mb.status === 'active' ? 'Pause sync' : 'Resume sync'}
                          onClick={() => handleToggleStatus(mb.id)}
                          aria-label={mb.status === 'active' ? 'Pause sync' : 'Resume sync'}
                        >
                          {mb.status === 'active' ? <Pause size={15} /> : <Play size={15} />}
                        </button>
                        <button
                          type="button"
                          className="button icon danger"
                          title="Disconnect mailbox"
                          onClick={() => setDisconnectPrompt({ id: mb.id, email: mb.email })}
                          aria-label="Disconnect mailbox"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Provider Credentials Setup Modal */}
      {setupProvider && (
        <dialog
          className="remove-dialog"
          open
          style={{ maxWidth: '580px', width: '90%' }}
          aria-labelledby="setup-provider-title"
        >
          <h2 id="setup-provider-title">
            Configure {setupProvider === 'google' ? 'Google' : 'Microsoft'} OAuth Application
          </h2>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', margin: '0.5rem 0 1rem 0' }}>
            To enable 1-click login for your users, provide your OAuth 2.0 Client credentials. These are securely encrypted with AES-256-GCM in Letterdock.
          </p>

          <div style={{ background: 'var(--chrome)', padding: '0.85rem', borderRadius: 'var(--radius-md)', marginBottom: '1.25rem' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, display: 'block', marginBottom: '0.35rem' }}>
              Authorized Redirect URI:
            </span>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <code style={{ flex: 1, padding: '0.35rem 0.5rem', background: 'var(--surface)', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', overflowX: 'auto' }}>
                {redirectUri}
              </code>
              <button
                type="button"
                className="button icon"
                onClick={() => copyText(redirectUri)}
                title="Copy Redirect URI"
              >
                {copiedUri === redirectUri ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.4rem' }}>
              Copy and paste this exact Redirect URI into your {setupProvider === 'google' ? 'Google Cloud Console' : 'Azure Entra ID App Registration'}.
            </span>
          </div>

          <form onSubmit={handleSaveCredentials}>
            <label style={{ display: 'block', marginBottom: '0.85rem' }}>
              <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>Client ID:</span>
              <input
                type="text"
                required
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                placeholder={setupProvider === 'google' ? '123456789-xyz.apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000'}
                style={{ width: '100%', marginTop: '0.25rem' }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: '1.25rem' }}>
              <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>Client Secret:</span>
              <input
                type="password"
                required
                value={clientSecret}
                onChange={e => setClientSecret(e.target.value)}
                placeholder="••••••••••••••••••••••••"
                style={{ width: '100%', marginTop: '0.25rem' }}
              />
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem' }}>
              <button
                type="button"
                onClick={() => setSetupProvider(null)}
                disabled={savingConfig}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={savingConfig}
              >
                {savingConfig ? 'Saving…' : 'Save & Connect'}
              </button>
            </div>
          </form>
        </dialog>
      )}

      {/* Disconnect Confirmation Modal */}
      {disconnectPrompt && (
        <dialog className="remove-dialog" open aria-labelledby="disconnect-title">
          <h2 id="disconnect-title">Disconnect {disconnectPrompt.email}?</h2>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', margin: '0.5rem 0 1rem 0' }}>
            Letterdock will stop synchronizing new emails from this account.
          </p>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.25rem', cursor: 'pointer', fontSize: '0.88rem' }}>
            <input
              type="checkbox"
              checked={deleteLocalData}
              onChange={e => setDeleteLocalData(e.target.checked)}
            />
            <span>Also delete all locally downloaded emails and attachments from this account</span>
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem' }}>
            <button
              type="button"
              disabled={disconnecting}
              onClick={() => {
                setDisconnectPrompt(null);
                setDeleteLocalData(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={disconnecting}
              onClick={handleConfirmDisconnect}
            >
              {disconnecting ? 'Disconnecting…' : 'Confirm Disconnect'}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
};
