import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { User } from '../App';

export interface SignupStatus {
  enabled: boolean;
  trialDays: number;
}

export function Register({ onLogin }: { onLogin: (user: User) => void }) {
  const [status, setStatus] = useState<SignupStatus | null>(null);
  const [form, setForm] = useState({ username: '', password: '', confirmPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SignupStatus>('/signup/status')
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, trialDays: 0 }));
  }, []);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) {
      setError('Mật khẩu nhập lại không khớp');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ user: User }>('/signup', { method: 'POST', body: JSON.stringify(form) });
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đăng ký lỗi');
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <main className="auth-box">
        <div className="auth-brand">
          <span className="auth-mark">bv</span>
          bv-agent-msg
        </div>

        <div className="auth-card">
          <h1>Đăng ký dùng thử</h1>
          {!status ? (
            <p className="auth-intro">Đang tải…</p>
          ) : !status.enabled ? (
            <p className="auth-intro">
              Hệ thống chưa mở đăng ký. Liên hệ quản trị viên để được cấp tài khoản. <Link to="/login">Đăng nhập</Link>
            </p>
          ) : (
            <>
              <p className="auth-intro">Tạo workspace cho shop của bạn, dùng thử {status.trialDays} ngày.</p>
              <form onSubmit={submit} className="auth-form">
                <label className="field">
                  <span>Tên đăng nhập</span>
                  <input
                    value={form.username}
                    onChange={set('username')}
                    autoComplete="username"
                    autoFocus
                    required
                    pattern="[a-zA-Z0-9._\-]{3,32}"
                    title="3–32 ký tự: chữ, số, . _ -"
                  />
                </label>
                <label className="field">
                  <span>Mật khẩu</span>
                  <input
                    value={form.password}
                    onChange={set('password')}
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={6}
                  />
                </label>
                <label className="field">
                  <span>Nhập lại mật khẩu</span>
                  <input
                    value={form.confirmPassword}
                    onChange={set('confirmPassword')}
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={6}
                  />
                </label>

                {error && <div className="alert">{error}</div>}

                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy ? 'Đang tạo…' : 'Tạo tài khoản'}
                </button>
                <p className="auth-intro">
                  Đã có tài khoản? <Link to="/login">Đăng nhập</Link>
                </p>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
