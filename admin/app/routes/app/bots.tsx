import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Plus, Settings2, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useDialogs } from '@/components/dialogs';
import { Field, LoadError, Loading, Notices, Page, PageHeader, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface Agent {
  id: string;
  name: string;
  enabled: boolean;
  greeting: string;
  fallbackMessage: string;
  handoffMessage: string;
  llmEnabled: boolean;
  systemPrompt: string;
  pauseAfterFallbacks: number;
  greetingQuickReplies: string[];
  waitMessage: string;
  ruleCount: number;
  channelCount: number;
  createdAt: string;
}

interface BotList {
  items: Agent[];
  maxBots: number;
}

export function Bots() {
  const [data, setData] = useState<BotList | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { confirm } = useDialogs();

  const load = () => api<BotList>('/bots').then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const toggle = async (bot: Agent) => {
    setError('');
    try {
      await api(`/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !bot.enabled }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không cập nhật được AI agent.');
    }
  };

  const remove = async (bot: Agent) => {
    const ok = await confirm({
      title: `Xoá AI agent ${bot.name}?`,
      description: 'Toàn bộ rule của AI agent này cũng bị xoá.',
      confirmLabel: 'Xoá',
      destructive: true,
    });
    if (!ok) return;
    setError('');
    setNotice('');
    try {
      const result = await api<{ ok: boolean }>(`/bots/${bot.id}`, { method: 'DELETE' });
      setNotice(result.ok ? 'Đã xoá AI agent.' : '');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không xoá được AI agent.');
    }
  };

  if (error && !data) return <LoadError message={error} />;
  if (!data) return <Loading />;

  const full = data.items.length >= data.maxBots;

  return (
    <Page>
      <PageHeader
        title="AI agent"
        description="Mỗi AI agent có bộ rule, lời chào và persona riêng; gắn vào một hoặc nhiều kênh."
        actions={
          <>
            <Badge variant="outline" className="h-7 px-3 text-sm">
              {data.items.length} / {data.maxBots} theo gói hiện tại
            </Badge>
            <Button
              onClick={() => setCreating(true)}
              disabled={full}
              title={full ? 'Gói hiện tại đã đạt giới hạn số AI agent.' : undefined}
            >
              <Plus />
              Thêm AI agent
            </Button>
          </>
        }
      />
      <Notices error={error} notice={notice} />

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên</TableHead>
              <TableHead>Bật</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Kênh đang gắn</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((bot) => (
              <TableRow key={bot.id}>
                <TableCell className="font-medium">
                  <Link to={`/bots/${bot.id}`} className="text-foreground">
                    {bot.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Switch checked={bot.enabled} onCheckedChange={() => toggle(bot)} aria-label="Bật AI agent" />
                </TableCell>
                <TableCell className="tabular-nums">{bot.ruleCount}</TableCell>
                <TableCell className="tabular-nums">{bot.channelCount}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`/bots/${bot.id}`} className="hover:no-underline">
                        <Settings2 />
                        Cấu hình
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => remove(bot)}
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
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  <div className="space-y-3">
                    <p>Chưa có AI agent. Tạo một agent rồi thêm rule và gắn vào kênh.</p>
                    <Button size="sm" onClick={() => setCreating(true)} disabled={full}>
                      <Plus />
                      Thêm AI agent đầu tiên
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>

      <CreateBotDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

/** Creating an agent leads straight to its detail page: the next step is always adding rules. */
function CreateBotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setName('');
      setError('');
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const bot = await api<Agent>('/bots', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      navigate(`/bots/${bot.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tạo được AI agent.');
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Thêm AI agent</DialogTitle>
            <DialogDescription>Sau khi tạo, bạn sẽ được chuyển tới trang thêm rule cho agent này.</DialogDescription>
          </DialogHeader>
          <Notices error={error} />
          <Field label="Tên" htmlFor="bot-name">
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              autoFocus
              placeholder="Ví dụ: Tư vấn bán hàng"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Huỷ
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Plus />}
              Tạo AI agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
