import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Agent } from './bot';
import { api } from '../api';

interface Rule {
  id: string;
  name: string;
  keywords: string[];
  matchMode: string;
  priority: number;
  answer: string;
  enabled: boolean;
}

const emptyRule = { name: '', keywords: '', matchMode: 'contains', priority: 0, answer: '', enabled: true };

export function BotDetail() {
  const { botId = '' } = useParams();
  const [bot, setBot] = useState<Agent | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [form, setForm] = useState(emptyRule);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    const [b, r] = await Promise.all([api<Agent>(`/bots/${botId}`), api<Rule[]>(`/bots/${botId}/rules`)]);
    setBot(b);
    setRules(r);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [botId]);

  const saveBot = async (e: FormEvent) => {
    e.preventDefault();
    if (!bot) return;
    setError('');
    setNotice('');
    try {
      await api(`/bots/${botId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: bot.name,
          enabled: bot.enabled,
          greeting: bot.greeting,
          fallbackMessage: bot.fallbackMessage,
          handoffMessage: bot.handoffMessage,
          llmEnabled: bot.llmEnabled,
          systemPrompt: bot.systemPrompt,
          pauseAfterFallbacks: Number(bot.pauseAfterFallbacks),
        }),
      });
      setNotice('Đã lưu cấu hình.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi lưu cấu hình');
    }
  };

  const saveRule = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = JSON.stringify({
      name: form.name,
      keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean),
      matchMode: form.matchMode,
      priority: Number(form.priority),
      answer: form.answer,
      enabled: form.enabled,
    });
    try {
      if (editing) await api(`/bots/${botId}/rules/${editing}`, { method: 'PATCH', body });
      else await api(`/bots/${botId}/rules`, { method: 'POST', body });
      setForm(emptyRule);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi lưu rule');
    }
  };

  const edit = (rule: Rule) => {
    setEditing(rule.id);
    setForm({ ...rule, keywords: rule.keywords.join(', ') });
  };

  const remove = async (id: string) => {
    if (!confirm('Xoá rule này?')) return;
    await api(`/bots/${botId}/rules/${id}`, { method: 'DELETE' });
    await load();
  };

  const toggle = async (rule: Rule) => {
    await api(`/bots/${botId}/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) });
    await load();
  };

  if (error && !bot) return <p className="error pad">{error}</p>;
  if (!bot) return <p className="muted pad">Đang tải…</p>;

  return (
    <div className="pad">
      <p className="muted">
        <Link to="/bots">← AI agent</Link>
      </p>
      <h1>{bot.name}</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <form className="grid" onSubmit={saveBot}>
        <label>
          Tên
          <input value={bot.name} onChange={(e) => setBot({ ...bot, name: e.target.value })} maxLength={100} />
        </label>
        <label>
          Lời chào
          <input value={bot.greeting} onChange={(e) => setBot({ ...bot, greeting: e.target.value })} />
        </label>
        <label>
          Câu fallback
          <input value={bot.fallbackMessage} onChange={(e) => setBot({ ...bot, fallbackMessage: e.target.value })} />
        </label>
        <label>
          Câu chuyển người
          <input value={bot.handoffMessage} onChange={(e) => setBot({ ...bot, handoffMessage: e.target.value })} />
        </label>
        <label>
          Fallback trước khi chuyển người
          <input
            type="number"
            min={1}
            value={bot.pauseAfterFallbacks}
            onChange={(e) => setBot({ ...bot, pauseAfterFallbacks: Number(e.target.value) })}
          />
        </label>
        <label>
          Persona (tối đa 4000 ký tự)
          <textarea
            value={bot.systemPrompt}
            maxLength={4000}
            rows={6}
            placeholder="Ví dụ: Bạn là nhân viên tư vấn của shop ABC, giọng thân thiện…"
            onChange={(e) => setBot({ ...bot, systemPrompt: e.target.value })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={bot.enabled} onChange={(e) => setBot({ ...bot, enabled: e.target.checked })} />
          Bật AI agent
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={bot.llmEnabled}
            onChange={(e) => setBot({ ...bot, llmEnabled: e.target.checked })}
          />
          Dùng LLM khi rule không khớp
        </label>
        <button type="submit">Lưu cấu hình</button>
      </form>

      <div className="section-head">
        <h2>Rule</h2>
        <Link to={`/bots/${botId}/import`}>Nhập hàng loạt (AI / CSV)</Link>
      </div>
      <table>
        <thead>
          <tr>
            <th>Ưu tiên</th>
            <th>Tên</th>
            <th>Keyword</th>
            <th>Bật</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td>{rule.priority}</td>
              <td>{rule.name}</td>
              <td>{rule.keywords.join(', ')}</td>
              <td>
                <input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule)} />
              </td>
              <td className="actions">
                <button onClick={() => edit(rule)}>Sửa</button>
                <button className="danger" onClick={() => remove(rule.id)}>
                  Xoá
                </button>
              </td>
            </tr>
          ))}
          {!rules.length && (
            <tr>
              <td colSpan={5} className="muted">
                Chưa có rule.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>{editing ? 'Sửa rule' : 'Thêm rule'}</h2>
      <form className="grid" onSubmit={saveRule}>
        <label>
          Tên
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label>
          Keyword (phân cách bằng dấu phẩy)
          <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} required />
        </label>
        <label>
          Ưu tiên
          <input
            type="number"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          />
        </label>
        <label>
          Câu trả lời
          <textarea value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} required />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Bật
        </label>
        <button type="submit">{editing ? 'Lưu rule' : 'Thêm rule'}</button>
        {editing && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setEditing(null);
              setForm(emptyRule);
            }}
          >
            Huỷ
          </button>
        )}
      </form>
    </div>
  );
}
