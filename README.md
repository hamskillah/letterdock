# Letterdock

Self-hosted inbound email for your domains. Receive mail at any address on a
domain you control, read it in one dashboard, and connect it to your tools
through a read-only API and signed webhooks.

[![CI](https://github.com/hamskillah/letterdock/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hamskillah/letterdock/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Letterdock receives email only. Cloudflare Email Routing handles SMTP and
stages mail in private R2. Letterdock pulls it over HTTPS, so your VPS does
not need port 25. Letterdock has no paid feature tiers. Your hosting and
Cloudflare usage are subject to each provider's limits and charges.

## Features

| Inbox | Integrations | Operations |
| --- | --- | --- |
| Catch-all addresses, address names and pins, search, labels, archives, raw mail and attachments | Domain-scoped API keys, Resend-compatible receiving endpoints, signed webhooks with retries and replay | Cloudflare setup from the dashboard, health checks, storage limits and optional auto-prune |

## Quick start

You need Docker with Compose and a domain you control. A domain on Cloudflare
is required for the managed email setup. The dashboard can run on localhost.

```sh
git clone https://github.com/hamskillah/letterdock.git
cd letterdock
cp .env.example .env
chmod 600 .env
```

Set `ADMIN_PASSWORD` to a strong password of at least 16 characters. Generate
independent values for `SESSION_SECRET` and `POSTGRES_PASSWORD` with
`openssl rand -hex 32`. Keep the session secret with your backups. It also
protects stored Cloudflare credentials and webhook secrets.

For a new standalone installation, build and start the services:

```sh
docker compose up -d --build
```

For an automated production deployment, follow the
[production deployment and recovery guide](docs/deployment.md) instead.

Open **http://localhost:3000** and sign in with the password you set. Use
`main` for the current preview, including security fixes. The
`v0.1.0-preview.1` tag predates those fixes. See [release status](docs/progress.md)
for remaining verification.

### Choose a custom port

Set `APP_PORT` in `.env`. Leave `PUBLIC_URL` blank to use localhost on
that port.

```dotenv
APP_PORT=8080
PUBLIC_URL=
```

Run `docker compose up -d` to apply the change, then open
**http://localhost:8080**. If your existing `.env` already sets `PUBLIC_URL`,
clear it for localhost or update it to the exact origin your browser uses.
The container continues listening on port 3000 internally.

### Access a VPS installation

Compose binds the app to loopback and leaves PostgreSQL unpublished. For a
private dashboard, forward the port from your machine and open the same
localhost URL. For a custom port, replace both occurrences of `3000` below
with your `APP_PORT`. If your local and remote ports differ, set
`PUBLIC_URL` to the local browser origin.

```sh
ssh -N -L 3000:127.0.0.1:3000 user@your-vps
```

For public dashboard or API access, set `PUBLIC_URL` to your HTTPS origin and
front the app with a reverse proxy. Point its upstream to `127.0.0.1` on
your configured `APP_PORT`. See the [sample Caddyfile](deploy/Caddyfile.example).
Keep the application port and PostgreSQL private.

## Receive your first email

1. In **Domains**, add a domain you control and click **Set up domain**.
2. Letterdock checks the domain's DNS. If it uses Cloudflare, authorize the
   connection when prompted so Letterdock can provision a Worker and private
   R2 bucket, configure verification DNS, and set up the catch-all route.
   Review existing MX and catch-all routing before switching a live domain.
3. Wait for DNS verification. Send a test email from an external account to a
   new address on the domain, then open **Inbox**. You can also create or
   pin addresses in **Addresses** without adding DNS records for each address.

```mermaid
flowchart LR
    Sender --> Routing[Cloudflare Email Routing]
    Routing --> Worker[Email Worker]
    Worker --> R2[Private R2 staging]
    App[Letterdock] -->|HTTPS pull via Worker or R2 API| R2
    App --> Postgres[(PostgreSQL)]
```

<details>
<summary>Manual Worker and R2 setup</summary>

1. Create a private R2 bucket and set its name in
   [cloudflare/wrangler.toml](cloudflare/wrangler.toml).
2. From `cloudflare/`, run `npx wrangler deploy`. In Cloudflare Email Routing,
   point the domain's catch-all action at your Worker.
3. Set `R2_BUCKET`, `R2_ENDPOINT`, `AWS_ACCESS_KEY_ID`, and
   `AWS_SECRET_ACCESS_KEY` in `.env`. Scope the R2 credentials to the staging
   bucket and allow listing, reading, and deleting objects. Configure lifecycle
   expiry for the `mail/` prefix.
4. Restart Letterdock, add the domain in the dashboard, publish its
   verification TXT record, and choose **Advanced settings → Verify DNS**. The built-in verifier
   expects Cloudflare Email Routing MX records.

To let Letterdock configure a zone using an existing Worker, set
`CLOUDFLARE_EMAIL_WORKER` and provide a zone-scoped `CLOUDFLARE_API_TOKEN`
with Zone Read, DNS Edit, Zone Settings Edit, and Email Routing Rules Edit.

</details>

To confirm mail actually reaches your inbox, open **Domains → Delivery health →
Start delivery test**. Send a message from an external mailbox to the generated
address within 30 minutes. The domain's catch-all rule must route it to
Letterdock. After the message is processed, the panel shows **Test email verified**.
**Recent delivery activity** shows messages seen by this instance, including
processing errors and quota failures.

## Integrations and retention

- **API keys** are scoped to one verified domain and exclude Trash and expired
  messages. Handle keys and temporary attachment URLs as credentials.
- **Webhooks** send signed `email.received` events to HTTPS endpoints.
  **Integrations** shows delivery attempts and provides replay. Permanently
  deleting a message cancels pending retries, while recent delivery history
  remains available for 30 days.
- **Address rules** can add a label and queue a webhook for new mail at an
  exact recipient address. Create a webhook with **Selected addresses**
  in **Integrations**, then assign it under **Addresses → Settings**. Webhooks
  with matching global, domain, or address filters continue to receive events.
- **Auto-prune** is off by default. In **Domains**, choose an age from 1 to
  3650 days and confirm to permanently delete older email and attachments
  across that domain's folders. PostgreSQL can reuse deleted rows' space
  through autovacuum. The separate retention setting moves mail to Trash.
  Restoring a message exempts it from that move rule. Domain Auto-prune still
  applies if enabled.
- **Trash** automatically deletes messages and attachments after 30 days in
  Trash. Existing Trash messages get 30 days from the upgrade. A domain's
  shorter Auto-prune policy may delete them sooner.

## Storage limits, backups, and upgrades

| Default | Behavior |
| --- | --- |
| 20 MiB per message | The Worker rejects larger messages. |
| 512 MiB per domain per rolling 24 hours | Excess mail stays in staging and is retried when the rolling window allows it. Health shows recent messages deferred for quota. Managed staging expires after seven days. |
| 10 GiB estimated database usage or 1 GiB free disk | Import pauses when the next message would cross either threshold. Managed staging expires unimported mail after seven days. |

Tune the byte limits in [.env.example](.env.example). If PostgreSQL lives on
a separate filesystem, set `DISK_PATH` to a path on that filesystem that the
app can access.

Back up PostgreSQL to a private directory outside the checkout and encrypt
the dump and deployment secrets before storing them off-host.

```sh
backup_dir="$HOME/letterdock-backups"
install -d -m 700 "$backup_dir"
(umask 077; docker compose exec -T db pg_dump -U letterdock -Fc letterdock \
  > "$backup_dir/letterdock-$(date +%F-%H%M%S).dump")
```

Restore into an empty database with the same owner. Before upgrading, retain
a backup and the previous image. After upgrading, check **Health** and verify
external delivery to a new address. Existing managed Workers can be refreshed
using the same Compose files as the deployment.

For the automated deployment procedure, failure handling, and its limitations,
see [Production deployment and recovery](docs/deployment.md).

<details>
<summary>Refresh a managed Cloudflare Worker</summary>

```sh
docker compose exec -T app node --import tsx --input-type=module -e '
  import { refreshManagedIngress } from "./src/cloudflare-ingress.ts";
  import { db } from "./src/db.ts";
  try { await refreshManagedIngress(); } finally { await db.end(); }
'
```

</details>

## Development

Use Node.js 24 and an isolated PostgreSQL 17 test database. The integration
suite creates test fixtures, so never point it at a production database.

```sh
npm ci
npm run check
npm run build
npx playwright install chromium
DATABASE_URL=postgres://postgres:YOUR_TEST_PASSWORD@127.0.0.1:5432/postgres npm test
```

[Apache License 2.0](LICENSE)
