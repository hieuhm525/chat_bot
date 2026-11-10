import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';

interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  priority: number;
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
}

const empty = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  priority: 0,
  enabled: true,
};

export function Providers() {
  const [items, setItems] = useState<Provider[]>([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api<Provider[]>('/llm-providers').then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const body: Record<string, unknown> = {
      name: form.name,
      baseUrl: form.baseUrl,
      model: form.model,
      priority: Number(form.priority),
      enabled: form.enabled,
    };
    if (form.apiKey) body.apiKey = form.apiKey;
    try {
      if (form.id) await api(`/llm-providers/${form.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/llm-providers', { method: 'POST', body: JSON.stringify(body) });
      setForm(empty);
      setNotice(form.id ? 'Đã lưu provider.' : 'Đã thêm provider.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi lưu provider');
    }
  };

  const edit = (provider: Provider) => {
    setForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: '',
      priority: provider.priority,
      enabled: provider.enabled,
    });
  };

  const toggle = async (provider: Provider) => {
    await api(`/llm-providers/${provider.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !provider.enabled }),
    });
    await load();
  };

  const test = async (provider: Provider) => {
    setError('');
    setNotice('');
    try {
      const result = await api<{ ok: boolean; detail: string }>(`/llm-providers/${provider.id}/test`, {
        method: 'POST',
      });
      setNotice(`${provider.name}: ${result.ok ? 'OK' : 'Lỗi'} — ${result.detail}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi kiểm tra provider');
    }
  };

  const remove = async (provider: Provider) => {
    if (!confirm(`Xoá provider ${provider.name}?`)) return;
    await api(`/llm-providers/${provider.id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="pad">
      <h1>AI provider</h1>
      <p className="muted">
        Thứ tự thử từ trên xuống (ưu tiên cao trước). Provider lỗi sẽ chuyển sang provider kế tiếp. Key được mã hoá,
        không bao giờ hiển thị lại.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <table>
        <thead>
          <tr>
            <th>Ưu tiên</th>
            <th>Tên</th>
            <th>Model</th>
            <th>Key</th>
            <th>Bật</th>
            <th>Kiểm tra</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>{p.priority}</td>
              <td>
                <div>{p.name}</div>
                <div className="muted">{p.baseUrl}</div>
              </td>
              <td>{p.model}</td>
              <td>{p.hasKey ? `••••${p.keyHint ?? ''}` : '—'}</td>
              <td>
                <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
              </td>
              <td>
                {p.lastCheckAt ? (
                  <span className={`badge ${p.lastCheckOk ? '' : 'disabled'}`} title={p.lastError ?? ''}>
                    {p.lastCheckOk ? 'OK' : 'Lỗi'}
                  </span>
                ) : (
                  <span className="muted">chưa</span>
                )}
              </td>
              <td className="actions">
                <button onClick={() => edit(p)}>Sửa</button>
                <button onClick={() => test(p)}>Kiểm tra</button>
                <button className="danger" onClick={() => remove(p)}>
                  Xoá
                </button>
              </td>
            </tr>
          ))}
          {!items.length && (
            <tr>
              <td colSpan={7} className="muted">
                Chưa có provider. Thêm key Gemini / OpenRouter / Groq để bật trả lời bằng AI.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>{form.id ? 'Sửa provider' : 'Thêm provider'}</h2>
      <form className="grid" onSubmit={submit}>
        <label>
          Tên
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
        </label>
        <label>
          Base URL
          <input
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            required
            placeholder="https://openrouter.ai/api/v1"
          />
        </label>
        <label>
          Model
          <input
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            required
            placeholder="meta-llama/llama-3.3-70b-instruct:free"
          />
        </label>
        <label>
          API key
          <input
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            type="password"
            autoComplete="new-password"
            placeholder={form.id ? 'Để trống = giữ key cũ' : 'Bỏ trống nếu là Ollama local'}
          />
        </label>
        <label>
          Ưu tiên
          <input
            type="number"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Bật provider
        </label>
        <button type="submit">{form.id ? 'Lưu provider' : 'Thêm provider'}</button>
        {form.id && (
          <button type="button" className="link" onClick={() => setForm(empty)}>
            Huỷ
          </button>
        )}
      </form>
    </div>
  );
}
