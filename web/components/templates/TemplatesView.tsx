import React, { useState, useEffect } from 'react';
import {
  FileCode,
  Plus,
  Play,
  Copy,
  Trash2,
  Edit3,
  Check,
  Eye,
  Smartphone,
  Monitor,
  Code
} from 'lucide-react';
import { api } from '../../api/client.js';

export interface TemplateItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  subject: string;
  html_content: string;
  text_content: string;
  variables: Array<{ key: string; type: string }>;
  sample_data: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export const TemplatesView: React.FC = () => {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateItem | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [previewResult, setPreviewResult] = useState<{ subject: string; html: string; text: string } | null>(null);
  const [testVariablesJson, setTestVariablesJson] = useState('{}');
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('');
  const [htmlContent, setHtmlContent] = useState('');
  const [textContent, setTextContent] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await api<{ data: TemplateItem[] }>('/templates');
      setTemplates(res.data || []);
      if (!selectedTemplate && res.data && res.data.length > 0) {
        loadTemplate(res.data[0]);
      }
    } catch (err) {
      console.error('Failed to load templates', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const loadTemplate = async (item: TemplateItem) => {
    setSelectedTemplate(item);
    setIsEditing(false);
    setName(item.name);
    setSlug(item.slug);
    setDescription(item.description || '');
    setSubject(item.subject);
    setHtmlContent(item.html_content || '');
    setTextContent(item.text_content || '');
    setTestVariablesJson(JSON.stringify(item.sample_data || {}, null, 2));

    // Render initial preview
    try {
      const prev = await api<{ rendered: { subject: string; html: string; text: string } }>(
        `/templates/${item.id}/preview`,
        'POST',
        { variables: item.sample_data || {} }
      );
      setPreviewResult(prev.rendered);
    } catch {
      setPreviewResult({ subject: item.subject, html: item.html_content || '', text: item.text_content || '' });
    }
  };

  const handleRunPreview = async () => {
    if (!selectedTemplate) return;
    try {
      let parsed = {};
      try {
        parsed = JSON.parse(testVariablesJson);
      } catch {
        alert('Invalid JSON in test variables');
        return;
      }
      const prev = await api<{ rendered: { subject: string; html: string; text: string } }>(
        `/templates/${selectedTemplate.id}/preview`,
        'POST',
        { variables: parsed }
      );
      setPreviewResult(prev.rendered);
    } catch (err: any) {
      alert('Failed to preview: ' + err.message);
    }
  };

  const handleStartCreate = () => {
    setSelectedTemplate(null);
    setIsEditing(true);
    setName('');
    setSlug('');
    setDescription('');
    setSubject('');
    setHtmlContent('<h1>Hello {{ name }}</h1>\n<p>Welcome to Letterdock!</p>');
    setTextContent('Hello {{ name }}. Welcome to Letterdock!');
    setTestVariablesJson('{\n  "name": "Alex"\n}');
    setPreviewResult(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      let parsedSample = {};
      try {
        parsedSample = JSON.parse(testVariablesJson);
      } catch {}

      const payload = {
        name,
        slug: slug.trim() || undefined,
        description,
        subject,
        html_content: htmlContent,
        text_content: textContent,
        sample_data: parsedSample
      };

      if (selectedTemplate) {
        const updated = await api<TemplateItem>(`/templates/${selectedTemplate.id}`, 'PUT', payload);
        await fetchTemplates();
        loadTemplate(updated);
      } else {
        const created = await api<TemplateItem>('/templates', 'POST', payload);
        await fetchTemplates();
        loadTemplate(created);
      }
      setIsEditing(false);
    } catch (err: any) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return;
    try {
      await api(`/templates/${id}`, 'DELETE');
      setSelectedTemplate(null);
      await fetchTemplates();
    } catch (err: any) {
      alert('Delete failed: ' + err.message);
    }
  };

  const copyCodeSnippet = (templateSlug: string) => {
    const code = "// Send via Letterdock Drop-In Resend API:\nawait resend.emails.send({\n  from: 'Letterdock <system@yourdomain.com>',\n  to: ['customer@example.com'],\n  template: '" + templateSlug + "',\n  variables: " + (testVariablesJson.trim() || '{}') + "\n});";
    navigator.clipboard.writeText(code);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  return (
    <div className="manage-view" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>Transactional Email Templates</h2>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Build, preview, and dispatch dynamic templates via the Resend-compatible API.
          </p>
        </div>
        <button className="primary" onClick={handleStartCreate} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={16} />
          <span>New Template</span>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1.25rem', alignItems: 'start' }}>
        {/* Template List Sidebar */}
        <div className="card" style={{ padding: '0.75rem', maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', padding: '0.5rem 0.5rem 0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Templates ({templates.length})
          </div>
          {loading ? (
            <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading templates...</div>
          ) : templates.length === 0 ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              No templates created yet. Click "New Template" to start.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {templates.map(tpl => {
                const isSelected = selectedTemplate?.id === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    onClick={() => loadTemplate(tpl)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      width: '100%',
                      padding: '0.625rem 0.75rem',
                      borderRadius: '6px',
                      background: isSelected ? 'var(--selected)' : 'transparent',
                      border: isSelected ? '1px solid var(--accent)' : '1px solid transparent',
                      textAlign: 'left',
                      cursor: 'pointer'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: isSelected ? 'var(--primary)' : 'var(--text)' }}>
                        {tpl.name}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {tpl.variables?.length || 0} vars
                      </span>
                    </div>
                    <code style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {tpl.slug}
                    </code>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Template Detail / Editor / Preview */}
        <div className="card" style={{ padding: '1.25rem', minHeight: '520px' }}>
          {isEditing ? (
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{selectedTemplate ? 'Edit Template' : 'Create New Template'}</h3>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="button" className="secondary" onClick={() => setIsEditing(false)}>Cancel</button>
                  <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving...' : 'Save Template'}</button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Template Name</label>
                  <input type="text" className="input" value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Welcome Onboarding" />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Slug (API Identifier)</label>
                  <input type="text" className="input" value={slug} onChange={e => setSlug(e.target.value)} placeholder="welcome-onboarding" />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Subject Line (supports variables)</label>
                <input type="text" className="input" value={subject} onChange={e => setSubject(e.target.value)} placeholder="Welcome, {{ name }}!" />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>HTML Content</label>
                <textarea className="input" rows={10} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }} value={htmlContent} onChange={e => setHtmlContent(e.target.value)} placeholder="<p>Hello {{ name }}</p>" />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Plain Text Fallback</label>
                <textarea className="input" rows={3} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }} value={textContent} onChange={e => setTextContent(e.target.value)} placeholder="Hello {{ name }}" />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Sample Test Variables (JSON)</label>
                <textarea className="input" rows={4} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }} value={testVariablesJson} onChange={e => setTestVariablesJson(e.target.value)} placeholder='{ "name": "Alex" }' />
              </div>
            </form>
          ) : selectedTemplate ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Header Toolbar */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600 }}>{selectedTemplate.name}</h3>
                  <code style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>slug: {selectedTemplate.slug}</code>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button className="secondary" onClick={() => copyCodeSnippet(selectedTemplate.slug)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem' }}>
                    {copiedSnippet ? <Check size={14} color="var(--success)" /> : <Code size={14} />}
                    <span>{copiedSnippet ? 'Copied' : 'Copy API Snippet'}</span>
                  </button>
                  <button className="secondary" onClick={() => setIsEditing(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem' }}>
                    <Edit3 size={14} />
                    <span>Edit</span>
                  </button>
                  <button className="secondary danger" onClick={() => handleDelete(selectedTemplate.id)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem' }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Variable Chips */}
              {selectedTemplate.variables && selectedTemplate.variables.length > 0 && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Detected Variables:</span>
                  {selectedTemplate.variables.map(v => (
                    <span key={v.key} style={{ padding: '0.2rem 0.5rem', borderRadius: '4px', background: 'var(--bg-subtle)', border: '1px solid var(--border)', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                      {"{{"} {v.key} {"}}"}
                    </span>
                  ))}
                </div>
              )}

              {/* Split Preview and Test Runner */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '1.25rem' }}>
                {/* Visual Preview */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                      Subject: <span style={{ fontWeight: 400 }}>{previewResult?.subject || selectedTemplate.subject}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--bg-subtle)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <button
                        className="icon"
                        style={{ padding: '4px 6px', background: previewDevice === 'desktop' ? 'var(--card-bg)' : 'transparent' }}
                        onClick={() => setPreviewDevice('desktop')}
                        title="Desktop view"
                      >
                        <Monitor size={14} />
                      </button>
                      <button
                        className="icon"
                        style={{ padding: '4px 6px', background: previewDevice === 'mobile' ? 'var(--card-bg)' : 'transparent' }}
                        onClick={() => setPreviewDevice('mobile')}
                        title="Mobile 375px view"
                      >
                        <Smartphone size={14} />
                      </button>
                    </div>
                  </div>

                  <div
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      background: '#ffffff',
                      color: '#0f172a',
                      height: '380px',
                      overflow: 'auto',
                      padding: '1rem',
                      width: previewDevice === 'mobile' ? '375px' : '100%',
                      margin: previewDevice === 'mobile' ? '0 auto' : '0',
                      boxShadow: previewDevice === 'mobile' ? '0 4px 12px rgba(0,0,0,0.15)' : 'none',
                      transition: 'width 0.2s ease'
                    }}
                    dangerouslySetInnerHTML={{ __html: previewResult?.html || selectedTemplate.html_content }}
                  />
                </div>

                {/* Variable Runner */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'var(--bg-subtle)', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Test Data (JSON)</span>
                    <button className="primary" onClick={handleRunPreview} style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Play size={12} />
                      <span>Render</span>
                    </button>
                  </div>
                  <textarea
                    rows={12}
                    className="input"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', width: '100%', height: '100%', resize: 'none' }}
                    value={testVariablesJson}
                    onChange={e => setTestVariablesJson(e.target.value)}
                  />
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    Edit JSON variables and click "Render" to update live preview.
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
              <FileCode size={36} strokeWidth={1.5} />
              <p style={{ marginTop: '0.75rem', fontSize: '0.9rem' }}>Select a template or create a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
