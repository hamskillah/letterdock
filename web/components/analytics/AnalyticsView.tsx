import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  MailCheck,
  Eye,
  MousePointer,
  AlertTriangle,
  RotateCw,
  Activity,
  CheckCircle2,
  ExternalLink
} from 'lucide-react';
import { api } from '../../api/client.js';

export const AnalyticsView: React.FC = () => {
  const [data, setData] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      const [overview, eventsRes] = await Promise.all([
        api<any>('/analytics/overview'),
        api<any>('/analytics/events')
      ]);
      setData(overview);
      setEvents(eventsRes?.events || []);
    } catch (err) {
      console.error('Failed to load analytics', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const totals = data?.totals || {};
  const rates = data?.rates || {};
  const timeline = data?.timeline || [];

  return (
    <div className="manage-view" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>Analytics & Deliverability Suite</h2>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Real-time engagement telemetry, open & click tracking rates, and outbound deliverability health.
          </p>
        </div>
        <button className="secondary" onClick={fetchAnalytics} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <RotateCw size={15} className={loading ? 'spinning' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {/* KPI Metric Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            <span>Total Sent</span>
            <MailCheck size={16} />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700 }}>{totals.sent ?? 0}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {totals.delivered ?? 0} confirmed delivered
          </div>
        </div>

        <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            <span>Delivery Rate</span>
            <CheckCircle2 size={16} color="var(--success)" />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700 }}>{rates.deliveryRate ?? 100}%</div>
          <div style={{ fontSize: '0.75rem', color: rates.deliveryRate >= 98 ? 'var(--success)' : 'var(--warning)' }}>
            {rates.deliveryRate >= 98 ? '★ Excellent reputation' : 'Monitor bouncing'}
          </div>
        </div>

        <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            <span>Unique Opens</span>
            <Eye size={16} color="var(--primary)" />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700 }}>{totals.opens ?? 0}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {rates.openRate ?? 0}% open rate
          </div>
        </div>

        <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            <span>Clicks</span>
            <MousePointer size={16} color="var(--info)" />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700 }}>{totals.clicks ?? 0}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {rates.clickRate ?? 0}% click rate
          </div>
        </div>

        <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            <span>Bounces</span>
            <AlertTriangle size={16} color={totals.bounces > 0 ? 'var(--danger)' : 'var(--text-muted)'} />
          </div>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, color: totals.bounces > 0 ? 'var(--danger)' : 'var(--text)' }}>
            {totals.bounces ?? 0}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {rates.bounceRate ?? 0}% bounce rate
          </div>
        </div>
      </div>

      {/* 7-Day Performance Timeline */}
      <div className="card" style={{ padding: '1.25rem' }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>7-Day Engagement Timeline</h3>
        {timeline.length === 0 ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            No engagement recorded in the last 7 days.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '0.5rem' }}>Date</th>
                  <th style={{ padding: '0.5rem' }}>Delivered</th>
                  <th style={{ padding: '0.5rem' }}>Opens</th>
                  <th style={{ padding: '0.5rem' }}>Clicks</th>
                  <th style={{ padding: '0.5rem' }}>Bounces</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((row: any) => (
                  <tr key={row.day} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.5rem', fontWeight: 600 }}>{row.day}</td>
                    <td style={{ padding: '0.5rem' }}>{row.delivered || 0}</td>
                    <td style={{ padding: '0.5rem', color: 'var(--primary)' }}>{row.opens || 0}</td>
                    <td style={{ padding: '0.5rem', color: 'var(--info)' }}>{row.clicks || 0}</td>
                    <td style={{ padding: '0.5rem', color: row.bounces > 0 ? 'var(--danger)' : 'inherit' }}>{row.bounces || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Real-time Tracking Events Stream */}
      <div className="card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Recent Tracking & Delivery Events</h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Last 100 events</span>
        </div>

        {events.length === 0 ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            No recent email events recorded yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '0.5rem' }}>Event</th>
                  <th style={{ padding: '0.5rem' }}>Recipient</th>
                  <th style={{ padding: '0.5rem' }}>Message ID</th>
                  <th style={{ padding: '0.5rem' }}>Details</th>
                  <th style={{ padding: '0.5rem' }}>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev: any) => {
                  let badgeBg = 'var(--hover)';
                  let badgeColor = 'var(--text)';
                  if (ev.event_type === 'delivered') { badgeBg = 'var(--success-bg)'; badgeColor = 'var(--success)'; }
                  if (ev.event_type === 'opened') { badgeBg = 'var(--info-bg)'; badgeColor = 'var(--info)'; }
                  if (ev.event_type === 'clicked') { badgeBg = 'var(--selected)'; badgeColor = 'var(--accent)'; }
                  if (ev.event_type === 'bounced') { badgeBg = 'var(--danger-bg)'; badgeColor = 'var(--danger)'; }

                  const targetUrl = ev.metadata?.targetUrl;

                  return (
                    <tr key={ev.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.5rem' }}>
                        <span style={{ padding: '0.15rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600, background: badgeBg, color: badgeColor }}>
                          {ev.event_type}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem', fontWeight: 500 }}>{ev.recipient}</td>
                      <td style={{ padding: '0.5rem' }}>
                        <code style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                          {ev.message_id?.slice(0, 12)}...
                        </code>
                      </td>
                      <td style={{ padding: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {targetUrl ? (
                          <span title={targetUrl} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                            {targetUrl.slice(0, 35)}... <ExternalLink size={11} />
                          </span>
                        ) : ev.metadata?.provider ? (
                          <span>via {ev.metadata.provider}</span>
                        ) : '-'}
                      </td>
                      <td style={{ padding: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {new Date(ev.created_at).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
