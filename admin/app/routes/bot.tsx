import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export interface Agent {
  id: string;
  name: string;
  enabled: boolean;
  greeting: string;
  fallbackMessage: string;
  handoffMessage: string;
  llmEnabled: boolean;
  systemPrompt: string;
  pauseAfterFallbacks: number;
  ruleCount: number;
  channelCount: number;
  createdAt: string;
}

interface BotList {
  items: Agent[];
  maxBots: number;
}

export function Bots() {
  const [data, setData] = useState<BotList | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api<BotList>('/bots').then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api('/bots', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      setNotice('Đã tạo AI agent.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi tạo AI agent');
    }
  };

  const toggle = async (bot: Agent) => {
    setError('');
    try {
      await api(`/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !bot.enabled }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi cập nhật AI agent');
    }
  };

  const remove = async (bot: Agent) => {
    if (!confirm(`Xoá AI agent ${bot.name}?`)) return;
    setError('');
    setNotice('');
    try {
      const result = await api<{ ok: boolean }>(`/bots/${bot.id}`, { method: 'DELETE' });
      setNotice(result.ok ? 'Đã xoá AI agent.' : '');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi xoá AI agent');
    }
  };

  if (error && !data) return <p className="error pad">{error}</p>;
  if (!data) return <p className="muted pad">Đang tải…</p>;

  return (
    <div className="pad">
      <h1>AI agent</h1>
      <p className="muted">
        Đang dùng {data.items.length} / {data.maxBots} theo gói thuê.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <table>
        <thead>
          <tr>
            <th>Tên</th>
            <th>Bật</th>
            <th>Rule</th>
            <th>Kênh đang gắn</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((bot) => (
            <tr key={bot.id}>
              <td>
                <Link to={`/bots/${bot.id}`}>{bot.name}</Link>
              </td>
              <td>
                <input type="checkbox" checked={bot.enabled} onChange={() => toggle(bot)} />
              </td>
              <td>{bot.ruleCount}</td>
              <td>{bot.channelCount}</td>
              <td className="actions">
                <Link to={`/bots/${bot.id}`}>Cấu hình</Link>
                <button className="danger" onClick={() => remove(bot)}>
                  Xoá
                </button>
              </td>
            </tr>
          ))}
          {!data.items.length && (
            <tr>
              <td colSpan={5} className="muted">
                Chưa có AI agent.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Thêm AI agent</h2>
      <form className="grid" onSubmit={create}>
        <label>
          Tên
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
        <button type="submit" disabled={data.items.length >= data.maxBots}>
          Thêm AI agent
        </button>
      </form>
      {data.items.length >= data.maxBots && (
        <p className="muted">Gói thuê đã đạt giới hạn số AI agent.</p>
      )}
    </div>
  );
}
