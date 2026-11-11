import { FormEvent, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, Lock, LockOpen, Pencil, Plus, Search } from 'lucide-react';
import { api } from '../../api';
import { useDialogs } from '@/components/dialogs';
import { Field, Notices, Page, PageHeader, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { IconAction } from '@/components/icon-action';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/password-input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Pager } from '@/components/pager';
import { useDebounced } from '@/hooks/use-debounced';
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

/** yyyy-mm-dd in the browser's local timezone (toISOString would shift to UTC). */
function localDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDateInput(value: string | null) {
  return value ? localDate(new Date(value)) : '';
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

type UsernameCheck = 'idle' | 'checking' | 'available' | 'taken' | 'error';

interface TenantPage {
  items: Tenant[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 20;

export function Tenants() {
  const [data, setData] = useState<TenantPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 300);
  const items = data?.items ?? [];
  const filtered = Boolean(q || status);
  const [form, setForm] = useState(empty);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { confirm, askPassword } = useDialogs();

  // Check the username while the admin types, so a duplicate shows before submitting.
  const creating = open && !form.id;
  const usernameQuery = useDebounced(form.username.trim().toLowerCase(), 300);
  const [usernameCheck, setUsernameCheck] = useState<{ value: string; state: UsernameCheck; message?: string }>({
    value: '',
    state: 'idle',
  });
  useEffect(() => {
    if (!creating || !USERNAME_RE.test(usernameQuery)) {
      setUsernameCheck({ value: usernameQuery, state: 'idle' });
      return;
    }
    let cancelled = false;
    setUsernameCheck({ value: usernameQuery, state: 'checking' });
    api<{ available: boolean }>(`/tenants/username-available?${new URLSearchParams({ username: usernameQuery })}`)
      .then((res) => {
        if (!cancelled) setUsernameCheck({ value: usernameQuery, state: res.available ? 'available' : 'taken' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setUsernameCheck({
          value: usernameQuery,
          state: 'error',
          message: err instanceof Error ? err.message : 'Không kiểm tra được tên đăng nhập.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [creating, usernameQuery]);
  // Only trust a result that matches what is currently typed (debounce lag).
  const currentUsername = form.username.trim().toLowerCase();
  const usernameTaken = usernameCheck.state === 'taken' && usernameCheck.value === currentUsername;
  const usernameError = usernameTaken
    ? `Tên đăng nhập "${currentUsername}" đã tồn tại, hãy chọn tên khác.`
    : usernameCheck.state === 'error' && usernameCheck.value === currentUsername
      ? usernameCheck.message
      : undefined;
  const usernameHint =
    usernameCheck.value !== currentUsername || usernameCheck.state === 'checking'
      ? USERNAME_RE.test(currentUsername) ? 'Đang kiểm tra…' : '3-32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang'
      : usernameCheck.state === 'available'
        ? 'Tên đăng nhập dùng được.'
        : '3-32 ký tự: chữ, số, dấu chấm, gạch dưới, gạch ngang';

  const requestSeq = useRef(0);
  const load = async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    try {
      const res = await api<TenantPage>(`/tenants?${params}`);
      if (seq !== requestSeq.current) return; // a newer query is already in flight
      // Deleting/filtering can leave the current page past the end; step back to the last page.
      const last = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
      if (page > last) {
        setPage(last);
        return;
      }
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh sách tenant.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };
  // Reload exactly when the query changes; filter handlers reset the page in the same render.
  useEffect(() => {
    void load();
  }, [page, q, status]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.id && usernameTaken) return;
    setFormError('');
    setNotice('');
    setSaving(true);
    const body: Record<string, unknown> = {
      plan: form.plan,
      maxBots: Number(form.maxBots),
      maxChannels: Number(form.maxChannels),
      expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59`).toISOString() : null,
    };
    try {
      if (form.id) {
        await api(`/tenants/${form.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, name: form.name }) });
        setNotice('Đã lưu tenant.');
      } else {
        await api('/tenants', {
          method: 'POST',
          body: JSON.stringify({ ...body, username: form.username, password: form.password }),
        });
        setNotice('Đã tạo tenant. Chủ shop đăng nhập tại /app.');
      }
      setOpen(false);
      setForm(empty);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Không lưu được tenant.');
    } finally {
      setSaving(false);
    }
  };

  const openForm = (value: typeof empty) => {
    setForm(value);
    setFormError('');
    setOpen(true);
  };

  // New tenants default to expiring today; the admin extends it when needed.
  const openCreate = () => openForm({ ...empty, expiresAt: localDate(new Date()) });

  const setStatus = async (tenant: Tenant, action: 'suspend' | 'resume') => {
    if (
      action === 'suspend' &&
      !(await confirm({
        title: `Khóa ${tenant.name}?`,
        description: 'Chủ shop không đăng nhập được, bot ngừng trả lời. Tin nhắn đến vẫn được lưu.',
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
      setError(err instanceof Error ? err.message : 'Không khóa/mở lại được tenant.');
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
      setError(err instanceof Error ? err.message : 'Không đặt lại được mật khẩu.');
    }
  };

  const edit = (tenant: Tenant) =>
    openForm({
      id: tenant.id,
      name: tenant.name,
      username: tenant.username ?? '',
      password: '',
      plan: tenant.plan,
      maxBots: tenant.maxBots,
      maxChannels: tenant.maxChannels,
      expiresAt: toDateInput(tenant.expiresAt),
    });

  return (
    <Page className="max-w-7xl">
      <PageHeader
        title="Tenant"
        description="Workspace của từng shop. Tenant bị khóa/hết hạn thì bot ngừng trả lời, tin nhắn đến vẫn được lưu."
        actions={
          <Button onClick={openCreate}>
            <Plus />
            Thêm tenant
          </Button>
        }
      />
      <Notices error={error} notice={notice} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Tìm tên shop hoặc tên đăng nhập"
            aria-label="Tìm tenant"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-8"
            maxLength={100}
          />
        </div>
        <div className="w-full sm:w-44">
          <NativeSelect aria-label="Lọc theo trạng thái" value={status} onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}>
            <NativeSelectOption value="">Mọi trạng thái</NativeSelectOption>
            {Object.entries(statusLabel).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {loading && data && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Đang tải" />}
      </div>

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shop</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead className="hidden md:table-cell">Gói</TableHead>
              <TableHead>Hết hạn</TableHead>
              <TableHead className="hidden md:table-cell">Bot / Kênh</TableHead>
              <TableHead className="hidden md:table-cell">Hội thoại / Tin tháng</TableHead>
              <TableHead className="hidden md:table-cell">Ngày tạo</TableHead>
              <TableHead>
                <span className="sr-only">Thao tác</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{t.username ?? '—'}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={statusClass[t.status]}>
                    {statusLabel[t.status] ?? t.status}
                  </Badge>
                </TableCell>
                <TableCell className="hidden md:table-cell">{t.plan}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {t.expiresAt ? new Date(t.expiresAt).toLocaleDateString('vi-VN') : '—'}
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap tabular-nums">
                  {t.bots}/{t.maxBots} · {t.channels}/{t.maxChannels}
                </TableCell>
                <TableCell className="hidden md:table-cell tabular-nums">
                  {t.conversations} / {t.messagesThisMonth}
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap text-muted-foreground">
                  {new Date(t.createdAt).toLocaleDateString('vi-VN')}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <IconAction onClick={() => edit(t)} label={`Sửa tenant ${t.name}`} tooltip="Sửa">
                      <Pencil />
                    </IconAction>
                    {t.status === 'suspended' ? (
                      <IconAction onClick={() => setStatus(t, 'resume')} label={`Mở lại tenant ${t.name}`} tooltip="Mở lại">
                        <LockOpen />
                      </IconAction>
                    ) : (
                      <IconAction
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setStatus(t, 'suspend')}
                        label={`Khóa tenant ${t.name}`} tooltip="Khóa"
                      >
                        <Lock />
                      </IconAction>
                    )}
                    <IconAction
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => resetPassword(t)}
                      label={`Đặt lại mật khẩu cho ${t.name}`} tooltip="Đặt lại mật khẩu"
                    >
                      <KeyRound />
                    </IconAction>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!data &&
              loading &&
              Array.from({ length: 3 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {data && !items.length && filtered && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  <div className="space-y-3">
                    <p>Không có tenant nào khớp bộ lọc.</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSearch('');
                        setStatusFilter('');
                        setPage(1);
                      }}
                    >
                      Xoá bộ lọc
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {data && !items.length && !filtered && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  <div className="space-y-3">
                    <p>Chưa có tenant. Shop tự đăng ký tại /app/register hoặc tạo ở đây.</p>
                    <Button size="sm" onClick={openCreate}>
                      <Plus />
                      Thêm tenant đầu tiên
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>
      {data && data.total > 0 && (
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} disabled={loading} />
      )}

      <Dialog open={open} onOpenChange={(v) => !v && !saving && setOpen(false)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{form.id ? `Sửa tenant: ${form.name}` : 'Thêm tenant'}</DialogTitle>
            <DialogDescription>
              {form.id ? 'Đổi gói, giới hạn và ngày hết hạn của shop.' : 'Chủ shop đăng nhập tại /app bằng tài khoản này.'}
            </DialogDescription>
          </DialogHeader>
          <Notices error={formError} />
          <div className="grid gap-5 sm:grid-cols-2">
            {form.id && (
              <Field label="Tên shop" htmlFor="t-name">
                <Input
                  id="t-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  maxLength={100}
                />
              </Field>
            )}
            {!form.id && (
              <>
                <Field label="Tên đăng nhập" htmlFor="t-username" error={usernameError} hint={usernameHint}>
                  <Input
                    id="t-username"
                    aria-invalid={Boolean(usernameError) || undefined}
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
                  <PasswordInput
                    id="t-password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
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
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Huỷ
            </Button>
            <Button type="submit" disabled={saving || (!form.id && usernameTaken)}>
              {saving && <Loader2 className="animate-spin" />}
              {form.id ? 'Lưu tenant' : 'Tạo tenant'}
            </Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
