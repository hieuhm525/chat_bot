import { FormEvent, useEffect, useState } from 'react';
import { Check, ChevronRight, Copy as CopyIcon, ExternalLink, Loader2, Menu, PlugZap, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { api } from '../api';
import { toast } from 'sonner';
import { useDialogs } from '@/components/dialogs';
import { Field, LoadError, Loading, Notices, Page, PageHeader, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Channel {
  id: string;
  provider: string;
  name: string;
  externalId: string;
  botId: string | null;
  status: string;
  config: { verifyToken?: string; messengerProfile?: MessengerProfile } | null;
  credentialExpiresAt: string | null;
}

interface MenuItem {
  title: string;
  url?: string;
}

interface MessengerProfile {
  getStarted: boolean;
  persistentMenu: MenuItem[];
}

/** Meta's limits for the persistent menu; the API enforces the same numbers. */
const MAX_MENU_ITEMS = 20;
const MENU_TITLE_MAX = 30;

interface ChannelList {
  items: Channel[];
  maxChannels: number;
}

interface BotOption {
  id: string;
  name: string;
}

const PLATFORMS = [
  { id: 'messenger', label: 'Facebook Messenger', ready: true },
  { id: 'zalo', label: 'Zalo OA', ready: false },
  { id: 'whatsapp', label: 'WhatsApp', ready: false },
  { id: 'telegram', label: 'Telegram', ready: false },
];

const PROVIDER_LABEL: Record<string, string> = { messenger: 'Messenger', zalo: 'Zalo OA', whatsapp: 'WhatsApp' };

const STATUS_LABEL: Record<string, string> = { active: 'Hoạt động', error: 'Lỗi', disabled: 'Đã tắt' };

const STATUS_CLASS: Record<string, string> = {
  active: 'bg-success/10 text-success',
  error: 'bg-destructive/10 text-destructive',
  disabled: 'bg-muted text-muted-foreground',
};

const blank = () => ({
  name: '',
  botId: '',
  pageId: '',
  accessToken: '',
  appSecret: '',
});

export function Channels() {
  const [data, setData] = useState<ChannelList | null>(null);
  const [bots, setBots] = useState<BotOption[]>([]);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const { confirm } = useDialogs();
  const [menuFor, setMenuFor] = useState<Channel | null>(null);
  // Shown only after save: the server generates the verify token, so there is nothing to paste into Meta before that.
  const [saved, setSaved] = useState<Channel | null>(null);

  const webhookUrl = `${window.location.origin}/webhooks/messenger`;

  const load = async () => {
    const [channels, botList] = await Promise.all([
      api<ChannelList>('/channels'),
      api<{ items: BotOption[] }>('/bots'),
    ]);
    setData(channels);
    setBots(botList.items);
    setForm((f) => (f.botId || !botList.items.length ? f : { ...f, botId: botList.items[0].id }));
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  const set = (key: keyof ReturnType<typeof blank>) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setFormError('');
    setNotice('');
    setSaved(null);
    setBusy(true);
    try {
      const channel = await api<Channel>('/channels', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'messenger',
          name: form.name,
          externalId: form.pageId.trim(),
          botId: form.botId,
          credentials: { accessToken: form.accessToken.trim(), appSecret: form.appSecret.trim() },
        }),
      });
      // Validate the token and subscribe the Page right away so problems show up now, not on the first message.
      const result = await api<{ ok: boolean; detail?: string }>(`/channels/${channel.id}/test`, { method: 'POST' });
      setNotice(
        result.ok
          ? `Đã thêm kênh.${result.detail ? ` ${result.detail}.` : ''} Nhắn thử vào Page để kiểm tra bot trả lời.`
          : `Đã lưu kênh nhưng chưa kết nối được: ${result.detail ?? 'Meta không trả lý do'}. Bấm Kiểm tra ở bảng kênh để thử lại.`,
      );
      setSaved(channel);
      setForm({ ...blank(), botId: form.botId });
      setAdding(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Không tạo được kênh.');
    } finally {
      setBusy(false);
    }
  };

  const test = async (c: Channel) => {
    setError('');
    setNotice(`Đang kiểm tra ${c.name}…`);
    try {
      const result = await api<{ ok: boolean; detail?: string }>(`/channels/${c.id}/test`, { method: 'POST' });
      setNotice(`${c.name}: ${result.ok ? 'OK' : 'Lỗi'}${result.detail ? ` — ${result.detail}` : ''}`);
      await load();
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Không kiểm tra được kênh.');
    }
  };

  const remove = async (c: Channel) => {
    const ok = await confirm({
      title: `Xoá kênh ${c.name}?`,
      description: 'Kênh đã có hội thoại sẽ bị tắt thay vì xoá, lịch sử hội thoại được giữ lại.',
      confirmLabel: 'Xoá kênh',
      destructive: true,
    });
    if (!ok) return;
    setError('');
    try {
      const result = await api<{ disabled: boolean }>(`/channels/${c.id}`, { method: 'DELETE' });
      setNotice(result.disabled ? 'Kênh đã được tắt, lịch sử hội thoại được giữ lại.' : 'Đã xoá kênh.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không xoá được kênh.');
    }
  };

  const botName = (botId: string | null) => bots.find((b) => b.id === botId)?.name ?? '—';

  if (error && !data) return <LoadError message={error} />;
  if (!data) return <Loading />;

  const activeCount = data.items.filter((c) => c.status !== 'disabled').length;
  const full = activeCount >= data.maxChannels;
  const addBlocked = !bots.length
    ? 'Hãy tạo AI agent trước.'
    : full
      ? 'Gói thuê đã đạt giới hạn số kênh. Tắt bớt kênh hoặc nâng gói.'
      : undefined;
  const openAdd = () => {
    setFormError('');
    setAdding(true);
  };

  return (
    <Page>
      <PageHeader
        title="Kênh"
        description="Kết nối Fanpage Messenger để AI agent tự trả lời tin nhắn khách."
        actions={
          <>
            <Badge variant="outline" className="h-7 px-3 text-sm">
              {activeCount} / {data.maxChannels} kênh theo gói (kênh đã tắt không tính)
            </Badge>
            <Button
              onClick={openAdd}
              disabled={!bots.length || full}
              title={addBlocked}
            >
              <Plus />
              Thêm kênh
            </Button>
          </>
        }
      />
      {!bots.length && (
        <Notices error="Chưa thêm được kênh: hãy tạo AI agent trước (menu AI agent), kênh cần một agent để trả lời." />
      )}
      <Notices error={error} notice={notice} />
      {saved?.config?.verifyToken && (
        <Card className="border-primary/30 bg-accent/40">
          <CardHeader>
            <CardTitle>Dán vào Meta → Messenger → Settings → Webhooks</CardTitle>
            <CardDescription>
              Bấm Verify and save trên Meta. Token này cũng copy được ở cột Verify token trong bảng kênh.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Callback URL">
              <Copy value={webhookUrl} />
            </Field>
            <Field label="Verify Token">
              <Copy value={saved.config.verifyToken} />
            </Field>
          </CardContent>
        </Card>
      )}

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên</TableHead>
              <TableHead>Nền tảng</TableHead>
              <TableHead>Page ID</TableHead>
              <TableHead>AI agent</TableHead>
              <TableHead>Verify token</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>{PROVIDER_LABEL[c.provider] ?? c.provider}</TableCell>
                <TableCell className="font-mono text-xs">{c.externalId}</TableCell>
                <TableCell>{botName(c.botId)}</TableCell>
                <TableCell>
                  {c.config?.verifyToken ? (
                    <Copy value={c.config.verifyToken} short />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className={STATUS_CLASS[c.status]}>
                    {STATUS_LABEL[c.status] ?? c.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {c.provider === 'messenger' && (
                      <Button variant="outline" size="sm" onClick={() => setMenuFor(c)}>
                        <Menu />
                        Menu
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => test(c)}>
                      <PlugZap />
                      Kiểm tra
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => remove(c)}
                      title="Xoá" aria-label="Xoá"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!data.items.length && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  <div className="space-y-3">
                    <p>Chưa có kênh nào. Kết nối Fanpage để AI agent bắt đầu trả lời khách.</p>
                    <Button size="sm" onClick={openAdd} disabled={!bots.length || full} title={addBlocked}>
                      <Plus />
                      Thêm kênh đầu tiên
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>

      <MenuDialog
        channel={menuFor}
        onClose={() => setMenuFor(null)}
        onSaved={async (message) => {
          setMenuFor(null);
          setNotice(message);
          await load();
        }}
      />

      <Dialog open={adding} onOpenChange={(v) => !v && !busy && setAdding(false)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
          <form onSubmit={submit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Thêm kênh</DialogTitle>
              <DialogDescription>
                Verify Token được tạo tự động và hiện ra ở đầu trang sau khi bấm Lưu và kết nối.
              </DialogDescription>
            </DialogHeader>
            <details className="group rounded-lg border bg-muted/30 px-4 py-3 text-sm">
              <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
                <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
                Các bước thiết lập Messenger
                <a
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 font-normal"
                >
                  Meta Developers
                  <ExternalLink className="size-3.5" />
                </a>
              </summary>
              <div className="mt-4 space-y-4">
                <ol className="space-y-3 text-sm leading-relaxed">
                  {[
                    <>
                      Vào Meta Developers, tạo App loại Business, thêm sản phẩm <b>Messenger</b>.
                    </>,
                    <>
                      App settings → Basic: copy <b>App Secret</b> vào form.
                    </>,
                    <>
                      Messenger → Settings → <b>Generate access tokens</b>: chọn Fanpage, copy <b>Page Access Token</b> và{' '}
                      <b>Page ID</b> vào form.
                    </>,
                    <>
                      Bấm <b>Lưu và kết nối</b> trước: hệ thống tạo Verify Token, kiểm tra token và tự đăng ký Page nhận tin
                      nhắn.
                    </>,
                    <>
                      Messenger → Settings → <b>Webhooks</b>: dán <b>Callback URL</b> và <b>Verify Token</b> (hiện ra sau khi
                      lưu, hoặc copy ở bảng kênh phía trên), bấm Verify and save. Nếu Page chưa nhận tin, bấm <b>Kiểm tra</b>{' '}
                      ở bảng kênh để đăng ký lại.
                    </>,
                    <>
                      Nhắn thử vào Fanpage từ một tài khoản khác. App ở chế độ Development chỉ nhận tin từ người có vai trò
                      trong App.
                    </>,
                  ].map((step, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
                        {i + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                {['localhost', '127.0.0.1'].includes(window.location.hostname) && (
                  <div className="flex gap-3 border-t pt-4 text-sm">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <div className="space-y-1">
                      <p className="font-medium">Meta không gọi được tới localhost</p>
                      <p className="text-muted-foreground">
                        Chạy tunnel (<code>cloudflared tunnel --url http://localhost:3000</code>) rồi dán vào Meta:{' '}
                        <code>https://&lt;url-tunnel&gt;/webhooks/messenger</code>.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </details>
            <Notices error={formError} />
            <div className="grid gap-5 md:grid-cols-2">
              <div className="grid content-start gap-5">
                <Field label="Nền tảng">
                  <div
                    role="radiogroup"
                    aria-label="Nền tảng"
                    className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-4"
                  >
                    {PLATFORMS.map((p) => {
                      const active = p.id === 'messenger';
                      return (
                        <button
                          key={p.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={cn(
                            'flex flex-col items-center justify-center gap-0.5 rounded-md px-2 py-2 text-center text-sm font-medium transition-colors',
                            active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                            !p.ready && 'cursor-not-allowed',
                          )}
                          disabled={!p.ready}
                        >
                          {p.label}
                          {!p.ready && <small className="text-xs font-normal">Sắp có</small>}
                        </button>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Tên kênh *" htmlFor="c-name">
                  <Input
                    id="c-name"
                    value={form.name}
                    onChange={set('name')}
                    required
                    maxLength={100}
                    placeholder="Fanpage Shop ABC"
                  />
                </Field>
                <Field label="AI agent trả lời *" htmlFor="c-bot">
                  <NativeSelect id="c-bot" className="w-full" value={form.botId} onChange={set('botId')} required>
                    <NativeSelectOption value="">— Chọn AI agent —</NativeSelectOption>
                    {bots.map((b) => (
                      <NativeSelectOption key={b.id} value={b.id}>
                        {b.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <div className="grid content-start gap-5">
                <Field label="Page ID *" htmlFor="c-page">
                  <Input
                    id="c-page"
                    value={form.pageId}
                    onChange={set('pageId')}
                    required
                    pattern="\d+"
                    title="Chỉ gồm chữ số"
                  />
                </Field>
                <Field label="Page Access Token *" htmlFor="c-token">
                  <Textarea
                    id="c-token"
                    className="font-mono text-xs"
                    value={form.accessToken}
                    onChange={set('accessToken')}
                    required
                    rows={3}
                  />
                </Field>
                <Field label="App Secret *" htmlFor="c-secret">
                  <Input
                    id="c-secret"
                    value={form.appSecret}
                    onChange={set('appSecret')}
                    required
                    type="password"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Callback URL (dán vào Meta)">
                  <Copy value={webhookUrl} />
                </Field>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
                Huỷ
              </Button>
              <Button type="submit" disabled={busy || !bots.length || full}>
                {busy ? <Loader2 className="animate-spin" /> : <PlugZap />}
                {busy ? 'Đang kết nối…' : 'Lưu và kết nối'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/** Problems per menu row, so each one shows under its own input. */
function menuItemErrors(item: MenuItem): { title?: string; url?: string } {
  const errors: { title?: string; url?: string } = {};
  const title = item.title.trim();
  if (!title) errors.title = 'Nhập tên mục.';
  else if (title.length > MENU_TITLE_MAX) errors.title = `Tối đa ${MENU_TITLE_MAX} ký tự, đang có ${title.length}.`;
  const url = item.url?.trim();
  if (url && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(url)) errors.url = 'Link phải bắt đầu bằng https:// và là địa chỉ hợp lệ.';
  return errors;
}

function MenuDialog(props: { channel: Channel | null; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const { channel } = props;
  const [getStarted, setGetStarted] = useState(false);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!channel) return;
    const profile = channel.config?.messengerProfile;
    setGetStarted(profile?.getStarted ?? false);
    setItems(profile?.persistentMenu ?? []);
    setError('');
    setSubmitted(false);
  }, [channel]);

  const errors = items.map(menuItemErrors);
  const invalid = errors.some((e) => e.title || e.url);
  const update = (index: number, patch: Partial<MenuItem>) =>
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    if (!channel) return;
    if (invalid) {
      setError(`Có ${errors.filter((x) => x.title || x.url).length} mục menu chưa hợp lệ, xem lỗi dưới từng ô.`);
      return;
    }
    setSaving(true);
    try {
      await api(`/channels/${channel.id}/messenger-profile`, {
        method: 'PUT',
        body: JSON.stringify({
          getStarted,
          persistentMenu: items.map((item) => ({
            title: item.title.trim(),
            ...(item.url?.trim() ? { url: item.url.trim() } : {}),
          })),
        }),
      });
      await props.onSaved(
        `Đã cập nhật nút Bắt đầu và menu của ${channel.name}. Messenger có thể mất vài phút mới hiện thay đổi cho khách.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không lưu được menu.');
    } finally {
      setSaving(false);
    }
  };

  const forcedGetStarted = items.length > 0;

  return (
    <Dialog open={channel !== null} onOpenChange={(open) => !open && !saving && props.onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Nút Bắt đầu & menu cố định</DialogTitle>
            <DialogDescription>
              Hiện trên Page {channel?.name}. Khách bấm mục menu không có link = gửi đúng tên mục cho bot, nên đặt tên trùng
              keyword của rule muốn trả lời.
            </DialogDescription>
          </DialogHeader>
          <Notices error={error} />

          <div className="grid gap-1.5">
            <div className="flex items-center gap-3">
              <Switch
                id="m-get-started"
                checked={getStarted || forcedGetStarted}
                disabled={forcedGetStarted}
                onCheckedChange={setGetStarted}
              />
              <Label htmlFor="m-get-started" className="font-normal">
                Hiện nút "Bắt đầu" khi khách mở Page lần đầu
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {forcedGetStarted
                ? 'Messenger bắt buộc có nút Bắt đầu khi dùng menu cố định.'
                : 'Khách bấm Bắt đầu sẽ nhận lời chào của AI agent (cấu hình ở trang AI agent).'}
            </p>
          </div>

          <div className="grid gap-3">
            <Label>Menu cố định ({items.length}/{MAX_MENU_ITEMS})</Label>
            {!items.length && <p className="text-sm text-muted-foreground">Chưa có mục nào.</p>}
            {items.map((item, index) => (
              <div key={index} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
                <Field
                  label={<span className="sr-only">Tên mục {index + 1}</span>}
                  htmlFor={`m-title-${index}`}
                  error={submitted ? errors[index].title : undefined}
                >
                  <Input
                    id={`m-title-${index}`}
                    value={item.title}
                    placeholder="Ví dụ: Bảng giá"
                    aria-invalid={submitted && Boolean(errors[index].title)}
                    onChange={(e) => update(index, { title: e.target.value })}
                  />
                </Field>
                <Field
                  label={<span className="sr-only">Link của mục {index + 1}</span>}
                  htmlFor={`m-url-${index}`}
                  error={submitted ? errors[index].url : undefined}
                  className="col-span-1 row-start-2 sm:row-start-auto"
                >
                  <Input
                    id={`m-url-${index}`}
                    value={item.url ?? ''}
                    placeholder="Link https:// (bỏ trống = gửi cho bot)"
                    aria-invalid={submitted && Boolean(errors[index].url)}
                    onChange={(e) => update(index, { url: e.target.value })}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="row-start-1 mt-0.5 sm:row-start-auto"
                  onClick={() => setItems(items.filter((_, i) => i !== index))}
                  title="Xoá mục"
                  aria-label={`Xoá mục ${index + 1}`}
                >
                  <X />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={items.length >= MAX_MENU_ITEMS}
                onClick={() => setItems([...items, { title: '' }])}
              >
                <Plus />
                Thêm mục
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose} disabled={saving}>
              Huỷ
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              Lưu & đẩy lên Messenger
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Copy({ value, short }: { value: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Trình duyệt chặn copy tự động. Hãy bôi đen đoạn mã rồi nhấn Ctrl+C.');
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code
        className={cn(
          'min-w-0 truncate rounded-md border bg-muted/60 px-2.5 py-1.5 text-xs select-all',
          short ? 'max-w-24' : 'flex-1',
        )}
        title={short ? value : undefined}
      >
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={copy}
        title={copied ? 'Đã copy' : 'Copy'}
        aria-label={copied ? 'Đã copy' : 'Copy'}
      >
        {copied ? <Check className="text-success" /> : <CopyIcon />}
      </Button>
    </div>
  );
}
