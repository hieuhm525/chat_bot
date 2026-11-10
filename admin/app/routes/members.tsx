import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';

interface Member {
  id: string;
  username: string;
  role: string;
  disabledAt: string | null;
  createdAt: string;
}

export function Members() {
  const [items, setItems] = useState<Member[]>([]);
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api<Member[]>('/members').then(setItems).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api('/members', { method: 'POST', body: JSON.stringify(form) });
      setForm({ username: '', password: '' });
      setNotice('Đã thêm nhân viên.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi thêm thành viên');
    }
  };

  const changePassword = async (member: Member) => {
    const password = window.prompt(`Mật khẩu mới cho ${member.username} (từ 6 ký tự):`);
    if (!password) return;
    setError('');
    setNotice('');
    try {
      await api(`/members/${member.id}/password`, { method: 'PATCH', body: JSON.stringify({ password }) });
      setNotice(`Đã đổi mật khẩu ${member.username} và đăng xuất các phiên cũ.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi đổi mật khẩu');
    }
  };

  const disable = async (member: Member) => {
    if (!confirm(`Vô hiệu hoá ${member.username}? Họ sẽ không đăng nhập được nữa.`)) return;
    setError('');
    setNotice('');
    try {
      await api(`/members/${member.id}`, { method: 'DELETE' });
      setNotice(`Đã vô hiệu hoá ${member.username}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi vô hiệu hoá');
    }
  };

  return (
    <div className="pad">
      <h1>Thành viên</h1>
      <p className="muted">
        Nhân viên (agent) xem hội thoại, tiếp quản và trả lời khách; không sửa được bot, kênh hay thành viên.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <table>
        <thead>
          <tr>
            <th>Tên đăng nhập</th>
            <th>Vai trò</th>
            <th>Trạng thái</th>
            <th>Ngày tạo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td>{m.username}</td>
              <td>{m.role === 'owner' ? 'Chủ shop' : 'Nhân viên'}</td>
              <td>
                <span className={`badge ${m.disabledAt ? 'error' : ''}`}>
                  {m.disabledAt ? 'Đã vô hiệu hoá' : 'Hoạt động'}
                </span>
              </td>
              <td>{new Date(m.createdAt).toLocaleDateString('vi-VN')}</td>
              <td className="actions">
                <button onClick={() => changePassword(m)}>Đổi mật khẩu</button>
                {!m.disabledAt && (
                  <button className="danger" onClick={() => disable(m)}>
                    Vô hiệu hoá
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!items.length && (
            <tr>
              <td colSpan={5} className="muted">
                Chưa có thành viên.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Thêm nhân viên</h2>
      <form className="grid" onSubmit={submit}>
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
        <button type="submit">Thêm nhân viên</button>
      </form>
    </div>
  );
}
