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

interface Usage {
  provider: string;
  answers: number;
  tokensIn: number;
  tokensOut: number;
  tokensToday: number;
}

interface TestResult {
  reply: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
  rateLimit?: { limitTokens?: number; remainingTokens?: number; limitRequests?: number; remainingRequests?: number };
  credits?: { usage: number | null; limit: number | null; remaining: number | null };
}

interface TestResponse {
  ok: boolean;
  detail: string;
  result?: TestResult;
}

interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  keyUrl?: string;
  /** Where to check remaining quota when the API does not report it. */
  quotaUrl?: string;
}

const PRESETS: Preset[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    quotaUrl: 'https://aistudio.google.com/usage',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
  },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    quotaUrl: 'https://platform.openai.com/usage',
  },
  { id: 'ollama', label: 'Ollama (máy local)', baseUrl: 'http://localhost:11434/v1' },
];

/** Ids that are clearly not chat models (embeddings, image/video/audio generation, realtime). */
const NON_CHAT = /embed|imagen|veo|tts|aqa|audio|live|whisper|dall-e|moderation|image|robotics|lyria|transcribe/i;

type Probe = { ok: boolean; detail: string } | 'pending';

const presetFor = (baseUrl: string) => PRESETS.find((p) => p.baseUrl === baseUrl.replace(/\/$/, ''))?.id ?? 'custom';

const empty = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  priority: 0,
  enabled: true,
};

const fmt = (n: number | undefined | null) => (n == null ? '—' : n.toLocaleString('vi-VN'));

export function Providers() {
  const [items, setItems] = useState<Provider[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [form, setForm] = useState(empty);
  const [preset, setPreset] = useState('custom');
  const [models, setModels] = useState<string[]>([]);
  const [hidden, setHidden] = useState(0);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [showFailed, setShowFailed] = useState(false);
  const [busy, setBusy] = useState<'' | 'scan' | 'test' | 'probe'>('');
  const [check, setCheck] = useState<TestResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () =>
    Promise.all([api<Provider[]>('/llm-providers'), api<Usage[]>('/llm-providers/usage')])
      .then(([list, used]) => {
        setItems(list);
        setUsage(used);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const clearModels = () => {
    setModels([]);
    setHidden(0);
    setProbes({});
    setShowFailed(false);
  };

  const resetForm = () => {
    setForm(empty);
    setPreset('custom');
    clearModels();
    setCheck(null);
  };

  const choosePreset = (id: string) => {
    setPreset(id);
    clearModels();
    setCheck(null);
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setForm((f) => ({
      ...f,
      baseUrl: p.baseUrl,
      name: !f.name || PRESETS.some((x) => x.id === f.name) ? p.id : f.name,
    }));
  };

  // The stored key is reused when editing and the key field is left blank.
  const draft = () => ({
    ...(form.id ? { id: form.id } : {}),
    baseUrl: form.baseUrl,
    model: form.model,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
  });

  const scan = async () => {
    setError('');
    setBusy('scan');
    try {
      const res = await api<{ models: string[] }>('/llm-providers/models', {
        method: 'POST',
        body: JSON.stringify(draft()),
      });
      const chat = res.models.filter((m) => !NON_CHAT.test(m));
      setProbes({});
      setModels(chat);
      setHidden(res.models.length - chat.length);
      if (!chat.length) setError('Provider không trả về model chat nào.');
      else if (!chat.includes(form.model)) setForm((f) => ({ ...f, model: chat[0] }));
    } catch (err) {
      clearModels();
      setError(`Quét model lỗi: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy('');
    }
  };

  /** Calls each scanned model once (3 at a time) so the list only offers models this key can use. */
  const probeAll = async () => {
    setError('');
    setBusy('probe');
    setShowFailed(false);
    const queue = [...models];
    const results: Record<string, Probe> = Object.fromEntries(models.map((m) => [m, 'pending' as const]));
    setProbes({ ...results });
    const worker = async () => {
      for (let model = queue.shift(); model; model = queue.shift()) {
        try {
          const res = await api<TestResponse>('/llm-providers/test', {
            method: 'POST',
            body: JSON.stringify({ ...draft(), model }),
          });
          results[model] = { ok: res.ok, detail: res.detail };
        } catch (err) {
          results[model] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
        setProbes({ ...results });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const working = models.filter((m) => (results[m] as { ok: boolean }).ok);
    if (!working.length) setError('Không model nào trả lời được. Kiểm tra lại key hoặc hạn mức.');
    else if (!working.includes(form.model)) setForm((f) => ({ ...f, model: working[0] }));
    setBusy('');
  };

  const testDraft = async () => {
    setError('');
    setBusy('test');
    setCheck(null);
    try {
      setCheck(await api<TestResponse>('/llm-providers/test', { method: 'POST', body: JSON.stringify(draft()) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi kiểm tra');
    } finally {
      setBusy('');
    }
  };

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
      resetForm();
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
    setPreset(presetFor(provider.baseUrl));
    clearModels();
    setCheck(null);
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
      const res = await api<TestResponse>(`/llm-providers/${provider.id}/test`, { method: 'POST' });
      const r = res.result;
      setNotice(
        `${provider.name}: ${res.ok ? 'OK' : 'Lỗi'} — ${res.detail}` +
          (r ? ` (${r.latencyMs} ms, ${fmt((r.tokensIn ?? 0) + (r.tokensOut ?? 0))} token)` : ''),
      );
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

  const current = PRESETS.find((p) => p.id === preset);
  const probed = Object.keys(probes).length > 0;
  const done = Object.values(probes).filter((p) => p !== 'pending');
  const okCount = done.filter((p) => p.ok).length;
  const isOk = (m: string) => {
    const p = probes[m];
    return p && p !== 'pending' && p.ok;
  };
  const visible = probed && busy !== 'probe' && !showFailed ? models.filter(isOk) : models;
  const mark = (m: string) => {
    const p = probes[m];
    if (!p) return m;
    if (p === 'pending') return `… ${m}`;
    return `${p.ok ? '✓' : '✗'} ${m}`;
  };
  const usageOf = (name: string) => usage.find((u) => u.provider === name);

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
            <th title="Tổng token bot đã dùng với provider này (vào + ra)">Đã dùng</th>
            <th>Bật</th>
            <th>Kiểm tra</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const u = usageOf(p.name);
            return (
              <tr key={p.id}>
                <td>{p.priority}</td>
                <td>
                  <div>{p.name}</div>
                  <div className="muted">{p.baseUrl}</div>
                </td>
                <td>{p.model}</td>
                <td>{p.hasKey ? `••••${p.keyHint ?? ''}` : '—'}</td>
                <td>
                  {u ? (
                    <>
                      <div>{fmt(u.tokensIn + u.tokensOut)} token</div>
                      <div className="muted">
                        hôm nay {fmt(u.tokensToday)} · {fmt(u.answers)} câu trả lời
                      </div>
                    </>
                  ) : (
                    <span className="muted">0</span>
                  )}
                </td>
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
            );
          })}
          {!items.length && (
            <tr>
              <td colSpan={8} className="muted">
                Chưa có provider. Thêm key Gemini / OpenRouter / Groq để bật trả lời bằng AI.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>{form.id ? 'Sửa provider' : 'Thêm provider'}</h2>
      <form className="grid" onSubmit={submit}>
        <label>
          Nhà cung cấp
          <select value={preset} onChange={(e) => choosePreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Tuỳ chỉnh (OpenAI-compatible)</option>
          </select>
        </label>
        <label>
          Tên
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
        </label>
        <label>
          Base URL
          <input
            value={form.baseUrl}
            onChange={(e) => {
              setForm({ ...form, baseUrl: e.target.value });
              setPreset(presetFor(e.target.value));
            }}
            required
            readOnly={preset !== 'custom'}
            placeholder="https://openrouter.ai/api/v1"
          />
        </label>
        <label>
          API key{' '}
          {current?.keyUrl && (
            <a href={current.keyUrl} target="_blank" rel="noreferrer" className="muted">
              (lấy key)
            </a>
          )}
          <input
            value={form.apiKey}
            onChange={(e) => {
              setForm({ ...form, apiKey: e.target.value });
              clearModels();
              setCheck(null);
            }}
            type="password"
            autoComplete="new-password"
            placeholder={form.id ? 'Để trống = giữ key cũ' : preset === 'ollama' ? 'Không cần key' : 'Dán API key'}
          />
        </label>
        <label>
          Model
          {visible.length ? (
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required>
              {visible.map((m) => {
                const p = probes[m];
                return (
                  <option key={m} value={m} title={p && p !== 'pending' && !p.ok ? p.detail : undefined}>
                    {mark(m)}
                  </option>
                );
              })}
            </select>
          ) : (
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              required
              placeholder="Bấm “Quét model” hoặc gõ tên"
            />
          )}
        </label>
        <button type="button" onClick={scan} disabled={!form.baseUrl || busy !== ''}>
          {busy === 'scan' ? 'Đang quét…' : 'Quét model'}
        </button>
        {models.length > 0 && (
          <button type="button" onClick={probeAll} disabled={busy !== ''}>
            {busy === 'probe' ? `Đang thử ${done.length}/${models.length}…` : 'Lọc model dùng được'}
          </button>
        )}
        {models.length > 0 && (
          <p className="muted" style={{ gridColumn: '1 / -1', margin: 0 }}>
            {models.length} model chat{hidden ? ` (đã ẩn ${hidden} model embedding/ảnh/âm thanh)` : ''}.
            {probed && busy !== 'probe' && (
              <>
                {' '}
                Dùng được {okCount}/{models.length}.{' '}
                <button type="button" className="link" onClick={() => setShowFailed(!showFailed)}>
                  {showFailed ? 'Chỉ hiện model dùng được' : 'Hiện cả model lỗi'}
                </button>
              </>
            )}
            {!probed && ' Bấm “Lọc model dùng được” để gọi thử từng model (mỗi model tốn ~10 token).'}
          </p>
        )}
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
        <button type="button" onClick={testDraft} disabled={!form.baseUrl || !form.model || busy !== ''}>
          {busy === 'test' ? 'Đang kiểm tra…' : 'Test kết nối'}
        </button>
        <button type="submit">{form.id ? 'Lưu provider' : 'Thêm provider'}</button>
        {form.id && (
          <button type="button" className="link" onClick={resetForm}>
            Huỷ
          </button>
        )}
      </form>

      {check && <CheckResult check={check} quotaUrl={current?.quotaUrl} />}
    </div>
  );
}

function CheckResult({ check, quotaUrl }: { check: TestResponse; quotaUrl?: string }) {
  const r = check.result;
  return (
    <div className="card" style={{ marginTop: 16, maxWidth: 900 }}>
      <p>
        <span className={`badge ${check.ok ? '' : 'error'}`}>{check.ok ? 'Kết nối OK' : 'Lỗi'}</span>{' '}
        {!check.ok && check.detail}
      </p>
      {r && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) 1fr', gap: '6px 12px', margin: 0 }}>
          <dt>Model trả lời</dt>
          <dd>{r.model}</dd>
          <dt>Độ trễ</dt>
          <dd>{fmt(r.latencyMs)} ms</dd>
          <dt>Token lần test này</dt>
          <dd>
            {fmt(r.tokensIn)} vào + {fmt(r.tokensOut)} ra
          </dd>
          {r.rateLimit?.remainingTokens != null && (
            <>
              <dt>Token còn lại (phút này)</dt>
              <dd>
                {fmt(r.rateLimit.remainingTokens)} / {fmt(r.rateLimit.limitTokens)}
              </dd>
            </>
          )}
          {r.rateLimit?.remainingRequests != null && (
            <>
              <dt>Request còn lại</dt>
              <dd>
                {fmt(r.rateLimit.remainingRequests)} / {fmt(r.rateLimit.limitRequests)}
              </dd>
            </>
          )}
          {r.credits && (
            <>
              <dt>Credit đã dùng</dt>
              <dd>${r.credits.usage ?? 0}</dd>
              <dt>Credit còn lại</dt>
              <dd>{r.credits.remaining == null ? 'không giới hạn' : `$${r.credits.remaining} / $${r.credits.limit}`}</dd>
            </>
          )}
          {!r.rateLimit && !r.credits && (
            <>
              <dt>Hạn mức còn lại</dt>
              <dd className="muted">
                Provider không trả về qua API.{' '}
                {quotaUrl && (
                  <a href={quotaUrl} target="_blank" rel="noreferrer">
                    Xem trên trang của provider
                  </a>
                )}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
