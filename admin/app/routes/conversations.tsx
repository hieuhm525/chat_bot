import { FormEvent, UIEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, ChevronUp, Filter, Hand, Loader2, MessagesSquare, Search, Send, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { Notices } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

interface ConversationSummary {
  id: string;
  mode: string;
  customerName: string | null;
  externalUserId: string;
  channelName: string;
  botName: string | null;
  assignedUserName: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

interface Message {
  id: string;
  direction: 'in' | 'out';
  senderType: 'customer' | 'bot' | 'agent' | 'system';
  senderName: string;
  content: string;
  status: string;
  errorCode: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface Detail {
  id: string;
  mode: string;
  fallbackCount: number;
  botName: string | null;
  assignedUserName: string | null;
  customer: { displayName: string | null; externalUserId: string };
  channel: { id: string; name: string; provider: string } | null;
  messages: Message[];
}

interface Options {
  channels: Array<{ id: string; name: string; status: string }>;
  bots: Array<{ id: string; name: string }>;
  members: Array<{ id: string; username: string; role: string }>;
}

interface Page {
  items: ConversationSummary[];
  nextCursor: string | null;
}

interface Filters {
  channelId: string;
  botId: string;
  mode: string;
  assignedUserId: string;
  from: string;
  to: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  channelId: '',
  botId: '',
  mode: '',
  assignedUserId: '',
  from: '',
  to: '',
  search: '',
};

const MODE_LABEL: Record<string, string> = { bot: 'Bot', human: 'Người thật', off: 'Đã tắt' };

const SOURCE_LABEL: Record<string, string> = {
  rule: 'Rule',
  llm: 'AI (LLM)',
  fallback: 'Câu trả lời mặc định',
  agent: 'Nhân viên',
};

const STATUS_LABEL: Record<string, string> = {
  received: 'Đã nhận',
  queued: 'Đang chờ gửi',
  sent: 'Đã gửi',
  delivered: 'Đã tới',
  read: 'Đã đọc',
  failed: 'Gửi lỗi',
  blocked_by_policy: 'Bị chặn',
};

function queryString(filters: Filters, cursor?: string) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

const MODE_CLASS: Record<string, string> = {
  bot: 'bg-accent text-accent-foreground',
  human: 'bg-success/10 text-success',
  off: 'bg-muted text-muted-foreground',
};

const BUBBLE: Record<Message['senderType'], string> = {
  customer: 'self-start bg-card',
  bot: 'self-end border-primary/20 bg-accent',
  agent: 'self-end border-success/25 bg-success/10',
  system: 'self-center bg-muted text-xs',
};

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString('vi-VN') : '—';
}

export function Conversations() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [options, setOptions] = useState<Options>({ channels: [], bots: [], members: [] });
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [detail, setDetail] = useState<Message | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'act' | 'send' | 'older'>('');
  const loadingRef = useRef(false);

  const loadPage = async (cursor: string | undefined, active: Filters) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await api<Page>(`/conversations?${queryString(active, cursor)}`);
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const loadDetail = (id: string) =>
    api<Detail>(`/conversations/${id}`).then((row) => {
      setSelected(row);
      setDetail(null);
    });

  useEffect(() => {
    api<Options>('/conversations/options').then(setOptions).catch((e) => setError(e.message));
    loadPage(undefined, EMPTY_FILTERS);
  }, []);

  const applyFilters = (e: FormEvent) => {
    e.preventDefault();
    loadPage(undefined, filters);
  };

  const open = (id: string) => {
    loadDetail(id).catch((e) => toast.error(`Không mở được hội thoại: ${e.message}`));
  };

  /** Runs a thread action; failures surface as a toast because the list (and its error slot) is hidden on mobile. */
  const run = async (kind: 'act' | 'send' | 'older', label: string, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };

  const act = (path: 'takeover' | 'release') =>
    run('act', path === 'takeover' ? 'Không tiếp quản được' : 'Không trả lại bot được', async () => {
      if (!selected) return;
      await api(`/conversations/${selected.id}/${path}`, { method: 'POST' });
      await Promise.all([loadDetail(selected.id), loadPage(undefined, filters)]);
    });

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!selected || !text.trim()) return;
    return run('send', 'Gửi tin thất bại', async () => {
      await api(`/conversations/${selected.id}/messages`, { method: 'POST', body: JSON.stringify({ content: text }) });
      setText('');
      await loadDetail(selected.id);
    });
  };

  const loadOlder = () =>
    run('older', 'Không tải được tin cũ', async () => {
      if (!selected?.messages.length) return;
      const older = await api<Message[]>(
        `/conversations/${selected.id}/messages?before=${encodeURIComponent(selected.messages[0].id)}`,
      );
      setSelected({ ...selected, messages: [...older, ...selected.messages] });
    });

  const onScroll = (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (nextCursor && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      loadPage(nextCursor, filters);
    }
  };

  const setFilter = (key: keyof Filters) => (e: { target: { value: string } }) =>
    setFilters({ ...filters, [key]: e.target.value });

  return (
    <div className="grid h-full md:h-screen md:grid-cols-[380px_1fr]">
      <section className={cn('min-h-0 flex-col border-r bg-card md:flex', selected ? 'hidden' : 'flex')}>
        <div className="space-y-3 border-b p-4">
          <h1 className="text-lg font-semibold tracking-tight">Hội thoại</h1>
          <form className="space-y-2" onSubmit={applyFilters}>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Tìm hội thoại"
                className="pl-8"
                placeholder="Tìm tên khách, ID khách, nội dung tin…"
                value={filters.search}
                onChange={setFilter('search')}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NativeSelect size="sm" aria-label="Lọc theo kênh" value={filters.channelId} onChange={setFilter('channelId')}>
                <NativeSelectOption value="">Mọi kênh</NativeSelectOption>
                {options.channels.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name}
                    {c.status === 'disabled' ? ' (đã tắt)' : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect size="sm" aria-label="Lọc theo AI agent" value={filters.botId} onChange={setFilter('botId')}>
                <NativeSelectOption value="">Mọi AI agent</NativeSelectOption>
                {options.bots.map((b) => (
                  <NativeSelectOption key={b.id} value={b.id}>
                    {b.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect size="sm" aria-label="Lọc theo chế độ" value={filters.mode} onChange={setFilter('mode')}>
                <NativeSelectOption value="">Mọi chế độ</NativeSelectOption>
                <NativeSelectOption value="bot">Bot</NativeSelectOption>
                <NativeSelectOption value="human">Người thật</NativeSelectOption>
                <NativeSelectOption value="off">Đã tắt</NativeSelectOption>
              </NativeSelect>
              <NativeSelect size="sm" aria-label="Lọc theo người tiếp quản" value={filters.assignedUserId} onChange={setFilter('assignedUserId')}>
                <NativeSelectOption value="">Mọi người tiếp quản</NativeSelectOption>
                {options.members.map((m) => (
                  <NativeSelectOption key={m.id} value={m.id}>
                    {m.username}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <div className="grid gap-1">
                <Label htmlFor="f-from" className="text-xs font-normal text-muted-foreground">
                  Từ ngày
                </Label>
                <Input id="f-from" type="date" className="h-8" value={filters.from} onChange={setFilter('from')} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="f-to" className="text-xs font-normal text-muted-foreground">
                  Đến ngày
                </Label>
                <Input id="f-to" type="date" className="h-8" value={filters.to} onChange={setFilter('to')} />
              </div>
            </div>
            <Button type="submit" size="sm" className="w-full">
              <Filter />
              Lọc
            </Button>
          </form>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
          {error && (
            <div className="p-3">
              <Notices error={error} />
            </div>
          )}
          {items.map((item) => {
            const name = item.customerName ?? item.externalUserId;
            return (
              <button
                key={item.id}
                className={cn(
                  'flex w-full gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/60',
                  selected?.id === item.id && 'bg-accent hover:bg-accent',
                )}
                onClick={() => open(item.id)}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {initials(name)}
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(item.lastMessageAt)}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px]', MODE_CLASS[item.mode])}>
                      {MODE_LABEL[item.mode] ?? item.mode}
                    </Badge>
                    <span className="truncate">
                      {item.channelName}
                      {item.botName ? ` · ${item.botName}` : ''}
                      {item.assignedUserName ? ` · ${item.assignedUserName}` : ''}
                    </span>
                  </span>
                  {item.lastMessage && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">{item.lastMessage}</span>
                  )}
                </span>
              </button>
            );
          })}
          {!items.length && !loading && (
            <p className="p-6 text-center text-sm text-muted-foreground">Không có hội thoại phù hợp.</p>
          )}
          {loading && (
            <p className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Đang tải…
            </p>
          )}
        </div>
      </section>

      <section className={cn('min-h-0 flex-col bg-background md:flex', selected ? 'flex' : 'hidden')}>
        {!selected ? (
          <div className="m-auto flex flex-col items-center gap-3 text-muted-foreground">
            <span className="grid size-12 place-items-center rounded-full bg-muted">
              <MessagesSquare className="size-5" />
            </span>
            <p className="text-sm">Chọn một hội thoại.</p>
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between gap-3 border-b bg-card px-5 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-2 md:hidden"
                  aria-label="Quay lại danh sách hội thoại"
                  onClick={() => setSelected(null)}
                >
                  <ArrowLeft />
                </Button>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {initials(selected.customer.displayName ?? selected.customer.externalUserId)}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">
                    {selected.customer.displayName ?? selected.customer.externalUserId}
                  </h2>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px]', MODE_CLASS[selected.mode])}>
                      {MODE_LABEL[selected.mode] ?? selected.mode}
                    </Badge>
                    {selected.channel?.name}
                    {selected.botName ? ` · ${selected.botName}` : ''}
                    {selected.assignedUserName ? ` · ${selected.assignedUserName}` : ''}
                  </p>
                </div>
              </div>
              {selected.mode === 'human' ? (
                <Button variant="outline" size="sm" disabled={busy === 'act'} onClick={() => act('release')}>
                  <Undo2 />
                  Trả lại bot
                </Button>
              ) : (
                <Button size="sm" disabled={busy === 'act'} onClick={() => act('takeover')}>
                  <Hand />
                  Tiếp quản
                </Button>
              )}
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4">
              <Button
                variant="ghost"
                size="sm"
                className="self-center text-muted-foreground"
                disabled={busy === 'older'}
                onClick={loadOlder}
              >
                {busy === 'older' ? <Loader2 className="animate-spin" /> : <ChevronUp />}
                Tải tin cũ hơn
              </Button>
              {selected.messages.map((m) => {
                const clickable = m.senderType === 'bot';
                const failed = m.status === 'failed' || m.status === 'blocked_by_policy';
                return (
                  <div
                    key={m.id}
                    className={cn(
                      'max-w-[75%] rounded-2xl border px-3.5 py-2 text-sm shadow-xs',
                      BUBBLE[m.senderType],
                      clickable && 'cursor-pointer transition-colors hover:border-primary/50',
                      failed && 'border-destructive/60',
                    )}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => setDetail(m) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setDetail(m);
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="mb-0.5 flex items-center justify-between gap-3 text-xs">
                      <span className="flex items-center gap-1 font-medium">
                        {m.senderType === 'bot' && <Bot className="size-3.5 text-primary" />}
                        {m.senderName}
                      </span>
                      <time className="text-[11px] text-muted-foreground">{formatTime(m.createdAt)}</time>
                    </div>
                    <div className="whitespace-pre-wrap">{m.content}</div>
                    <div className={cn('mt-1 text-[11px] text-muted-foreground', failed && 'text-destructive')}>
                      {STATUS_LABEL[m.status] ?? m.status}
                      {m.errorCode ? ` · Lý do: ${m.errorCode}` : ''}
                      {clickable ? ' · Bấm để xem chi tiết' : ''}
                    </div>
                  </div>
                );
              })}
            </div>

            <form className="flex gap-2 border-t bg-card px-5 py-3" onSubmit={send}>
              <Input
                aria-label="Nội dung tin gửi khách"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Gửi tin cho khách…"
              />
              <Button type="submit" disabled={!text.trim() || busy === 'send'}>
                {busy === 'send' ? <Loader2 className="animate-spin" /> : <Send />}
                Gửi
              </Button>
            </form>
          </>
        )}
      </section>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Chi tiết tin của bot</DialogTitle>
          </DialogHeader>
          {detail && (
            <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">Nguồn trả lời</dt>
              <dd>{SOURCE_LABEL[String(detail.metadata.source)] ?? String(detail.metadata.source ?? '—')}</dd>
              <dt className="text-muted-foreground">Rule</dt>
              <dd className="break-all font-mono text-xs">{String(detail.metadata.ruleId ?? '—')}</dd>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="break-all">{String(detail.metadata.model ?? '—')}</dd>
              <dt className="text-muted-foreground">Provider</dt>
              <dd>{String(detail.metadata.provider ?? '—')}</dd>
              <dt className="text-muted-foreground">Token vào / ra</dt>
              <dd className="tabular-nums">
                {String(detail.metadata.tokensIn ?? '—')} / {String(detail.metadata.tokensOut ?? '—')}
              </dd>
              <dt className="text-muted-foreground">Độ trễ</dt>
              <dd className="tabular-nums">
                {detail.metadata.latencyMs ? `${String(detail.metadata.latencyMs)} ms` : '—'}
              </dd>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
