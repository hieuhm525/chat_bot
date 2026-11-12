import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileUp,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Save,
  Sparkles,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Agent } from './bots';
import { api } from '../../api';
import { normalizeText } from '../../../../src/shared/normalize-text';
import { useDialogs } from '@/components/dialogs';
import { Field, LoadError, Loading, Notices, Page, PageHeader, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { IconAction } from '@/components/icon-action';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { MAX_QUICK_REPLIES, QUICK_REPLY_TITLE_MAX, parseQuickReplies } from '@/lib/quick-replies';

interface Rule {
  id: string;
  name: string;
  keywords: string[];
  matchMode: string;
  priority: number;
  answer: string;
  quickReplies: string[];
  useAi: boolean;
  enabled: boolean;
}

const QUICK_REPLY_HINT = `Nút bấm hiện dưới tin nhắn (chỉ Messenger). Phân cách bằng dấu phẩy, tối đa ${MAX_QUICK_REPLIES} nút, mỗi nút ≤ ${QUICK_REPLY_TITLE_MAX} ký tự. Khách bấm nút = gửi đúng chữ trên nút, nên đặt trùng keyword của rule muốn trả lời.`;

type StatusFilter = 'all' | 'on' | 'off';

const PAGE_SIZE = 20;
const MAX_KEYWORDS_SHOWN = 4;

export function BotDetail() {
  const { botId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'config' ? 'config' : 'rules';
  const [bot, setBot] = useState<Agent | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    const [b, r] = await Promise.all([api<Agent>(`/bots/${botId}`), api<Rule[]>(`/bots/${botId}/rules`)]);
    setBot(b);
    setRules(r);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [botId]);

  const report = (message: { error?: string; notice?: string }) => {
    setError(message.error ?? '');
    setNotice(message.notice ?? '');
  };

  const changeTab = (value: string) => {
    report({});
    setParams(value === 'config' ? { tab: 'config' } : {}, { replace: true });
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

      <Tabs value={tab} onValueChange={changeTab} className="gap-6">
        <TabsList>
          <TabsTrigger value="rules">Rule ({rules.length})</TabsTrigger>
          <TabsTrigger value="config">Cấu hình</TabsTrigger>
        </TabsList>
        <Notices error={error} notice={notice} />
        <TabsContent value="rules">
          <RulesTab botId={botId} rules={rules} reload={load} report={report} />
        </TabsContent>
        <TabsContent value="config">
          <ConfigTab bot={bot} setBot={setBot} reload={load} report={report} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

type Report = (message: { error?: string; notice?: string }) => void;

function ConfigTab(props: {
  bot: Agent;
  setBot: (bot: Agent) => void;
  reload: () => Promise<void>;
  report: Report;
}) {
  const { bot, setBot, report } = props;
  const [saving, setSaving] = useState(false);
  const [greetingReplies, setGreetingReplies] = useState(bot.greetingQuickReplies.join(', '));
  const greetingParsed = parseQuickReplies(greetingReplies);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    report({});
    if (greetingParsed.error) {
      report({ error: `Nút dưới lời chào: ${greetingParsed.error}.` });
      return;
    }
    setSaving(true);
    try {
      await api(`/bots/${bot.id}`, {
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
          greetingQuickReplies: greetingParsed.items,
          waitMessage: bot.waitMessage,
        }),
      });
      await props.reload();
      report({ notice: 'Đã lưu cấu hình.' });
    } catch (err) {
      report({ error: err instanceof Error ? err.message : 'Không lưu được cấu hình AI agent.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>Cấu hình</CardTitle>
          <CardDescription>Lời chào, câu trả lời khi không hiểu và hướng dẫn cho AI khi trả lời khách.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-2">
          <Field label="Tên" htmlFor="b-name">
            <Input id="b-name" value={bot.name} onChange={(e) => setBot({ ...bot, name: e.target.value })} maxLength={100} />
          </Field>
          <Field label="Lời chào" htmlFor="b-greeting">
            <Textarea id="b-greeting" value={bot.greeting} onChange={(e) => setBot({ ...bot, greeting: e.target.value })} />
          </Field>
          <Field label="Nút bấm dưới lời chào" htmlFor="b-greeting-qr" hint={QUICK_REPLY_HINT} error={greetingParsed.error}>
            <Input
              id="b-greeting-qr"
              value={greetingReplies}
              placeholder="Xem giá, Phí ship, Gặp nhân viên"
              aria-invalid={Boolean(greetingParsed.error)}
              onChange={(e) => setGreetingReplies(e.target.value)}
            />
          </Field>
          <Field
            label="Tin nhắn chờ khi AI trả lời chậm"
            htmlFor="b-wait"
            hint="Gửi trước nếu AI cần hơn 6 giây để trả lời. Để trống để tắt."
          >
            <Textarea
              id="b-wait"
              value={bot.waitMessage}
              maxLength={1000}
              onChange={(e) => setBot({ ...bot, waitMessage: e.target.value })}
            />
          </Field>
          <Field label="Câu trả lời khi không hiểu" htmlFor="b-fallback">
            <Textarea
              id="b-fallback"
              value={bot.fallbackMessage}
              onChange={(e) => setBot({ ...bot, fallbackMessage: e.target.value })}
            />
          </Field>
          <Field label="Câu chuyển người" htmlFor="b-handoff">
            <Textarea
              id="b-handoff"
              value={bot.handoffMessage}
              onChange={(e) => setBot({ ...bot, handoffMessage: e.target.value })}
            />
          </Field>
          <Field label="Số lần không hiểu trước khi chuyển người" htmlFor="b-pause">
            <Input
              id="b-pause"
              type="number"
              min={1}
              value={bot.pauseAfterFallbacks}
              onChange={(e) => setBot({ ...bot, pauseAfterFallbacks: Number(e.target.value) })}
            />
          </Field>
          <div className="grid content-end gap-3">
            <SwitchRow id="b-enabled" label="Bật AI agent" checked={bot.enabled} onChange={(v) => setBot({ ...bot, enabled: v })} />
            <SwitchRow
              id="b-llm"
              label="Dùng AI trả lời khi không có rule khớp"
              checked={bot.llmEnabled}
              onChange={(v) => setBot({ ...bot, llmEnabled: v })}
            />
          </div>
          <Field
            label="Tính cách & hướng dẫn cho AI"
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
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {saving ? 'Đang lưu…' : 'Lưu cấu hình'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

function RulesTab(props: { botId: string; rules: Rule[]; reload: () => Promise<void>; report: Report }) {
  const { botId, rules, reload, report } = props;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // undefined = dialog closed, null = adding a new rule.
  const [dialogRule, setDialogRule] = useState<Rule | null | undefined>(undefined);
  const { confirm } = useDialogs();

  // Index once per load so typing in the search box does not re-normalise every answer.
  const index = useMemo(
    () => new Map(rules.map((r) => [r.id, normalizeText([r.name, r.keywords.join(' '), r.answer].join(' '))])),
    [rules],
  );

  const filtered = useMemo(() => {
    const q = normalizeText(query);
    return rules.filter(
      (r) =>
        (status === 'all' || r.enabled === (status === 'on')) && (!q || (index.get(r.id) ?? '').includes(q)),
    );
  }, [rules, index, query, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // Drop selections for rules that no longer exist (deleted here or elsewhere).
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rules.map((r) => r.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rules]);

  const setFilter = (next: { query?: string; status?: StatusFilter }) => {
    if (next.query !== undefined) setQuery(next.query);
    if (next.status !== undefined) setStatus(next.status);
    setPage(1);
  };

  const pageSelected = visible.filter((r) => selected.has(r.id)).length;
  const headerChecked = pageSelected === 0 ? false : pageSelected === visible.length ? true : 'indeterminate';

  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (headerChecked === true) visible.forEach((r) => next.delete(r.id));
      else visible.forEach((r) => next.add(r.id));
      return next;
    });
  };

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (action: () => Promise<string>, failure: string) => {
    report({});
    setBusy(true);
    try {
      const message = await action();
      await reload();
      report({ notice: message });
    } catch (err) {
      report({ error: err instanceof Error ? `${failure}: ${err.message}` : failure });
    } finally {
      setBusy(false);
    }
  };

  const partial = (done: number, asked: number) =>
    done < asked ? ` (${asked - done} rule không còn tồn tại, có thể đã bị xoá ở tab khác)` : '';

  const bulkToggle = (enabled: boolean) => {
    const ids = [...selected];
    return run(async () => {
      const res = await api<{ updated: number }>(`/bots/${botId}/rules/bulk-update`, {
        method: 'POST',
        body: JSON.stringify({ ids, enabled }),
      });
      return `Đã ${enabled ? 'bật' : 'tắt'} ${res.updated}/${ids.length} rule.${partial(res.updated, ids.length)}`;
    }, `Không ${enabled ? 'bật' : 'tắt'} được ${ids.length} rule đã chọn`);
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    const ok = await confirm({
      title: `Xoá ${ids.length} rule đã chọn?`,
      description: 'Không thể hoàn tác.',
      confirmLabel: 'Xoá',
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      const res = await api<{ deleted: number }>(`/bots/${botId}/rules/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      setSelected(new Set());
      return `Đã xoá ${res.deleted}/${ids.length} rule.${partial(res.deleted, ids.length)}`;
    }, `Không xoá được ${ids.length} rule đã chọn`);
  };

  const toggle = (rule: Rule) =>
    run(async () => {
      await api(`/bots/${botId}/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) });
      return `Đã ${rule.enabled ? 'tắt' : 'bật'} rule "${rule.name}".`;
    }, `Không ${rule.enabled ? 'tắt' : 'bật'} được rule "${rule.name}"`);

  const remove = async (rule: Rule) => {
    const ok = await confirm({ title: `Xoá rule ${rule.name}?`, confirmLabel: 'Xoá', destructive: true });
    if (!ok) return;
    await run(async () => {
      await api(`/bots/${botId}/rules/${rule.id}`, { method: 'DELETE' });
      return `Đã xoá rule "${rule.name}".`;
    }, `Không xoá được rule "${rule.name}"`);
  };

  const filtering = query.trim() !== '' || status !== 'all';
  const from = filtered.length ? (current - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(current * PAGE_SIZE, filtered.length);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Rule khớp keyword được ưu tiên trước AI. Ưu tiên cao hơn được xét trước.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link to={`/bots/${botId}/import`} className="hover:no-underline">
              <FileUp />
              Nhập hàng loạt (AI / CSV)
            </Link>
          </Button>
          <Button onClick={() => setDialogRule(null)}>
            <Plus />
            Thêm rule
          </Button>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-1.5 text-sm">
          <span className="font-medium">Đã chọn {selected.size} rule</span>
          <div className="flex flex-wrap gap-1 sm:ml-auto">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => bulkToggle(true)}>
              <Power />
              Bật
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => bulkToggle(false)}>
              <PowerOff />
              Tắt
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={bulkDelete}
            >
              <Trash2 />
              Xoá
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(new Set())}>
              <X />
              Bỏ chọn
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setFilter({ query: e.target.value })}
              placeholder="Tìm theo tên, keyword, câu trả lời…"
              aria-label="Tìm rule"
              className="pl-8"
            />
          </div>
          <NativeSelect
            value={status}
            onChange={(e) => setFilter({ status: e.target.value as StatusFilter })}
            aria-label="Lọc trạng thái"
          >
            <NativeSelectOption value="all">Tất cả</NativeSelectOption>
            <NativeSelectOption value="on">Đang bật</NativeSelectOption>
            <NativeSelectOption value="off">Đang tắt</NativeSelectOption>
          </NativeSelect>
        </div>
      )}

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={headerChecked}
                  onCheckedChange={togglePage}
                  disabled={!visible.length}
                  aria-label="Chọn tất cả rule trong trang này"
                />
              </TableHead>
              <TableHead className="hidden w-20 sm:table-cell">Ưu tiên</TableHead>
              <TableHead>Tên</TableHead>
              <TableHead className="hidden lg:table-cell">Keyword</TableHead>
              <TableHead>Bật</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((rule) => {
              const extra = rule.keywords.slice(MAX_KEYWORDS_SHOWN);
              return (
                <TableRow key={rule.id} data-state={selected.has(rule.id) ? 'selected' : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(rule.id)}
                      onCheckedChange={() => toggleOne(rule.id)}
                      aria-label={`Chọn rule ${rule.name}`}
                    />
                  </TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">{rule.priority}</TableCell>
                  <TableCell className="max-w-36 sm:max-w-72">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium">{rule.name}</span>
                      {rule.useAi && (
                        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-xs" title="AI trả lời dựa trên nội dung rule">
                          <Sparkles className="size-3" />
                          AI
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground" title={rule.answer}>
                      {rule.answer}
                    </div>
                    {/* Narrow screens: priority and keyword columns fold into this line. */}
                    <div className="truncate text-xs text-muted-foreground lg:hidden">
                      <span className="sm:hidden">Ưu tiên {rule.priority} · </span>
                      {rule.keywords.length} keyword
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="flex max-w-md flex-wrap gap-1">
                      {rule.keywords.slice(0, MAX_KEYWORDS_SHOWN).map((k) => (
                        <Badge key={k} variant="secondary" className="font-normal">
                          {k}
                        </Badge>
                      ))}
                      {extra.length > 0 && (
                        <Badge variant="outline" className="cursor-help font-normal" title={extra.join(', ')}>
                          +{extra.length}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={rule.enabled}
                      disabled={busy}
                      onCheckedChange={() => toggle(rule)}
                      aria-label={`Bật rule ${rule.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <IconAction onClick={() => setDialogRule(rule)} label={`Sửa rule ${rule.name}`} tooltip="Sửa">
                        <Pencil />
                      </IconAction>
                      <IconAction
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => remove(rule)}
                        disabled={busy}
                        label={`Xoá rule ${rule.name}`} tooltip="Xoá"
                      >
                        <Trash2 />
                      </IconAction>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!visible.length && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {rules.length ? (
                    <div className="space-y-3">
                      <p>Không có rule nào khớp bộ lọc.</p>
                      <Button variant="outline" size="sm" onClick={() => setFilter({ query: '', status: 'all' })}>
                        Xoá bộ lọc
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p>Chưa có rule. Thêm từng rule hoặc nhập hàng loạt từ tài liệu / CSV.</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button size="sm" onClick={() => setDialogRule(null)}>
                          <Plus />
                          Thêm rule
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/bots/${botId}/import`} className="hover:no-underline">
                            <FileUp />
                            Nhập hàng loạt
                          </Link>
                        </Button>
                      </div>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            Hiển thị {from}–{to} / {filtered.length} rule
            {filtering && ` (lọc từ ${rules.length})`}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
                aria-label="Trang trước"
              >
                <ChevronLeft />
              </Button>
              <span className="px-2 tabular-nums">
                Trang {current} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={current >= pageCount}
                onClick={() => setPage(current + 1)}
                aria-label="Trang sau"
              >
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      )}

      <RuleDialog
        botId={botId}
        rule={dialogRule}
        onClose={() => setDialogRule(undefined)}
        onSaved={async (message) => {
          setDialogRule(undefined);
          await reload();
          report({ notice: message });
        }}
      />
    </section>
  );
}

const emptyForm = { name: '', keywords: '', priority: 0, answer: '', quickReplies: '', useAi: false, enabled: true };

function RuleDialog(props: {
  botId: string;
  /** undefined = closed, null = new rule. */
  rule: Rule | null | undefined;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const { rule } = props;
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (rule === undefined) return;
    setError('');
    setForm(
      rule ? { ...rule, keywords: rule.keywords.join(', '), quickReplies: (rule.quickReplies ?? []).join(', ') } : emptyForm,
    );
  }, [rule]);

  const quickReplies = parseQuickReplies(form.quickReplies);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const keywords = form.keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
    const problems = [
      ...(keywords.length ? [] : ['Keyword: cần ít nhất 1 keyword, phân cách bằng dấu phẩy.']),
      ...(quickReplies.error ? [`Nút trả lời nhanh: ${quickReplies.error}.`] : []),
    ];
    if (problems.length) {
      setError(problems.join(' '));
      return;
    }
    setSaving(true);
    const body = JSON.stringify({
      name: form.name.trim(),
      keywords,
      priority: Number(form.priority),
      answer: form.answer,
      quickReplies: quickReplies.items,
      useAi: form.useAi,
      enabled: form.enabled,
    });
    try {
      if (rule) await api(`/bots/${props.botId}/rules/${rule.id}`, { method: 'PATCH', body });
      else await api(`/bots/${props.botId}/rules`, { method: 'POST', body });
      await props.onSaved(rule ? `Đã lưu rule "${form.name.trim()}".` : `Đã thêm rule "${form.name.trim()}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không lưu được rule.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={rule !== undefined} onOpenChange={(open) => !open && !saving && props.onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{rule ? 'Sửa rule' : 'Thêm rule'}</DialogTitle>
            <DialogDescription>Khi tin nhắn của khách chứa keyword, bot trả lời đúng câu trả lời bên dưới.</DialogDescription>
          </DialogHeader>
          <Notices error={error} />
          <div className="grid gap-5 sm:grid-cols-[1fr_8rem]">
            <Field label="Tên" htmlFor="r-name">
              <Input
                id="r-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                autoFocus
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
            <Field label="Keyword" htmlFor="r-keywords" hint="Các cách khách hay hỏi, phân cách bằng dấu phẩy; tin nhắn chứa 1 cụm là khớp. Mỗi cụm ≥2 từ, ví dụ: phí ship, tiền ship, ship bao nhiêu. Không cần gõ thêm bản không dấu hay viết tắt." className="sm:col-span-2">
              <Textarea
                id="r-keywords"
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                required
              />
            </Field>
            <Field label="Câu trả lời" htmlFor="r-answer" className="sm:col-span-2">
              <Textarea
                id="r-answer"
                rows={5}
                value={form.answer}
                onChange={(e) => setForm({ ...form, answer: e.target.value })}
                required
              />
            </Field>
            <Field
              label="Nút trả lời nhanh"
              htmlFor="r-quick-replies"
              hint={QUICK_REPLY_HINT}
              error={quickReplies.error}
              className="sm:col-span-2"
            >
              <Input
                id="r-quick-replies"
                value={form.quickReplies}
                placeholder="Bảng giá, Đặt hàng"
                aria-invalid={Boolean(quickReplies.error)}
                onChange={(e) => setForm({ ...form, quickReplies: e.target.value })}
              />
            </Field>
            <div className="grid gap-1.5 sm:col-span-2">
              <SwitchRow
                id="r-use-ai"
                label="AI trả lời dựa trên nội dung này"
                checked={form.useAi}
                onChange={(v) => setForm({ ...form, useAi: v })}
              />
              <p className="text-xs text-muted-foreground">
                Bật cho câu trả lời cần tính theo thông tin của khách (chọn size theo chiều cao/cân nặng, tính phí ship theo
                tỉnh…): AI đọc nội dung này rồi trả lời đúng trường hợp. Tắt thì gửi nguyên văn, nhanh và không tốn token. Cần bật
                "Dùng AI" trong tab Cấu hình; AI lỗi thì vẫn gửi nguyên văn.
              </p>
            </div>
            <SwitchRow id="r-enabled" label="Bật rule" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose} disabled={saving}>
              Huỷ
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {rule ? 'Lưu rule' : 'Thêm rule'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
