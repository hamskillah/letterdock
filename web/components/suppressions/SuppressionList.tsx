import React, { useEffect, useState } from 'react';
import { ShieldAlert, Plus, Trash2, Search } from 'lucide-react';
import { api, when } from '../../api/client.js';
import type { Suppression } from '../../types/index.js';
import { Modal } from '../ui/Modal.js';

export const SuppressionList: React.FC<{
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}> = ({ onError, onNotice }) => {
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newReason, setNewReason] = useState<'bounce' | 'complaint' | 'manual'>('manual');
  const [newDetails, setNewDetails] = useState('');
  const [saving, setSaving] = useState(false);

  async function loadSuppressions() {
    setLoading(true);
    try {
      const res = await api<{ suppressions: Suppression[] }>('/suppressions');
      setSuppressions(res.suppressions || []);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSuppressions();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/suppressions', 'POST', {
        email: newEmail.trim().toLowerCase(),
        reason: newReason,
        details: newDetails.trim()
      });
      onNotice(`${newEmail} added to suppression list.`);
      setModalOpen(false);
      setNewEmail('');
      setNewDetails('');
      await loadSuppressions();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(email: string) {
    if (!confirm(`Remove ${email} from suppression list? Future dispatches to this address will be permitted.`)) return;
    try {
      await api(`/suppressions/${encodeURIComponent(email)}`, 'DELETE');
      onNotice(`Suppression for ${email} removed.`);
      await loadSuppressions();
    } catch (e: any) {
      onError(e.message);
    }
  }

  const filtered = suppressions.filter(s =>
    s.email.toLowerCase().includes(search.toLowerCase()) ||
    s.details?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <section className="settings suppressions-page">
      <header className="settings-heading">
        <span className="section-icon">
          <ShieldAlert size={21} />
        </span>
        <div>
          <h1>Suppression List & Abuse Protection</h1>
          <p>Automated suppression barrier preventing sends to hard-bounced or spam-complaining recipients.</p>
        </div>
        <button
          type="button"
          className="button primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setModalOpen(true)}
        >
          <Plus size={15} />
          <span>Add Suppression</span>
        </button>
      </header>

      <section className="settings-panel">
        <div className="dns-heading">
          <h2>Active Suppressions ({filtered.length})</h2>
          <div className="compact">
            <input
              type="search"
              placeholder="Filter recipient or reason…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ minWidth: '260px' }}
            />
            <button type="button" onClick={loadSuppressions} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>

        {filtered.length === 0 && !loading && (
          <p className="empty-state">
            {search ? 'No suppressions match search query.' : 'No recipients currently suppressed in this workspace.'}
          </p>
        )}

        {filtered.length > 0 && (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Recipient Email</th>
                <th>Reason</th>
                <th>Details</th>
                <th>Domain</th>
                <th>Recorded At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td>
                    <strong className="mono">{s.email}</strong>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        s.reason === 'complaint'
                          ? 'badge-error'
                          : s.reason === 'bounce'
                          ? 'badge-warn'
                          : 'badge-neutral'
                      }`}
                    >
                      {s.reason.toUpperCase()}
                    </span>
                  </td>
                  <td>
                    <small>{s.details || '—'}</small>
                  </td>
                  <td>
                    <small>{s.domain || 'All'}</small>
                  </td>
                  <td>
                    <small>{when(s.created_at)}</small>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button icon danger"
                      title="Remove suppression"
                      onClick={() => handleRemove(s.email)}
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
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add Recipient to Suppression List"
        description="Prevent outbound dispatches to this email address across the active workspace."
      >
        <form onSubmit={handleAdd} className="settings-form">
          <label>
            Recipient Email Address
            <input
              type="email"
              required
              placeholder="user@example.com"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
            />
          </label>

          <label>
            Suppression Reason
            <select
              value={newReason}
              onChange={e => setNewReason(e.target.value as any)}
            >
              <option value="manual">Manual Suppression (Operator requested)</option>
              <option value="bounce">Hard Bounce (Invalid address / mailbox full)</option>
              <option value="complaint">Spam Complaint (Unsubscribe / report)</option>
            </select>
          </label>

          <label>
            Details / Notes
            <input
              type="text"
              placeholder="Operator notes or diagnostic code"
              value={newDetails}
              onChange={e => setNewDetails(e.target.value)}
            />
          </label>

          <div className="modal-footer">
            <button type="button" onClick={() => setModalOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? 'Adding…' : 'Suppress Recipient'}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
};
