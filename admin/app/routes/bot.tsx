import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Settings2, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useDialogs } from '@/components/dialogs';
import { Field, LoadError, Loading, Notices, Page, PageHeader, Section, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { confirm } = useDialogs();

  const load = () => api<BotList>('/bots').then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      await api('/bots', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      setNotice('Đã tạo AI agent.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi tạo AI agent');
    }
  };

  const toggle = async (bot: Agent) => {
    setError('');
    try {
      await api(`/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !bot.enabled }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi cập nhật AI agent');
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
      setError(err instanceof Error ? err.message : 'Lỗi xoá AI agent');
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
          <Badge variant="outline" className="h-7 px-3 text-sm">
            {data.items.length} / {data.maxBots} theo gói thuê
          </Badge>
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
                  Chưa có AI agent.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>

      <Section title="Thêm AI agent">
        <Card className="py-5">
          <CardContent className="space-y-3">
            <form className="grid items-end gap-4 sm:grid-cols-[1fr_auto]" onSubmit={create}>
              <Field label="Tên" htmlFor="bot-name">
                <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
              </Field>
              <Button type="submit" disabled={full}>
                <Plus />
                Thêm AI agent
              </Button>
            </form>
            {full && <p className="text-sm text-muted-foreground">Gói thuê đã đạt giới hạn số AI agent.</p>}
          </CardContent>
        </Card>
      </Section>
    </Page>
  );
}
