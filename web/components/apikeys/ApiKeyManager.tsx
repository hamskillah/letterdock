import React, { useEffect, useState } from 'react';
import { Key, Plus, Trash2, Copy, Check } from 'lucide-react';
import type { ApiKey, Domain } from '../../types/index.js';
import { Modal } from '../ui/Modal.js';
import { when } from '../../api/client.js';

export const ApiKeyManager: React.FC<{
  domains: Domain[];
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}> = ({ domains, onError, onNotice }) => {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [domainScope, setDomainScope] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadKeys() {
    setLoading(true);
    try {
      const res = await fetch('/api-keys');
      const data = await res.json();
      setKeys(data.data || []);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadKeys();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          domain: domainScope || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to generate API key');

      setCreatedSecret(data.token);
      setCreateOpen(false);
      setName('');
      setDomainScope('');
      await loadKeys();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string, keyName: string) {
    if (!confirm(`Revoke API key "${keyName}"? Applications using this key will immediately lose access.`)) return;
    try {
      const res = await fetch(`/api-keys/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to revoke API key');
      onNotice(`API key "${keyName}" revoked.`);
      await loadKeys();
    } catch (e: any) {
      onError(e.message);
    }
  }

  return (
    <section className="settings apikeys-page">
      <header className="settings-heading">
        <span className="section-icon">
          <Key size={21} />
        </span>
        <div>
          <h1>Sovereign API Keys</h1>
          <p>Generate drop-in Resend-compatible API keys (re_...) for your applications.</p>
        </div>
        <button
          type="button"
          className="button primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={15} />
          <span>Create API Key</span>
        </button>
      </header>

      <section className="settings-panel">
        <div className="dns-heading">
          <h2>Active API Keys ({keys.length})</h2>
          <button type="button" onClick={loadKeys} disabled={loading}>
            Refresh
          </button>
        </div>

        {keys.length === 0 && !loading && (
          <p className="empty-state">
            No API keys generated yet. Create a key to access the Resend-compatible API from your backend.
          </p>
        )}

        {keys.length > 0 && (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Key Name</th>
                <th>Domain Scope</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong>
                  </td>
                  <td>
                    {k.domain ? (
                      <span className="badge mono">{k.domain}</span>
                    ) : (
                      <span className="badge badge-ok">All Domains</span>
                    )}
                  </td>
                  <td>
                    <small>{when(k.created_at)}</small>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button icon danger"
                      title="Revoke key"
                      onClick={() => handleRevoke(k.id, k.name)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Resend-Compatible API Key"
        description="Generates an authorized re_... token with sha256 hash storage in PostgreSQL."
      >
        <form onSubmit={handleCreate} className="settings-form">
          <label>
            Key Name
            <input
              type="text"
              required
              placeholder="e.g. Production Backend, Next.js Ingress"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </label>

          <label>
            Domain Restriction (Optional)
            <select
              value={domainScope}
              onChange={e => setDomainScope(e.target.value)}
            >
              <option value="">All Domains in Workspace (Full Access)</option>
              {domains
                .filter(d => d.verified)
                .map(d => (
                  <option key={d.name} value={d.name}>
                    {d.name} (Restricted)
                  </option>
                ))}
            </select>
          </label>

          <div className="modal-footer">
            <button type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={creating}>
              {creating ? 'Generating…' : 'Generate Key'}
            </button>
          </div>
        </form>
      </Modal>

      {createdSecret && (
        <Modal
          isOpen={true}
          onClose={() => {
            setCreatedSecret(null);
            setCopied(false);
          }}
          title="Save Your API Key"
          description="This key will never be displayed again. Store it securely in your environment variables."
        >
          <div className="secret-box">
            <code className="mono">{createdSecret}</code>
            <button
              type="button"
              className="button icon"
              onClick={async () => {
                await navigator.clipboard.writeText(createdSecret);
                setCopied(true);
                onNotice('API key copied to clipboard');
              }}
              title="Copy to clipboard"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setCreatedSecret(null);
                setCopied(false);
              }}
            >
              I Have Saved This Key
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
};
