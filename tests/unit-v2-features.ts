import assert from 'node:assert/strict';
import { renderTemplate, extractVariables, renderString } from '../src/templates.js';
import {
  signTrackingToken,
  verifyTrackingToken,
  injectEmailTracking,
  TRANSPARENT_GIF_BUFFER
} from '../src/analytics.js';
import { parseSearchQuery } from '../src/threads.js';
import { evaluateRule, checkCondition, type InboundRule, type MessageContext } from '../src/rules.js';

console.log('--- Running Letterdock v2 Unit Test Suite ---');

// 1. Template Engine Tests
{
  console.log('1. Testing Templates Engine...');
  const tpl = 'Hello {{ user.name }}, your balance is {{ balance }}. {{#if is_vip}}★ VIP Member{{else}}Standard{{/if}} {{#each items}}[{{@index}}:{{this}}]{{/each}}';
  const rendered = renderString(tpl, {
    user: { name: 'Alice' },
    balance: '$50.00',
    is_vip: true,
    items: ['apple', 'banana']
  });
  assert.equal(rendered, 'Hello Alice, your balance is $50.00. ★ VIP Member [0:apple][1:banana]');

  const extracted = extractVariables(tpl).map(v => v.key).sort();
  assert.deepEqual(extracted, ['balance', 'is_vip', 'items', 'user.name']);
  console.log('✓ Template rendering, loops, conditionals, & variable extraction passed');
}

// 2. Analytics & Tracking Tests
{
  console.log('2. Testing Analytics & Tracking Tokens...');
  process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || '01234567890123456789012345678901';

  const payload = {
    wid: 'default',
    mid: 'msg-12345',
    oid: 'out-67890',
    rcpt: 'test@example.com',
    url: 'https://letterdock.com/dashboard',
    ts: Date.now()
  };

  const token = signTrackingToken(payload);
  assert.ok(token && token.includes('.'), 'Token must be formatted with signature');

  const decoded = verifyTrackingToken(token);
  assert.ok(decoded, 'Decoded token should not be null');
  assert.equal(decoded?.wid, payload.wid);
  assert.equal(decoded?.mid, payload.mid);
  assert.equal(decoded?.rcpt, payload.rcpt);
  assert.equal(decoded?.url, payload.url);

  // Negative test: Tampering with token
  const tampered = token.slice(0, -3) + 'xyz';
  const tamperedResult = verifyTrackingToken(tampered);
  assert.equal(tamperedResult, null, 'Tampered token must be rejected');

  // Tracking Injection
  const originalHtml = '<html><body><h1>Welcome!</h1><a href="https://example.com/login">Login</a></body></html>';
  const trackedHtml = injectEmailTracking(originalHtml, {
    workspaceId: 'default',
    messageId: 'msg-1',
    outboundId: 'out-1',
    recipient: 'test@example.com',
    baseUrl: 'https://mail.example.com',
    trackOpens: true,
    trackClicks: true
  });

  assert.ok(trackedHtml.includes('/t/c/'), 'Links must be rewritten for click tracking');
  assert.ok(trackedHtml.includes('/t/o/'), 'Open tracking pixel must be injected');
  assert.ok(trackedHtml.includes('.gif'), 'Open pixel must be a GIF');
  assert.ok(TRANSPARENT_GIF_BUFFER.length > 0, 'Transparent GIF buffer must be valid');
  console.log('✓ Tracking token generation, tamper resistance, & link/pixel injection passed');
}

// 3. Search Query Parser Tests
{
  console.log('3. Testing Advanced Search Query Parser...');
  const query = 'from:alice@example.com to:support subject:"Urgent invoice" has:attachment is:unread folder:archive payment failed';
  const parsed = parseSearchQuery(query);

  assert.equal(parsed.from, 'alice@example.com');
  assert.equal(parsed.to, 'support');
  assert.equal(parsed.subject, 'Urgent invoice');
  assert.equal(parsed.hasAttachment, true);
  assert.equal(parsed.isUnread, true);
  assert.equal(parsed.folder, 'archive');
  assert.equal(parsed.plainText, 'payment failed');
  console.log('✓ Advanced search query syntax parser passed');
}

// 4. Inbound Automation Rules Engine Tests
{
  console.log('4. Testing Inbound Rules Engine Evaluator...');
  const ctx: MessageContext = {
    id: 'test-msg-1',
    workspaceId: 'default',
    domain: 'example.com',
    sender: 'billing@vendor.com',
    recipient: 'finance@example.com',
    subject: '[URGENT] Q4 Invoice Overdue',
    body: 'Please see attached invoice for payment.',
    headers: { 'x-priority': 'high' },
    hasAttachments: true
  };

  const rule1: InboundRule = {
    id: 'r1',
    workspace_id: 'default',
    name: 'Auto-Label Invoices',
    priority: 10,
    enabled: true,
    match_all: true,
    conditions: [
      { field: 'subject', operator: 'contains', value: 'invoice' },
      { field: 'has_attachments', operator: 'equals', value: 'true' }
    ],
    actions: [{ type: 'add_label', params: { label: 'invoices' } }]
  };

  assert.equal(evaluateRule(rule1, ctx), true, 'Rule 1 should match');

  const rule2: InboundRule = {
    id: 'r2',
    workspace_id: 'default',
    name: 'Regex Sender Match',
    priority: 20,
    enabled: true,
    match_all: false,
    conditions: [
      { field: 'sender', operator: 'regex', value: '^[a-z]+@vendor\\.com$' },
      { field: 'recipient', operator: 'equals', value: 'unknown@example.com' }
    ],
    actions: [{ type: 'star' }]
  };

  assert.equal(evaluateRule(rule2, ctx), true, 'Rule 2 should match with OR condition');

  const ruleDisabled: InboundRule = {
    ...rule1,
    enabled: false
  };
  assert.equal(evaluateRule(ruleDisabled, ctx), false, 'Disabled rule must not match');

  console.log('✓ Inbound rules evaluation, regex, conditions, & enabled flags passed');
}

console.log('\nAll Letterdock v2 Unit Tests PASSED cleanly! (4/4 Pillars verified)');
