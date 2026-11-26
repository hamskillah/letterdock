import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);

    -- Multi-Tenancy & Workspace Foundation (Implicit Zero-State)
    CREATE TABLE IF NOT EXISTS workspaces (
      id text PRIMARY KEY,
      name text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO workspaces(id, name) VALUES ('default', 'Default Workspace')
      ON CONFLICT (id) DO NOTHING;

    -- Server-Side Session Management (Instant Revocation & Auditability)
    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id text NOT NULL DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
      admin_user_id text NOT NULL DEFAULT 'admin',
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      ip_address text,
      user_agent text
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace_id);

    CREATE TABLE IF NOT EXISTS domains (
      name text PRIMARY KEY, token uuid NOT NULL DEFAULT gen_random_uuid(),
      verified boolean NOT NULL DEFAULT false, last_received timestamptz, retention_days integer
    );
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS workspace_id text DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS removed_at timestamptz;
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS prune_days integer CHECK (prune_days BETWEEN 1 AND 3650);
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS delivery_test_address text;
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS delivery_test_expires timestamptz;
    ALTER TABLE domains ADD COLUMN IF NOT EXISTS delivery_verified_at timestamptz;

    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY, domain text NOT NULL REFERENCES domains(name),
      recipient text NOT NULL, sender text NOT NULL, raw bytea,
      subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', html text NOT NULL DEFAULT '',
      headers jsonb NOT NULL DEFAULT '{}', message_id text, state text NOT NULL DEFAULT 'pending',
      error text, received timestamptz NOT NULL DEFAULT now(), unread boolean NOT NULL DEFAULT true,
      starred boolean NOT NULL DEFAULT false, folder text NOT NULL DEFAULT 'inbox',
      labels text[] NOT NULL DEFAULT '{}'
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS workspace_id text DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS retention_exempt boolean NOT NULL DEFAULT false;
    ALTER TABLE messages ALTER COLUMN raw DROP NOT NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_storage_key text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_checksum_sha256 text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_size_bytes bigint;

    UPDATE messages SET trashed_at=now() WHERE folder='trash' AND trashed_at IS NULL;
    CREATE INDEX IF NOT EXISTS messages_trash_age ON messages(trashed_at,id) WHERE folder='trash';
    CREATE INDEX IF NOT EXISTS messages_received ON messages(received DESC, id DESC);
    CREATE INDEX IF NOT EXISTS messages_domain_received ON messages(domain,received,id);
    CREATE INDEX IF NOT EXISTS messages_pending ON messages(id) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient);
    CREATE INDEX IF NOT EXISTS messages_raw_storage_key ON messages(raw_storage_key) WHERE raw_storage_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_search ON messages USING gin (
      to_tsvector('simple', sender || ' ' || recipient || ' ' || subject || ' ' || body)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename text NOT NULL, mime text NOT NULL, data bytea
    );
    ALTER TABLE attachments ALTER COLUMN data DROP NOT NULL;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_key text;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS checksum_sha256 text;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS size_bytes bigint;

    CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message);
    CREATE INDEX IF NOT EXISTS attachments_storage_key ON attachments(storage_key) WHERE storage_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS inboxes (
      address text PRIMARY KEY, name text NOT NULL DEFAULT '', pinned boolean NOT NULL DEFAULT false
    );
    ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS workspace_id text DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS removed_at timestamptz;
    CREATE TABLE IF NOT EXISTS blocks (sender text PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, hash text NOT NULL UNIQUE
    );
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS workspace_id text DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS domain text REFERENCES domains(name);
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS hooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text NOT NULL, secret text NOT NULL,
      filter text NOT NULL DEFAULT ''
    );
    ALTER TABLE hooks ADD COLUMN IF NOT EXISTS workspace_id text DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE hooks ADD COLUMN IF NOT EXISTS address_only boolean NOT NULL DEFAULT false;
    ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS auto_label text;
    ALTER TABLE inboxes ADD COLUMN IF NOT EXISTS webhook_id uuid REFERENCES hooks(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS inboxes_webhook ON inboxes(webhook_id) WHERE webhook_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hook uuid NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
      message uuid REFERENCES messages(id) ON DELETE SET NULL, attempts integer NOT NULL DEFAULT 0,
      next_attempt timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'pending',
      UNIQUE(hook, message)
    );
    CREATE TABLE IF NOT EXISTS delivery_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      delivery uuid REFERENCES deliveries(id) ON DELETE CASCADE, result text NOT NULL,
      attempted timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS message_removed_at timestamptz;
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='deliveries'::regclass
                 AND conname='deliveries_message_fkey' AND confdeltype<>'n') THEN
        ALTER TABLE deliveries ALTER COLUMN message DROP NOT NULL;
        ALTER TABLE deliveries DROP CONSTRAINT deliveries_message_fkey;
        ALTER TABLE deliveries ADD CONSTRAINT deliveries_message_fkey
          FOREIGN KEY (message) REFERENCES messages(id) ON DELETE SET NULL;
      END IF;
    END;
    $migration$;
    CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(message) WHERE message IS NOT NULL;
    CREATE INDEX IF NOT EXISTS deliveries_message_removed ON deliveries(message_removed_at) WHERE message_removed_at IS NOT NULL;
    CREATE OR REPLACE FUNCTION mark_purged_message_deliveries() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      WITH cancelled AS (
        UPDATE deliveries SET status='cancelled',message_removed_at=now()
        WHERE message=OLD.id AND status='pending' RETURNING id
      )
      INSERT INTO delivery_log(delivery,result)
        SELECT id,'Cancelled: message permanently deleted before delivery' FROM cancelled;
      UPDATE deliveries SET message_removed_at=now()
      WHERE message=OLD.id AND message_removed_at IS NULL;
      RETURN OLD;
    END;
    $body$;
    DROP TRIGGER IF EXISTS mark_purged_message_deliveries ON messages;
    CREATE TRIGGER mark_purged_message_deliveries BEFORE DELETE ON messages
      FOR EACH ROW EXECUTE FUNCTION mark_purged_message_deliveries();
    CREATE TABLE IF NOT EXISTS ingest_log (
      id uuid PRIMARY KEY, recipient text NOT NULL, status text NOT NULL, time timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS workspace_id text DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS domain text;
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS bytes bigint NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS ingest_log_activity ON ingest_log(domain,time DESC,id DESC);
    CREATE INDEX IF NOT EXISTS ingest_log_domain_time ON ingest_log(domain,time) WHERE status='stored';
    CREATE INDEX IF NOT EXISTS ingest_log_rejected_time ON ingest_log(time) WHERE status<>'stored';

    -- High-Throughput Worker Pool Queue (PostgreSQL-Native Concurrency)
    CREATE TABLE IF NOT EXISTS job_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id text NOT NULL DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
      job_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
      locked_until timestamptz,
      locked_by text,
      next_attempt timestamptz NOT NULL DEFAULT now(),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS job_queue_active ON job_queue(next_attempt ASC, created_at ASC)
      WHERE status IN ('pending', 'processing');
    CREATE INDEX IF NOT EXISTS job_queue_locked ON job_queue(locked_until)
      WHERE status = 'processing';
    CREATE INDEX IF NOT EXISTS job_queue_workspace ON job_queue(workspace_id);
    CREATE INDEX IF NOT EXISTS job_queue_type ON job_queue(job_type);

    -- Phase 3: Outbound Relay Profiles, Suppression Lists & Outbound Messages
    CREATE TABLE IF NOT EXISTS outbound_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id text NOT NULL DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
      domain text NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
      provider text NOT NULL CHECK (provider IN ('smtp', 'resend', 'ses', 'brevo', 'mock')),
      credentials_encrypted text NOT NULL,
      from_name text NOT NULL DEFAULT '',
      from_email text NOT NULL DEFAULT '',
      is_default boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT outbound_profiles_ws_domain_key UNIQUE (workspace_id, domain)
    );
    CREATE INDEX IF NOT EXISTS outbound_profiles_domain ON outbound_profiles(domain);

    CREATE TABLE IF NOT EXISTS suppressions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id text NOT NULL DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
      domain text,
      email text NOT NULL,
      reason text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual')),
      details text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT suppressions_ws_email_key UNIQUE (workspace_id, email)
    );
    CREATE INDEX IF NOT EXISTS suppressions_email_lookup ON suppressions(email);

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id text NOT NULL DEFAULT 'default' REFERENCES workspaces(id) ON DELETE CASCADE,
      domain text NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
      idempotency_key text,
      from_address text NOT NULL,
      to_address text[] NOT NULL DEFAULT '{}',
      cc text[] NOT NULL DEFAULT '{}',
      bcc text[] NOT NULL DEFAULT '{}',
      reply_to text[] NOT NULL DEFAULT '{}',
      subject text NOT NULL DEFAULT '',
      text_body text NOT NULL DEFAULT '',
      html_body text NOT NULL DEFAULT '',
      headers jsonb NOT NULL DEFAULT '{}',
      tags jsonb NOT NULL DEFAULT '[]',
      attachments jsonb NOT NULL DEFAULT '[]',
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'bounced', 'suppressed')),
      error text,
      provider text NOT NULL DEFAULT 'mock',
      provider_message_id text,
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS outbound_idempotency ON outbound_messages(workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS outbound_messages_domain ON outbound_messages(domain, created_at DESC);
    CREATE INDEX IF NOT EXISTS outbound_messages_status ON outbound_messages(status)
      WHERE status IN ('queued', 'sending');
  `);
}
