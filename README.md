# Letterdock

**Sovereign Inbound & Outbound Email Infrastructure with Drop-In Resend SDK Parity.**

Letterdock is an autonomous, self-hosted email platform designed for developers and sovereign operators. Send and receive email across all your domains, manage inbound and outbound mail in a unified keyboard-driven dashboard, and connect your applications through full Resend-compatible APIs, OpenAPI 3.1 documentation, and signed webhooks.

[![CI](https://github.com/hamskillah/letterdock/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hamskillah/letterdock/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![OpenAPI 3.1](https://img.shields.io/badge/OpenAPI-3.1-green.svg)](docs)

---

## Highlights

- **Drop-in Resend SDK Parity**: Works seamlessly with `resend` npm package or REST clients. Drop-in endpoints for `/emails`, `/emails/batch`, `/api-keys`, `/domains`, `/audiences`, `/contacts`, and `/api/suppressions`.
- **Hybrid Blob Storage**: Seamlessly stream and store email payloads on the local filesystem or S3-compatible object stores (Cloudflare R2, AWS S3, MinIO) with dual-read fallback and zero-downtime migration.
- **Harbor Ledger Operator Experience**: Built to the Harbor Ledger design system—high-density, typography-forward (Inter & JetBrains Mono), WCAG 2.1 AA accessible, 320px mobile-responsive, with instant keyboard triage (`j`/`k` navigation, `e` archive, `s` star, `c` compose, `d` density toggle).
- **Resilient Background Worker Pool**: PostgreSQL `SKIP LOCKED` concurrency, exponential retry backoff, dead-letter queueing, crashed worker lease recovery, and heartbeat renewals.
- **Interactive OpenAPI Documentation**: Built-in interactive Scalar documentation at `/docs` and raw OpenAPI 3.1 schema at `/api/openapi.json`.
- **Sovereign Security Baseline**: AES-256-GCM encrypted secrets, strict origin CSRF protection, signed session cookies, domain-scoped API keys (`re_...`), and rate-limited endpoints.
- **Lightweight Production Footprint**: Fastify-powered architecture strictly budgeted under 150 MB RSS memory usage.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph Inbound
        Sender[External Sender] --> CF[Cloudflare Email Routing]
        CF --> Worker[Ingress Worker]
        Worker --> R2[Cloudflare R2 / Ingress Queue]
        R2 -->|HTTPS Pull| LD[Letterdock Server]
    end

    subgraph Outbound
        AppClient[Application / Resend SDK] -->|POST /emails| LD
        LD --> Relay[SMTP Relay / Upstream Provider]
        Relay --> Recipient[Destination Recipient]
    end

    subgraph Storage & Ops
        LD --> DB[(PostgreSQL 17)]
        LD --> Blobs[(Hybrid Blob Storage: Disk or S3/R2)]
        LD --> UI[Harbor Ledger Console]
    end
```

---

## Quick Start

You need Docker with Docker Compose and a domain you control.

```sh
git clone https://github.com/hamskillah/letterdock.git
cd letterdock
cp .env.example .env
chmod 600 .env
```

Edit `.env` and set:
1. `ADMIN_PASSWORD`: Strong password (min 16 chars) for the operator dashboard.
2. `SESSION_SECRET`: Random secret for signing session cookies (`openssl rand -hex 32`).
3. `POSTGRES_PASSWORD`: Password for the PostgreSQL database container.
4. `APP_ENCRYPTION_KEY`: Random 32-byte key for AES-256-GCM secret encryption (`openssl rand -hex 32`).

Start the infrastructure:

```sh
docker compose up -d --build
```

Open **http://localhost:3000** and sign in.
Interactive API documentation is immediately available at **http://localhost:3000/docs**.

---

## Drop-In Resend SDK Usage

Configure your application using the standard Resend SDK to point to your Letterdock instance:

```typescript
import { Resend } from 'resend';

// Initialize with your Letterdock API key and instance URL
const resend = new Resend('re_your_letterdock_scoped_key', {
  baseUrl: 'https://mail.yourdomain.com' // or http://localhost:3000
});

// Send email exactly as you would with Resend
const { data, error } = await resend.emails.send({
  from: 'hello@yourdomain.com',
  to: ['customer@example.com'],
  subject: 'Welcome to Letterdock',
  html: '<p>Sent via sovereign infrastructure!</p>'
});

console.log('Dispatched message ID:', data?.id);
```

---

## Outbound Relay Setup

Letterdock supports flexible outbound delivery strategies configured per-domain or globally via `.env`:

- **SMTP Relay**: Connect to any SMTP host (Mailgun, Postmark, Amazon SES, Brevo, custom Postfix).
- **Resend Relay**: Fallback upstream through Resend.
- **Mock Mode**: Isolated testing mode without dispatching live emails.

Set up via the Web Console under **Domains → Outbound Settings**, or configure default credentials in `.env`:

```dotenv
OUTBOUND_PROVIDER=smtp
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=postmaster@yourdomain.com
SMTP_PASS=your-smtp-relay-password
```

---

## Inbound Email Setup

### Automated Cloudflare Setup
1. In **Domains**, add your domain and click **Set up domain**.
2. If your DNS is on Cloudflare, authorize connection to automatically provision the Ingress Worker, private R2 staging bucket, and DNS MX/TXT records.
3. Verify DNS and send a test email.

### Manual Inbound Ingress
Deploy the worker in `cloudflare/` using Wrangler and configure Email Routing catch-all rules to route into your private R2 bucket or direct raw HTTPS ingress endpoint (`POST /api/ingress/raw`).

---

## Keyboard-First Operator Experience

The Harbor Ledger console supports full keyboard navigation:

| Key | Action |
| --- | --- |
| `j` / `k` | Move focus down / up through message rows |
| `Enter` | Open selected message in reader |
| `e` | Archive message |
| `s` | Toggle starred status |
| `u` | Mark as unread / read |
| `c` | Open compose modal |
| `d` | Toggle density mode (**Comfortable** vs **Compact**) |
| `/` | Focus search bar |
| `?` | Open keyboard shortcuts reference cheat-sheet |
| `Escape` | Close modals or reader view and restore focus |

---

## Storage & Backup Management

Letterdock stores raw message payloads using its hybrid driver (`STORAGE_DRIVER=fs` or `s3`). Local blobs are stored under `/app/data` which is persisted via the Docker Compose `app_data` volume.

### PostgreSQL Backups
```sh
backup_dir="$HOME/letterdock-backups"
install -d -m 700 "$backup_dir"
(umask 077; docker compose exec -T db pg_dump -U letterdock -Fc letterdock \
  > "$backup_dir/letterdock-$(date +%F-%H%M%S).dump")
```

### Restore
```sh
docker compose exec -T db pg_restore -U letterdock -d letterdock --clean < backup.dump
```

---

## 5-Pillar Quality Release Gates

Every build and commit must pass our strict 5-pillar verification gates before merging:

1. **Test Suite & API Specification**: 100% test pass rate across 8 comprehensive suites (`unit-crypto`, `unit-storage`, `phase1-foundation`, `phase2-worker-ingress`, `phase3-outbound-resend`, `phase4-ui-modular-design`, `phase5-release-gates`, `integration`). Complete OpenAPI 3.1 & Scalar specs.
2. **Security & Session Hardening**: AES-256-GCM encrypted credentials, strict CSRF origin checking, tampered cookie signature rejection, and domain-scoped multi-tenant isolation.
3. **Data Integrity & Storage Resilience**: Hybrid blob dual-read byte-level fidelity, atomic database state transitions, transactional inbox mutations.
4. **Accessibility & Design Fidelity**: Harbor Ledger design principles, WCAG 2.1 AA contrast (`>= 4.5:1`) across Light/Dark modes, 320px responsive reflow with zero horizontal overflow, unclipped hit targets, and accessible dialogs.
5. **Production Footprint**: Fastify server process memory RSS strictly budgeted under 150 MB.

---

## Development & Testing

```sh
# Install dependencies
npm ci

# Typecheck and build
npm run check
npm run build

# Run Playwright and 5-pillar release gate test suites
DATABASE_URL=postgres://postgres:letterdock_test@127.0.0.1:5432/postgres npm test
```

---

## License

[Apache License 2.0](LICENSE)
