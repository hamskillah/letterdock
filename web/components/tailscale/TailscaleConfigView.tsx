import React, { useState, useEffect } from 'react';
import {
  Radio,
  Copy,
  Check,
  CheckCircle2,
  AlertTriangle,
  Info,
  ShieldCheck,
  Server,
  Layers,
  ArrowRight,
  ExternalLink
} from 'lucide-react';
import type { TailscaleStatusResponse, TailscaleVerifyOriginResponse } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';

export interface TailscaleConfigViewProps {
  api: <T = any>(path: string, method?: string, data?: unknown) => Promise<T>;
}

export const TailscaleConfigView: React.FC<TailscaleConfigViewProps> = ({ api }) => {
  const [status, setStatus] = useState<TailscaleStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [configuredOrigin, setConfiguredOrigin] = useState('');
  const [mode, setMode] = useState<'serve' | 'direct' | 'sidecar' | 'custom'>('serve');
  const [activeTab, setActiveTab] = useState<'serve' | 'direct' | 'sidecar'>('serve');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Origin verification probe state
  const [verifyingOrigin, setVerifyingOrigin] = useState(false);
  const [verifyResult, setVerifyResult] = useState<TailscaleVerifyOriginResponse | null>(null);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const res: TailscaleStatusResponse = await api('/settings/tailscale');
      setStatus(res);
      setEnabled(res.enabled);
      setConfiguredOrigin(res.settings.configuredOrigin || '');
      setMode(res.settings.mode || 'serve');
    } catch (err) {
      console.error('Failed to load Tailscale status', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleCopy = async (key: string, text: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard', err);
    }
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    setSaveMessage(null);
    try {
      const updated = await api<TailscaleStatusResponse>('/settings/tailscale', 'POST', {
        enabled,
        configuredOrigin: configuredOrigin.trim() || null,
        mode
      });
      setStatus(updated);
      setSaveMessage('Tailscale configuration saved successfully!');
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (err: any) {
      setSaveMessage('Error saving configuration: ' + (err.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyCurrentOrigin = async () => {
    setVerifyingOrigin(true);
    try {
      const currentOrigin = window.location.origin;
      const res = await api<TailscaleVerifyOriginResponse>('/settings/tailscale/verify-origin', 'POST', {
        origin: currentOrigin
      });
      setVerifyResult(res);
    } catch (err: any) {
      setVerifyResult({
        origin: window.location.origin,
        allowed: false,
        reason: err.message || 'Verification failed'
      });
    } finally {
      setVerifyingOrigin(false);
    }
  };

  const currentWindowOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const detectedIpv4 = status?.host.ipv4;
  const detectedMagicDns = status?.host.magicDns;
  const isOnline = status?.host.running;

  return (
    <section className="settings tailscale-view">
      <header className="settings-heading">
        <span className="section-icon">
          <Radio size={21} />
        </span>
        <div className="title-with-badge">
          <h1>Tailscale Access</h1>
          {status && (
            <Badge variant={status.enabled ? 'ok' : 'neutral'}>
              {status.enabled ? 'Authorized' : 'Disabled'}
            </Badge>
          )}
        </div>
      </header>

      {/* 1. Host Daemon Status Overview */}
      <section className="settings-panel tailscale-status-panel">
        <div className="panel-header-row">
          <div>
            <h2>Host Tailscale Daemon</h2>
            <p className="panel-subtitle">
              Inspect whether Tailscale is running on this server and review detected network interfaces.
            </p>
          </div>
          <button
            type="button"
            className="dns-refresh-btn"
            onClick={fetchStatus}
            disabled={loading}
          >
            Refresh Status
          </button>
        </div>

        <div className="tailscale-status-grid">
          <div className="status-metric">
            <span className="metric-label">Daemon Status</span>
            <span className="metric-value">
              {isOnline ? (
                <Badge variant="ok">Online ({status?.host.backendState})</Badge>
              ) : status?.host.installed ? (
                <Badge variant="warn">{status.host.backendState}</Badge>
              ) : (
                <Badge variant="neutral">Not installed on host</Badge>
              )}
            </span>
          </div>

          <div className="status-metric">
            <span className="metric-label">Tailscale IPv4</span>
            <span className="metric-value mono">
              {detectedIpv4 ? (
                <div className="copyable-pill">
                  <span>{detectedIpv4}</span>
                  <button
                    type="button"
                    className="copy-mini-btn"
                    onClick={() => handleCopy('ipv4', detectedIpv4)}
                    title="Copy Tailscale IP"
                    aria-label="Copy Tailscale IP"
                  >
                    {copiedKey === 'ipv4' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              ) : (
                <span className="text-muted">—</span>
              )}
            </span>
          </div>

          <div className="status-metric">
            <span className="metric-label">MagicDNS Name</span>
            <span className="metric-value mono">
              {detectedMagicDns ? (
                <div className="copyable-pill">
                  <span>{detectedMagicDns}</span>
                  <button
                    type="button"
                    className="copy-mini-btn"
                    onClick={() => handleCopy('magicDns', detectedMagicDns)}
                    title="Copy MagicDNS hostname"
                    aria-label="Copy MagicDNS hostname"
                  >
                    {copiedKey === 'magicDns' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              ) : (
                <span className="text-muted">—</span>
              )}
            </span>
          </div>

          <div className="status-metric">
            <span className="metric-label">Server Listen Port</span>
            <span className="metric-value mono">{status?.listenPort ?? 3000}</span>
          </div>
        </div>
      </section>

      {/* 2. Authorization & Origin Policy Configuration */}
      <section className="settings-panel">
        <h2>Origin & CSRF Security Policy</h2>
        <p className="panel-subtitle">
          Letterdock enforces strict origin and CSRF checks. Enable Tailscale authorization to allow dashboard
          access and form mutations over your private WireGuard network.
        </p>

        <form className="settings-form tailscale-form" onSubmit={handleSave}>
          <label className="checkbox-row tailscale-toggle-row">
            <input
              type="checkbox"
              id="tailscale-enabled-toggle"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
            />
            <div className="toggle-text">
              <strong>Allow Tailscale Origin Authorization</strong>
              <small>
                Permits incoming requests from standard Tailscale CGNAT addresses (100.64.0.0/10),
                IPv6 ULA (fd7a:115c:a1e0::/48), and MagicDNS (*.ts.net) domains.
              </small>
            </div>
          </label>

          <label htmlFor="tailscale-origin-input">
            Configured Origin / Custom Domain (optional)
            <div className="input-with-actions">
              <input
                id="tailscale-origin-input"
                name="configuredOrigin"
                type="url"
                value={configuredOrigin}
                onChange={e => setConfiguredOrigin(e.target.value)}
                placeholder="https://my-node.tailnet.ts.net"
              />
              {detectedMagicDns && (
                <button
                  type="button"
                  className="quick-fill-btn"
                  onClick={() => setConfiguredOrigin(`https://${detectedMagicDns}`)}
                >
                  Use MagicDNS
                </button>
              )}
              {detectedIpv4 && (
                <button
                  type="button"
                  className="quick-fill-btn"
                  onClick={() => setConfiguredOrigin(`http://${detectedIpv4}:${status?.listenPort || 3000}`)}
                >
                  Use IP
                </button>
              )}
            </div>
            <span className="input-hint">
              Explicit origin URL to authorize if accessing through a custom reverse proxy or Tailscale Funnel.
            </span>
          </label>

          <div className="form-actions-row">
            <button
              type="submit"
              className="primary tailscale-save-btn"
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
            {saveMessage && (
              <span className="save-feedback" role="status">
                {saveMessage}
              </span>
            )}
          </div>
        </form>
      </section>

      {/* 3. Live Browser Origin Probe */}
      <section className="settings-panel origin-verifier-panel">
        <div className="panel-header-row">
          <div>
            <h2>Current Browser Connection Test</h2>
            <p className="panel-subtitle">
              Verify whether your current browser origin is allowed to interact with the Letterdock API.
            </p>
          </div>
          <button
            type="button"
            className="secondary verify-origin-btn"
            onClick={handleVerifyCurrentOrigin}
            disabled={verifyingOrigin}
          >
            {verifyingOrigin ? 'Verifying...' : 'Test Current Origin'}
          </button>
        </div>

        <div className="current-origin-card">
          <div className="origin-row">
            <span className="label">Current Browser Origin:</span>
            <code className="origin-code">{currentWindowOrigin}</code>
          </div>

          {verifyResult && (
            <div className={`verify-outcome ${verifyResult.allowed ? 'allowed' : 'rejected'}`}>
              {verifyResult.allowed ? (
                <>
                  <CheckCircle2 size={18} className="outcome-icon" />
                  <div>
                    <strong>Origin is Authorized</strong>
                    <p>{verifyResult.reason}</p>
                  </div>
                </>
              ) : (
                <>
                  <AlertTriangle size={18} className="outcome-icon" />
                  <div>
                    <strong>Origin is Not Authorized</strong>
                    <p>{verifyResult.reason}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* 4. Connection Modes & Setup Guides */}
      <section className="settings-panel guides-panel">
        <h2>Deployment & Connection Guides</h2>
        <p className="panel-subtitle">
          Choose the connection mode that matches your infrastructure architecture.
        </p>

        <div className="guide-tab-nav" role="tablist" aria-label="Tailscale Connection Methods">
          <button
            role="tab"
            aria-selected={activeTab === 'serve'}
            className={`guide-tab ${activeTab === 'serve' ? 'active' : ''}`}
            onClick={() => setActiveTab('serve')}
          >
            <Server size={15} />
            <span>Tailscale Serve (HTTPS)</span>
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'direct'}
            className={`guide-tab ${activeTab === 'direct' ? 'active' : ''}`}
            onClick={() => setActiveTab('direct')}
          >
            <ShieldCheck size={15} />
            <span>Direct Tailnet IP</span>
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'sidecar'}
            className={`guide-tab ${activeTab === 'sidecar' ? 'active' : ''}`}
            onClick={() => setActiveTab('sidecar')}
          >
            <Layers size={15} />
            <span>Docker Sidecar</span>
          </button>
        </div>

        <div className="guide-tab-content">
          {activeTab === 'serve' && (
            <div className="guide-card" role="tabpanel">
              <div className="guide-banner recommend">
                <Badge variant="accent">Recommended</Badge>
                <span>Automated Let's Encrypt TLS certificates, zero open firewall ports, HTTPS by default.</span>
              </div>
              <p>
                Run Tailscale Serve on the host to expose Letterdock securely over your Tailnet. Tailscale terminates TLS
                using automatic valid Let's Encrypt certificates for your MagicDNS domain.
              </p>
              <div className="guide-code-box">
                <div className="code-header">
                  <span>Terminal Command</span>
                  <button
                    type="button"
                    className="copy-mini-btn"
                    onClick={() => handleCopy('serveCmd', `tailscale serve --bg ${status?.listenPort || 3000}`)}
                    aria-label="Copy Tailscale Serve command"
                  >
                    {copiedKey === 'serveCmd' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <code>tailscale serve --bg {status?.listenPort || 3000}</code>
              </div>
              <div className="guide-url-preview">
                <span>Dashboard Access URL:</span>
                <code>https://{detectedMagicDns || '<node>.<tailnet>.ts.net'}</code>
              </div>
            </div>
          )}

          {activeTab === 'direct' && (
            <div className="guide-card" role="tabpanel">
              <p>
                Bind Letterdock directly to your host's private Tailscale IP (100.64.0.0/10). The service remains
                completely unreachable from the public internet and accessible only to authenticated devices on your Tailnet.
              </p>
              <div className="guide-code-box">
                <div className="code-header">
                  <span>1. Configure in .env</span>
                  <button
                    type="button"
                    className="copy-mini-btn"
                    onClick={() => handleCopy('directEnv', `BIND_ADDRESS=${detectedIpv4 || '100.x.y.z'}`)}
                    aria-label="Copy BIND_ADDRESS setting"
                  >
                    {copiedKey === 'directEnv' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <code>BIND_ADDRESS={detectedIpv4 || '100.x.y.z'}</code>
              </div>
              <div className="guide-code-box">
                <div className="code-header">
                  <span>2. Restart Docker Stack</span>
                  <button
                    type="button"
                    className="copy-mini-btn"
                    onClick={() => handleCopy('directRestart', 'docker compose up -d')}
                    aria-label="Copy restart command"
                  >
                    {copiedKey === 'directRestart' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <code>docker compose up -d</code>
              </div>
              <div className="guide-url-preview">
                <span>Dashboard Access URL:</span>
                <code>http://{detectedIpv4 || '100.x.y.z'}:{status?.listenPort || 3000}</code>
              </div>
            </div>
          )}

          {activeTab === 'sidecar' && (
            <div className="guide-card" role="tabpanel">
              <p>
                If Tailscale is not installed on your host OS, launch the turnkey Tailscale Docker container sidecar
                alongside Letterdock using the included overlay.
              </p>
              <div className="guide-code-box">
                <div className="code-header">
                  <span>Start Stack with Tailscale Container</span>
                  <button
                    type="button"
                    className="copy-mini-btn"
                    onClick={() => handleCopy('sidecarCmd', 'docker compose -f compose.yml -f compose.tailscale.yml up -d')}
                    aria-label="Copy sidecar compose command"
                  >
                    {copiedKey === 'sidecarCmd' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <code>docker compose -f compose.yml -f compose.tailscale.yml up -d</code>
              </div>
              <p className="text-muted">
                Requires <code>TS_AUTHKEY</code> in your <code>.env</code> file (generated from Tailscale Admin Console → Settings → Keys).
              </p>
            </div>
          )}
        </div>
      </section>
    </section>
  );
};
