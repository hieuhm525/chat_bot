import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '../api';
import type { User } from '../App';
import type { SignupStatus } from './register';
import { AuthShell } from '@/components/auth-shell';
import { Field, Notices } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
    <AuthShell title="Đăng nhập" description="Dùng tài khoản được cấp cho bạn.">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Tên đăng nhập" htmlFor="username">
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>

        <Field label="Mật khẩu" htmlFor="password">
          <Input
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
            required
            minLength={6}
          />
        </Field>

        <Notices error={error} />

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </Button>
        {signup && (
          <p className="text-center text-sm text-muted-foreground">
            Chưa có tài khoản? <Link to="/register">Đăng ký dùng thử</Link>
          </p>
        )}
      </form>
    </AuthShell>
  );
}
