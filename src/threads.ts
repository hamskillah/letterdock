import { db } from './db.js';

export interface ParsedSearchQuery {
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  isStarred?: boolean;
  isUnread?: boolean;
  plainText: string;
}

/**
 * Parse advanced search query strings:
 * e.g., "from:alice@example.com subject:'order confirmation' has:attachment urgent"
 */
export function parseSearchQuery(queryStr: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = {
    plainText: ''
  };

  if (!queryStr || typeof queryStr !== 'string') return result;

  const textTokens: string[] = [];
  const regex = /(?:(\w+):(?:"([^"]+)"|'([^']+)'|(\S+)))|(\S+)/g;
  let match;

  while ((match = regex.exec(queryStr)) !== null) {
    if (match[1]) {
      const key = match[1].toLowerCase();
      const value = match[2] || match[3] || match[4] || '';

      switch (key) {
        case 'from':
          result.from = value;
          break;
        case 'to':
          result.to = value;
          break;
        case 'subject':
          result.subject = value;
          break;
        case 'folder':
          result.folder = value;
          break;
        case 'has':
          if (value === 'attachment' || value === 'attachments') {
            result.hasAttachment = true;
          }
          break;
        case 'is':
          if (value === 'starred') result.isStarred = true;
          if (value === 'unread') result.isUnread = true;
          break;
        default:
          textTokens.push(match[0]);
      }
    } else if (match[5]) {
      textTokens.push(match[5]);
    }
  }

  result.plainText = textTokens.join(' ').trim();
  return result;
}

/**
 * Determine or inherit thread_id for an incoming message based on RFC 5322 headers.
 */
export async function resolveIncomingThreadId(params: {
  workspaceId: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | string[] | null;
  id: string;
}): Promise<string> {
  const candidates: string[] = [];

  if (params.inReplyTo) {
    candidates.push(params.inReplyTo.replace(/[<>]/g, '').trim());
  }

  if (params.references) {
    const refList = Array.isArray(params.references) ? params.references : [params.references];
    for (const ref of refList) {
      if (typeof ref === 'string') {
        const cleaned = ref.replace(/[<>]/g, '').trim();
        if (cleaned) candidates.push(cleaned);
      }
    }
  }

  if (candidates.length > 0) {
    // Look for existing thread_id in messages or outbound_messages
    const res = await db.query(
      `SELECT thread_id, id FROM messages
       WHERE workspace_id = $1 AND (message_id = ANY($2::text[]) OR id::text = ANY($2::text[]))
         AND thread_id IS NOT NULL
       LIMIT 1`,
      [params.workspaceId, candidates]
    );

    if (res.rows.length > 0 && res.rows[0].thread_id) {
      return res.rows[0].thread_id;
    }

    const outboundRes = await db.query(
      `SELECT thread_id, id FROM outbound_messages
       WHERE workspace_id = $1 AND (provider_message_id = ANY($2::text[]) OR id::text = ANY($2::text[]))
         AND thread_id IS NOT NULL
       LIMIT 1`,
      [params.workspaceId, candidates]
    );

    if (outboundRes.rows.length > 0 && outboundRes.rows[0].thread_id) {
      return outboundRes.rows[0].thread_id;
    }
  }

  // Fallback: This message is the root of a new thread
  return params.messageId ? params.messageId.replace(/[<>]/g, '').trim() : params.id;
}

export interface ThreadMessageItem {
  id: string;
  type: 'inbound' | 'outbound';
  sender: string;
  recipient: string;
  subject: string;
  timestamp: string;
  bodySnippet: string;
  html?: string;
  attachments?: Array<{ id: string; filename: string; mime: string; bytes: number }>;
}

/**
 * Retrieve all messages within a conversation thread.
 */
export async function getConversationThread(
  workspaceId: string,
  threadId: string
): Promise<ThreadMessageItem[]> {
  const [inboundRes, outboundRes] = await Promise.all([
    db.query(
      `SELECT m.id, 'inbound' as type, m.sender, m.recipient, m.subject, m.received as timestamp,
              substring(m.body, 1, 250) as snippet, m.html,
              coalesce(
                json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mime', a.mime, 'bytes', coalesce(a.size_bytes, octet_length(a.data), 0)))
                FILTER (WHERE a.id IS NOT NULL),
                '[]'
              ) as attachments
       FROM messages m
       LEFT JOIN attachments a ON a.message = m.id
       WHERE m.workspace_id = $1 AND (m.thread_id = $2 OR m.id::text = $2)
       GROUP BY m.id
       ORDER BY m.received ASC`,
      [workspaceId, threadId]
    ),
    db.query(
      `SELECT id, 'outbound' as type, from_address as sender, array_to_string(to_address, ', ') as recipient,
              subject, created_at as timestamp, substring(text_body, 1, 250) as snippet, html_body as html,
              '[]'::json as attachments
       FROM outbound_messages
       WHERE workspace_id = $1 AND (thread_id = $2 OR id::text = $2)
       ORDER BY created_at ASC`,
      [workspaceId, threadId]
    )
  ]);

  const items: ThreadMessageItem[] = [
    ...inboundRes.rows.map(r => ({
      id: r.id,
      type: 'inbound' as const,
      sender: r.sender,
      recipient: r.recipient,
      subject: r.subject,
      timestamp: r.timestamp,
      bodySnippet: r.snippet,
      html: r.html,
      attachments: r.attachments
    })),
    ...outboundRes.rows.map(r => ({
      id: r.id,
      type: 'outbound' as const,
      sender: r.sender,
      recipient: r.recipient,
      subject: r.subject,
      timestamp: r.timestamp,
      bodySnippet: r.snippet,
      html: r.html,
      attachments: r.attachments
    }))
  ];

  // Sort unified chronologically
  items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return items;
}
