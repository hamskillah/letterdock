/**
 * Letterdock Safe Template Engine
 * Supports:
 * - Variable interpolation: {{ name }}, {{ user.profile.email }}
 * - HTML escaping by default, triple braces {{{ raw_html }}} for unescaped output
 * - Conditionals: {{#if condition}}...{{else}}...{{/if}} and {{#unless condition}}...{{/unless}}
 * - Iterations: {{#each items}}...{{/each}} with @index, @first, @last, this
 * - Variable introspection for visual builder / schema generation
 */

function escapeHtml(str: string): string {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolvePath(obj: any, path: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.trim().split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr == null) return undefined;
    curr = curr[part];
  }
  return curr;
}

export interface VariableMeta {
  key: string;
  type: 'string' | 'array' | 'boolean' | 'object';
}

/**
 * Scan a template string for all variable tags, conditionals, and iteration blocks.
 */
export function extractVariables(templateStr: string): VariableMeta[] {
  if (!templateStr) return [];
  const found = new Map<string, VariableMeta>();

  // Iterations: {{#each listKey}}
  const eachRegex = /\{\{#each\s+([a-zA-Z0-9_.-]+)\}\}/g;
  let match;
  while ((match = eachRegex.exec(templateStr)) !== null) {
    found.set(match[1], { key: match[1], type: 'array' });
  }

  // Conditionals: {{#if boolKey}} or {{#unless boolKey}}
  const ifRegex = /\{\{#(?:if|unless)\s+([a-zA-Z0-9_.-]+)\}\}/g;
  while ((match = ifRegex.exec(templateStr)) !== null) {
    if (!found.has(match[1])) {
      found.set(match[1], { key: match[1], type: 'boolean' });
    }
  }

  // Standard variables: {{ key }} or {{{ key }}}
  const varRegex = /\{\{\{?\s*([a-zA-Z0-9_.-]+)\s*\}?\}\}/g;
  while ((match = varRegex.exec(templateStr)) !== null) {
    const key = match[1];
    if (key.startsWith('#') || key.startsWith('/') || key === 'else' || key === '@index' || key === '@first' || key === '@last' || key === 'this') {
      continue;
    }
    if (!found.has(key)) {
      found.set(key, { key, type: 'string' });
    }
  }

  return Array.from(found.values());
}

/**
 * Render a string with data context.
 */
export function renderString(template: string, data: Record<string, any> = {}): string {
  if (!template) return '';

  let output = template;

  // 1. Process {{#each list}} ... {{/each}}
  const eachBlockRegex = /\{\{#each\s+([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
  output = output.replace(eachBlockRegex, (_match, listKey, innerTemplate) => {
    const list = resolvePath(data, listKey);
    if (!Array.isArray(list) || list.length === 0) return '';

    return list.map((item, index) => {
      const itemScope = typeof item === 'object' && item !== null
        ? { ...data, ...item, this: item, '@index': index, '@first': index === 0, '@last': index === list.length - 1 }
        : { ...data, this: item, '@index': index, '@first': index === 0, '@last': index === list.length - 1 };
      return renderString(innerTemplate, itemScope);
    }).join('');
  });

  // 2. Process {{#if key}} ... {{else}} ... {{/if}}
  const ifBlockRegex = /\{\{#if\s+([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
  output = output.replace(ifBlockRegex, (_match, key, thenPart, elsePart) => {
    const val = resolvePath(data, key);
    const isTruthy = Boolean(val && (!Array.isArray(val) || val.length > 0));
    return isTruthy ? renderString(thenPart, data) : (elsePart ? renderString(elsePart, data) : '');
  });

  // 3. Process {{#unless key}} ... {{/unless}}
  const unlessBlockRegex = /\{\{#unless\s+([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g;
  output = output.replace(unlessBlockRegex, (_match, key, inner) => {
    const val = resolvePath(data, key);
    const isFalsy = !val || (Array.isArray(val) && val.length === 0);
    return isFalsy ? renderString(inner, data) : '';
  });

  // 4. Process Triple Braces {{{ raw_html }}} (unescaped)
  const rawRegex = /\{\{\{\s*([@a-zA-Z0-9_.-]+)\s*\}\}\}/g;
  output = output.replace(rawRegex, (_match, key) => {
    const val = resolvePath(data, key);
    return val != null ? String(val) : '';
  });

  // 5. Process Double Braces {{ escaped_var }} (HTML escaped)
  const varRegex = /\{\{\s*([@a-zA-Z0-9_.-]+)\s*\}\}/g;
  output = output.replace(varRegex, (_match, key) => {
    const val = resolvePath(data, key);
    return val != null ? escapeHtml(String(val)) : '';
  });

  return output;
}

export interface TemplateDefinition {
  subject?: string;
  html_content?: string;
  text_content?: string;
}

export interface RenderedTemplateResult {
  subject: string;
  html: string;
  text: string;
}

/**
 * Render a complete template (subject, HTML, text) given a context dictionary.
 */
export function renderTemplate(
  template: TemplateDefinition,
  data: Record<string, any> = {}
): RenderedTemplateResult {
  const subject = renderString(template.subject || '', data);
  const html = renderString(template.html_content || '', data);
  const text = renderString(template.text_content || '', data);

  return { subject, html, text };
}
