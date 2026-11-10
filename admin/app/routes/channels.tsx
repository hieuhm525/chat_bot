import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';

interface Channel {
  id: string;
  provider: string;
  name: string;
  externalId: string;
  botId: string | null;
  status: string;
  credentialExpiresAt: string | null;
}

interface ChannelList {
  items: Channel[];
  maxChannels: number;
}

interface BotOption {
  id: string;
  name: string;
}

export function Channels() {
  const [data, setData] = useState<ChannelList | null>(null);
  const [bots, setBots] = useState<BotOption[]>([]);
  const [form, setForm] = useState({
    provider: 'messenger',
    name: '',
    externalId: '',
    botId: '',
    accessToken: '',
    refreshToken: '',
    oaSecret: '',
  });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    const [channels, botList] = await Promise.all([
      api<ChannelList>('/channels'),
      api<{ items: BotOption[] }>('/bots'),
    ]);
    setData(channels);
    setBots(botList.items);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const credentials: Record<string, string> = { accessToken: form.accessToken };
    if (form.provider === 'zalo') {
      credentials.refreshToken = form.refreshToken;
      credentials.oaSecret = form.oaSecret;
    }
    try {
      await api('/channels', {
        method: 'POST',
        body: JSON.stringify({
          provider: form.provider,
          name: form.name,
          externalId: form.externalId,
          botId: form.botId,
          credentials,
        }),
      });
      setForm({ ...form, name: '', externalId: '', accessToken: '', refreshToken: '', oaSecret: '' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi tạo kênh');
    }
  };

  const test = async (id: string) => {
    setNotice('Đang kiểm tra…');
    const result = await api<{ ok: boolean; detail?: string }>(`/channels/${id}/test`, { method: 'POST' });
    setNotice(result.ok ? 'Kết nối OK' : `Lỗi: ${result.detail ?? 'không rõ'}`);
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm('Xoá kênh này? Kênh đã có hội thoại sẽ bị tắt thay vì xoá.')) return;
    const result = await api<{ disabled: boolean }>(`/channels/${id}`, { method: 'DELETE' });
    setNotice(result.disabled ? 'Kênh đã được tắt, lịch sử hội thoại được giữ lại.' : 'Đã xoá kênh.');
    await load();
  };

  const botName = (botId: string | null) => bots.find((b) => b.id === botId)?.name ?? '—';

  if (error && !data) return <p className="error pad">{error}</p>;
  if (!data) return <p className="muted pad">Đang tải…</p>;

  const activeCount = data.items.filter((c) => c.status !== 'disabled').length;

  return (
    <div className="pad">
      <h1>Kênh</h1>
      <p className="muted">
        Đang dùng {activeCount} / {data.maxChannels} theo gói thuê (kênh đã tắt không tính).
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <table>
        <thead>
          <tr>
            <th>Tên</th>
            <th>Provider</th>
            <th>External ID</th>
            <th>AI agent</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.provider}</td>
              <td>{c.externalId}</td>
              <td>{botName(c.botId)}</td>
              <td>
                <span className={`badge ${c.status}`}>{c.status}</span>
              </td>
              <td className="actions">
                <button onClick={() => test(c.id)}>Kiểm tra</button>
                <button className="danger" onClick={() => remove(c.id)}>
                  Xoá
                </button>
              </td>
            </tr>
          ))}
          {!data.items.length && (
            <tr>
              <td colSpan={6} className="muted">
                Chưa cấu hình kênh.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Thêm kênh</h2>
      {!bots.length && <p className="muted">Hãy tạo AI agent trước khi thêm kênh.</p>}
      <form className="grid" onSubmit={submit}>
        <label>
          Provider
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            <option value="messenger">Messenger</option>
            <option value="zalo">Zalo OA</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </label>
        <label>
          Tên
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label>
          {form.provider === 'messenger' ? 'Page ID' : form.provider === 'whatsapp' ? 'Phone Number ID' : 'OA ID'}
          <input value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} required />
        </label>
        <label>
          AI agent
          <select value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })} required>
            <option value="">— Chọn AI agent —</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Access token
          <input value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} required />
        </label>
        {form.provider === 'zalo' && (
          <>
            <label>
              Refresh token
              <input value={form.refreshToken} onChange={(e) => setForm({ ...form, refreshToken: e.target.value })} />
            </label>
            <label>
              OA secret key
              <input value={form.oaSecret} onChange={(e) => setForm({ ...form, oaSecret: e.target.value })} />
            </label>
          </>
        )}
        <button type="submit" disabled={!bots.length || activeCount >= data.maxChannels}>
          Thêm kênh
        </button>
      </form>
      {activeCount >= data.maxChannels && <p className="muted">Gói thuê đã đạt giới hạn số kênh.</p>}
      <p className="muted">Webhook URL: /webhooks/messenger · /webhooks/zalo · /webhooks/whatsapp</p>
    </div>
  );
}
