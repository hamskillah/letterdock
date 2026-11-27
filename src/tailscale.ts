import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from './db.js';

const execFilePromise = promisify(execFile);

export interface TailscaleHostInfo {
  installed: boolean;
  running: boolean;
  backendState: string;
  ips: string[];
  ipv4: string | null;
  ipv6: string | null;
  hostname: string | null;
  magicDns: string | null;
}

export interface TailscaleSettings {
  enabled: boolean;
  configuredOrigin: string | null;
  mode: 'serve' | 'direct' | 'sidecar' | 'custom';
}

export interface TailscaleStatusResponse {
  enabled: boolean;
  detected: boolean;
  host: TailscaleHostInfo;
  settings: TailscaleSettings;
  listenPort: number;
  bindAddress: string;
  activeOrigins: string[];
  suggestedOrigins: string[];
  serveCommand: string;
}

/**
 * Validates whether an IPv4 address is within Tailscale's Carrier-Grade NAT (CGNAT) block:
 * 100.64.0.0/10 (100.64.0.0 to 100.127.255.255).
 */
export function isTailscaleIpv4(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return false;
  return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
}

/**
 * Validates whether an IPv6 address is within Tailscale's Unique Local Address (ULA) block:
 * fd7a:115c:a1e0::/48
 */
export function isTailscaleIpv6(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const clean = ip.trim().toLowerCase().replace(/[\[\]]/g, '');
  return clean.startsWith('fd7a:115c:a1e0:') || clean === 'fd7a:115c:a1e0::';
}

/**
 * Validates whether a domain is a genuine Tailscale MagicDNS hostname (*.ts.net).
 * Strictly ensures it ends with '.ts.net' without subdomain evasion.
 */
export function isTailscaleMagicDns(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return false;
  const lower = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!lower.endsWith('.ts.net')) return false;
  if (lower === '.ts.net' || lower === 'ts.net') return false;
  // Ensure the segment immediately preceding ts.net is separated by a dot
  const parts = lower.split('.');
  if (parts.length < 3) return false;
  return parts[parts.length - 2] === 'ts' && parts[parts.length - 1] === 'net';
}

/**
 * Checks if a hostname (without protocol or port) is any valid Tailscale identifier.
 */
export function isTailscaleHostname(hostname: string): boolean {
  const h = hostname.replace(/[\[\]]/g, '');
  return isTailscaleIpv4(h) || isTailscaleIpv6(h) || isTailscaleMagicDns(h);
}

/**
 * Detects Tailscale state directly on the host machine using the tailscale CLI.
 */
export async function detectTailscaleHost(): Promise<TailscaleHostInfo> {
  try {
    const { stdout } = await execFilePromise('tailscale', ['status', '--json'], { timeout: 3000 });
    const parsed = JSON.parse(stdout);
    const ips: string[] = Array.isArray(parsed.TailscaleIPs) ? parsed.TailscaleIPs : [];
    const ipv4 = ips.find(ip => isTailscaleIpv4(ip)) || null;
    const ipv6 = ips.find(ip => isTailscaleIpv6(ip)) || null;
    const rawDns = parsed.Self?.DNSName || null;
    const magicDns = rawDns ? rawDns.replace(/\.$/, '') : null;
    const hostname = parsed.Self?.HostName || null;
    const running = parsed.BackendState === 'Running';

    return {
      installed: true,
      running,
      backendState: parsed.BackendState || 'Unknown',
      ips,
      ipv4,
      ipv6,
      hostname,
      magicDns
    };
  } catch {
    return {
      installed: false,
      running: false,
      backendState: 'Not detected',
      ips: [],
      ipv4: null,
      ipv6: null,
      hostname: null,
      magicDns: null
    };
  }
}

/**
 * Retrieves Tailscale settings from PostgreSQL database and environment fallbacks.
 */
export async function getTailscaleSettings(): Promise<TailscaleSettings> {
  let enabled = process.env.TAILSCALE_ENABLED === 'true';
  let configuredOrigin: string | null = process.env.TAILSCALE_ORIGIN || null;
  let mode: TailscaleSettings['mode'] = (process.env.TAILSCALE_MODE as any) || 'serve';

  try {
    const { rows } = await db.query(
      "SELECT key, value FROM settings WHERE key IN ('tailscale_enabled', 'tailscale_origin', 'tailscale_mode')"
    );
    for (const row of rows) {
      if (row.key === 'tailscale_enabled') enabled = row.value === 'true';
      if (row.key === 'tailscale_origin') configuredOrigin = row.value || null;
      if (row.key === 'tailscale_mode') mode = (row.value as any) || 'serve';
    }
  } catch {}

  return { enabled, configuredOrigin, mode };
}

/**
 * Saves Tailscale settings to PostgreSQL database.
 */
export async function saveTailscaleSettings(settings: Partial<TailscaleSettings>): Promise<TailscaleSettings> {
  if (settings.enabled !== undefined) {
    await db.query(
      "INSERT INTO settings(key, value) VALUES('tailscale_enabled', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [settings.enabled ? 'true' : 'false']
    );
  }

  if (settings.configuredOrigin !== undefined) {
    const originVal = settings.configuredOrigin ? settings.configuredOrigin.trim() : '';
    await db.query(
      "INSERT INTO settings(key, value) VALUES('tailscale_origin', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [originVal]
    );
  }

  if (settings.mode !== undefined) {
    await db.query(
      "INSERT INTO settings(key, value) VALUES('tailscale_mode', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [settings.mode]
    );
  }

  return await getTailscaleSettings();
}

/**
 * Evaluates whether an HTTP Origin header is authorized under Tailscale policy.
 */
export function isAllowedTailscaleOrigin(
  origin: string | undefined,
  settings: TailscaleSettings,
  hostInfo?: TailscaleHostInfo
): { allowed: boolean; reason?: string } {
  if (!origin) return { allowed: false, reason: 'Missing origin header' };
  if (!settings.enabled) return { allowed: false, reason: 'Tailscale origin access is disabled in settings' };

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();

    // 1. Explicitly configured Tailscale origin match
    if (settings.configuredOrigin) {
      try {
        const confUrl = new URL(settings.configuredOrigin);
        if (confUrl.origin.toLowerCase() === url.origin.toLowerCase()) {
          return { allowed: true, reason: 'Matches configured Tailscale origin' };
        }
      } catch {}
    }

    // 2. Tailscale CGNAT IPv4 match (100.64.0.0/10)
    if (isTailscaleIpv4(hostname)) {
      return { allowed: true, reason: 'Origin uses Tailscale CGNAT IPv4 range (100.64.0.0/10)' };
    }

    // 3. Tailscale Unique Local Address IPv6 match (fd7a:115c:a1e0::/48)
    if (isTailscaleIpv6(hostname)) {
      return { allowed: true, reason: 'Origin uses Tailscale IPv6 ULA range (fd7a:115c:a1e0::/48)' };
    }

    // 4. Tailscale MagicDNS domain match (*.ts.net)
    if (isTailscaleMagicDns(hostname)) {
      return { allowed: true, reason: 'Origin uses Tailscale MagicDNS (*.ts.net)' };
    }

    // 5. Host info detected matches
    if (hostInfo && hostInfo.running) {
      if (hostInfo.magicDns && hostname === hostInfo.magicDns.toLowerCase().replace(/\.$/, '')) {
        return { allowed: true, reason: 'Matches detected host MagicDNS name' };
      }
      if (hostInfo.ips.includes(hostname)) {
        return { allowed: true, reason: 'Matches detected host Tailscale IP' };
      }
    }
  } catch {}

  return { allowed: false, reason: 'Origin does not match any authorized Tailscale address or domain' };
}

/**
 * Generates aggregated Tailscale status, instructions, and connection parameters.
 */
export async function getTailscaleStatus(listenPort = 3000): Promise<TailscaleStatusResponse> {
  const [host, settings] = await Promise.all([
    detectTailscaleHost(),
    getTailscaleSettings()
  ]);

  const bindAddress = process.env.BIND_ADDRESS || '127.0.0.1';
  const suggestedOrigins: string[] = [];

  if (host.magicDns) {
    suggestedOrigins.push(`https://${host.magicDns}`);
    suggestedOrigins.push(`http://${host.magicDns}:${listenPort}`);
  }
  if (host.ipv4) {
    suggestedOrigins.push(`http://${host.ipv4}:${listenPort}`);
  }
  if (settings.configuredOrigin && !suggestedOrigins.includes(settings.configuredOrigin)) {
    suggestedOrigins.unshift(settings.configuredOrigin);
  }

  const activeOrigins: string[] = [];
  if (settings.enabled) {
    if (settings.configuredOrigin) activeOrigins.push(settings.configuredOrigin);
    if (host.ipv4) activeOrigins.push(`http://${host.ipv4}:${listenPort}`);
    if (host.magicDns) activeOrigins.push(`https://${host.magicDns}`);
  }

  return {
    enabled: settings.enabled,
    detected: host.installed && host.running,
    host,
    settings,
    listenPort,
    bindAddress,
    activeOrigins,
    suggestedOrigins,
    serveCommand: `tailscale serve --bg ${listenPort}`
  };
}
