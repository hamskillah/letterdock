import React, { useState } from 'react';
import { Send, X } from 'lucide-react';
import { Modal } from '../ui/Modal.js';
import type { Domain } from '../../types/index.js';

export interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  domains: Domain[];
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

export const ComposeModal: React.FC<ComposeModalProps> = ({
  isOpen,
  onClose,
  domains,
  onNotice,
  onError
}) => {
  const verifiedDomains = domains.filter(d => d.verified);
  const defaultFrom = verifiedDomains.length > 0 ? `dispatch@${verifiedDomains[0].name}` : '';

  const [fromAddress, setFromAddress] = useState(defaultFrom);
  const [toAddresses, setToAddresses] = useState('');
  const [ccAddresses, setCcAddresses] = useState('');
  const [bccAddresses, setBccAddresses] = useState('');
  const [subject, setSubject] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');

  // Update defaultFrom if not set
  React.useEffect(() => {
    if (!fromAddress && verifiedDomains.length > 0) {
      setFromAddress(`dispatch@${verifiedDomains[0].name}`);
    }
  }, [verifiedDomains, fromAddress]);

  React.useEffect(() => {
    if (!isOpen) {
      setFormError('');
    }
  }, [isOpen]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setFormError('');

    try {
      const toList = toAddresses
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const ccList = ccAddresses
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const bccList = bccAddresses
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      if (!toList.length) {
        throw new Error('At least one recipient in To is required');
      }

      const res = await fetch('/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddress,
          to: toList,
          cc: ccList.length ? ccList : undefined,
          bcc: bccList.length ? bccList : undefined,
          subject,
          html: htmlBody || '<p></p>'
        })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.message || 'Failed to dispatch email');
      }

      onNotice(`Email dispatched successfully (ID: ${data.id})`);
      // Reset form on success
      setToAddresses('');
      setCcAddresses('');
      setBccAddresses('');
      setSubject('');
      setHtmlBody('');
      setFormError('');
      onClose();
    } catch (err: any) {
      setFormError(err.message || 'An error occurred during dispatch');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Compose Outbound Email"
      description="Send email via Letterdock outbound relay and Resend-compatible engine."
      maxWidth="680px"
    >
      <form onSubmit={handleSend} className="settings-form compose-form">
        {formError && (
          <div
            className="banner error compose-error"
            role="alert"
            style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>{formError}</span>
            <button
              type="button"
              className="icon"
              aria-label="Dismiss error"
              onClick={() => setFormError('')}
            >
              <X size={15} />
            </button>
          </div>
        )}

        <label>
          From
          <input
            type="text"
            required
            value={fromAddress}
            placeholder="Sender <sender@verified-domain.com>"
            onChange={e => setFromAddress(e.target.value)}
          />
        </label>

        <label>
          To (comma separated)
          <input
            type="text"
            required
            value={toAddresses}
            placeholder="alice@domain.com, bob@domain.com"
            onChange={e => setToAddresses(e.target.value)}
          />
        </label>

        <details className="compose-advanced">
          <summary>CC / BCC</summary>
          <div className="compact" style={{ marginTop: '0.5rem', display: 'flex', gap: '0.75rem', width: '100%' }}>
            <label style={{ flex: 1 }}>
              CC
              <input
                type="text"
                value={ccAddresses}
                placeholder="carol@domain.com"
                onChange={e => setCcAddresses(e.target.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              BCC
              <input
                type="text"
                value={bccAddresses}
                placeholder="audit@domain.com"
                onChange={e => setBccAddresses(e.target.value)}
              />
            </label>
          </div>
        </details>

        <label>
          Subject
          <input
            type="text"
            required
            value={subject}
            placeholder="Quarterly Ledger Update"
            onChange={e => setSubject(e.target.value)}
          />
        </label>

        <label>
          HTML Body
          <textarea
            rows={7}
            value={htmlBody}
            placeholder="<p>Enter email content here...</p>"
            onChange={e => setHtmlBody(e.target.value)}
            className="mono"
            style={{ width: '100%', resize: 'vertical' }}
          />
        </label>

        <div className="modal-footer" style={{ marginTop: '1rem' }}>
          <button type="button" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={sending}>
            <Send size={15} /> {sending ? 'Sending…' : 'Send Message'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
