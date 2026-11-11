import { FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FileUp, Pencil, Save, Trash2 } from 'lucide-react';
import { Agent } from './bot';
import { api } from '../api';
import { scrollToId, useDialogs } from '@/components/dialogs';
import { Field, LoadError, Loading, Notices, Page, PageHeader, Section, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface Rule {
  id: string;
  name: string;
  keywords: string[];
  matchMode: string;
  priority: number;
  answer: string;
  enabled: boolean;
}

const emptyRule = { name: '', keywords: '', matchMode: 'contains', priority: 0, answer: '', enabled: true };

export function BotDetail() {
  const { botId = '' } = useParams();
  const [bot, setBot] = useState<Agent | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [form, setForm] = useState(emptyRule);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { confirm } = useDialogs();

  const load = async () => {
    const [b, r] = await Promise.all([api<Agent>(`/bots/${botId}`), api<Rule[]>(`/bots/${botId}/rules`)]);
    setBot(b);
    setRules(r);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [botId]);

  const saveBot = async (e: FormEvent) => {
    e.preventDefault();
    if (!bot) return;
    setError('');
    setNotice('');
    try {
      await api(`/bots/${botId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: bot.name,
          enabled: bot.enabled,
          greeting: bot.greeting,
          fallbackMessage: bot.fallbackMessage,
          handoffMessage: bot.handoffMessage,
          llmEnabled: bot.llmEnabled,
          systemPrompt: bot.systemPrompt,
          pauseAfterFallbacks: Number(bot.pauseAfterFallbacks),
        }),
      });
      setNotice('Đã lưu cấu hình.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi lưu cấu hình');
    }
  };

  const saveRule = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = JSON.stringify({
      name: form.name,
      keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean),
      matchMode: form.matchMode,
      priority: Number(form.priority),
      answer: form.answer,
      enabled: form.enabled,
    });
    try {
      if (editing) await api(`/bots/${botId}/rules/${editing}`, { method: 'PATCH', body });
      else await api(`/bots/${botId}/rules`, { method: 'POST', body });
      setForm(emptyRule);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi lưu rule');
    }
  };

  const edit = (rule: Rule) => {
    setEditing(rule.id);
    setForm({ ...rule, keywords: rule.keywords.join(', ') });
    scrollToId('rule-form');
  };

  const remove = async (rule: Rule) => {
    const ok = await confirm({ title: `Xoá rule ${rule.name}?`, confirmLabel: 'Xoá', destructive: true });
    if (!ok) return;
    setError('');
    try {
      await api(`/bots/${botId}/rules/${rule.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi xoá rule');
    }
  };

  const toggle = async (rule: Rule) => {
    setError('');
    try {
      await api(`/bots/${botId}/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi cập nhật rule');
    }
  };

  if (error && !bot) return <LoadError message={error} />;
  if (!bot) return <Loading />;

  return (
    <Page>
      <PageHeader
        back={
          <Link to="/bots" className="inline-flex items-center gap-1 text-muted-foreground">
            <ArrowLeft className="size-4" />
            AI agent
          </Link>
        }
        title={bot.name}
        actions={
          <Badge variant={bot.enabled ? 'default' : 'secondary'}>{bot.enabled ? 'Đang bật' : 'Đang tắt'}</Badge>
        }
      />
      <Notices error={error} notice={notice} />

      <form onSubmit={saveBot}>
        <Card>
          <CardHeader>
            <CardTitle>Cấu hình</CardTitle>
            <CardDescription>Lời chào, câu fallback và persona dùng khi trả lời khách.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2">
            <Field label="Tên" htmlFor="b-name">
              <Input id="b-name" value={bot.name} onChange={(e) => setBot({ ...bot, name: e.target.value })} maxLength={100} />
            </Field>
            <Field label="Lời chào" htmlFor="b-greeting">
              <Input id="b-greeting" value={bot.greeting} onChange={(e) => setBot({ ...bot, greeting: e.target.value })} />
            </Field>
            <Field label="Câu fallback" htmlFor="b-fallback">
              <Input
                id="b-fallback"
                value={bot.fallbackMessage}
                onChange={(e) => setBot({ ...bot, fallbackMessage: e.target.value })}
              />
            </Field>
            <Field label="Câu chuyển người" htmlFor="b-handoff">
              <Input
                id="b-handoff"
                value={bot.handoffMessage}
                onChange={(e) => setBot({ ...bot, handoffMessage: e.target.value })}
              />
            </Field>
            <Field label="Fallback trước khi chuyển người" htmlFor="b-pause">
              <Input
                id="b-pause"
                type="number"
                min={1}
                value={bot.pauseAfterFallbacks}
                onChange={(e) => setBot({ ...bot, pauseAfterFallbacks: Number(e.target.value) })}
              />
            </Field>
            <div className="grid content-end gap-3">
              <SwitchRow
                id="b-enabled"
                label="Bật AI agent"
                checked={bot.enabled}
                onChange={(v) => setBot({ ...bot, enabled: v })}
              />
              <SwitchRow
                id="b-llm"
                label="Dùng LLM khi rule không khớp"
                checked={bot.llmEnabled}
                onChange={(v) => setBot({ ...bot, llmEnabled: v })}
              />
            </div>
            <Field
              label="Persona"
              htmlFor="b-prompt"
              hint={`${bot.systemPrompt.length.toLocaleString('vi-VN')} / 4.000 ký tự`}
              className="md:col-span-2"
            >
              <Textarea
                id="b-prompt"
                value={bot.systemPrompt}
                maxLength={4000}
                rows={6}
                placeholder="Ví dụ: Bạn là nhân viên tư vấn của shop ABC, giọng thân thiện…"
                onChange={(e) => setBot({ ...bot, systemPrompt: e.target.value })}
              />
            </Field>
            <div className="md:col-span-2">
              <Button type="submit">
                <Save />
                Lưu cấu hình
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>

      <Section
        title="Rule"
        description="Rule khớp keyword được ưu tiên trước LLM. Ưu tiên cao hơn được xét trước."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to={`/bots/${botId}/import`} className="hover:no-underline">
              <FileUp />
              Nhập hàng loạt (AI / CSV)
            </Link>
          </Button>
        }
      >
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Ưu tiên</TableHead>
                <TableHead>Tên</TableHead>
                <TableHead>Keyword</TableHead>
                <TableHead>Bật</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id} data-state={editing === rule.id ? 'selected' : undefined}>
                  <TableCell className="tabular-nums">{rule.priority}</TableCell>
                  <TableCell className="font-medium">{rule.name}</TableCell>
                  <TableCell>
                    <div className="flex max-w-md flex-wrap gap-1">
                      {rule.keywords.map((k) => (
                        <Badge key={k} variant="secondary" className="font-normal">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch checked={rule.enabled} onCheckedChange={() => toggle(rule)} aria-label="Bật rule" />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => edit(rule)} title="Sửa" aria-label="Sửa">
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => remove(rule)}
                        title="Xoá" aria-label="Xoá"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!rules.length && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    Chưa có rule.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableCard>
      </Section>

      <form id="rule-form" onSubmit={saveRule} className="scroll-mt-6">
        <Card>
          <CardHeader>
            <CardTitle>{editing ? 'Sửa rule' : 'Thêm rule'}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-[1fr_1fr_8rem]">
            <Field label="Tên" htmlFor="r-name">
              <Input id="r-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label="Keyword" htmlFor="r-keywords" hint="Phân cách bằng dấu phẩy.">
              <Input
                id="r-keywords"
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                required
              />
            </Field>
            <Field label="Ưu tiên" htmlFor="r-priority">
              <Input
                id="r-priority"
                type="number"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              />
            </Field>
            <Field label="Câu trả lời" htmlFor="r-answer" className="md:col-span-3">
              <Textarea
                id="r-answer"
                rows={4}
                value={form.answer}
                onChange={(e) => setForm({ ...form, answer: e.target.value })}
                required
              />
            </Field>
            <div className="flex flex-wrap items-center gap-4 md:col-span-3">
              <SwitchRow id="r-enabled" label="Bật" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
              <div className="ml-auto flex gap-2">
                {editing && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      setForm(emptyRule);
                    }}
                  >
                    Huỷ
                  </Button>
                )}
                <Button type="submit">{editing ? 'Lưu rule' : 'Thêm rule'}</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </form>
    </Page>
  );
}

function SwitchRow(props: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
      <Label htmlFor={props.id} className="font-normal">
        {props.label}
      </Label>
    </div>
  );
}
