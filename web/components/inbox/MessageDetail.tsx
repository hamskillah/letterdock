import React, { useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Paperclip,
  X
} from 'lucide-react';
import type { Detail } from '../../types/index.js';
import { when, senderName, emailDate } from '../../api/client.js';

export interface MessageDetailProps {
  detail: Detail;
  onBack: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onArchive: (id: string) => void;
  onTrash: (id: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onToggleUnread: (id: string, unread: boolean) => void;
  onBlockSender: (sender: string) => void;
  onUpdateLabels?: (id: string, label: string, remove?: boolean) => void;
  onPermanentlyDelete?: (id: string) => void;
  onRetryParsing?: (id: string) => void;
  onRefreshStatus?: (detail: Detail) => void;
}

export const MessageDetail: React.FC<MessageDetailProps> = ({
  detail,
  onBack,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onArchive,
  onTrash,
  onToggleStar,
  onToggleUnread,
  onBlockSender,
  onUpdateLabels,
  onPermanentlyDelete,
  onRetryParsing,
  onRefreshStatus
}) => {
  const [view, setView] = useState<'Message' | 'Plain text' | 'Headers' | 'Thread'>('Message');
  const [threadMessages, setThreadMessages] = useState<any[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<{ name: string; url: string } | null>(null);

  const cleanSender = senderName(detail.sender);

  return (
    <article>
      <div className="reader-actions">
        <button
          className="icon mobile"
          aria-label="Back to messages"
          onClick={onBack}
        >
          <ArrowLeft size={19} />
        </button>

        <button
          onClick={() => onArchive(detail.id)}
        >
          {detail.folder === 'inbox' ? 'Archive' : 'Restore'}
        </button>

        {detail.folder !== 'trash' ? (
          <button onClick={() => onTrash(detail.id)}>Trash</button>
        ) : (
          <button
            onClick={() => {
              if (confirm('Permanently delete this message?')) {
                onPermanentlyDelete?.(detail.id);
              }
            }}
          >
            Delete permanently
          </button>
        )}

        <details className="reader-more" key={detail.id}>
          <summary>More</summary>
          <div className="reader-more-panel">
            <button onClick={() => onToggleUnread(detail.id, !detail.unread)}>
              {detail.unread ? 'Mark read' : 'Mark unread'}
            </button>
            <button
              onClick={() =>
                setView(view === 'Plain text' ? 'Message' : 'Plain text')
              }
            >
              {view === 'Plain text' ? 'Show formatted message' : 'Plain text'}
            </button>
            <button
              onClick={() =>
                setView(view === 'Headers' ? 'Message' : 'Headers')
              }
            >
              {view === 'Headers' ? 'Hide headers' : 'Headers'}
            </button>
            <button
              onClick={async () => {
                if (view === 'Thread') {
                  setView('Message');
                } else {
                  setView('Thread');
                  setLoadingThread(true);
                  try {
                    const res = await fetch(`/api/messages/${detail.id}/thread`);
                    if (res.ok) {
                      const data = await res.json();
                      setThreadMessages(data.messages || []);
                    }
                  } catch (err) {
                    console.error('Failed to load thread', err);
                  } finally {
                    setLoadingThread(false);
                  }
                }
              }}
            >
              {view === 'Thread' ? 'Show single message' : 'Conversation thread'}
            </button>
            <a
              className="button"
              download={
                detail.subject ? `${detail.subject}.eml` : 'message.eml'
              }
              href={`/api/messages/${encodeURIComponent(detail.id)}/raw`}
            >
              Download original
            </a>
            <button onClick={() => onBlockSender(detail.sender)}>
              Block sender
            </button>
          </div>
        </details>

        <div className="reader-navigation">
          <button
            className="icon"
            aria-label="Previous message"
            disabled={!hasPrev}
            onClick={onPrev}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon"
            aria-label="Next message"
            disabled={!hasNext}
            onClick={onNext}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      <h2 className="subject">{detail.subject || '(No subject)'}</h2>

      <details className="message-details" key={detail.id}>
        <summary>
          <span className="ellipsis">{cleanSender}</span>
          <time dateTime={detail.received}>
            {emailDate.format(new Date(detail.received))}
          </time>
        </summary>
        <dl className="message-meta">
          <dt>From</dt>
          <dd>{detail.sender || 'Unknown sender'}</dd>
          <dt>Delivered to</dt>
          <dd>{detail.recipient}</dd>
          <dt>Received</dt>
          <dd>{when(detail.received)}</dd>
        </dl>
        <div className="label-list">
          {detail.labels.map(label => (
            <button
              key={label}
              onClick={() => onUpdateLabels?.(detail.id, label, true)}
            >
              {label}
              <X size={12} />
            </button>
          ))}
          <form
            className="compact"
            onSubmit={e => {
              e.preventDefault();
              const val = new FormData(e.currentTarget).get('label') as string;
              e.currentTarget.reset();
              if (val) onUpdateLabels?.(detail.id, val, false);
            }}
          >
            <input
              name="label"
              aria-label="New label"
              placeholder="Add label"
              required
              maxLength={60}
            />
            <button>Add</button>
          </form>
        </div>
      </details>

      {detail.attachments && detail.attachments.length > 0 && (
        <section className="attachments">
          <h3>Attachments</h3>
          {detail.attachments.map(item => (
            <div className="file" key={item.id}>
              <Paperclip size={17} />
              <span className="ellipsis">{item.filename}</span>
              <small>{Math.ceil(item.bytes / 1024)} KB</small>
              {/^image\/(png|jpeg|gif|webp)$/.test(item.mime) && (
                <button
                  onClick={async () => {
                    const response = await fetch('/api/files/' + item.id);
                    if (!response.ok) throw Error('Preview unavailable');
                    setPreviewAttachment({
                      name: item.filename,
                      url: URL.createObjectURL(
                        new Blob([await response.arrayBuffer()], { type: item.mime })
                      )
                    });
                  }}
                >
                  Preview
                </button>
              )}
              <a className="button" href={'/api/files/' + item.id} download={item.filename}>
                Download
              </a>
            </div>
          ))}
        </section>
      )}

      {view !== 'Message' && (
        <div className="reader-format">
          <strong>{view}</strong>
          <button onClick={() => setView('Message')}>Back to message</button>
        </div>
      )}

      {detail.state === 'failed' ? (
        <div className="error">
          <p>{detail.error}</p>
          <button onClick={() => onRetryParsing?.(detail.id)}>Retry parsing</button>
        </div>
      ) : detail.state === 'pending' ? (
        <button onClick={() => onRefreshStatus?.(detail)}>
          Refresh processing status
        </button>
      ) : view === 'Thread' ? (
        <div className="thread-view" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem 0' }}>
          {loadingThread ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>Loading conversation history...</p>
          ) : threadMessages.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No other messages in this conversation.</p>
          ) : (
            threadMessages.map((m, idx) => (
              <div
                key={m.id || idx}
                style={{
                  border: m.id === detail.id ? '2px solid var(--primary)' : '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '1rem',
                  background: m.type === 'outbound' ? 'var(--bg-subtle)' : 'var(--card-bg)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{
                      padding: '0.1rem 0.4rem',
                      borderRadius: '4px',
                      fontWeight: 600,
                      background: m.type === 'outbound' ? 'rgba(14, 165, 233, 0.15)' : 'rgba(34, 197, 94, 0.15)',
                      color: m.type === 'outbound' ? '#0284c7' : 'var(--success)'
                    }}>
                      {m.type === 'outbound' ? 'Sent (Outbound)' : 'Received (Inbound)'}
                    </span>
                    <strong>{m.sender}</strong> → <span>{m.recipient}</span>
                  </div>
                  <time style={{ color: 'var(--text-muted)' }}>{new Date(m.timestamp).toLocaleString()}</time>
                </div>
                <div style={{ fontSize: '0.9rem', lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>
                  {m.bodySnippet || (m.html ? 'Formatted message content' : '')}
                </div>
              </div>
            ))
          )}
        </div>
      ) : view === 'Headers' ? (
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {JSON.stringify(detail.headers, null, 2)}
        </pre>
      ) : view === 'Plain text' || !detail.html ? (
        <pre className="body-text mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {detail.body}
        </pre>
      ) : (
        <iframe
          title="Email body"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={
            '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:15px system-ui;line-height:1.65;margin:0;color:#252e29;overflow-wrap:anywhere}table{max-width:100%}</style>' +
            detail.html
          }
        />
      )}

      {previewAttachment && (
        <dialog
          className="modal-dialog"
          open
          onClose={() => {
            URL.revokeObjectURL(previewAttachment.url);
            setPreviewAttachment(null);
          }}
          style={{ maxWidth: '800px', textAlign: 'center' }}
        >
          <div className="modal-header">
            <h3>{previewAttachment.name}</h3>
            <button
              type="button"
              className="icon"
              onClick={() => {
                URL.revokeObjectURL(previewAttachment.url);
                setPreviewAttachment(null);
              }}
            >
              <X size={18} />
            </button>
          </div>
          <div style={{ padding: '1rem', overflow: 'auto' }}>
            <img
              src={previewAttachment.url}
              alt={previewAttachment.name}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          </div>
        </dialog>
      )}
    </article>
  );
};
