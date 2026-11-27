# ADR 0004: Tailscale Private Dashboard Access & Origin Authorization

- **Status:** Approved
- **Date:** 2026-11-27
- **Author:** Autonomous Lead Engineer & Founder

## Context & Problem Statement
Letterdock is designed for sovereign, self-hosted email management. In production deployments (such as VPS instances), binding the web UI directly to public interfaces (`0.0.0.0:3000`) or exposing raw HTTP ports without VPN or mesh network encryption introduces unnecessary attack surface. Furthermore, Letterdock enforces strict CSRF and Origin header validation (`isAllowedOrigin`) to prevent cross-site request forgery attacks. 

When accessing the Letterdock dashboard over a private Tailscale tailnet (via Tailscale Carrier-Grade NAT IPv4 `100.64.0.0/10`, IPv6 Unique Local Address `fd7a:115c:a1e0::/48`, or MagicDNS `*.ts.net` hostnames), HTTP requests were previously rejected with HTTP 403 Forbidden because the Origin header did not match the configured single `publicOrigin` or local loopback.

## Approved Decisions

### 1. Dual-Tier Origin Authorization Architecture
- **Decision:** Enhance `isAllowedOrigin` in `src/server.ts` and `src/tailscale.ts` to authorize incoming browser requests from authenticated Tailscale networks when enabled:
  1. Primary: Configured `publicOrigin` (always authorized).
  2. Local loopback: `localhost` / `127.0.0.1` with matching port (development / proxy parity).
  3. Tailscale CGNAT Range: `100.64.0.0/10` (100.64.0.0 - 100.127.255.255).
  4. Tailscale IPv6 ULA Range: `fd7a:115c:a1e0::/48`.
  5. Tailscale MagicDNS: Hostnames ending strictly in `.ts.net` with subdomain evasion protection.
  6. Explicit configured origin: Optional custom domain / proxy origin saved in DB settings (`tailscale_origin`).
- **Rationale:** Preserves strict CSRF defense against external attacker origins while granting seamless, zero-friction access to operators connected to their sovereign private mesh network.

### 2. Flexible Network Interface Binding (`BIND_ADDRESS`)
- **Decision:** Parameterize container and compose host binding to `${BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-3000}:3000`.
- **Rationale:** By default, Letterdock remains securely locked down to local loopback (`127.0.0.1`). Operators wishing to bind directly to their host's Tailscale IP can configure `BIND_ADDRESS=100.x.y.z`, ensuring that the host firewall (UFW) rejects public traffic while Tailscale tun traffic flows smoothly.

### 3. Turnkey Three-Mode Connection Support
- **Decision:** Support three distinct connection topologies with interactive documentation and copyable commands in the dashboard:
  1. **Tailscale Serve (Recommended):** `tailscale serve --bg 3000`. Terminates HTTPS with automated Let's Encrypt certificates for the machine's MagicDNS domain with zero open firewall ports.
  2. **Direct Tailnet IP:** Direct binding to the host's `100.x.y.z` IP via `BIND_ADDRESS`.
  3. **Docker Sidecar Container:** Provided `compose.tailscale.yml` overlay joining the app container into the Tailscale network namespace (`network_mode: "service:tailscale"`).

### 4. Interactive Operator UI & Origin Verifier Probe
- **Decision:** Provide a dedicated "Tailscale" management view in the dashboard sidebar, featuring live daemon status metrics (backend state, IPv4, MagicDNS), origin policy toggles, quick-fill buttons, an interactive browser origin test probe, and connection guides.
- **Rationale:** Eliminates operator guesswork by validating whether the operator's current browser origin is allowed by the security barrier before navigating or executing mutations.

## Consequences & Verification
- Comprehensive unit tests (`tests/unit-tailscale.ts`) verify exact CGNAT range bounds and attack evasion rejection.
- Integration feature tests (`tests/feature-tailscale.ts`) verify real Fastify HTTP CSRF enforcement, settings updates, and memory RSS footprint (<150MB).
- Playwright browser test (`tests/playwright-tailscale-ui.ts`) confirms 100% UI interaction, dark mode contrast, 320px responsive reflow, and screenshot capture.
