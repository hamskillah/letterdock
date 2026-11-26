import React, { useEffect, useState } from 'react';
import { Send, Plus, Trash2, CheckCircle2, ShieldAlert } from 'lucide-react';
import { api, when } from '../../api/client.js';
import type { OutboundProfile, Domain } from '../../types/index.js';
import { Modal } from '../ui/Modal.js';

export const OutboundConfig: React.FC<{
  domains: Domain[];
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}> = ({ domains, onError, onNotice }) => {
  const [profiles, setProfiles] = useState<OutboundProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Partial<OutboundProfile> | null>(null);
  const [provider, setProvider] = useState<'smtp' | 'resend' | 'ses' | 'brevo' | 'mock'>('smtp');
  const [domainName, setDomainName] = useState('');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [credsJson, setCredsJson] = useState('{}');
  const [saving, setSaving] = useState(false);

  async function loadProfiles() {
    setLoading(true);
    try {
      const res = await api<{ profiles: OutboundProfile[] }>('/outbound/profiles');
      setProfiles(res.profiles || []);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProfiles();
  }, []);

  function openCreate() {
    setEditingProfile(null);
    setProvider('smtp');
    setDomainName(domains[0]?.name || '');
    setFromName('');
    setFromEmail('');
    setIsDefault(false);
    setCredsJson('{\n  "host": "smtp.example.com",\n  "port": 587,\n  "user": "smtp_user",\n  "pass": "secret"\n}');
    setEditorOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      let credentials = {};
      try {
        credentials = JSON.parse(credsJson);
      } catch {
        throw new Error('Credentials must be valid JSON');
      }

      await api('/outbound/profiles', 'POST', {
        domain: domainName,
        provider,
        credentials,
        from_name: fromName,
        from_email: fromEmail,
        is_default: isDefault
      });
      onNotice(`Outbound profile for ${domainName} saved successfully.`);
      setEditorOpen(false);
      await loadProfiles();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(domain: string) {
    if (!confirm(`Delete outbound profile for ${domain}?`)) return;
    try {
      await api(`/outbound/profiles/${encodeURIComponent(domain)}`, 'DELETE');
      onNotice(`Profile for ${domain} deleted.`);
      await loadProfiles();
    } catch (err: any) {
      onError(err.message);
    }
  }

  return (
    <section className="settings outbound-page">
      <header className="settings-heading">
        <span className="section-icon">
          <Send size={21} />
        </span>
        <div>
          <h1>Outbound Relay Configuration</h1>
          <p>Configure SMTP, Resend, Brevo, or Mock relay profiles for verified domains.</p>
        </div>
        <button
          type="button"
          className="button primary"
          style={{ marginLeft: 'auto' }}
          onClick={openCreate}
        >
          <Plus size={15} />
          <span>New Profile</span>
        </button>
      </header>

      <section className="settings-panel">
        <div className="dns-heading">
          <h2>Configured Outbound Profiles</h2>
          <button type="button" onClick={loadProfiles} disabled={loading}>
            Refresh
          </button>
        </div>

        {profiles.length === 0 && !loading && (
          <p className="empty-state">
            No outbound relay profiles configured yet. Add a profile to send email via SMTP, Resend, or Brevo.
          </p>
        )}

        {profiles.length > 0 && (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Provider</th>
                <th>Sender</th>
                <th>Default</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.domain}</strong>
                  </td>
                  <td>
                    <span className="badge mono">{p.provider.toUpperCase()}</span>
                  </td>
                  <td>
                    {p.from_email ? (
                      <span>{p.from_name ? `${p.from_name} <${p.from_email}>` : p.from_email}</span>
                    ) : (
                      <small className="mono">Inherited</small>
                    )}
                  </td>
                  <td>
                    {p.is_default ? (
                      <span className="badge badge-ok">Default</span>
                    ) : (
                      <small>No</small>
                    )}
                  </td>
                  <td>
                    <small>{when(p.updated_at || p.created_at)}</small>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button icon danger"
                      title="Delete profile"
                      onClick={() => handleDelete(p.domain)}
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
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        title="Configure Outbound Relay Profile"
        description="Credentials are encrypted at rest with AES-256-GCM before database storage."
      >
        <form onSubmit={handleSave} className="settings-form">
          <label>
            Domain
            <input
              type="text"
              required
              value={domainName}
              placeholder="example.com"
              onChange={e => setDomainName(e.target.value.trim().toLowerCase())}
            />
          </label>

          <label>
            Provider
            <select
              value={provider}
              onChange={e => {
                const val = e.target.value as any;
                setProvider(val);
                if (val === 'smtp') {
                  setCredsJson('{\n  "host": "smtp.example.com",\n  "port": 587,\n  "user": "smtp_user",\n  "pass": "secret"\n}');
                } else if (val === 'resend') {
                  setCredsJson('{\n  "apiKey": "re_your_resend_key"\n}');
                } else if (val === 'brevo') {
                  setCredsJson('{\n  "apiKey": "xkeysib-your_brevo_key"\n}');
                } else {
                  setCredsJson('{}');
                }
              }}
            >
              <option value="smtp">Custom SMTP (Standard)</option>
              <option value="resend">Resend Relay API</option>
              <option value="brevo">Brevo Relay API</option>
              <option value="mock">Mock Relay (Testing / Dry-run)</option>
            </select>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <label>
              Default Sender Name
              <input
                type="text"
                placeholder="Support Team"
                value={fromName}
                onChange={e => setFromName(e.target.value)}
              />
            </label>
            <label>
              Default Sender Email
              <input
                type="email"
                placeholder={`noreply@${domainName || 'example.com'}`}
                value={fromEmail}
                onChange={e => setFromEmail(e.target.value)}
              />
            </label>
          </div>

          <label>
            Encrypted Provider Credentials (JSON)
            <textarea
              rows={5}
              className="mono"
              required
              value={credsJson}
              onChange={e => setCredsJson(e.target.value)}
            />
          </label>

          <label className="check" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={isDefault}
              onChange={e => setIsDefault(e.target.checked)}
            />
            <span>Set as default outbound profile for this workspace</span>
          </label>

          <div className="modal-footer">
            <button type="button" onClick={() => setEditorOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Profile'}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
};
