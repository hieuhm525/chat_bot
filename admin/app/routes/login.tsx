import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { User } from '../App';
import type { SignupStatus } from './register';

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signup, setSignup] = useState(false);

  useEffect(() => {
    if (!window.location.pathname.startsWith('/app')) return;
    api<SignupStatus>('/signup/status')
      .then((s) => setSignup(s.enabled))
      .catch(() => setSignup(false));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api<{ user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đăng nhập lỗi');
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
          <h1>Đăng nhập</h1>
          <p className="auth-intro">Dùng tài khoản được cấp cho bạn.</p>

          <form onSubmit={submit} className="auth-form">
          <label className="field">
            <span>Tên đăng nhập</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>

          <label className="field">
            <span>Mật khẩu</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              required
              minLength={6}
            />
          </label>

          {error && <div className="alert">{error}</div>}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </button>
          {signup && (
            <p className="auth-intro">
              Chưa có tài khoản? <Link to="/register">Đăng ký dùng thử</Link>
            </p>
          )}
          </form>
        </div>
      </main>
    </div>
  );
}
