import React, { useEffect, useState } from 'react';
import type { Domain, DeliveryHealth } from '../../types/index.js';
import { api, when } from '../../api/client.js';

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

export const DeliveryPanel: React.FC<{ domain: Domain }> = ({ domain }) => {
  const [health, setHealth] = useState<DeliveryHealth | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const path = '/domains/' + encodeURIComponent(domain.name) + '/delivery-health';
  const test = health ?? domain;
  const address = test.delivery_test_address;
  const pending = Boolean(address && !test.delivery_verified_at && !test.test_expired);

  useEffect(() => {
    if (busy || !pending) return;
    let current = true;
    let timer: number;
    async function check() {
      if (!document.hidden) {
        try {
          const result = await api<DeliveryHealth>(path);
          if (current) {
            setHealth(result);
            setError('');
          }
        } catch (cause) {
          if (current)
            setError(cause instanceof Error ? cause.message : 'Could not check delivery.');
        }
      }
      if (current) timer = window.setTimeout(check, 5000);
    }
    timer = window.setTimeout(check, 5000);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [path, pending, busy]);

  async function load(start = false) {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      if (start) await api(path, 'POST');
      setHealth(await api<DeliveryHealth>(path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check delivery.');
    } finally {
      setBusy(false);
    }
  }

  const verified = test.delivery_verified_at;
  const lastReceived = health?.last_received ?? domain.last_received;
  const testState = verified
    ? 'Test email verified'
    : test.test_expired
    ? 'Test expired'
    : pending
    ? 'Waiting for test email'
    : '';

  return (
    <section className="dns-panel delivery-panel">
      <div className="dns-heading">
        <h3>Delivery health</h3>
        <button disabled={busy} onClick={() => void load()}>
          {health ? 'Refresh activity' : 'Check delivery'}
        </button>
      </div>
      <p>{lastReceived ? 'Last received ' + when(lastReceived) : 'No email received yet.'}</p>
      {!domain.verified && <p>Verify DNS before starting a delivery test.</p>}
      {domain.verified && !pending && (
        <button disabled={busy} onClick={() => void load(true)}>
          {address ? 'Start new test' : 'Start delivery test'}
        </button>
      )}
      <p role="status">
        {testState}
        {verified && ' · ' + when(verified)}
      </p>
      {error && <p role="alert">{error}</p>}
      {pending && address && (
        <>
          <p>
            Send an email from your usual mail app before{' '}
            {test.delivery_test_expires && when(test.delivery_test_expires)}. Use any subject.
          </p>
          <div className="compact">
            <code>{address}</code>
            {navigator.clipboard && (
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(address);
                    setCopied(true);
                  } catch {
                    setError('Select the address and copy it manually.');
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy address'}
              </button>
            )}
          </div>
          <p>
            Cloudflare must route this address to Letterdock. If the test stays pending, check the catch-all rule and recent activity.
          </p>
        </>
      )}
      {health?.staging_error && <p>Staging reported an issue. Check the Health page for details.</p>}
      {health && (
        <details>
          <summary>Recent delivery activity</summary>
          {health.activity.length ? (
            <ul className="delivery-activity">
              {health.activity.map(event => (
                <li key={event.id}>
                  <strong>{inboundStatus[event.status] ?? event.status}</strong>
                  <span>
                    {event.recipient} · {when(event.time)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No activity recorded for this domain.</p>
          )}
        </details>
      )}
    </section>
  );
};
