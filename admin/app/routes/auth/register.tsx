import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '../../api';
import type { User } from '../../App';
import { AuthShell } from '@/components/auth-shell';
import { Field, Loading, Notices } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/password-input';

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
      setError(err instanceof Error ? err.message : 'Không đăng ký được, thử lại sau.');
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <AuthShell title="Đăng ký dùng thử">
        <Loading />
      </AuthShell>
    );
  }

  if (!status.enabled) {
    return (
      <AuthShell
        title="Đăng ký dùng thử"
        description={
          <>
            Hệ thống chưa mở đăng ký. Liên hệ quản trị viên để được cấp tài khoản. <Link to="/login">Đăng nhập</Link>
          </>
        }
      />
    );
  }

  return (
    <AuthShell title="Đăng ký dùng thử" description={`Tạo workspace cho shop của bạn, dùng thử ${status.trialDays} ngày.`}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Tên đăng nhập" htmlFor="username" hint="3–32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang.">
          <Input
            id="username"
            value={form.username}
            onChange={set('username')}
            autoComplete="username"
            autoFocus
            required
            pattern="[a-zA-Z0-9._\-]{3,32}"
            title="3–32 ký tự: chữ, số, . _ -"
          />
        </Field>
        <Field label="Mật khẩu" htmlFor="password" hint="Tối thiểu 6 ký tự.">
          <PasswordInput
            id="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            required
            minLength={6}
          />
        </Field>
        <Field label="Nhập lại mật khẩu" htmlFor="confirmPassword">
          <PasswordInput
            id="confirmPassword"
            value={form.confirmPassword}
            onChange={set('confirmPassword')}
            autoComplete="new-password"
            required
            minLength={6}
          />
        </Field>

        <Notices error={error} />

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? 'Đang tạo…' : 'Tạo workspace'}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Đã có tài khoản? <Link to="/login">Đăng nhập</Link>
        </p>
      </form>
    </AuthShell>
  );
}
