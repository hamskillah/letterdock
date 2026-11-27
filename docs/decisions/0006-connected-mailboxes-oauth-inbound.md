# ADR 0006: Connected External Mailboxes (Gmail & Outlook) via OAuth 2.0 Inbound-Only

- **Status:** Approved
- **Date:** 2026-11-28
- **Author:** Autonomous Lead Engineer & Founder

## Context & Problem Statement
Operators and users manage external personal and organizational email accounts (Google Gmail, Microsoft Outlook, Hotmail, and Microsoft 365). Previously, ingesting mail required either configuring custom domain DNS MX records via Cloudflare or manual IMAP configurations with fragile App Passwords.

The objective of this architecture is to provide an autonomous, 1-click **"Sign in with Google"** and **"Sign in with Microsoft"** experience to seamlessly stream incoming emails into the Letterdock workspace, while establishing **multi-layer, cryptographically enforced Inbound-Only security** guaranteeing that connected external accounts cannot be used for outbound sending.

## Approved Decisions

### 1. Pure OAuth 2.0 (1-Click) with PKCE & Strict Read-Only Scopes
- **Decision:** Mandate OAuth 2.0 Authorization Code flow with PKCE (RFC 7636, S256 challenge) and single-use state verification with a 10-minute TTL.
- **Scope Restriction:**
  - Google: `https://www.googleapis.com/auth/gmail.readonly`, `openid`, `email`, `profile`.
  - Microsoft: `Mail.Read`, `offline_access`, `openid`, `email`, `profile`.
  - Prohibited scopes (`gmail.send`, `gmail.compose`, `gmail.modify`, `mail.google.com`, `Mail.Send`, `Mail.ReadWrite`) trigger an immediate token rejection and abort before database persistence.

### 2. Multi-Layer Inbound-Only Enforcement
- **Layer 1 (Provider Scope Gate):** External provider APIs reject send requests with HTTP 403 Forbidden.
- **Layer 2 (Database Constraint):** Table `connected_mailboxes` enforces `CHECK (direction = 'inbound_only')` and has zero foreign keys to outbound profiles.
- **Layer 3 (Outbound Relay Barrier):** The central `sendEmail()` engine in `src/outbound.ts` actively queries `isSenderConnectedMailbox()`. Any attempt to send with a `From:` address corresponding to a connected mailbox is rejected with HTTP 400 Bad Request (`inbound_only_mailbox`).
- **Layer 4 (UI Enforcement):** Mailboxes and incoming messages are explicitly badged with `[ Inbound Only ]`.

### 3. Cryptographic Storage & Key Separation
- **Decision:** OAuth client secrets, access tokens, and refresh tokens are encrypted at rest using AES-256-GCM via `APP_ENCRYPTION_KEY` (with HKDF-SHA256 derivation), completely isolated from `SESSION_SECRET`.
- **Zero-Leak Policy:** Secrets are never committed to Git, logged, or exposed in API responses.

### 4. Concurrency-Safe Refresh Lifecycle & Rotation
- **Decision:** Implement in-flight mutex deduplication (`refreshLocks`) to prevent race conditions during concurrent polling.
- **Rotation Support:** Handles providers returning rotated refresh tokens upon exchange. Automatically marks mailboxes as `revoked` if the user revokes permissions at the provider dashboard.

### 5. Incremental Sync & Deduplication Engine
- **Decision:** Ingest raw RFC 822 MIME payloads directly into blob storage (`messages/raw/{id}.eml`) and link them to `messages` with `mailbox_id`.
- **Deduplication:** Uses provider message IDs and MIME `Message-ID` headers to prevent duplicate ingestion. Background worker drains pending parsing and attachment indexing.

### 6. Harbor Ledger UI & Mobile-First Accessibility
- **Decision:** Provide a dedicated "Connected Accounts" view in the dashboard sidebar under Manage. Includes provider status cards, 1-click connect actions, credential setup modals with copyable callback URIs, sync controls, pause/resume toggles, and disconnect confirmation with optional local data deletion.
- **Compliance:** Full WCAG 2.1 AA text contrast and 320px responsive reflow containment.
