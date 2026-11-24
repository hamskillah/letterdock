import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);
    CREATE TABLE IF NOT EXISTS domains (
      name text PRIMARY KEY, token uuid NOT NULL DEFAULT gen_random_uuid(),
      verified boolean NOT NULL DEFAULT false, last_received timestamptz, retention_days integer
    );
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS removed_at timestamptz;
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS prune_days integer CHECK (prune_days BETWEEN 1 AND 3650);
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS delivery_test_address text;
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS delivery_test_expires timestamptz;
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS delivery_verified_at timestamptz;
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY, domain text NOT NULL REFERENCES domains(name),
      recipient text NOT NULL, sender text NOT NULL, raw bytea NOT NULL,
      subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', html text NOT NULL DEFAULT '',
      headers jsonb NOT NULL DEFAULT '{}', message_id text, state text NOT NULL DEFAULT 'pending',
      error text, received timestamptz NOT NULL DEFAULT now(), unread boolean NOT NULL DEFAULT true,
      starred boolean NOT NULL DEFAULT false, folder text NOT NULL DEFAULT 'inbox',
      labels text[] NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS messages_received ON messages(received DESC, id DESC);
    CREATE INDEX IF NOT EXISTS messages_domain_received ON messages(domain,received,id);
    CREATE INDEX IF NOT EXISTS messages_pending ON messages(id) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient);
    CREATE INDEX IF NOT EXISTS messages_search ON messages USING gin (
      to_tsvector('simple', sender || ' ' || recipient || ' ' || subject || ' ' || body)
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename text NOT NULL, mime text NOT NULL, data bytea NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message);
    CREATE TABLE IF NOT EXISTS inboxes (
      address text PRIMARY KEY, name text NOT NULL DEFAULT '', pinned boolean NOT NULL DEFAULT false
    );
    ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS removed_at timestamptz;
    CREATE TABLE IF NOT EXISTS blocks (sender text PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, hash text NOT NULL UNIQUE
    );
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS domain text REFERENCES domains(name);
    CREATE TABLE IF NOT EXISTS hooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text NOT NULL, secret text NOT NULL,
      filter text NOT NULL DEFAULT ''
    );
    ALTER TABLE hooks ADD COLUMN IF NOT EXISTS address_only boolean NOT NULL DEFAULT false;
    ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS auto_label text;
    ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS webhook_id uuid REFERENCES hooks(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS inboxes_webhook ON inboxes(webhook_id) WHERE webhook_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hook uuid NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
      message uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE, attempts integer NOT NULL DEFAULT 0,
      next_attempt timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'pending',
      UNIQUE(hook, message)
    );
    CREATE TABLE IF NOT EXISTS delivery_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      delivery uuid REFERENCES deliveries(id) ON DELETE CASCADE, result text NOT NULL,
      attempted timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ingest_log (
      id uuid PRIMARY KEY, recipient text NOT NULL, status text NOT NULL, time timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS domain text;
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS bytes bigint NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS ingest_log_activity ON ingest_log(domain,time DESC,id DESC);
    CREATE INDEX IF NOT EXISTS ingest_log_domain_time ON ingest_log(domain,time) WHERE status='stored';
    CREATE INDEX IF NOT EXISTS ingest_log_rejected_time ON ingest_log(time) WHERE status<>'stored';
  `);
}
