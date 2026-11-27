# ADR 0005: Letterdock v2 Platform Evolution (Templates, Automation Rules, Advanced Search/Threading, & Analytics Suite)

- **Status:** Approved
- **Date:** 2026-11-27
- **Author:** Autonomous Lead Engineer & Founder

## Context & Problem Statement
Letterdock v1.0.2 established a rock-solid, sovereign email management foundation: high-throughput PostgreSQL `SKIP LOCKED` worker pool, hybrid blob storage with lazy dual-read, Resend API parity, 1-click Cloudflare DNS synchronization, and Tailscale private dashboard origin authorization.

However, to elevate Letterdock from an inbound inbox and relay forwarder into a comprehensive developer platform and sovereign operator cockpit, four high-impact architectural pillars were required:
1. **Dynamic Transactional Email Templating:** Developers need variable interpolation (`{{ name }}`), conditionals, and loops with live previews and drop-in integration into `POST /emails`.
2. **Inbound Automation & Routing Rules:** Operators need to triage incoming email, execute multi-condition evaluation (from, to, subject, attachments, headers), auto-tag, route to external webhooks (Slack, Discord, raw JSON), and trigger loop-safe auto-responders without blocking the main ingress pipeline.
3. **Advanced Operator Search & RFC 5322 Threading:** Full-text search with structured operator syntax (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `folder:`) and conversation clustering using `Message-ID`, `In-Reply-To`, and `References` headers.
4. **Analytics & Deliverability Telemetry:** Real-time visibility into email deliverability health (sent, delivered, bounce rate), privacy-safe open tracking via HMAC-signed 1x1 transparent GIFs (`/t/o/:token.gif`), and signed click redirect proxies (`/t/c/:token`).

## Approved Decisions

### 1. Zero-Dependency Sandboxed Template Engine
- **Decision:** Implement a pure TypeScript template engine (`src/templates.ts`) supporting variable interpolation (with nested dot notation), HTML entity escaping by default, triple-brace unescaped rendering, conditionals (`{{#if}}`, `{{#unless}}`), array loops (`{{#each}}` with `@index`, `@first`, `@last`, `this`), and automated variable schema introspection (`extractVariables`).
- **Database Schema:** New table `templates` with workspace scoping, unique slug constraint, subject, HTML, plain text fallback, variable schemas, and default sample JSON data.
- **API Integration:** Drop-in support in `POST /emails` and `POST /emails/batch` via `template` and `variables` fields, rendering subject and body dynamically.

### 2. Asynchronous Inbound Automation Engine
- **Decision:** Implement `src/rules.ts` executed asynchronously in `src/jobs.ts` during the worker pool's post-parsing phase.
- **Conditions:** Field evaluation (`sender`, `recipient`, `subject`, `has_attachments`, `header`) against operators (`equals`, `contains`, `starts_with`, `ends_with`, `regex`), supporting both `AND` (`match_all: true`) and `OR` (`match_all: false`) evaluation.
- **Actions:** Label application, folder relocation (`archive`, `trash`, `spam`), starring, read status marking, formatted webhook dispatch (Slack rich text, Discord embeds, raw JSON), and loop-protected automated replies with `Auto-Submitted: auto-replied` headers.

### 3. PostgreSQL GIN Full-Text Search & RFC 5322 Conversation Graph
- **Decision:**
  - Enhance `GET /api/messages` with `parseSearchQuery` to transparently parse complex operator search queries (`from:alice subject:"invoice" has:attachment payment`) into indexed database conditions.
  - Implement conversation thread clustering in `src/threads.ts` using `Message-ID`, `In-Reply-To`, and `References` headers, recording `thread_id` across both `messages` and `outbound_messages`.
  - Expose `GET /api/threads/:id` and `GET /api/messages/:id/thread` to fetch complete multi-turn inbound and outbound conversations chronologically.

### 4. Cryptographically Signed Telemetry & Deliverability Suite
- **Decision:** Implement tamper-resistant tracking in `src/analytics.ts`:
  - Open tracking: `GET /t/o/:token.gif` serving a 1x1 transparent GIF buffer with `Cache-Control: no-store` and recording `opened` events.
  - Click tracking: `GET /t/c/:token` recording `clicked` events before issuing an HTTP 302 redirect to the destination URL.
  - Tokens: Authenticated HMAC-SHA256 signatures derived from the sovereign `APP_ENCRYPTION_KEY` containing workspace ID, message ID, recipient, and URL.
  - Deliverability metrics: `GET /api/analytics/overview` and `GET /api/analytics/events` computing real-time delivery rate, open rate, click rate, bounce rate, and 7-day volume trends.

### 5. Sovereign Operator UI Integration
- **Decision:** Add three dedicated views in the Harbor Ledger sidebar:
  1. **Templates:** Template manager with live split-screen editor, detected variable chips, desktop/mobile preview switcher, interactive JSON test runner, and copyable Resend API drop-in snippets.
  2. **Rules:** Visual rule builder with priority badges, condition and action configurators, enabled toggles, and live rule evaluation simulator.
  3. **Analytics:** Deliverability dashboard featuring 5 KPI cards (Total Sent, Delivery Rate, Unique Opens, Clicks, Bounces), 7-day engagement table, and real-time event log stream.
  4. **Inbox Conversation View:** Multi-message thread viewer in `MessageDetail.tsx` displaying chronological message exchanges.

## Verification & Validation
- **Unit Suite (`tests/unit-v2-features.ts`):** Verified template interpolation, loops, conditionals, variable extraction, tracking token HMAC tamper resistance, link rewriting, search query parsing, and rule conditions.
- **Integration Suite (`tests/feature-v2-platform.ts`):** Verified live HTTP server execution across templates CRUD, template-backed outbound dispatch, tracking pixel serving, click redirect, rules testing, thread retrieval, and analytics aggregations.
- **Playwright E2E Suite (`tests/playwright-v2-ui.ts`):** Verified full browser navigation, template creation, live preview toggle, rules simulation, analytics metrics rendering, 320px mobile reflow without overflow, and server process RSS under sovereign budget (140 MB < 150 MB).
