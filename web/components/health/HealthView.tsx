import React from 'react';
import { CircleGauge } from 'lucide-react';
import type { Health } from '../../types/index.js';
import { when } from '../../api/client.js';

const inboundStatus: Record<string, string> = {
  ready: 'In inbox',
  pending: 'Queued for processing',
  failed: 'MIME processing failed',
  stored: 'Previously stored',
  unknown_domain: 'Domain was inactive or unverified',
  blocked: 'Sender blocked',
  message_too_large: 'Message exceeds 20 MB',
  domain_quota: 'Deferred: daily domain quota',
  storage_quota: 'Deferred: storage limit'
};

export interface HealthViewProps {
  health?: Health;
  blocks: { sender: string }[];
  onRefresh: () => void;
  onBlockSender: (e: React.FormEvent<HTMLFormElement>) => void;
  onUnblockSender: (sender: string) => void;
}

export const HealthView: React.FC<HealthViewProps> = ({
  health,
  blocks,
  onRefresh,
  onBlockSender,
  onUnblockSender
}) => {
  return (
    <section className="settings">
      <header className="settings-heading health-heading">
        <span className="section-icon">
          <CircleGauge size={21} />
        </span>
        <h1>Health</h1>
        <button onClick={onRefresh}>Refresh</button>
      </header>

      {health && (
        <>
          <dl className="stats">
            <div>
              <dt>Free disk space</dt>
              <dd>{(health.free / 1024 ** 3).toFixed(1)} GiB</dd>
            </div>
            <div>
              <dt>Pending parsing</dt>
              <dd>
                {health.queues.find(row => row.state === 'pending')?.count ?? 0}
              </dd>
            </div>
            <div>
              <dt>Failed webhooks</dt>
              <dd>
                {health.deliveries.find(row => row.status === 'failed')?.count ?? 0}
              </dd>
            </div>
          </dl>

          {health.queues
            .filter(row => row.state !== 'ready')
            .map(row => (
              <p key={row.state}>
                Oldest {row.state} message · {when(row.oldest)}
              </p>
            ))}

          <section className="settings-panel">
            <h2>Staging connection</h2>
            <p>
              {!health.staging.configured
                ? 'R2 configuration required'
                : health.staging.error
                ? 'Staging error. Check application logs.'
                : health.staging.moreWaiting
                ? 'Importing staged messages'
                : 'Connected'}
              {health.staging.lastChecked &&
                ' · ' + when(health.staging.lastChecked)}
            </p>
            {health.deferred.length > 0 && (
              <ul className="delivery-activity">
                {health.deferred.map(item => (
                  <li key={item.status}>
                    {item.count} · {inboundStatus[item.status]}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="settings-panel">
        <h2>Blocked envelope senders</h2>
        <form className="settings-form" onSubmit={onBlockSender}>
          <label>
            Sender
            <input
              name="sender"
              type="email"
              placeholder="sender@example.com"
              required
            />
          </label>
          <button className="primary">Block</button>
        </form>
        {blocks.map(item => (
          <div className="settings-row compact" key={item.sender}>
            <span>{item.sender}</span>
            <button onClick={() => onUnblockSender(item.sender)}>Unblock</button>
          </div>
        ))}
      </section>

      {health && (
        <details className="settings-panel health-ingest">
          <summary>Recent ingest · {health.ingest.length}</summary>
          {health.ingest.length === 0 && (
            <p className="empty-state">No ingest activity yet.</p>
          )}
          {health.ingest.map(item => (
            <div className="settings-row compact" key={item.id}>
              <span>{item.recipient}</span>
              <small>
                {item.status} · {when(item.time)}
              </small>
            </div>
          ))}
        </details>
      )}
    </section>
  );
};
