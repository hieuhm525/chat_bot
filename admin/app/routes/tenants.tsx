import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';

interface Tenant {
  id: string;
  name: string;
  status: string;
  plan: string;
  maxBots: number;
  maxChannels: number;
  expiresAt: string | null;
  createdAt: string;
  username: string | null;
  bots: number;
  channels: number;
  conversations: number;
  messagesThisMonth: number;
}

const statusLabel: Record<string, string> = {
  trial: 'Dùng thử',
  active: 'Hoạt động',
  suspended: 'Đã khóa',
  expired: 'Hết hạn',
};

const empty = {
  id: '',
  name: '',
  username: '',
  password: '',
  plan: 'trial',
  maxBots: 1,
  maxChannels: 1,
  expiresAt: '',
};

function toDateInput(value: string | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : '';
}

export function Tenants() {
  const [items, setItems] = useState<Tenant[]>([]);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api<Tenant[]>('/tenants').then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const body: Record<string, unknown> = {
      name: form.name,
      plan: form.plan,
      maxBots: Number(form.maxBots),
      maxChannels: Number(form.maxChannels),
      expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59`).toISOString() : null,
    };
    try {
      if (form.id) {
        await api(`/tenants/${form.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        setNotice('Đã lưu tenant.');
      } else {
        await api('/tenants', {
          method: 'POST',
          body: JSON.stringify({ ...body, username: form.username, password: form.password }),
        });
        setNotice('Đã tạo tenant. Chủ shop đăng nhập tại /app.');
      }
      setForm(empty);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi lưu tenant');
    }
  };

  const setStatus = async (tenant: Tenant, action: 'suspend' | 'resume') => {
    setError('');
    setNotice('');
    try {
      await api(`/tenants/${tenant.id}/${action}`, { method: 'POST' });
      setNotice(action === 'suspend' ? `Đã khóa ${tenant.name}.` : `Đã mở lại ${tenant.name}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi đổi trạng thái');
    }
  };

  const resetPassword = async (tenant: Tenant) => {
    const password = window.prompt(`Mật khẩu mới cho ${tenant.username ?? tenant.name} (từ 6 ký tự):`);
    if (!password) return;
    setError('');
    setNotice('');
    try {
      await api(`/tenants/${tenant.id}/reset-owner-password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setNotice('Đã đặt lại mật khẩu và đăng xuất các phiên cũ của chủ shop.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi đặt lại mật khẩu');
    }
  };

  const edit = (tenant: Tenant) => {
    setForm({
      id: tenant.id,
      name: tenant.name,
      username: tenant.username ?? '',
      password: '',
      plan: tenant.plan,
      maxBots: tenant.maxBots,
      maxChannels: tenant.maxChannels,
      expiresAt: toDateInput(tenant.expiresAt),
    });
  };

  return (
    <div className="pad">
      <h1>Tenant</h1>
      <p className="muted">
        Mỗi tenant là một workspace riêng; chủ shop đăng nhập tại /app. Tenant bị khóa hoặc hết hạn không đăng nhập
        được và bot ngừng trả lời, tin nhắn đến vẫn được lưu.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <table>
        <thead>
          <tr>
            <th>Shop</th>
            <th>Trạng thái</th>
            <th>Gói</th>
            <th>Hết hạn</th>
            <th>Bot / Kênh</th>
            <th>Hội thoại / Tin tháng này</th>
            <th>Ngày tạo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id}>
              <td>
                <div>{t.name}</div>
                <div className="muted">{t.username ?? '—'}</div>
              </td>
              <td>
                <span className={`badge ${t.status === 'active' || t.status === 'trial' ? '' : 'error'}`}>
                  {statusLabel[t.status] ?? t.status}
                </span>
              </td>
              <td>{t.plan}</td>
              <td>{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString('vi-VN') : '—'}</td>
              <td>
                {t.bots} / {t.maxBots} · {t.channels} / {t.maxChannels}
              </td>
              <td>
                {t.conversations} / {t.messagesThisMonth}
              </td>
              <td>{new Date(t.createdAt).toLocaleDateString('vi-VN')}</td>
              <td className="actions">
                <button onClick={() => edit(t)}>Sửa</button>
                {t.status === 'suspended' ? (
                  <button onClick={() => setStatus(t, 'resume')}>Mở lại</button>
                ) : (
                  <button className="danger" onClick={() => setStatus(t, 'suspend')}>
                    Khóa
                  </button>
                )}
                <button className="danger" onClick={() => resetPassword(t)}>
                  Đặt lại mật khẩu
                </button>
              </td>
            </tr>
          ))}
          {!items.length && (
            <tr>
              <td colSpan={8} className="muted">
                Chưa có tenant.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>{form.id ? 'Sửa tenant' : 'Thêm tenant'}</h2>
      <form className="grid" onSubmit={submit}>
        <label>
          Tên shop
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
        </label>
        {!form.id && (
          <>
            <label>
              Tên đăng nhập
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
                minLength={3}
                maxLength={32}
                pattern="[a-zA-Z0-9._\-]+"
                title="3-32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang"
                autoComplete="off"
              />
            </label>
            <label>
              Mật khẩu
              <input
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </label>
          </>
        )}
        <label>
          Gói
          <input value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} maxLength={50} />
        </label>
        <label>
          Giới hạn bot
          <input
            type="number"
            min={0}
            value={form.maxBots}
            onChange={(e) => setForm({ ...form, maxBots: Number(e.target.value) })}
          />
        </label>
        <label>
          Giới hạn kênh
          <input
            type="number"
            min={0}
            value={form.maxChannels}
            onChange={(e) => setForm({ ...form, maxChannels: Number(e.target.value) })}
          />
        </label>
        <label>
          Hết hạn
          <input
            type="date"
            value={form.expiresAt}
            onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
          />
        </label>
        <button type="submit">{form.id ? 'Lưu tenant' : 'Tạo tenant'}</button>
        {form.id && (
          <button type="button" className="link" onClick={() => setForm(empty)}>
            Huỷ
          </button>
        )}
      </form>
    </div>
  );
}
