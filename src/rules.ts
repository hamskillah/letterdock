import { db } from './db.js';
import { renderTemplate } from './templates.js';
import { sendEmail } from './outbound.js';

export interface RuleCondition {
  field: 'sender' | 'recipient' | 'subject' | 'has_attachments' | 'header';
  header_name?: string;
  operator: 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'regex';
  value: string;
}

export interface RuleAction {
  type: 'add_label' | 'move_folder' | 'star' | 'mark_read' | 'webhook' | 'auto_reply';
  params?: {
    label?: string;
    folder?: string;
    url?: string;
    format?: 'raw' | 'slack' | 'discord';
    template?: string;
    subject?: string;
  };
}

export interface InboundRule {
  id: string;
  workspace_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match_all: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface MessageContext {
  id: string;
  workspaceId: string;
  domain: string;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  headers: Record<string, any>;
  hasAttachments: boolean;
}

/**
 * Check if a condition matches the message context.
 */
export function checkCondition(cond: RuleCondition, ctx: MessageContext): boolean {
  let targetVal = '';

  switch (cond.field) {
    case 'sender':
      targetVal = ctx.sender || '';
      break;
    case 'recipient':
      targetVal = ctx.recipient || '';
      break;
    case 'subject':
      targetVal = ctx.subject || '';
      break;
    case 'has_attachments':
      const expected = cond.value === 'true' || cond.value === '1';
      return ctx.hasAttachments === expected;
    case 'header':
      if (cond.header_name && ctx.headers) {
        const headerKey = cond.header_name.toLowerCase();
        targetVal = String(ctx.headers[headerKey] || '');
      }
      break;
    default:
      return false;
  }

  const v = (cond.value || '').toLowerCase();
  const t = targetVal.toLowerCase();

  switch (cond.operator) {
    case 'equals':
      return t === v;
    case 'contains':
      return t.includes(v);
    case 'starts_with':
      return t.startsWith(v);
    case 'ends_with':
      return t.endsWith(v);
    case 'regex':
      try {
        const re = new RegExp(cond.value, 'i');
        return re.test(targetVal);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Evaluate all conditions for a rule.
 */
export function evaluateRule(rule: InboundRule, ctx: MessageContext): boolean {
  if (!rule.enabled || !rule.conditions || rule.conditions.length === 0) {
    return false;
  }

  if (rule.match_all) {
    return rule.conditions.every(c => checkCondition(c, ctx));
  } else {
    return rule.conditions.some(c => checkCondition(c, ctx));
  }
}

/**
 * Dispatch an external webhook formatted for Slack, Discord, or standard JSON.
 */
export async function dispatchRuleWebhook(
  url: string,
  format: 'raw' | 'slack' | 'discord' = 'raw',
  ctx: MessageContext
): Promise<void> {
  const snippet = ctx.body.slice(0, 300);
  let payload: any;

  if (format === 'slack') {
    payload = {
      text: `📨 *New Email:* ${ctx.subject}\n*From:* ${ctx.sender} → *To:* ${ctx.recipient}\n> ${snippet.replace(/\n/g, '\n> ')}`
    };
  } else if (format === 'discord') {
    payload = {
      embeds: [
        {
          title: ctx.subject || '(No Subject)',
          description: snippet || '(Empty body)',
          color: 0x155e75, // Maritime spruce
          fields: [
            { name: 'From', value: ctx.sender, inline: true },
            { name: 'To', value: ctx.recipient, inline: true }
          ],
          footer: { text: 'Letterdock Inbound Automation' },
          timestamp: new Date().toISOString()
        }
      ]
    };
  } else {
    // Standard raw JSON webhook
    payload = {
      event: 'email.received',
      message: {
        id: ctx.id,
        domain: ctx.domain,
        sender: ctx.sender,
        recipient: ctx.recipient,
        subject: ctx.subject,
        snippet,
        hasAttachments: ctx.hasAttachments,
        receivedAt: new Date().toISOString()
      }
    };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.warn(`[Rules Webhook Warning] ${url} responded with ${res.status}`);
    }
  } catch (err: any) {
    console.error(`[Rules Webhook Error] Failed to dispatch to ${url}:`, err.message);
  }
}

/**
 * Apply all matching rules for an inbound message.
 */
export async function applyInboundRules(ctx: MessageContext): Promise<string[]> {
  const rulesRes = await db.query(
    `SELECT id, workspace_id, name, priority, enabled, match_all, conditions, actions
     FROM inbound_rules
     WHERE workspace_id = $1 AND enabled = true
     ORDER BY priority ASC, created_at ASC`,
    [ctx.workspaceId]
  );

  const rules: InboundRule[] = rulesRes.rows;
  const appliedRuleNames: string[] = [];

  for (const rule of rules) {
    if (!evaluateRule(rule, ctx)) continue;

    appliedRuleNames.push(rule.name);

    for (const action of rule.actions) {
      try {
        switch (action.type) {
          case 'add_label':
            if (action.params?.label) {
              await db.query(
                `UPDATE messages
                 SET labels = array_append(labels, $2)
                 WHERE id = $1 AND NOT ($2 = ANY(labels))`,
                [ctx.id, action.params.label]
              );
            }
            break;

          case 'move_folder':
            if (action.params?.folder) {
              await db.query(
                `UPDATE messages SET folder = $2 WHERE id = $1`,
                [ctx.id, action.params.folder]
              );
            }
            break;

          case 'star':
            await db.query(`UPDATE messages SET starred = true WHERE id = $1`, [ctx.id]);
            break;

          case 'mark_read':
            await db.query(`UPDATE messages SET unread = false WHERE id = $1`, [ctx.id]);
            break;

          case 'webhook':
            if (action.params?.url) {
              await dispatchRuleWebhook(action.params.url, action.params.format || 'raw', ctx);
            }
            break;

          case 'auto_reply':
            // Prevent auto-reply loops: do not reply to bounce, automated mail, or self
            const autoSubmitted = ctx.headers['auto-submitted'];
            const precedence = ctx.headers['precedence'];
            const isLoop = autoSubmitted || precedence === 'bulk' || precedence === 'junk';
            if (!isLoop && action.params?.template) {
              const tplRes = await db.query(
                `SELECT subject, html_content, text_content FROM templates
                 WHERE workspace_id = $1 AND (slug = $2 OR id::text = $2) LIMIT 1`,
                [ctx.workspaceId, action.params.template]
              );
              if (tplRes.rows.length > 0) {
                const rendered = renderTemplate(tplRes.rows[0], {
                  sender: ctx.sender,
                  recipient: ctx.recipient,
                  subject: ctx.subject,
                  id: ctx.id
                });
                await sendEmail({
                  workspaceId: ctx.workspaceId,
                  from: ctx.recipient,
                  to: ctx.sender,
                  subject: action.params.subject || rendered.subject || `Re: ${ctx.subject}`,
                  html: rendered.html,
                  text: rendered.text,
                  headers: {
                    'Auto-Submitted': 'auto-replied',
                    'In-Reply-To': ctx.headers['message-id'] || ctx.id,
                    'X-Letterdock-Auto-Reply': 'true'
                  }
                }).catch(err => console.error('[Auto-Reply Error]:', err.message));
              }
            }
            break;
        }
      } catch (actionErr: any) {
        console.error(`[Rule Action Error] ${rule.name} action ${action.type} failed:`, actionErr.message);
      }
    }
  }

  return appliedRuleNames;
}
