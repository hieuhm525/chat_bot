import { FormEvent, useState } from 'react';
import { api } from '../api';
import type { User } from '../App';

export interface SetupStatus {
  needsSetup: boolean;
  tokenRequired: boolean;
  localOnly: boolean;
  allowed: boolean;
}

export function Setup({ status, onDone }: { status: SetupStatus; onDone: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Mật khẩu nhập lại không khớp');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ user: User }>('/setup', {
        method: 'POST',
        body: JSON.stringify({ username, password, confirmPassword, setupToken: setupToken || undefined }),
      });
      onDone(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tạo admin lỗi');
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
          {!status.allowed ? (
            <>
              <h1>Chưa thể tạo tài khoản</h1>
              <p className="auth-intro">
                Đặt <code>SETUP_TOKEN</code> trong <code>.env</code> rồi khởi động lại server, hoặc mở trang này từ
                chính máy chủ.
              </p>
            </>
          ) : (
            <>
              <h1>Tạo tài khoản quản trị</h1>
              <p className="auth-intro">Tài khoản đầu tiên có toàn quyền với workspace này.</p>

              <form onSubmit={submit} className="auth-form">
              <label className="field">
                <span>Tên đăng nhập</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[a-zA-Z0-9._\-]+"
                  title="3-32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang"
                />
                <small className="hint">3–32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang.</small>
              </label>

              <label className="field">
                <span>Mật khẩu</span>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={6}
                />
                <small className="hint">Tối thiểu 6 ký tự.</small>
              </label>

              <label className="field">
                <span>Xác nhận mật khẩu</span>
                <input
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={6}
                />
              </label>

              {status.tokenRequired && (
                <label className="field">
                  <span>Setup token</span>
                  <input
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    type="password"
                    required
                  />
                  <small className="hint">Lấy từ SETUP_TOKEN trong .env.</small>
                </label>
              )}

              {error && <div className="alert">{error}</div>}

              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? 'Đang tạo…' : 'Tạo tài khoản'}
              </button>
              </form>

              <p className="auth-foot">Trang này tự ẩn sau khi hệ thống có tài khoản đầu tiên.</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
