import { FormEvent, useEffect, useState } from 'react';
import { KeyRound, Lock, LockOpen, Pencil } from 'lucide-react';
import { api } from '../api';
import { scrollToId, useDialogs } from '@/components/dialogs';
import { Field, Notices, Page, PageHeader, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

const statusClass: Record<string, string> = {
  trial: 'bg-accent text-accent-foreground',
  active: 'bg-success/10 text-success',
  suspended: 'bg-destructive/10 text-destructive',
  expired: 'bg-warning/15 text-foreground',
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
  const { confirm, askPassword } = useDialogs();

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
    if (
      action === 'suspend' &&
      !(await confirm({
        title: `Khóa ${tenant.name}?`,
        description: 'Chủ shop và nhân viên không đăng nhập được, bot ngừng trả lời. Tin nhắn đến vẫn được lưu.',
        confirmLabel: 'Khóa tenant',
        destructive: true,
      }))
    )
      return;
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
    const password = await askPassword({
      title: `Đặt lại mật khẩu chủ shop ${tenant.username ?? tenant.name}`,
      description: 'Các phiên đăng nhập cũ của chủ shop sẽ bị đăng xuất.',
      confirmLabel: 'Đặt lại mật khẩu',
    });
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
    scrollToId('tenant-form');
  };

  return (
    <Page className="max-w-7xl">
      <PageHeader
        title="Tenant"
        description="Mỗi tenant là một workspace riêng; chủ shop đăng nhập tại /app. Tenant bị khóa hoặc hết hạn không đăng nhập được và bot ngừng trả lời, tin nhắn đến vẫn được lưu."
      />
      <Notices error={error} notice={notice} />

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shop</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Gói</TableHead>
              <TableHead>Hết hạn</TableHead>
              <TableHead>Bot / Kênh</TableHead>
              <TableHead>Hội thoại / Tin tháng</TableHead>
              <TableHead>Ngày tạo</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((t) => (
              <TableRow key={t.id} data-state={form.id === t.id ? 'selected' : undefined}>
                <TableCell>
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{t.username ?? '—'}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={statusClass[t.status]}>
                    {statusLabel[t.status] ?? t.status}
                  </Badge>
                </TableCell>
                <TableCell>{t.plan}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {t.expiresAt ? new Date(t.expiresAt).toLocaleDateString('vi-VN') : '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {t.bots}/{t.maxBots} · {t.channels}/{t.maxChannels}
                </TableCell>
                <TableCell className="tabular-nums">
                  {t.conversations} / {t.messagesThisMonth}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {new Date(t.createdAt).toLocaleDateString('vi-VN')}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => edit(t)} title="Sửa" aria-label="Sửa">
                      <Pencil />
                    </Button>
                    {t.status === 'suspended' ? (
                      <Button variant="ghost" size="icon-sm" onClick={() => setStatus(t, 'resume')} title="Mở lại" aria-label="Mở lại">
                        <LockOpen />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setStatus(t, 'suspend')}
                        title="Khóa" aria-label="Khóa"
                      >
                        <Lock />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => resetPassword(t)}
                      title="Đặt lại mật khẩu" aria-label="Đặt lại mật khẩu"
                    >
                      <KeyRound />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  Chưa có tenant.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>

      <form id="tenant-form" onSubmit={submit} className="scroll-mt-6">
        <Card>
          <CardHeader>
            <CardTitle>{form.id ? `Sửa tenant: ${form.name}` : 'Thêm tenant'}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Tên shop" htmlFor="t-name">
              <Input
                id="t-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                maxLength={100}
              />
            </Field>
            {!form.id && (
              <>
                <Field label="Tên đăng nhập" htmlFor="t-username">
                  <Input
                    id="t-username"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[a-zA-Z0-9._\-]+"
                    title="3-32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Mật khẩu" htmlFor="t-password">
                  <Input
                    id="t-password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}
            <Field label="Gói" htmlFor="t-plan">
              <Input
                id="t-plan"
                value={form.plan}
                onChange={(e) => setForm({ ...form, plan: e.target.value })}
                maxLength={50}
              />
            </Field>
            <Field label="Giới hạn bot" htmlFor="t-bots">
              <Input
                id="t-bots"
                type="number"
                min={0}
                value={form.maxBots}
                onChange={(e) => setForm({ ...form, maxBots: Number(e.target.value) })}
              />
            </Field>
            <Field label="Giới hạn kênh" htmlFor="t-channels">
              <Input
                id="t-channels"
                type="number"
                min={0}
                value={form.maxChannels}
                onChange={(e) => setForm({ ...form, maxChannels: Number(e.target.value) })}
              />
            </Field>
            <Field label="Hết hạn" htmlFor="t-expires">
              <Input
                id="t-expires"
                type="date"
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              />
            </Field>
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
              <Button type="submit">{form.id ? 'Lưu tenant' : 'Tạo tenant'}</Button>
              {form.id && (
                <Button type="button" variant="ghost" onClick={() => setForm(empty)}>
                  Huỷ
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </form>
    </Page>
  );
}
