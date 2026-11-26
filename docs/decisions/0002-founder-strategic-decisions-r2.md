# ADR 0002: Founder Strategic Decisions Round 2

- **Status:** Approved by Founder
- **Date:** 2026-11-27
- **Author:** Autonomous Lead Engineer & Founder

## Context & Problem Statement
Following the approval of Round 1 high-level pillars (ADR 0001), Letterdock required concrete architectural decisions regarding outbound relaying, Resend API parity, storage migration safety, forward-compatible tenancy, worker queue concurrency, and operator UX standards.

## Approved Decisions

### 1. Outbound Provider Abstraction: Per-Domain Profiles with Global Fallback
- **Decision:** Support independent outbound relay profiles per domain (Amazon SES, Resend, Brevo, Custom SMTP) with encrypted credential storage in PostgreSQL and optional global fallback configured in `.env`.
- **Consequence:** Requires new `outbound_profiles` relation, domain authorization enforcement, encrypted secrets management, and provider adapter interfaces.

### 2. Resend Ecosystem Compatibility: Drop-in Parity for Core Endpoints
- **Decision:** Provide strict drop-in compatibility for core Resend REST endpoints (`POST /emails`, `POST /emails/batch`, `GET /emails/:id`, `GET/POST /domains`, `GET/POST /api-keys`, and inbound receiving endpoints) verifiable against official Resend SDKs, complemented by native Letterdock endpoints for unique features.
- **Consequence:** Requires a contract-testing harness verifying request/response parity against official Resend client libraries.

### 3. Zero-Downtime Storage Migration: Lazy Dual-Read with Background Migration
- **Decision:** Migrate attachment and raw RFC 822 MIME blobs from PostgreSQL `bytea` to an abstract hybrid blob storage engine via lazy dual-read with asynchronous batch migration. Legacy `bytea` columns are only dropped after cryptographic checksum verification confirms 100% integrity across all records.
- **Consequence:** Zero operational downtime during upgrades; safe streaming without database RAM exhaustion; requires orphan blob GC job.

### 4. Forward-Compatible Multi-Tenancy: Implicit Workspace Zero-State
- **Decision:** Introduce a foundational `workspaces` table with a default workspace (`id: 'default'`). Enforce workspace scoping across `domains`, `messages`, `api_keys`, and `hooks` via foreign key constraints, while keeping the UI single-admin for current milestones.
- **Consequence:** Prepares the data layer for multi-user RBAC without requiring database schema overhauls later.

### 5. Performance & Concurrency: PostgreSQL-Native Worker Pool via `SKIP LOCKED`
- **Decision:** Replace serial 1-job-per-tick queue processing with a concurrent PostgreSQL worker pool utilizing `FOR UPDATE SKIP LOCKED`, bounded batching, exponential backoff with jitter, job leasing with heartbeats, dead-letter queuing (DLQ), and graceful shutdown.
- **Consequence:** Ultra-low RAM footprint suitable for 1-CPU / 1-GB RAM VPS without adding Redis as a mandatory service.

### 6. Design System & Operator Experience: Keyboard-First High-Density Inbox
- **Decision:** Build a fast, keyboard-first inbox with density toggles, split-pane reading, and dark/light themes, engineered with full accessibility for mouse, mobile touchscreen, and assistive technologies (WCAG 2.1 AA).
- **Consequence:** Requires modular React components, structured design tokens, and comprehensive Playwright interaction testing.
