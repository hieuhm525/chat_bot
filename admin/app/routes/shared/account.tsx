import { FormEvent, useState } from 'react';
import { Check, Loader2, LogOut, Monitor, Moon, Sun, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '../../api';
import type { User } from '../../App';
import { useDialogs } from '@/components/dialogs';
import { Field, fieldMessageId, Page, PageHeader, Section } from '@/components/page';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PasswordInput } from '@/components/password-input';
import { setTheme, useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { initials, ROLE_LABEL } from '@/lib/user';

/** Same rule as PASSWORD_RULE in src/modules/auth/auth.service.ts. */
const PASSWORD_CHECKS = [
  { label: 'Từ 8 đến 128 ký tự', test: (v: string) => v.length >= 8 && v.length <= 128 },
  { label: 'Có ít nhất một chữ cái', test: (v: string) => /[A-Za-zÀ-ỹ]/.test(v) },
  { label: 'Có ít nhất một chữ số', test: (v: string) => /\d/.test(v) },
];

type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

function ChangePasswordForm() {
  const empty = { currentPassword: '', newPassword: '', confirmPassword: '' };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<PasswordField, string>>>({});
  const [busy, setBusy] = useState(false);

  const set = (key: PasswordField) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const validate = () => {
    const next: Partial<Record<PasswordField, string>> = {};
    if (!form.currentPassword) next.currentPassword = 'Nhập mật khẩu hiện tại';
    const failed = PASSWORD_CHECKS.filter((c) => !c.test(form.newPassword)).map((c) => c.label.toLowerCase());
    if (failed.length) next.newPassword = `Mật khẩu mới chưa đạt: ${failed.join(', ')}`;
    else if (form.newPassword === form.currentPassword) next.newPassword = 'Mật khẩu mới phải khác mật khẩu hiện tại';
    if (form.confirmPassword !== form.newPassword) next.confirmPassword = 'Nhập lại chưa khớp với mật khẩu mới';
    return next;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const res = await api<{ revokedSessions: number }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      setForm(empty);
      toast.success(
        res.revokedSessions
          ? `Đã đổi mật khẩu và đăng xuất ${res.revokedSessions} phiên trên thiết bị khác.`
          : 'Đã đổi mật khẩu.',
      );
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        setErrors(err.fieldErrors as Partial<Record<PasswordField, string>>);
      } else {
        toast.error(err instanceof Error ? err.message : 'Không đổi được mật khẩu, thử lại sau.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid max-w-md gap-4">
      <Field label="Mật khẩu hiện tại" htmlFor="current-password" error={errors.currentPassword}>
        <PasswordInput
          id="current-password"
          value={form.currentPassword}
          onChange={(e) => set('currentPassword')(e.target.value)}
          autoComplete="current-password"
          required
          aria-invalid={Boolean(errors.currentPassword) || undefined}
        />
      </Field>
      <Field label="Mật khẩu mới" htmlFor="new-password" error={errors.newPassword}>
        <PasswordInput
          id="new-password"
          value={form.newPassword}
          onChange={(e) => set('newPassword')(e.target.value)}
          autoComplete="new-password"
          required
          aria-invalid={Boolean(errors.newPassword) || undefined}
          aria-describedby={`new-password-rules ${fieldMessageId('new-password')}`}
        />
        <ul id="new-password-rules" className="grid gap-1 text-xs" aria-label="Yêu cầu mật khẩu">
          {PASSWORD_CHECKS.map((c) => {
            const ok = c.test(form.newPassword);
            return (
              <li key={c.label} className={cn('flex items-center gap-1.5', ok ? 'text-success' : 'text-muted-foreground')}>
                {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                {c.label}
              </li>
            );
          })}
        </ul>
      </Field>
      <Field label="Nhập lại mật khẩu mới" htmlFor="confirm-password" error={errors.confirmPassword}>
        <PasswordInput
          id="confirm-password"
          value={form.confirmPassword}
          onChange={(e) => set('confirmPassword')(e.target.value)}
          autoComplete="new-password"
          required
          aria-invalid={Boolean(errors.confirmPassword) || undefined}
        />
      </Field>
      <p className="text-xs text-muted-foreground">Sau khi đổi, các phiên đăng nhập trên thiết bị khác sẽ bị đăng xuất.</p>
      <div>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Đổi mật khẩu
        </Button>
      </div>
    </form>
  );
}

function SessionsCard() {
  const { confirm } = useDialogs();
  const [busy, setBusy] = useState(false);

  const logoutOthers = async () => {
    const ok = await confirm({
      title: 'Đăng xuất khỏi mọi thiết bị khác?',
      description: 'Các trình duyệt và thiết bị khác đang đăng nhập bằng tài khoản này sẽ phải đăng nhập lại. Phiên hiện tại vẫn giữ.',
      confirmLabel: 'Đăng xuất thiết bị khác',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api<{ revokedSessions: number }>('/auth/logout-others', { method: 'POST' });
      toast.success(
        res.revokedSessions ? `Đã đăng xuất ${res.revokedSessions} phiên trên thiết bị khác.` : 'Không có phiên nào khác đang đăng nhập.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Không đăng xuất được thiết bị khác, thử lại sau.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="outline" onClick={logoutOthers} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <LogOut />}
      Đăng xuất khỏi mọi thiết bị khác
    </Button>
  );
}

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Sáng', icon: Sun },
  { value: 'dark', label: 'Tối', icon: Moon },
  { value: 'system', label: 'Theo hệ thống', icon: Monitor },
];

function ThemePicker() {
  const { theme } = useTheme();
  return (
    <RadioGroup
      aria-label="Giao diện"
      value={theme}
      onValueChange={(value) => setTheme(value as Theme)}
      className="grid-cols-1 sm:grid-cols-3"
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <Label
          key={value}
          htmlFor={`theme-${value}`}
          className="flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-4 py-3 font-normal transition-colors hover:bg-muted/60 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
        >
          <RadioGroupItem id={`theme-${value}`} value={value} />
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {label}
        </Label>
      ))}
    </RadioGroup>
  );
}

export function Account({ user }: { user: User }) {
  return (
    <Page className="max-w-3xl">
      <PageHeader title="Tài khoản" description="Thông tin đăng nhập và bảo mật của bạn." />

      <Card>
        <CardContent className="flex items-center gap-4">
          <Avatar className="size-12">
            <AvatarFallback className="text-base font-semibold">{initials(user.username)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate font-medium">{user.username}</div>
            <div className="text-sm text-muted-foreground">{ROLE_LABEL[user.role] ?? user.role}</div>
          </div>
        </CardContent>
      </Card>

      <Section title="Đổi mật khẩu">
        <Card>
          <CardContent>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Phiên đăng nhập"
        description="Dùng khi bạn quên đăng xuất ở máy khác hoặc nghi ngờ tài khoản bị lộ."
      >
        <SessionsCard />
      </Section>

      <Section title="Giao diện" description="Lựa chọn được lưu trên trình duyệt này.">
        <ThemePicker />
      </Section>
    </Page>
  );
}
