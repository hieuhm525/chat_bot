import { FormEvent, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../api';
import type { User } from '../App';
import { AuthShell } from '@/components/auth-shell';
import { Field, Notices } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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

  if (!status.allowed) {
    return (
      <AuthShell
        title="Chưa thể tạo tài khoản"
        description={
          <>
            Đặt <code>SETUP_TOKEN</code> trong <code>.env</code> rồi khởi động lại server, hoặc mở trang này từ chính
            máy chủ.
          </>
        }
      />
    );
  }

  return (
    <AuthShell
      title="Tạo tài khoản quản trị"
      description="Tài khoản đầu tiên có toàn quyền với workspace này."
      footer="Trang này tự ẩn sau khi hệ thống có tài khoản đầu tiên."
    >
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Tên đăng nhập" htmlFor="username" hint="3–32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang.">
          <Input
            id="username"
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
        </Field>

        <Field label="Mật khẩu" htmlFor="password" hint="Tối thiểu 6 ký tự.">
          <Input
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
          />
        </Field>

        <Field label="Xác nhận mật khẩu" htmlFor="confirmPassword">
          <Input
            id="confirmPassword"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
          />
        </Field>

        {status.tokenRequired && (
          <Field label="Setup token" htmlFor="setupToken" hint="Lấy từ SETUP_TOKEN trong .env.">
            <Input
              id="setupToken"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              type="password"
              required
            />
          </Field>
        )}

        <Notices error={error} />

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? 'Đang tạo…' : 'Tạo tài khoản'}
        </Button>
      </form>
    </AuthShell>
  );
}
