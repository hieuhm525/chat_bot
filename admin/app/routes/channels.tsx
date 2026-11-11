import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';

interface Channel {
  id: string;
  provider: string;
  name: string;
  externalId: string;
  botId: string | null;
  status: string;
  config: { verifyToken?: string } | null;
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

const PLATFORMS = [
  { id: 'messenger', label: 'Facebook Messenger', ready: true },
  { id: 'zalo', label: 'Zalo OA', ready: false },
  { id: 'whatsapp', label: 'WhatsApp', ready: false },
  { id: 'telegram', label: 'Telegram', ready: false },
];

const PROVIDER_LABEL: Record<string, string> = { messenger: 'Messenger', zalo: 'Zalo OA', whatsapp: 'WhatsApp' };

const STATUS_LABEL: Record<string, string> = { active: 'Hoạt động', error: 'Lỗi', disabled: 'Đã tắt' };

const blank = () => ({
  name: '',
  botId: '',
  pageId: '',
  accessToken: '',
  appSecret: '',
});

export function Channels() {
  const [data, setData] = useState<ChannelList | null>(null);
  const [bots, setBots] = useState<BotOption[]>([]);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  // Shown only after save: the server generates the verify token, so there is nothing to paste into Meta before that.
  const [saved, setSaved] = useState<Channel | null>(null);

  const webhookUrl = `${window.location.origin}/webhooks/messenger`;

  const load = async () => {
    const [channels, botList] = await Promise.all([
      api<ChannelList>('/channels'),
      api<{ items: BotOption[] }>('/bots'),
    ]);
    setData(channels);
    setBots(botList.items);
    setForm((f) => (f.botId || !botList.items.length ? f : { ...f, botId: botList.items[0].id }));
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  const set = (key: keyof ReturnType<typeof blank>) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setSaved(null);
    setBusy(true);
    try {
      const channel = await api<Channel>('/channels', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'messenger',
          name: form.name,
          externalId: form.pageId.trim(),
          botId: form.botId,
          credentials: { accessToken: form.accessToken.trim(), appSecret: form.appSecret.trim() },
        }),
      });
      // Validate the token and subscribe the Page right away so problems show up now, not on the first message.
      const result = await api<{ ok: boolean; detail?: string }>(`/channels/${channel.id}/test`, { method: 'POST' });
      setNotice(
        result.ok
          ? `Đã thêm kênh. ${result.detail ?? ''}. Nhắn thử vào Page để kiểm tra bot trả lời.`
          : `Đã lưu kênh nhưng chưa kết nối được: ${result.detail ?? 'không rõ'}`,
      );
      setSaved(channel);
      setForm({ ...blank(), botId: form.botId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi tạo kênh');
    } finally {
      setBusy(false);
    }
  };

  const test = async (c: Channel) => {
    setError('');
    setNotice(`Đang kiểm tra ${c.name}…`);
    try {
      const result = await api<{ ok: boolean; detail?: string }>(`/channels/${c.id}/test`, { method: 'POST' });
      setNotice(`${c.name}: ${result.ok ? 'OK' : 'Lỗi'} — ${result.detail ?? ''}`);
      await load();
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Lỗi kiểm tra');
    }
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
  const full = activeCount >= data.maxChannels;

  return (
    <div className="pad">
      <h1>Kênh</h1>
      <p className="muted">
        Đang dùng {activeCount} / {data.maxChannels} kênh theo gói thuê (kênh đã tắt không tính).
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      {saved?.config?.verifyToken && (
        <section className="panel">
          <h3>Dán vào Meta → Messenger → Settings → Webhooks</h3>
          <div className="field">
            <span>Callback URL</span>
            <Copy value={webhookUrl} />
          </div>
          <div className="field">
            <span>Verify Token</span>
            <Copy value={saved.config.verifyToken} />
          </div>
          <p className="muted">Bấm Verify and save trên Meta. Token này cũng copy được ở cột Verify token trong bảng kênh.</p>
        </section>
      )}

      <table>
        <thead>
          <tr>
            <th>Tên</th>
            <th>Nền tảng</th>
            <th>Page ID</th>
            <th>AI agent</th>
            <th>Verify token</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{PROVIDER_LABEL[c.provider] ?? c.provider}</td>
              <td>{c.externalId}</td>
              <td>{botName(c.botId)}</td>
              <td>{c.config?.verifyToken ? <Copy value={c.config.verifyToken} short /> : <span className="muted">—</span>}</td>
              <td>
                <span className={`badge ${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
              </td>
              <td className="actions">
                <button onClick={() => test(c)}>Kiểm tra</button>
                <button className="danger" onClick={() => remove(c.id)}>
                  Xoá
                </button>
              </td>
            </tr>
          ))}
          {!data.items.length && (
            <tr>
              <td colSpan={7} className="muted">
                Chưa có kênh nào. Kết nối Fanpage ở form bên dưới.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Thêm kênh</h2>
      {!bots.length && <p className="error">Hãy tạo AI agent trước (menu AI agent) rồi quay lại thêm kênh.</p>}
      {full && <p className="error">Gói thuê đã đạt giới hạn số kênh.</p>}

      <form onSubmit={submit} className="channel-form">
        <section className="panel">
          <h3>Thông tin cơ bản</h3>
          <div className="field">
            <span>Nền tảng</span>
            <div className="platforms">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`platform ${p.id === 'messenger' ? 'selected' : ''}`}
                  disabled={!p.ready}
                  title={p.ready ? undefined : 'Sắp có'}
                >
                  {p.label}
                  {!p.ready && <small>Sắp có</small>}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Tên kênh *</span>
            <input value={form.name} onChange={set('name')} required maxLength={100} placeholder="Fanpage Shop ABC" />
          </label>
          <label className="field">
            <span>AI agent trả lời *</span>
            <select value={form.botId} onChange={set('botId')} required>
              <option value="">— Chọn AI agent —</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="panel">
          <h3>Cài đặt API</h3>
          <label className="field">
            <span>Page ID *</span>
            <input value={form.pageId} onChange={set('pageId')} required pattern="\d+" title="Chỉ gồm chữ số" />
          </label>
          <label className="field">
            <span>Page Access Token *</span>
            <textarea value={form.accessToken} onChange={set('accessToken')} required rows={3} />
          </label>
          <label className="field">
            <span>App Secret *</span>
            <input value={form.appSecret} onChange={set('appSecret')} required type="password" autoComplete="off" />
          </label>
          <div className="field">
            <span>Callback URL (dán vào Meta)</span>
            <Copy value={webhookUrl} />
          </div>
          <p className="muted">Verify Token được tạo tự động và hiện ra sau khi bấm Lưu và kết nối.</p>
          <button type="submit" className="btn-primary" disabled={busy || !bots.length || full}>
            {busy ? 'Đang kết nối…' : 'Lưu và kết nối'}
          </button>
        </section>

        <section className="panel steps">
          <h3>
            Các bước thiết lập Messenger{' '}
            <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">
              Meta Developers ↗
            </a>
          </h3>
          <ol>
            <li>Vào Meta Developers, tạo App loại Business, thêm sản phẩm <b>Messenger</b>.</li>
            <li>
              App settings → Basic: copy <b>App Secret</b> vào form.
            </li>
            <li>
              Messenger → Settings → <b>Generate access tokens</b>: chọn Fanpage, copy <b>Page Access Token</b> và{' '}
              <b>Page ID</b> vào form.
            </li>
            <li>
              Bấm <b>Lưu và kết nối</b> trước: hệ thống tạo Verify Token, kiểm tra token và tự đăng ký Page nhận tin nhắn.
            </li>
            <li>
              Messenger → Settings → <b>Webhooks</b>: dán <b>Callback URL</b> và <b>Verify Token</b> (hiện ra sau khi lưu,
              hoặc copy ở bảng kênh phía trên), bấm Verify and save. Nếu Page chưa nhận tin, bấm <b>Kiểm tra</b> ở bảng kênh để đăng ký lại.
            </li>
            <li>Nhắn thử vào Fanpage từ một tài khoản khác. App ở chế độ Development chỉ nhận tin từ người có vai trò trong App.</li>
          </ol>
          {window.location.hostname === 'localhost' && (
            <p className="error">
              Meta không gọi được tới localhost. Chạy tunnel (<code>cloudflared tunnel --url http://localhost:3000</code>)
              rồi dán vào Meta: <code>https://&lt;url-tunnel&gt;/webhooks/messenger</code>.
            </p>
          )}
        </section>
      </form>
    </div>
  );
}

function Copy({ value, short }: { value: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      prompt('Copy:', value);
    }
  };
  return (
    <span className="copy-row">
      <code className="copy-value">{short ? `${value.slice(0, 8)}…` : value}</code>
      <button type="button" onClick={copy}>
        {copied ? 'Đã copy' : 'Copy'}
      </button>
    </span>
  );
}
