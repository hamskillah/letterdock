# ADR 0001: Founder Strategic Decisions Round 1

- **Status:** Approved by Founder
- **Date:** 2026-11-27
- **Author:** Autonomous Lead Engineer & Founder

## Context & Problem Statement
Letterdock was created as an inbound email workspace prototype leveraging Cloudflare Email Routing and R2 without exposing Port 25. While functional, it had architectural limitations: single admin password, attachment raw bytea storage bloat, tight coupling to Cloudflare DNS, single-file frontend monorepo, and no outbound reply capabilities. Strategic direction was required before undertaking substantial engineering.

## Approved Decisions

### 1. Product Positioning: Hybrid (Developer Platform with First-Class UI)
- **Decision:** Build Letterdock as an API-first developer platform that simultaneously features a polished, responsive, density-aware web dashboard for human operators.
- **Consequence:** Both the REST/SDK surface and the operator web UI are Tier-1 product deliverables.

### 2. Functional Scope: Inbound-First with SMTP Relay for Outbound
- **Decision:** Letterdock remains strictly focused on inbound reception as its primary sovereign value, but supports sending and replying to emails by relaying through external authenticated SMTP/API providers (Amazon SES, Resend, Brevo, custom SMTP).
- **Consequence:** Letterdock will not host or manage public SMTP port 25 outbound mail servers, avoiding IP warming, deliverability, and blacklisting operations.

### 3. User Model & Authentication: Single Admin + Multi-API Keys
- **Decision:** Retain a single-admin dashboard for current milestones, backed by granular domain-scoped API keys with specific permissions (read, delete, manage hooks).
- **Consequence:** System data model must cleanly isolate domain scopes and avoid hardcoded single-user assumptions to allow future seamless migration to multi-user RBAC.

### 4. Ingress Architecture: Cloudflare Native + Generic Ingestion API
- **Decision:** Cloudflare Email Routing + Worker + R2 remains the zero-open-port default. An additional HTTPS raw email ingestion endpoint (`POST /api/ingress/raw`) will be added for non-Cloudflare users or external webhooks.
- **Consequence:** Eliminates DNS vendor lock-in while preserving the "no open port 25" architectural invariant.

### 5. Storage Architecture: Hybrid Storage Driver
- **Decision:** PostgreSQL retains message metadata, routing, headers, indexes, and full-text search. Raw RFC 822 MIME blobs and attachments are extracted and stored via an abstract Blob Storage driver (default: encrypted local disk volume; optional: S3/R2/MinIO).
- **Consequence:** Prevents database table bloat, keeps backups fast, enables safe attachment streaming without RAM exhaustion. Requires dual-target backup and orphan cleanup jobs.

### 6. UI/UX & Design System: Modular Components with Tailored Design System
- **Decision:** Refactor the single-file `web/main.tsx` into modular component modules, governed by a structured Design Token system (Inter, density levels, dark/light theme tokens, motion guidelines) and verified via Playwright E2E visual/interaction probes.
- **Consequence:** Eliminates AI-slop aesthetics, ensures WCAG accessibility, and creates a maintainable foundation for rapid feature iteration.
