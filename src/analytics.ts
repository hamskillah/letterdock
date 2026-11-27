import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { getEncryptionKey } from './crypto.js';

const TRACKING_PURPOSE = 'email-tracking';

// Transparent 1x1 GIF buffer
export const TRANSPARENT_GIF_BUFFER = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

export interface TrackingPayload {
  wid: string;      // workspace_id
  mid: string;      // message_id
  oid?: string;     // outbound_id (uuid)
  rcpt: string;     // recipient
  url?: string;     // destination URL for clicks
  ts: number;       // timestamp
}

/**
 * Generate a signed tracking token (URL-safe base64).
 */
export function signTrackingToken(payload: TrackingPayload): string {
  const dataStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = getEncryptionKey(TRACKING_PURPOSE);
  const sig = createHmac('sha256', key).update(dataStr).digest('base64url');
  return `${dataStr}.${sig}`;
}

/**
 * Verify and decode a signed tracking token.
 */
export function verifyTrackingToken(token: string): TrackingPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [dataStr, sig] = parts;
  const key = getEncryptionKey(TRACKING_PURPOSE);
  const expectedSig = createHmac('sha256', key).update(dataStr).digest('base64url');

  try {
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const json = Buffer.from(dataStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as TrackingPayload;
    if (!parsed.wid || !parsed.mid || !parsed.rcpt) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Inject tracking pixel and rewrite links for click tracking.
 */
export function injectEmailTracking(
  html: string,
  options: {
    workspaceId: string;
    messageId: string;
    outboundId?: string;
    recipient: string;
    baseUrl: string;
    trackOpens?: boolean;
    trackClicks?: boolean;
  }
): string {
  if (!html) return html;
  let processed = html;
  const base = options.baseUrl.replace(/\/+$/, '');

  // 1. Click tracking: rewrite <a href="...">
  if (options.trackClicks) {
    processed = processed.replace(
      /<a\b([^>]*?)href=(["'])(https?:\/\/[^"'>]+)\2([^>]*?)>/gi,
      (_match, pre, quote, originalUrl, post) => {
        // Skip mailto, tel, or tracking URLs themselves
        if (originalUrl.includes('/t/c/')) {
          return _match;
        }
        const token = signTrackingToken({
          wid: options.workspaceId,
          mid: options.messageId,
          oid: options.outboundId,
          rcpt: options.recipient,
          url: originalUrl,
          ts: Date.now()
        });
        const redirectUrl = `${base}/t/c/${token}`;
        return `<a${pre}href=${quote}${redirectUrl}${quote}${post}>`;
      }
    );
  }

  // 2. Open tracking: append 1x1 image before </body> or at end
  if (options.trackOpens) {
    const token = signTrackingToken({
      wid: options.workspaceId,
      mid: options.messageId,
      oid: options.outboundId,
      rcpt: options.recipient,
      ts: Date.now()
    });
    const pixelUrl = `${base}/t/o/${token}.gif`;
    const pixelTag = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;max-height:0;overflow:hidden;" />`;

    if (processed.includes('</body>')) {
      processed = processed.replace('</body>', `${pixelTag}</body>`);
    } else {
      processed += pixelTag;
    }
  }

  return processed;
}

/**
 * Record an email tracking event.
 */
export async function recordEmailEvent(event: {
  workspaceId: string;
  messageId: string;
  outboundId?: string;
  recipient: string;
  eventType: 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained';
  metadata?: Record<string, any>;
}): Promise<void> {
  await db.query(
    `INSERT INTO email_events (workspace_id, message_id, outbound_id, recipient, event_type, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.workspaceId,
      event.messageId,
      event.outboundId || null,
      event.recipient.toLowerCase(),
      event.eventType,
      JSON.stringify(event.metadata || {})
    ]
  );
}

/**
 * Get aggregated analytics overview for workspace.
 */
export async function getAnalyticsOverview(workspaceId: string = 'default') {
  const [totalsRes, ratesRes, timelineRes] = await Promise.all([
    // Totals by event type in outbound_messages
    db.query(
      `SELECT
         COUNT(*) as total_sent,
         COUNT(*) FILTER (WHERE status = 'delivered') as total_delivered,
         COUNT(*) FILTER (WHERE status = 'bounced') as total_bounced,
         COUNT(*) FILTER (WHERE status = 'suppressed') as total_suppressed
       FROM outbound_messages
       WHERE workspace_id = $1`,
      [workspaceId]
    ),
    // Event count in email_events
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'opened') as unique_opens,
         COUNT(*) FILTER (WHERE event_type = 'clicked') as unique_clicks,
         COUNT(*) FILTER (WHERE event_type = 'bounced') as total_bounced_events
       FROM (
         SELECT DISTINCT message_id, recipient, event_type
         FROM email_events
         WHERE workspace_id = $1
       ) unique_events`,
      [workspaceId]
    ),
    // 7-day timeline breakdown
    db.query(
      `SELECT
         to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
         COUNT(*) FILTER (WHERE event_type = 'opened') as opens,
         COUNT(*) FILTER (WHERE event_type = 'clicked') as clicks,
         COUNT(*) FILTER (WHERE event_type = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE event_type = 'bounced') as bounces
       FROM email_events
       WHERE workspace_id = $1 AND created_at >= now() - interval '7 days'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [workspaceId]
    )
  ]);

  const totals = totalsRes.rows[0] || {};
  const rates = ratesRes.rows[0] || {};
  const sentCount = parseInt(totals.total_sent || '0', 10);
  const deliveredCount = parseInt(totals.total_delivered || '0', 10);
  const opensCount = parseInt(rates.unique_opens || '0', 10);
  const clicksCount = parseInt(rates.unique_clicks || '0', 10);
  const bouncesCount = parseInt(totals.total_bounced || '0', 10);

  const baseForRates = sentCount > 0 ? sentCount : 1;
  const openRate = ((opensCount / baseForRates) * 100).toFixed(1);
  const clickRate = ((clicksCount / baseForRates) * 100).toFixed(1);
  const bounceRate = ((bouncesCount / baseForRates) * 100).toFixed(1);
  const deliveryRate = (((sentCount - bouncesCount) / baseForRates) * 100).toFixed(1);

  return {
    totals: {
      sent: sentCount,
      delivered: deliveredCount,
      opens: opensCount,
      clicks: clicksCount,
      bounces: bouncesCount,
      suppressed: parseInt(totals.total_suppressed || '0', 10)
    },
    rates: {
      deliveryRate: Number(deliveryRate),
      openRate: Number(openRate),
      clickRate: Number(clickRate),
      bounceRate: Number(bounceRate)
    },
    timeline: timelineRes.rows
  };
}
