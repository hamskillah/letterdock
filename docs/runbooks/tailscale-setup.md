# Runbook: Accessing Letterdock Securely via Tailscale

This runbook guides operators through accessing the Letterdock dashboard over Tailscale private networking, keeping the application protected from the public internet.

---

## Prerequisites
- Letterdock v1.0.2 or higher running in Docker Compose.
- A Tailscale account and Tailscale client connected on your local machine (Mac, Windows, Linux, iOS, or Android).

---

## Method 1: Tailscale Serve (Recommended — Zero Port Forwarding & Valid HTTPS)

Tailscale Serve creates an encrypted reverse proxy on the host that automatically issues and renews Let's Encrypt TLS certificates for your machine's MagicDNS domain.

### 1. Ensure Tailscale is installed on the host machine
```bash
tailscale status
```

### 2. Enable Tailscale Origin Authorization in Letterdock
In Letterdock dashboard:
1. Navigate to **Tailscale** in the sidebar.
2. Check **Allow Tailscale Origin Authorization**.
3. Click **Save Configuration**.

Or set via `.env`:
```bash
TAILSCALE_ENABLED=true
```

### 3. Start Tailscale Serve on the Host
Expose Letterdock's local loopback port (default `3000`) as HTTPS:
```bash
tailscale serve --bg 3000
```

### 4. Access the Dashboard
Open your MagicDNS hostname in your browser:
```
https://<your-node-name>.<your-tailnet>.ts.net
```

---

## Method 2: Direct Tailnet IP Binding

If you prefer direct HTTP access over the Tailnet without Serve:

### 1. Obtain Host Tailscale IP
```bash
tailscale ip -4
# e.g., 100.121.221.90
```

### 2. Configure BIND_ADDRESS in `.env`
Edit `/opt/letterdock/.env` (or your app directory):
```bash
BIND_ADDRESS=100.121.221.90
TAILSCALE_ENABLED=true
```

### 3. Rebuild/Restart the Docker Stack
```bash
docker compose up -d
```

### 4. Access the Dashboard
```
http://100.121.221.90:3000
```

---

## Method 3: Tailscale Container Sidecar Overlay

For hosts where Tailscale cannot be installed directly at the OS level:

### 1. Generate an Auth Key in Tailscale Admin Console
Go to [Tailscale Admin Console](https://login.tailscale.com/admin/settings/keys) → **Settings** → **Keys** → **Generate auth key**.

### 2. Configure `.env`
```bash
TS_AUTHKEY=tskey-auth-kXXXXX-XXXXXX
TS_HOSTNAME=letterdock
TAILSCALE_ENABLED=true
```

### 3. Start Stack with the Sidecar Compose Overlay
```bash
docker compose -f compose.yml -f compose.tailscale.yml up -d
```

---

## Troubleshooting & Origin Verification

### Origin Rejected (HTTP 403)
If you see `{"message": "Origin rejected"}`:
1. Check that `TAILSCALE_ENABLED=true` in `.env` or enabled via the dashboard settings.
2. Use the **Current Browser Connection Test** in the Tailscale dashboard to inspect why the origin was allowed or rejected.
3. If using an unconventional custom domain through Tailscale Funnel or a reverse proxy, set `TAILSCALE_ORIGIN=https://your-custom-domain.ts.net`.
