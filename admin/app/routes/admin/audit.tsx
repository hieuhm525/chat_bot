import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { api } from '../../api';
import { Notices, Page, PageHeader, TableCard } from '@/components/page';
import { Pager } from '@/components/pager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDebounced } from '@/hooks/use-debounced';

interface AuditEntry {
  id: string;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** Keys match AUDIT_ACTIONS in src/modules/audit/audit.service.ts. */
const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Đăng nhập',
  'auth.login_failed': 'Đăng nhập thất bại',
  'auth.password_changed': 'Đổi mật khẩu',
  'auth.sessions_revoked': 'Đăng xuất thiết bị khác',
  'tenant.created': 'Tạo tenant',
  'tenant.signup': 'Shop tự đăng ký',
  'tenant.updated': 'Sửa tenant',
  'tenant.suspended': 'Khóa tenant',
  'tenant.resumed': 'Mở lại tenant',
  'tenant.owner_password_reset': 'Đặt lại mật khẩu chủ shop',
  'provider.created': 'Thêm AI provider',
  'provider.updated': 'Sửa AI provider',
  'provider.deleted': 'Xoá AI provider',
};

const DANGER = new Set(['auth.login_failed', 'tenant.suspended', 'tenant.owner_password_reset', 'provider.deleted']);

const FIELD_LABEL: Record<string, string> = {
  name: 'tên',
  plan: 'gói',
  maxBots: 'giới hạn bot',
  maxChannels: 'giới hạn kênh',
  expiresAt: 'hết hạn',
  baseUrl: 'base URL',
  model: 'model',
  priority: 'ưu tiên',
  enabled: 'bật',
  kind: 'loại',
  apiKey: 'API key',
};

const PAGE_SIZE = 25;

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'có' : 'không';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toLocaleDateString('vi-VN');
  return String(value);
}

/** One readable line from the metadata of an entry. */
function describe(entry: AuditEntry): string {
  const m = entry.metadata ?? {};
  const changes = m.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (changes) {
    return Object.entries(changes)
      .map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${show(v.from)} → ${show(v.to)}`)
      .join('; ');
  }
  switch (entry.action) {
    case 'auth.login_failed':
      return m.reason === 'unknown_user' ? 'Tên đăng nhập không tồn tại' : 'Sai mật khẩu';
    case 'auth.password_changed':
    case 'auth.sessions_revoked':
      return `Đã đăng xuất ${show(m.revokedSessions)} phiên khác`;
    case 'tenant.suspended':
    case 'tenant.resumed':
      return `Trạng thái: ${show(m.from)} → ${show(m.to)}`;
    case 'tenant.created':
    case 'tenant.signup':
      return `Chủ shop ${show(m.owner)}, gói ${show(m.plan)}, hết hạn ${show(m.expiresAt)}`;
    case 'tenant.owner_password_reset':
      return `Chủ shop ${show(m.owner)}, các phiên cũ đã bị đăng xuất`;
    case 'provider.created':
    case 'provider.deleted':
      return `${show(m.model)} · ${show(m.baseUrl)}`;
    case 'auth.login':
      return typeof m.userAgent === 'string' ? m.userAgent : '';
    default:
      return '';
  }
}

export function AuditLog() {
  const [data, setData] = useState<AuditPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search.trim(), 300);
  const requestSeq = useRef(0);
  const filtered = Boolean(q || action);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (action) params.set('action', action);
    api<AuditPage>(`/audit-logs?${params}`)
      .then((res) => {
        if (seq === requestSeq.current) setData(res);
      })
      .catch((err: unknown) => {
        if (seq === requestSeq.current) setError(err instanceof Error ? err.message : 'Không tải được nhật ký thao tác.');
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [page, q, action]);

  const items = data?.items ?? [];

  return (
    <Page className="max-w-7xl">
      <PageHeader
        title="Nhật ký thao tác"
        description="Ai đã làm gì, với đối tượng nào, lúc nào: đăng nhập, đổi mật khẩu, thao tác trên tenant và AI provider."
      />
      <Notices error={error} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Tìm người thực hiện hoặc đối tượng"
            aria-label="Tìm trong nhật ký"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-8"
            maxLength={100}
          />
        </div>
        <div className="w-full sm:w-60">
          <NativeSelect
            aria-label="Lọc theo thao tác"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <NativeSelectOption value="">Mọi thao tác</NativeSelectOption>
            {Object.entries(ACTION_LABEL).map(([value, label]) => (
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
              <TableHead>Thời gian</TableHead>
              <TableHead>Người thực hiện</TableHead>
              <TableHead>Thao tác</TableHead>
              <TableHead>Đối tượng</TableHead>
              <TableHead>Chi tiết</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data &&
              loading &&
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {items.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {new Date(e.createdAt).toLocaleString('vi-VN')}
                </TableCell>
                <TableCell className="font-medium">{e.actorUsername ?? '—'}</TableCell>
                <TableCell>
                  <Badge
                    variant="secondary"
                    className={DANGER.has(e.action) ? 'bg-destructive/10 text-destructive' : undefined}
                  >
                    {ACTION_LABEL[e.action] ?? e.action}
                  </Badge>
                </TableCell>
                <TableCell>{e.targetLabel ?? '—'}</TableCell>
                <TableCell className="max-w-md text-sm whitespace-normal text-muted-foreground">{describe(e) || '—'}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{e.ip ?? '—'}</TableCell>
              </TableRow>
            ))}
            {data && !items.length && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {filtered ? (
                    <div className="space-y-3">
                      <p>Không có mục nào khớp bộ lọc.</p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSearch('');
                          setAction('');
                          setPage(1);
                        }}
                      >
                        Xoá bộ lọc
                      </Button>
                    </div>
                  ) : (
                    'Chưa có thao tác nào được ghi lại.'
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>
      {data && data.total > 0 && (
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} disabled={loading} />
      )}
    </Page>
  );
}
