import React, { useState } from 'react';
import { Send, X, AlertCircle } from 'lucide-react';
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
  const defaultDomain = verifiedDomains[0]?.name || domains[0]?.name || '';

  const [fromAddress, setFromAddress] = useState(`notifications@${defaultDomain}`);
  const [toAddresses, setToAddresses] = useState('');
  const [ccAddresses, setCcAddresses] = useState('');
  const [bccAddresses, setBccAddresses] = useState('');
  const [subject, setSubject] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [sending, setSending] = useState(false);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
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
      onClose();
      // Reset fields
      setToAddresses('');
      setCcAddresses('');
      setBccAddresses('');
      setSubject('');
      setHtmlBody('');
    } catch (err: any) {
      onError(err.message);
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
            placeholder="recipient@example.com, colleague@example.com"
            onChange={e => setToAddresses(e.target.value)}
          />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <label>
            Cc (optional)
            <input
              type="text"
              value={ccAddresses}
              placeholder="cc@example.com"
              onChange={e => setCcAddresses(e.target.value)}
            />
          </label>
          <label>
            Bcc (optional)
            <input
              type="text"
              value={bccAddresses}
              placeholder="bcc@example.com"
              onChange={e => setBccAddresses(e.target.value)}
            />
          </label>
        </div>

        <label>
          Subject
          <input
            type="text"
            required
            value={subject}
            placeholder="Email Subject"
            onChange={e => setSubject(e.target.value)}
          />
        </label>

        <label>
          HTML Body
          <textarea
            rows={8}
            className="mono"
            required
            value={htmlBody}
            placeholder="<p>Hello world!</p>"
            onChange={e => setHtmlBody(e.target.value)}
          />
        </label>

        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={sending}>
            <Send size={15} />
            <span>{sending ? 'Sending…' : 'Send Message'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
