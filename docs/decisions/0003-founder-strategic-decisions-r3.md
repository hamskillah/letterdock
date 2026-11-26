# ADR 0003: Founder Strategic Decisions Round 3

- **Status:** Approved by Founder
- **Date:** 2026-11-27
- **Author:** Autonomous Lead Engineer & Founder

## Context & Problem Statement
With the core architectural decisions established in ADR 0001 and ADR 0002, Letterdock required final strategic alignment on security hierarchy, outbound safety, API documentation and SDK contract parity, brand identity and design engineering, disaster recovery, observability on constrained VPS environments, and governance boundaries for autonomous release execution.

## Approved Decisions

### 1. Security & Cryptographic Hierarchy: Key Separation & Server-Side Session Revocation
- **Decision:** Separate sensitive data encryption (`APP_ENCRYPTION_KEY` using AES-256-GCM with unique 96-bit nonces) from session cookie signing (`SESSION_SECRET`). Implement a server-side session registry in PostgreSQL (`sessions` table) enabling instant session revocation on logout, password changes, or manual admin purge.
- **Consequence:** Eliminates catastrophic failure where cookie compromise leaks database encryption keys; provides full server-side auditability and session invalidation.

### 2. Outbound Relay Safety & Sender Policy Enforcement
- **Decision:** Enforce strict domain ownership and verification checks before permitting outbound dispatch. Integrate provider bounce and spam complaint ingestion with an automated recipient suppression list. Implement idempotent send semantics to prevent duplicate deliveries.
- **Consequence:** Protects domain sender reputation and prevents downstream provider (SES, Resend, Brevo) account suspensions.

### 3. Developer Experience & Contract Parity: OpenAPI 3.1 & SDK Contract Testing
- **Decision:** Adopt OpenAPI 3.1 as the authoritative specification of Letterdock's API surface. Embed interactive API documentation (Scalar UI) in the application. Validate drop-in Resend compatibility via automated CI contract tests against official SDK libraries (`@resend/node`).
- **Consequence:** Guarantees zero-drift API documentation and verifiable compatibility claims before any release tag.

### 4. Brand Identity & Visual Language: Sovereign Maritime Precision
- **Decision:** Establish an original visual identity under the art direction "Sovereign Maritime Precision"—deep ocean slate (`#0f172a`), spruce accents (`#155e75`), clean paper surfaces (`#f8fafc`), and high-readability typography (Inter for UI, JetBrains Mono for RFC 822/JSON payloads). Enforce strict WCAG 2.1/2.2 AA accessibility, density toggles (Comfortable/Compact), and anti-AI-slop design standards.
- **Consequence:** Produces a distinctive, professional, high-performance UI tailored to developers and operators without generic dashboard tropes.

### 5. Backup & Disaster Recovery: Integrated Point-in-Time Manifest Tooling
- **Decision:** Develop unified backup and restore tooling (`letterdock backup` / `deploy/backup.sh`) that creates atomic, encrypted point-in-time archives combining PostgreSQL database dumps, blob storage payloads, and cryptographic SHA-256 manifests. Test restore functionality on isolated environments.
- **Consequence:** Solves the multi-target backup dilemma inherent in hybrid storage architectures; provides verifiable disaster recovery.

### 6. Observability & Telemetry: Embedded Lightweight Health Dashboard
- **Decision:** Implement zero-overhead structured logging via Pino, paired with an embedded operational telemetry tab in the web dashboard (monitoring worker queue depth, staging R2 queue age, webhook delivery latency/success ratios, and storage volume capacity). Provide an optional Prometheus-compatible `/metrics` endpoint.
- **Consequence:** Delivers full operational observability without requiring resource-heavy external monitoring containers (Grafana/Prometheus/ELK) on 1-CPU / 1-GB RAM VPS.

### 7. Release Gates & Autonomous Execution Boundaries: 5-Pillar Quality Gate
- **Decision:** Mandate strict 5-pillar release criteria for stable releases (Test Gate: 100% pass; Security Gate: zero vulnerabilities & verified authorization/SSRF/CSRF; Data Integrity Gate: verified idempotent migrations and dual-read storage; UX & A11y Gate: Playwright E2E and WCAG AA verification; Performance Gate: <150 MB application RSS under normal load). Lead Engineer operates with full autonomous ownership of design, implementation, refactoring, and PRs, escalating to Founder only for production deploys, new external costs, or fundamental ADR contradictions.
- **Consequence:** Enables rapid, high-velocity engineering cycles with uncompromised quality assurance.
