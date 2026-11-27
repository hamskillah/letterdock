import { renderTemplate, extractVariables, renderString } from '../src/templates.js';
import assert from 'node:assert/strict';

console.log('--- Testing Letterdock Template Engine ---');

// Test 1: Simple Variable Interpolation & HTML Escaping
{
  const tpl = 'Hello, {{ name }}! Welcome to <{{ company }}>.';
  const data = { name: 'Alice & Bob', company: 'Acme Corp <Ltd>' };
  const res = renderString(tpl, data);
  assert.equal(res, 'Hello, Alice &amp; Bob! Welcome to <Acme Corp &lt;Ltd&gt;>.');
  console.log('✓ Test 1: Variable interpolation & HTML escaping passed');
}

// Test 2: Triple Braces (Unescaped HTML)
{
  const tpl = '<div>{{{ badge_html }}}</div>';
  const data = { badge_html: '<span class="badge">Verified</span>' };
  const res = renderString(tpl, data);
  assert.equal(res, '<div><span class="badge">Verified</span></div>');
  console.log('✓ Test 2: Unescaped triple braces passed');
}

// Test 3: Conditionals (if / else / unless)
{
  const tpl = '{{#if is_premium}}VIP Member{{else}}Standard User{{/if}} | {{#unless expired}}Active{{/unless}}';
  assert.equal(renderString(tpl, { is_premium: true, expired: false }), 'VIP Member | Active');
  assert.equal(renderString(tpl, { is_premium: false, expired: true }), 'Standard User | ');
  console.log('✓ Test 3: Conditionals passed');
}

// Test 4: Loops (each) with @index, @first, @last
{
  const tpl = 'Items:{{#each items}} [{{@index}}:{{name}}]({{price}}){{/each}}';
  const data = {
    items: [
      { name: 'Book', price: '$10' },
      { name: 'Pen', price: '$2' }
    ]
  };
  const res = renderString(tpl, data);
  assert.equal(res, 'Items: [0:Book]($10) [1:Pen]($2)');
  console.log('✓ Test 4: Loops & scopes passed');
}

// Test 5: Nested Object Paths
{
  const tpl = 'Dear {{ user.profile.first_name }} of {{ user.account.id }}';
  const data = {
    user: {
      profile: { first_name: 'Sarah' },
      account: { id: 'ACC-992' }
    }
  };
  const res = renderString(tpl, data);
  assert.equal(res, 'Dear Sarah of ACC-992');
  console.log('✓ Test 5: Nested object paths passed');
}

// Test 6: Full renderTemplate
{
  const template = {
    subject: 'Receipt for {{ order_id }}',
    html_content: '<h1>Thanks {{ customer }}</h1><p>Total: {{ total }}</p>',
    text_content: 'Thanks {{ customer }}. Total: {{ total }}'
  };
  const rendered = renderTemplate(template, {
    order_id: '#ORD-402',
    customer: 'David',
    total: '$99.00'
  });
  assert.equal(rendered.subject, 'Receipt for #ORD-402');
  assert.equal(rendered.html, '<h1>Thanks David</h1><p>Total: $99.00</p>');
  assert.equal(rendered.text, 'Thanks David. Total: $99.00');
  console.log('✓ Test 6: Full renderTemplate passed');
}

// Test 7: extractVariables
{
  const tpl = 'Hi {{ name }}, your plan is {{#if is_pro}}Pro{{/if}}. Items: {{#each orders}}{{ item }}{{/each}}';
  const vars = extractVariables(tpl);
  const keys = vars.map(v => v.key).sort();
  assert.deepEqual(keys, ['is_pro', 'item', 'name', 'orders']);
  console.log('✓ Test 7: extractVariables passed');
}

console.log('All Letterdock Template Engine tests passed cleanly!');
