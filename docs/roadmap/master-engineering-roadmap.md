# LetterDock — Master Engineering Roadmap

**Document Version:** 1.0.0  
**Status:** Approved & Active  
**Author:** Autonomous Lead Engineer & Founder  
**Date:** 2026-11-27  
**Repository:** `hamskillah/letterdock`

---

## 1. Executive Summary & Consolidated Strategic Alignment

LetterDock is transforming from an inbound email prototype into a sovereign, production-grade developer platform with an operator-grade web inbox. It eliminates the operational complexity of hosting public SMTP port 25 mail servers while delivering first-class developer APIs, robust reliability, and a refined, keyboard-first user experience.

### Consolidated 19 Approved Strategic Decisions (Rounds 1–3)

| ID | Strategic Area | Approved Decision | Reference |
|---|---|---|---|
| **D01** | **Product Positioning** | Hybrid: Developer Platform with First-Class Operator UI | ADR 0001 |
| **D02** | **Functional Scope** | Inbound-First with authenticated Outbound Relay (SES, Resend, Brevo, SMTP) | ADR 0001 |
| **D03** | **User Model** | Single Admin + Granular Domain-Scoped API Keys | ADR 0001 |
| **D04** | **Ingress Architecture** | Cloudflare Native (Zero Port 25) + Generic Raw HTTPS Ingestion API | ADR 0001 |
| **D05** | **Storage Architecture** | Hybrid Storage Driver: PostgreSQL metadata + Abstract Blob Storage (Local FS/S3/R2) | ADR 0001 |
| **D06** | **UI/UX Architecture** | Modern Component Architecture with Tailored Design System & Playwright Testing | ADR 0001 |
| **D07** | **Outbound Abstraction** | Per-Domain Outbound Profiles with Encrypted Credentials & Global Fallback | ADR 0002 |
| **D08** | **Resend Parity** | Drop-in Compatibility for Core Endpoints verified by Official SDK + Native LetterDock API | ADR 0002 |
| **D09** | **Storage Migration** | Lazy Dual-Read with Asynchronous Batch Migration & Checksum Verification | ADR 0002 |
| **D10** | **Multi-Tenancy** | Implicit Workspace Zero-State (`workspaces` relation, foreign key scoping) | ADR 0002 |
| **D11** | **Worker Concurrency** | PostgreSQL-Native Worker Pool via `FOR UPDATE SKIP LOCKED` (Zero Redis dependency) | ADR 0002 |
| **D12** | **Operator Experience** | Keyboard-First High-Density Inbox with Full Accessibility (Mouse/Touch/Screen Reader) | ADR 0002 |
| **D13** | **Security & Cryptography** | Key Separation (`APP_ENCRYPTION_KEY` vs `SESSION_SECRET`, AES-256-GCM) & Server-Side Session Revocation | ADR 0003 |
| **D14** | **Outbound Safety** | Strict Domain Verification Gate, Rate Limiting, Bounce Ingestion & Suppression List | ADR 0003 |
| **D15** | **API Documentation** | OpenAPI 3.1 Source of Truth + Interactive Embedded Scalar UI & SDK Contract Testing | ADR 0003 |
| **D16** | **Brand Identity** | "Sovereign Maritime Precision" visual language, Inter + JetBrains Mono, WCAG AA | ADR 0003 |
| **D17** | **Disaster Recovery** | Integrated Backup/Restore Tooling with Point-in-Time Manifests & Checksum Verification | ADR 0003 |
| **D18** | **Observability & Telemetry** | Embedded Lightweight Health Dashboard, Structured Pino Logging & Prometheus `/metrics` | ADR 0003 |
| **D19** | **Release Governance** | Strict 5-Pillar Quality Release Gates & Clear Autonomous Escalation Boundaries | ADR 0003 |

---

## 2. Codebase Baseline & Technical Debt Reality

The current repository (`v0.1.0-preview.1` + recent hardening commits) possesses solid core capabilities but exhibits critical technical debts that must be systematically addressed:

- **Storage Bottleneck:** Attachments and raw MIME messages reside directly in PostgreSQL `bytea` columns (`src/db.ts:39`). A modest intake of 5,000 emails with attachments expands the database beyond typical memory buffers, degrading vacuuming and index performance.
- **Queue Throttling:** Background jobs (`src/jobs.ts`) execute on a single 3-second serial tick processing 1 webhook per cycle (~20 webhooks/minute), vulnerable to head-of-line blocking if an external endpoint stalls.
- **Session Lifecycle:** Web session cookies are signed timestamps without a server-side state registry (`src/server.ts:49-61`). Cookie invalidation upon logout is purely client-side.
- **Frontend Monolith:** `web/main.tsx` (873 lines) and `web/style.css` (415 lines) manage all UI tabs, states, and modals in a single file without design tokens or modular testing.
- **Ingress Coupling:** Ingestion depends exclusively on Cloudflare Email Routing and R2 staging with a 7-day TTL (`cloudflare/worker.js`). Users without Cloudflare DNS cannot ingest emails.

---

## 3. Dependency-Aware Implementation Roadmap

Phase flow:
Phase 1: Foundation, Security & Storage -> Phase 2: Concurrency & Resilient Ingress -> Phase 3: Outbound Relay & Resend Parity -> Phase 4: Design Engineering & Modular UI -> Phase 5: Observability, DR & Release Gates.

### Phase 1: Architectural Foundation, Security & Hybrid Storage Engine

**Goal:** Establish enterprise-grade cryptographic key separation, server-side session revocation, future-proof workspace scoping, and an abstract blob storage driver with zero-downtime lazy migration from PostgreSQL `bytea`.

#### Key Deliverables:
1. **Cryptographic Key Separation:**
   - Dedicated `APP_ENCRYPTION_KEY` (32-byte AES-256-GCM) with unique 96-bit nonces and authenticated tags for database credentials, distinct from `SESSION_SECRET`.
   - Safe derivation fallback for backwards compatibility on upgrade.
2. **Server-Side Session Management:**
   - New PostgreSQL table `sessions` with fields: `id`, `admin_user_id`, `created_at`, `expires_at`, `last_seen_at`, `ip_address`, `user_agent`.
   - Real server-side revocation on `POST /api/logout` and on admin password changes.
3. **Workspace Data Isolation Zero-State:**
   - New PostgreSQL table `workspaces` seeded with `id: 'default'`.
   - Foreign key relations added to `domains`, `messages`, `hooks`, `api_keys`, and `sessions` with transparent query scoping.
4. **Abstract Blob Storage Engine:**
   - `StorageDriver` interface: `put(key, stream/buffer, meta)`, `get(key)`, `delete(key)`, `exists(key)`.
   - Drivers: `EncryptedLocalStorageDriver` (default, filesystem volume with optional payload encryption) and `S3StorageDriver` (compatible with Cloudflare R2, MinIO, AWS S3).
5. **Lazy Dual-Read Storage Migration:**
   - Reads check Blob Storage first; if absent, read legacy PostgreSQL `bytea` and return seamlessly.
   - Background batch migrator with SHA-256 checksum verification. Legacy `bytea` columns retained until 100% of rows are verified in blob storage.

#### Acceptance Criteria & Definition of Done:
- [ ] Database migrations execute idempotently without data loss on existing databases.
- [ ] Session logout instantly terminates server-side session; replay of copied cookie returns 401 Unauthorized.
- [ ] Attachments and raw MIME stream directly to blob storage without holding full payloads in Node.js process memory.
- [ ] Automated tests verify lazy dual-read with synthetic legacy `bytea` rows.

---

### Phase 2: High-Throughput Worker Pool & Resilient Ingress Pipeline

**Goal:** Eliminate serial queue bottlenecks, provide high-throughput durable job processing using PostgreSQL `FOR UPDATE SKIP LOCKED`, and decouple email ingress from Cloudflare-only infrastructure.

#### Key Deliverables:
1. **PostgreSQL-Native Worker Pool:**
   - Job queue table `job_queue` with transactional leasing: `id`, `job_type`, `payload`, `attempts`, `max_attempts`, `locked_until`, `last_error`, `created_at`.
   - Worker pool running configurable concurrent workers (default 4 workers, scalable to VPS limits).
   - Concurrency managed via `SELECT ... FOR UPDATE SKIP LOCKED`.
   - Exponential backoff with random jitter for retries; Dead-Letter Queue (DLQ) state for unrecoverable failures after `max_attempts`.
   - Heartbeat lease renewals to recover crashed worker jobs automatically.
2. **Resilient Ingestion & Transient Error Recovery:**
   - Auto-retry pipeline for MIME parsing and database write failures with DLQ classification.
   - Staging R2 queue age monitoring and alerting before 7-day TTL expiration.
3. **Generic Raw HTTPS Ingestion API:**
   - Endpoint `POST /api/ingress/raw` supporting RFC 822 EML stream / multipart upload.
   - Domain routing, SPF/DKIM verification parsing, and immediate handover to durable worker queue.
   - Enables incoming email receipt via AWS SES webhooks, Postfix forwarders, or external relay scripts without exposing Port 25.

#### Acceptance Criteria & Definition of Done:
- [ ] Webhook delivery throughput scales to >100 deliveries/minute without head-of-line blocking.
- [ ] Worker pool process recovers gracefully on SIGTERM/SIGINT with zero dropped in-flight jobs.
- [ ] External EML injected via `POST /api/ingress/raw` parses identically to Cloudflare-ingested emails.
- [ ] Application process memory remains <120 MB RSS during 50 concurrent queue jobs.

---

### Phase 3: Outbound Relay Engine & Drop-In Resend Parity

**Goal:** Implement safe, authenticated outbound email dispatch via external providers (SES, Resend, Brevo, SMTP), enforce sender protection policies, and achieve verified drop-in compatibility with the official Resend SDK.

#### Key Deliverables:
1. **Per-Domain Outbound Profiles:**
   - Table `outbound_profiles` with encrypted provider credentials (SES, Resend, Brevo, Custom SMTP) per domain.
   - Global fallback configuration in `.env`.
2. **Strict Sender Authorization & Abuse Protection:**
   - Outbound dispatch restricted to domains verified in LetterDock.
   - Domain-level and API key-level rate limiting (token bucket algorithm).
   - Inbound bounce and spam complaint ingestion endpoints for external providers.
   - Automated suppression list preventing sends to repeatedly bounced addresses.
   - Idempotency key support on send endpoints to eliminate duplicate deliveries.
3. **Resend REST API Drop-In Parity:**
   - Endpoints:
     - `POST /emails` & `POST /emails/batch`
     - `GET /emails/:id`
     - `GET/POST /domains`, `GET /domains/:id`, `POST /domains/:id/verify`
     - `GET/POST /api-keys`, `DELETE /api-keys/:id`
     - `GET /emails/receiving` & attachments
   - Response structures, HTTP status codes, and error formats matching official Resend specifications.
4. **Authoritative OpenAPI 3.1 & Embedded Scalar UI:**
   - Complete OpenAPI 3.1 schema serving `/api/openapi.json`.
   - Embedded interactive documentation at `/docs` via Scalar UI (zero CDN dependencies).
5. **Automated SDK Contract Test Suite:**
   - CI test harness executing official `@resend/node` SDK pointing to LetterDock test server, verifying send, batch send, and receiving flows.

#### Acceptance Criteria & Definition of Done:
- [ ] Official `@resend/node` SDK succeeds across all implemented endpoints without modification other than `baseUrl`.
- [ ] Attempting to send from an unverified domain returns standard 403 Forbidden with descriptive error.
- [ ] Simulating a bounce notification records the bounce and suppresses future sends to that recipient.
- [ ] OpenAPI 3.1 schema validates with zero linter errors.

---

### Phase 4: Design Engineering & Sovereign Operator Experience

**Goal:** Refactor the single-file frontend into a modular, accessible, keyboard-first web application governed by the "Sovereign Maritime Precision" design system.

#### Key Deliverables:
1. **Design System & Semantic Tokens:**
   - Palette: Deep ocean slate (`#0f172a`), maritime spruce (`#155e75`), muted borders (`#e2e8f0`), dark mode variants.
   - Typography: Inter for UI chrome, JetBrains Mono for RFC 822 headers, JSON payloads, and tokens.
   - Density system: "Comfortable" (default) and "Compact" (high-density triage).
   - WCAG 2.1/2.2 AA compliant contrast ratios across all states.
2. **Modular Component Architecture:**
   - Decompose `web/main.tsx` into:
     - `web/components/layout/` (Sidebar, Header, StatusBanner)
     - `web/components/inbox/` (MessageList, MessageRow, MessageDetail, HeaderInspector)
     - `web/components/domains/` (DomainList, DnsRecordTable, DomainWizard)
     - `web/components/outbound/` (OutboundConfig, ComposeModal)
     - `web/components/health/` (TelemetryView, QueueMonitor)
     - `web/components/ui/` (Button, Input, Badge, Modal, ShortcutHint)
3. **Keyboard-First Navigation & Inclusive Interaction:**
   - Shortcuts: `j/k` (next/prev message), `e` (archive), `#` (delete), `r` (reply/compose), `/` (search), `?` (shortcut overlay).
   - Full accessibility for mouse, touch (swipe actions on mobile), and screen readers with semantic ARIA live regions and focus management.
4. **Playwright E2E & Visual Regression Suite:**
   - Automated browser probes for keyboard flow, modal trapping, dark mode toggle, mobile viewport layout, and zero overflow.

#### Acceptance Criteria & Definition of Done:
- [ ] Playwright test suite passes 100% on Chromium, Firefox, and WebKit viewports (desktop and mobile).
- [ ] Keyboard navigation allows complete email triage without touching the mouse.
- [ ] No layout shift (CLS < 0.05) or horizontal overflow on 320px mobile screens.
- [ ] WCAG contrast checks verify minimum 4.5:1 ratio on all text elements.

---

### Phase 5: Observability, Disaster Recovery & Production Release Verification

**Goal:** Deliver zero-overhead observability for constrained VPS hosts, implement verifiable disaster recovery tooling, and satisfy all 5 release gates.

#### Key Deliverables:
1. **Embedded Operational Telemetry:**
   - Structured JSON logging via Pino with sensitive data redaction (PII, tokens, authorization headers).
   - Operational telemetry tab in UI: Worker queue depth, oldest staging message age, 24h webhook delivery success rate, storage volume capacity, and p95 ingestion latency.
   - Optional Prometheus-compatible `/metrics` endpoint.
2. **Integrated Atomic Backup & Disaster Recovery Tooling:**
   - CLI / Script: `letterdock backup` (`deploy/backup.sh`) generating atomic point-in-time archives:
     - PostgreSQL database dump (`pg_dump`).
     - Blob storage payload directory sync.
     - Cryptographic SHA-256 manifest file.
     - AES-256 encrypted tarball archive.
   - Restore utility: `deploy/restore.sh` with pre-flight manifest integrity verification.
   - Automated DR test running in CI verifying full restore on a blank container.
3. **Strict 5-Pillar Release Gate Audit:**
   1. **Test Gate:** 100% unit, integration, and Resend SDK contract tests pass.
   2. **Security Gate:** Zero vulnerabilities in `npm audit --omit=dev`; verified CSRF, SSRF, and authorization boundaries.
   3. **Data Integrity Gate:** Migration and dual-read storage validated on populated database.
   4. **UX & A11y Gate:** Playwright automated probes confirm WCAG AA compliance and zero visual regressions.
   5. **Performance Gate:** Container application RSS stays <150 MB under sustained normal load.

#### Acceptance Criteria & Definition of Done:
- [ ] Backup and restore cycle executed and verified bit-for-bit on an isolated test environment.
- [ ] Application and worker pool memory footprint verified <150 MB RSS via live benchmark.
- [ ] Release documentation, migration guide, and production Compose configuration validated.

---

## 4. Autonomous Execution Methodology

All implementation cycles follow this strict loop:
```
DISCOVER -> VALIDATE -> PLAN -> DESIGN -> IMPLEMENT -> TEST -> REVIEW -> FIX -> VERIFY -> DOCUMENT -> MERGE -> NEXT
```

- **Subagent & Specialist Delegation:** Use specialized subagents (`design-director`, `design-reviewer`, `explore`) for design critique, accessibility audits, and visual inspections.
- **Continuous Execution:** Do not pause after completing single tasks or PRs while safe autonomous work remains executable.
- **Escalation Policy:** Escalate to Founder solely for production host deployment authorizations, external financial commitments, or fundamental ADR contradictions.
