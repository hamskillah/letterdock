import React from 'react';
import { Boxes } from 'lucide-react';
import type { Integration, Domain } from '../../types/index.js';
import { when } from '../../api/client.js';

export interface IntegrationsViewProps {
  integration?: Integration;
  domains: Domain[];
  credential: string;
  integrationForm: 'key' | 'hook' | null;
  webhookScope: string;
  onSetCredential: (s: string) => void;
  onSetIntegrationForm: (f: 'key' | 'hook' | null) => void;
  onSetWebhookScope: (s: string) => void;
  onCreateKey: (e: React.FormEvent<HTMLFormElement>) => void;
  onRevokeKey: (id: string) => void;
  onCreateHook: (e: React.FormEvent<HTMLFormElement>) => void;
  onRemoveHook: (id: string) => void;
  onReplay: (id: string) => void;
  onRefresh: () => void;
  onCopyCredential: () => void;
}

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({
  integration,
  domains,
  credential,
  integrationForm,
  webhookScope,
  onSetCredential,
  onSetIntegrationForm,
  onSetWebhookScope,
  onCreateKey,
  onRevokeKey,
  onCreateHook,
  onRemoveHook,
  onReplay,
  onRefresh,
  onCopyCredential
}) => {
  return (
    <section className="settings">
      <header className="settings-heading">
        <span className="section-icon">
          <Boxes size={21} />
        </span>
        <h1>Integrations</h1>
      </header>

      {credential && (
        <div className="secret">
          <strong>Copy this secret now</strong>
          <code>{credential}</code>
          <button onClick={onCopyCredential}>Copy</button>
          <button onClick={() => onSetCredential('')}>Dismiss</button>
        </div>
      )}

      <section className="settings-panel">
        <div className="dns-heading">
          <h2 id="api-key-heading">Read-only API keys</h2>
          <button
            aria-expanded={integrationForm === 'key'}
            onClick={() =>
              onSetIntegrationForm(integrationForm === 'key' ? null : 'key')
            }
          >
            {integrationForm === 'key' ? 'Cancel' : 'New API key'}
          </button>
        </div>

        {integration?.keys.length === 0 && (
          <p className="empty-state">No API keys yet.</p>
        )}

        {integrationForm === 'key' && (
          <form
            className="settings-form"
            aria-labelledby="api-key-heading"
            onSubmit={onCreateKey}
          >
            <label htmlFor="key-name">
              Key name
              <input id="key-name" name="name" autoFocus required maxLength={120} />
            </label>
            <label htmlFor="key-domain">
              Domain
              <select id="key-domain" name="domain" required defaultValue="">
                <option value="" disabled>
                  Select a verified domain
                </option>
                {domains
                  .filter(item => item.verified)
                  .map(item => (
                    <option key={item.name}>{item.name}</option>
                  ))}
              </select>
            </label>
            <button className="primary">Create key</button>
          </form>
        )}

        {integration?.keys.map(item => (
          <div className="settings-row compact" key={item.id}>
            <span className="integration-item">
              <strong>{item.name}</strong>
              <small>{item.domain ?? 'Disabled · Create a domain-scoped key'}</small>
            </span>
            <button onClick={() => onRevokeKey(item.id)}>Revoke</button>
          </div>
        ))}
      </section>

      <section className="settings-panel">
        <div className="dns-heading">
          <h2 id="webhook-heading">Webhooks</h2>
          <button
            aria-expanded={integrationForm === 'hook'}
            onClick={() => {
              onSetWebhookScope('all');
              onSetIntegrationForm(integrationForm === 'hook' ? null : 'hook');
            }}
          >
            {integrationForm === 'hook' ? 'Cancel' : 'New webhook'}
          </button>
        </div>

        {integration?.hooks.length === 0 && (
          <p className="empty-state">No webhooks yet.</p>
        )}

        {integrationForm === 'hook' && (
          <>
            <form
              className="settings-form"
              aria-labelledby="webhook-heading"
              onSubmit={onCreateHook}
            >
              <label>
                Public HTTPS endpoint
                <input name="url" type="url" autoFocus required />
              </label>
              <label>
                Receive events from
                <select
                  name="scope"
                  aria-describedby={
                    webhookScope === 'selected' ? 'webhook-scope-help' : undefined
                  }
                  value={webhookScope}
                  onChange={e => onSetWebhookScope(e.target.value)}
                >
                  <option value="all">All addresses</option>
                  <option value="filter">One domain or address</option>
                  <option value="selected">Selected addresses</option>
                </select>
              </label>
              {webhookScope === 'filter' && (
                <label>
                  Domain or address
                  <input name="filter" required placeholder="example.com" />
                </label>
              )}
              <button type="submit" className="primary">
                Add webhook
              </button>
            </form>
            {webhookScope === 'selected' && (
              <p id="webhook-scope-help" className="webhook-scope-help">
                Assign this webhook from the settings of each address.
              </p>
            )}
          </>
        )}

        {integration?.hooks.map(item => (
          <div className="settings-row compact" key={item.id}>
            <span className="integration-item">
              <code className="integration-endpoint">{item.url}</code>
              <small>
                {item.address_only
                  ? 'Selected addresses'
                  : item.filter || 'All addresses'}
              </small>
            </span>
            <button onClick={() => onRemoveHook(item.id)}>Remove</button>
          </div>
        ))}
      </section>

      <section className="settings-panel">
        <div className="dns-heading">
          <h2>Delivery attempts</h2>
          <button onClick={onRefresh}>Refresh history</button>
        </div>
        {integration?.deliveries.length === 0 && (
          <p className="empty-state">No deliveries yet.</p>
        )}
        {integration?.deliveries.map((item, index) => (
          <div className="settings-row compact" key={item.id + index}>
            <span className="integration-item">
              <code className="integration-endpoint">{item.url}</code>
              <small>
                {when(item.attempted)} · {item.result}
              </small>
            </span>
            {item.replayable ? (
              <button onClick={() => onReplay(item.id)}>Replay</button>
            ) : (
              <small>Original message deleted</small>
            )}
          </div>
        ))}
      </section>
    </section>
  );
};
