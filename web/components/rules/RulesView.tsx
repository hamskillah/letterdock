import React, { useState, useEffect } from 'react';
import {
  Sliders,
  Plus,
  Play,
  Trash2,
  Edit3,
  Check,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  ArrowRight
} from 'lucide-react';
import { api } from '../../api/client.js';

export interface RuleItem {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match_all: boolean;
  conditions: Array<{
    field: string;
    operator: string;
    value: string;
    header_name?: string;
  }>;
  actions: Array<{
    type: string;
    params?: Record<string, any>;
  }>;
  created_at: string;
  updated_at: string;
}

export const RulesView: React.FC = () => {
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedRule, setSelectedRule] = useState<RuleItem | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [priority, setPriority] = useState(100);
  const [enabled, setEnabled] = useState(true);
  const [matchAll, setMatchAll] = useState(true);
  const [conditions, setConditions] = useState<any[]>([
    { field: 'subject', operator: 'contains', value: '' }
  ]);
  const [actions, setActions] = useState<any[]>([
    { type: 'add_label', params: { label: '' } }
  ]);
  const [saving, setSaving] = useState(false);

  // Simulation test state
  const [simSender, setSimSender] = useState('billing@vendor.com');
  const [simSubject, setSimSubject] = useState('[URGENT] Payment Required');
  const [simBody, setSimBody] = useState('Please review overdue invoice.');
  const [simResult, setSimResult] = useState<any>(null);

  const fetchRules = async () => {
    setLoading(true);
    try {
      const res = await api<{ data: RuleItem[] }>('/rules');
      setRules(res.data || []);
    } catch (err) {
      console.error('Failed to load rules', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const handleStartCreate = () => {
    setSelectedRule(null);
    setName('');
    setPriority(100);
    setEnabled(true);
    setMatchAll(true);
    setConditions([{ field: 'subject', operator: 'contains', value: '' }]);
    setActions([{ type: 'add_label', params: { label: 'urgent' } }]);
    setIsEditing(true);
  };

  const handleStartEdit = (rule: RuleItem) => {
    setSelectedRule(rule);
    setName(rule.name);
    setPriority(rule.priority);
    setEnabled(rule.enabled);
    setMatchAll(rule.match_all);
    setConditions(rule.conditions.length > 0 ? rule.conditions : [{ field: 'subject', operator: 'contains', value: '' }]);
    setActions(rule.actions.length > 0 ? rule.actions : [{ type: 'add_label', params: { label: '' } }]);
    setIsEditing(true);
  };

  const handleAddCondition = () => {
    setConditions([...conditions, { field: 'sender', operator: 'contains', value: '' }]);
  };

  const handleRemoveCondition = (idx: number) => {
    setConditions(conditions.filter((_, i) => i !== idx));
  };

  const handleUpdateCondition = (idx: number, patch: any) => {
    const updated = [...conditions];
    updated[idx] = { ...updated[idx], ...patch };
    setConditions(updated);
  };

  const handleAddAction = () => {
    setActions([...actions, { type: 'add_label', params: { label: '' } }]);
  };

  const handleRemoveAction = (idx: number) => {
    setActions(actions.filter((_, i) => i !== idx));
  };

  const handleUpdateAction = (idx: number, patch: any) => {
    const updated = [...actions];
    updated[idx] = { ...updated[idx], ...patch };
    setActions(updated);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name,
        priority: Number(priority),
        enabled,
        match_all: matchAll,
        conditions: conditions.filter(c => c.field),
        actions: actions.filter(a => a.type)
      };

      if (selectedRule) {
        await api(`/rules/${selectedRule.id}`, 'PUT', payload);
      } else {
        await api('/rules', 'POST', payload);
      }
      setIsEditing(false);
      await fetchRules();
    } catch (err: any) {
      alert('Failed to save rule: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (rule: RuleItem) => {
    try {
      await api(`/rules/${rule.id}`, 'PUT', { enabled: !rule.enabled });
      await fetchRules();
    } catch (err: any) {
      alert('Failed to toggle rule: ' + err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    try {
      await api(`/rules/${id}`, 'DELETE');
      await fetchRules();
    } catch (err: any) {
      alert('Delete failed: ' + err.message);
    }
  };

  const handleSimulate = async (rule: RuleItem) => {
    try {
      const res = await api<any>('/rules/test', 'POST', {
        rule,
        message: {
          sender: simSender,
          recipient: 'inbox@yourdomain.com',
          subject: simSubject,
          body: simBody,
          headers: {},
          hasAttachments: false
        }
      });
      setSimResult(res);
    } catch (err: any) {
      alert('Simulation error: ' + err.message);
    }
  };

  return (
    <div className="manage-view" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>Inbound Automation & Routing Rules</h2>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            Automate email triage, labeling, external Slack/Discord notifications, and smart auto-responders.
          </p>
        </div>
        <button className="primary" onClick={handleStartCreate} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={16} />
          <span>New Rule</span>
        </button>
      </div>

      {isEditing ? (
        <div className="card" style={{ padding: '1.25rem' }}>
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{selectedRule ? 'Edit Automation Rule' : 'Create Automation Rule'}</h3>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="secondary" onClick={() => setIsEditing(false)}>Cancel</button>
                <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving...' : 'Save Rule'}</button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '1rem', alignItems: 'end' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Rule Name</label>
                <input type="text" className="input" value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Forward VIP Invoices" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Priority (Lower = Higher)</label>
                <input type="number" className="input" value={priority} onChange={e => setPriority(Number(e.target.value))} min={1} max={1000} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem' }}>Match Logic</label>
                <select className="input" value={matchAll ? 'all' : 'any'} onChange={e => setMatchAll(e.target.value === 'all')}>
                  <option value="all">Match ALL Conditions (AND)</option>
                  <option value="any">Match ANY Condition (OR)</option>
                </select>
              </div>
            </div>

            {/* Conditions Section */}
            <div style={{ background: 'var(--bg-subtle)', padding: '1rem', borderRadius: '6px', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>If Incoming Email Matches:</span>
                <button type="button" className="secondary" onClick={handleAddCondition} style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}>+ Add Condition</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {conditions.map((cond, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '140px 140px 1fr 40px', gap: '0.5rem', alignItems: 'center' }}>
                    <select className="input" value={cond.field} onChange={e => handleUpdateCondition(idx, { field: e.target.value })}>
                      <option value="subject">Subject</option>
                      <option value="sender">Sender (From)</option>
                      <option value="recipient">Recipient (To)</option>
                      <option value="has_attachments">Has Attachments</option>
                    </select>
                    <select className="input" value={cond.operator} onChange={e => handleUpdateCondition(idx, { operator: e.target.value })}>
                      <option value="contains">contains</option>
                      <option value="equals">equals</option>
                      <option value="starts_with">starts with</option>
                      <option value="ends_with">ends with</option>
                      <option value="regex">regex</option>
                    </select>
                    {cond.field === 'has_attachments' ? (
                      <select className="input" value={cond.value} onChange={e => handleUpdateCondition(idx, { value: e.target.value })}>
                        <option value="true">Yes (True)</option>
                        <option value="false">No (False)</option>
                      </select>
                    ) : (
                      <input type="text" className="input" value={cond.value} onChange={e => handleUpdateCondition(idx, { value: e.target.value })} placeholder="Value to match..." />
                    )}
                    <button type="button" className="icon" onClick={() => handleRemoveCondition(idx)} style={{ color: 'var(--danger)' }}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions Section */}
            <div style={{ background: 'var(--bg-subtle)', padding: '1rem', borderRadius: '6px', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Then Execute Actions:</span>
                <button type="button" className="secondary" onClick={handleAddAction} style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}>+ Add Action</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {actions.map((act, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 40px', gap: '0.5rem', alignItems: 'center' }}>
                    <select className="input" value={act.type} onChange={e => handleUpdateAction(idx, { type: e.target.value, params: {} })}>
                      <option value="add_label">Add Label / Tag</option>
                      <option value="move_folder">Move to Folder</option>
                      <option value="star">Star Message</option>
                      <option value="mark_read">Mark as Read</option>
                      <option value="webhook">Forward Webhook (Slack/Discord)</option>
                    </select>
                    <div>
                      {act.type === 'add_label' && (
                        <input type="text" className="input" value={act.params?.label || ''} onChange={e => handleUpdateAction(idx, { params: { label: e.target.value } })} placeholder="e.g. invoices, urgent, monitoring" />
                      )}
                      {act.type === 'move_folder' && (
                        <select className="input" value={act.params?.folder || 'archive'} onChange={e => handleUpdateAction(idx, { params: { folder: e.target.value } })}>
                          <option value="archive">Archive</option>
                          <option value="trash">Trash</option>
                          <option value="spam">Spam</option>
                        </select>
                      )}
                      {act.type === 'webhook' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '0.5rem' }}>
                          <select className="input" value={act.params?.format || 'slack'} onChange={e => handleUpdateAction(idx, { params: { ...act.params, format: e.target.value } })}>
                            <option value="slack">Slack</option>
                            <option value="discord">Discord</option>
                            <option value="raw">Raw JSON</option>
                          </select>
                          <input type="url" className="input" value={act.params?.url || ''} onChange={e => handleUpdateAction(idx, { params: { ...act.params, url: e.target.value } })} placeholder="https://hooks.slack.com/services/..." />
                        </div>
                      )}
                      {(act.type === 'star' || act.type === 'mark_read') && (
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Flag will be automatically applied</span>
                      )}
                    </div>
                    <button type="button" className="icon" onClick={() => handleRemoveAction(idx)} style={{ color: 'var(--danger)' }}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </form>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '1.25rem', alignItems: 'start' }}>
          {/* Rules Table */}
          <div className="card" style={{ padding: '0.75rem', overflowX: 'auto' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', padding: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Active Rules ({rules.length})
            </div>
            {loading ? (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading rules...</div>
            ) : rules.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                No automation rules configured yet. Click "New Rule" to create one.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {rules.map(rule => (
                  <div
                    key={rule.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.75rem 1rem',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      background: 'var(--card-bg)'
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '4px', background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                          P{rule.priority}
                        </span>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem', color: rule.enabled ? 'var(--text)' : 'var(--text-muted)' }}>
                          {rule.name}
                        </span>
                        {!rule.enabled && (
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', background: 'var(--bg-subtle)', padding: '0.1rem 0.35rem', borderRadius: '4px' }}>
                            Disabled
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <span>If: {rule.conditions.map(c => `${c.field} ${c.operator} "${c.value}"`).join(rule.match_all ? ' AND ' : ' OR ')}</span>
                        <span>→</span>
                        <span>Then: {rule.actions.map(a => a.type === 'add_label' ? `Tag "${a.params?.label}"` : a.type).join(', ')}</span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <button className="icon" onClick={() => handleToggleEnabled(rule)} title={rule.enabled ? 'Disable rule' : 'Enable rule'}>
                        {rule.enabled ? <ToggleRight size={20} color="var(--primary)" /> : <ToggleLeft size={20} />}
                      </button>
                      <button className="icon" onClick={() => handleSimulate(rule)} title="Simulate rule against sample email">
                        <Play size={16} />
                      </button>
                      <button className="icon" onClick={() => handleStartEdit(rule)} title="Edit rule">
                        <Edit3 size={16} />
                      </button>
                      <button className="icon" onClick={() => handleDelete(rule.id)} title="Delete rule" style={{ color: 'var(--danger)' }}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Simulator Panel */}
          <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Play size={15} />
              <span>Rule Simulator</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Test how your automation rules evaluate against sample email data.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, display: 'block', marginBottom: '0.2rem' }}>Sample Sender</label>
                <input type="text" className="input" style={{ fontSize: '0.8rem' }} value={simSender} onChange={e => setSimSender(e.target.value)} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, display: 'block', marginBottom: '0.2rem' }}>Sample Subject</label>
                <input type="text" className="input" style={{ fontSize: '0.8rem' }} value={simSubject} onChange={e => setSimSubject(e.target.value)} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, display: 'block', marginBottom: '0.2rem' }}>Sample Body</label>
                <textarea rows={3} className="input" style={{ fontSize: '0.8rem' }} value={simBody} onChange={e => setSimBody(e.target.value)} />
              </div>
            </div>

            {simResult && (
              <div style={{ marginTop: '0.5rem', padding: '0.75rem', borderRadius: '6px', background: simResult.matches ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: simResult.matches ? 'var(--success)' : 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  {simResult.matches ? <Check size={16} /> : <AlertCircle size={16} />}
                  <span>{simResult.matches ? 'Matched Rule Successfully!' : 'Did Not Match Conditions'}</span>
                </div>
                {simResult.matches && (
                  <div style={{ fontSize: '0.75rem', marginTop: '0.35rem', color: 'var(--text-muted)' }}>
                    Triggered Actions: {simResult.simulatedActions.map((a: any) => a.type).join(', ')}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
