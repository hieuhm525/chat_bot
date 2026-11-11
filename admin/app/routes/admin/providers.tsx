import { FormEvent, useEffect, useState } from 'react';
import { ExternalLink, FlaskConical, Loader2, Pencil, PlugZap, Plus, ScanSearch, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useDialogs } from '@/components/dialogs';
import { Field, Notices, Page, PageHeader, TableCard } from '@/components/page';
import { Badge } from '@/components/ui/badge';
import { IconAction } from '@/components/icon-action';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  model: string;
  priority: number;
  enabled: boolean;
  hasKey: boolean;
  keyHint: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
}

interface Usage {
  provider: string;
  answers: number;
  tokensIn: number;
  tokensOut: number;
  tokensToday: number;
  /** Real answers in the last 7 days that recorded a latency; p50/p95 are null when there are none. */
  latencyCount: number;
  latencyP50: number | null;
  latencyP95: number | null;
}

interface TestResult {
  reply: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
  rateLimit?: { limitTokens?: number; remainingTokens?: number; limitRequests?: number; remainingRequests?: number };
  credits?: { usage: number | null; limit: number | null; remaining: number | null };
}

interface TestResponse {
  ok: boolean;
  detail: string;
  result?: TestResult;
}

interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  keyUrl?: string;
  /** Where to check remaining quota when the API does not report it. */
  quotaUrl?: string;
}

const PRESETS: Preset[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    quotaUrl: 'https://aistudio.google.com/usage',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
  },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    quotaUrl: 'https://platform.openai.com/usage',
  },
  { id: 'ollama', label: 'Ollama (máy local)', baseUrl: 'http://localhost:11434/v1' },
];

/** Ids that are clearly not chat models (embeddings, image/video/audio generation, realtime). */
const NON_CHAT = /embed|imagen|veo|tts|aqa|audio|live|whisper|dall-e|moderation|image|robotics|lyria|transcribe/i;

type Probe = { ok: boolean; detail: string; latencyMs?: number } | 'pending';

/** Rough speed bands for a chat reply, so admins read a label instead of comparing raw ms. */
const speedLabel = (ms: number) => (ms < 1500 ? 'nhanh' : ms < 3500 ? 'trung bình' : 'chậm');

const presetFor = (baseUrl: string) => PRESETS.find((p) => p.baseUrl === baseUrl.replace(/\/$/, ''))?.id ?? 'custom';

const empty = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  priority: 0,
  enabled: true,
};

const fmt = (n: number | undefined | null) => (n == null ? '—' : n.toLocaleString('vi-VN'));

export function Providers() {
  const [items, setItems] = useState<Provider[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [form, setForm] = useState(empty);
  const [preset, setPreset] = useState('custom');
  const [models, setModels] = useState<string[]>([]);
  const [hidden, setHidden] = useState(0);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [showFailed, setShowFailed] = useState(false);
  const [busy, setBusy] = useState<'' | 'scan' | 'test' | 'probe'>('');
  const [check, setCheck] = useState<TestResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { confirm } = useDialogs();

  const load = () =>
    Promise.all([api<Provider[]>('/llm-providers'), api<Usage[]>('/llm-providers/usage')])
      .then(([list, used]) => {
        setItems(list);
        setUsage(used);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const clearModels = () => {
    setModels([]);
    setHidden(0);
    setProbes({});
    setShowFailed(false);
  };

  const resetForm = () => {
    setForm(empty);
    setPreset('custom');
    clearModels();
    setCheck(null);
    setFormError('');
  };

  const openCreate = () => {
    resetForm();
    setOpen(true);
  };

  const choosePreset = (id: string) => {
    setPreset(id);
    clearModels();
    setCheck(null);
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setForm((f) => ({
      ...f,
      baseUrl: p.baseUrl,
      name: !f.name || PRESETS.some((x) => x.id === f.name) ? p.id : f.name,
    }));
  };

  // The stored key is reused when editing and the key field is left blank.
  const draft = () => ({
    ...(form.id ? { id: form.id } : {}),
    baseUrl: form.baseUrl,
    model: form.model,
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
  });

  /** Lists the provider's chat models, then calls each one to keep only working models, fastest first. */
  const scan = async () => {
    setFormError('');
    setBusy('scan');
    let chat: string[];
    try {
      const res = await api<{ models: string[] }>('/llm-providers/models', {
        method: 'POST',
        body: JSON.stringify(draft()),
      });
      chat = res.models.filter((m) => !NON_CHAT.test(m));
      setProbes({});
      setModels(chat);
      setHidden(res.models.length - chat.length);
    } catch (err) {
      clearModels();
      setFormError(`Quét model lỗi: ${err instanceof Error ? err.message : err}`);
      setBusy('');
      return;
    }
    if (!chat.length) {
      setFormError('Provider không trả về model chat nào.');
      setBusy('');
      return;
    }
    await probeAll(chat);
  };

  /** Calls each model once (3 at a time) so the list only offers models this key can use. */
  const probeAll = async (models: string[]) => {
    setBusy('probe');
    setShowFailed(false);
    const queue = [...models];
    const results: Record<string, Probe> = Object.fromEntries(models.map((m) => [m, 'pending' as const]));
    setProbes({ ...results });
    const worker = async () => {
      for (let model = queue.shift(); model; model = queue.shift()) {
        try {
          const res = await api<TestResponse>('/llm-providers/test', {
            method: 'POST',
            body: JSON.stringify({ ...draft(), model }),
          });
          results[model] = { ok: res.ok, detail: res.detail, latencyMs: res.result?.latencyMs };
        } catch (err) {
          results[model] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
        setProbes({ ...results });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // Fastest working models first, so the default pick is the quickest one.
    const latency = (m: string) => {
      const r = results[m];
      return r !== 'pending' && r.ok ? (r.latencyMs ?? Infinity) : Infinity;
    };
    const sorted = [...models].sort((a, b) => latency(a) - latency(b));
    setModels(sorted);
    const working = sorted.filter((m) => (results[m] as { ok: boolean }).ok);
    if (!working.length) setFormError('Không model nào trả lời được. Kiểm tra lại key hoặc hạn mức.');
    else if (!working.includes(form.model)) setForm((f) => ({ ...f, model: working[0] }));
    setBusy('');
  };

  const testDraft = async () => {
    setFormError('');
    setBusy('test');
    setCheck(null);
    try {
      setCheck(await api<TestResponse>('/llm-providers/test', { method: 'POST', body: JSON.stringify(draft()) }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Không kiểm tra được model.');
    } finally {
      setBusy('');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    setNotice('');
    setSaving(true);
    const body: Record<string, unknown> = {
      name: form.name,
      baseUrl: form.baseUrl,
      model: form.model,
      priority: Number(form.priority),
      enabled: form.enabled,
    };
    if (form.apiKey) body.apiKey = form.apiKey;
    try {
      if (form.id) await api(`/llm-providers/${form.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/llm-providers', { method: 'POST', body: JSON.stringify(body) });
      setOpen(false);
      resetForm();
      setNotice(form.id ? 'Đã lưu provider.' : 'Đã thêm provider.');
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Không lưu được provider.');
    } finally {
      setSaving(false);
    }
  };

  const edit = (provider: Provider) => {
    setForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: '',
      priority: provider.priority,
      enabled: provider.enabled,
    });
    setPreset(presetFor(provider.baseUrl));
    clearModels();
    setCheck(null);
    setFormError('');
    setOpen(true);
  };

  const toggle = async (provider: Provider) => {
    setError('');
    try {
      await api(`/llm-providers/${provider.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !provider.enabled }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không cập nhật được provider.');
    }
  };

  const test = async (provider: Provider) => {
    setError('');
    setNotice('');
    try {
      const res = await api<TestResponse>(`/llm-providers/${provider.id}/test`, { method: 'POST' });
      const r = res.result;
      setNotice(
        `${provider.name}: ${res.ok ? 'OK' : 'Lỗi'} — ${res.detail}` +
          (r ? ` (${r.latencyMs} ms, ${fmt((r.tokensIn ?? 0) + (r.tokensOut ?? 0))} token)` : ''),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không kiểm tra được provider.');
    }
  };

  const remove = async (provider: Provider) => {
    const ok = await confirm({ title: `Xoá provider ${provider.name}?`, confirmLabel: 'Xoá', destructive: true });
    if (!ok) return;
    setError('');
    try {
      await api(`/llm-providers/${provider.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không xoá được provider.');
    }
  };

  const current = PRESETS.find((p) => p.id === preset);
  const probed = Object.keys(probes).length > 0;
  const done = Object.values(probes).filter((p) => p !== 'pending');
  const okCount = done.filter((p) => p.ok).length;
  const isOk = (m: string) => {
    const p = probes[m];
    return p && p !== 'pending' && p.ok;
  };
  const visible = probed && busy !== 'probe' && !showFailed ? models.filter(isOk) : models;
  // Fastest working model from the last scan; models are already sorted, so it is the first ok one with a latency.
  const fastest =
    busy === 'probe'
      ? undefined
      : models.find((m) => {
          const p = probes[m];
          return p && p !== 'pending' && p.ok && p.latencyMs != null;
        });
  const fastestMs = fastest ? (probes[fastest] as { latencyMs: number }).latencyMs : 0;
  const mark = (m: string) => {
    const p = probes[m];
    if (!p) return m;
    if (p === 'pending') return `… ${m}`;
    if (!p.ok) return `✗ ${m}`;
    if (p.latencyMs == null) return `✓ ${m}`;
    return `✓ ${m} — ${fmt(p.latencyMs)} ms (${speedLabel(p.latencyMs)})${m === fastest ? ' ★ nên chọn' : ''}`;
  };
  const usageOf = (name: string) => usage.find((u) => u.provider === name);

  return (
    <Page className="max-w-7xl">
      <PageHeader
        title="AI provider"
        description="Thử theo ưu tiên từ cao xuống; provider lỗi thì chuyển sang provider kế tiếp."
        actions={
          <Button onClick={openCreate}>
            <Plus />
            Thêm provider
          </Button>
        }
      />
      <Notices error={error} notice={notice} />

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Ưu tiên</TableHead>
              <TableHead>Tên</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Key</TableHead>
              <TableHead title="Tổng token bot đã dùng với provider này (vào + ra)">Đã dùng</TableHead>
              <TableHead title="Thời gian chờ provider trả lời khách thật, 7 ngày gần nhất. Trung vị = một nửa số câu nhanh hơn mức này; p95 = 95% số câu nhanh hơn mức này.">
                Độ trễ (7 ngày)
              </TableHead>
              <TableHead>Bật</TableHead>
              <TableHead>Kiểm tra</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((p) => {
              const u = usageOf(p.name);
              return (
                <TableRow key={p.id}>
                  <TableCell className="tabular-nums">{p.priority}</TableCell>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="max-w-56 truncate text-xs text-muted-foreground">{p.baseUrl}</div>
                  </TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs">{p.model}</TableCell>
                  <TableCell className="font-mono text-xs">{p.hasKey ? `••••${p.keyHint ?? ''}` : '—'}</TableCell>
                  <TableCell>
                    {u ? (
                      <>
                        <div className="tabular-nums">{fmt(u.tokensIn + u.tokensOut)} token</div>
                        <div className="text-xs text-muted-foreground">
                          hôm nay {fmt(u.tokensToday)} · {fmt(u.answers)} câu trả lời
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {u?.latencyP50 != null ? (
                      <>
                        <div className="tabular-nums">
                          {fmt(u.latencyP50)} ms{' '}
                          <span className="text-xs text-muted-foreground">({speedLabel(u.latencyP50)})</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          p95 {fmt(u.latencyP95)} ms · {fmt(u.latencyCount)} câu
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">chưa có</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch checked={p.enabled} onCheckedChange={() => toggle(p)} aria-label={`Bật provider ${p.name}`} />
                  </TableCell>
                  <TableCell>
                    {p.lastCheckAt ? (
                      p.lastCheckOk ? (
                        <Badge variant="secondary" className="bg-success/10 text-success">
                          OK
                        </Badge>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="secondary" className="cursor-help bg-destructive/10 text-destructive">
                              Lỗi
                            </Badge>
                          </TooltipTrigger>
                          {p.lastError && <TooltipContent className="max-w-xs">{p.lastError}</TooltipContent>}
                        </Tooltip>
                      )
                    ) : (
                      <span className="text-muted-foreground">chưa</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <IconAction onClick={() => edit(p)} label={`Sửa provider ${p.name}`} tooltip="Sửa">
                        <Pencil />
                      </IconAction>
                      <IconAction onClick={() => test(p)} label={`Kiểm tra provider ${p.name}`} tooltip="Kiểm tra">
                        <PlugZap />
                      </IconAction>
                      <IconAction
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => remove(p)}
                        label={`Xoá provider ${p.name}`} tooltip="Xoá"
                      >
                        <Trash2 />
                      </IconAction>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                  <div className="space-y-3">
                    <p>Chưa có provider. Thêm key Gemini / OpenRouter / Groq để bật trả lời bằng AI.</p>
                    <Button size="sm" onClick={openCreate}>
                      <Plus />
                      Thêm provider đầu tiên
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableCard>

      <Dialog open={open} onOpenChange={(v) => !v && !saving && busy === '' && setOpen(false)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
          <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{form.id ? `Sửa provider: ${form.name}` : 'Thêm provider'}</DialogTitle>
            <DialogDescription>Key được mã hoá và không bao giờ hiển thị lại.</DialogDescription>
          </DialogHeader>
          <Notices error={formError} />
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Nhà cung cấp" htmlFor="p-preset">
              <NativeSelect id="p-preset" value={preset} onChange={(e) => choosePreset(e.target.value)}>
                {PRESETS.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.label}
                  </NativeSelectOption>
                ))}
                <NativeSelectOption value="custom">Tuỳ chỉnh (OpenAI-compatible)</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field label="Tên" htmlFor="p-name">
              <Input
                id="p-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                maxLength={100}
              />
            </Field>
            <Field label="Base URL" htmlFor="p-url">
              <Input
                id="p-url"
                value={form.baseUrl}
                onChange={(e) => {
                  setForm({ ...form, baseUrl: e.target.value });
                  setPreset(presetFor(e.target.value));
                }}
                required
                readOnly={preset !== 'custom'}
                className={preset !== 'custom' ? 'bg-muted/50 text-muted-foreground' : undefined}
                placeholder="https://openrouter.ai/api/v1"
              />
            </Field>
            <Field
              label={
                <>
                  API key
                  {current?.keyUrl && (
                    <a
                      href={current.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 text-xs font-normal"
                    >
                      Lấy key
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </>
              }
              htmlFor="p-key"
            >
              <Input
                id="p-key"
                value={form.apiKey}
                onChange={(e) => {
                  setForm({ ...form, apiKey: e.target.value });
                  clearModels();
                  setCheck(null);
                }}
                type="password"
                autoComplete="new-password"
                placeholder={form.id ? 'Để trống = giữ key cũ' : preset === 'ollama' ? 'Không cần key' : 'Dán API key'}
              />
            </Field>

            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="p-model">Model</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="min-w-0 flex-1">
                  {visible.length ? (
                    <NativeSelect
                      id="p-model"
                      className="font-mono text-xs"
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value })}
                      required
                    >
                      {visible.map((m) => {
                        const p = probes[m];
                        return (
                          <NativeSelectOption
                            key={m}
                            value={m}
                            title={p && p !== 'pending' && !p.ok ? p.detail : undefined}
                          >
                            {mark(m)}
                          </NativeSelectOption>
                        );
                      })}
                    </NativeSelect>
                  ) : (
                    <Input
                      id="p-model"
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value })}
                      required
                      placeholder="Bấm “Quét model” (gọi thử từng model, ~10 token/model) hoặc gõ tên"
                    />
                  )}
                </div>
                <Button type="button" variant="outline" onClick={scan} disabled={!form.baseUrl || busy !== ''}>
                  {busy === 'scan' || busy === 'probe' ? <Loader2 className="animate-spin" /> : <ScanSearch />}
                  {busy === 'scan'
                    ? 'Đang quét…'
                    : busy === 'probe'
                      ? `Đang thử ${done.length}/${models.length}…`
                      : 'Quét model'}
                </Button>
              </div>
              {fastest && (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary" className="bg-success/10 text-success">
                    Gợi ý
                  </Badge>
                  <span>
                    Nên chọn <span className="font-mono text-xs">{fastest}</span>: nhanh nhất ({fmt(fastestMs)} ms).
                  </span>
                  {form.model !== fastest && (
                    <Button type="button" variant="link" className="h-auto p-0" onClick={() => setForm({ ...form, model: fastest })}>
                      Dùng model này
                    </Button>
                  )}
                </p>
              )}
              {models.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {models.length} model chat{hidden ? ` (đã ẩn ${hidden} model embedding/ảnh/âm thanh)` : ''}.
                  {probed && busy !== 'probe' && (
                    <>
                      {' '}
                      Dùng được {okCount}/{models.length}.{' '}
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => setShowFailed(!showFailed)}
                      >
                        {showFailed ? 'Chỉ hiện model dùng được' : 'Hiện cả model lỗi'}
                      </button>
                    </>
                  )}
                  {probed && busy !== 'probe' && okCount > 0 && ' Đã xếp model nhanh nhất lên đầu (đo bằng 1 câu hỏi ngắn, câu trả lời thật sẽ lâu hơn).'}
                </p>
              )}
            </div>

            <Field label="Ưu tiên" htmlFor="p-priority">
              <Input
                id="p-priority"
                type="number"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              />
            </Field>
            <div className="flex items-center gap-3 self-end pb-2">
              <Switch id="p-enabled" checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
              <Label htmlFor="p-enabled" className="font-normal">
                Bật provider
              </Label>
            </div>

            {check && (
              <div className="md:col-span-2">
                <CheckResult check={check} quotaUrl={current?.quotaUrl} />
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="sm:mr-auto"
              onClick={testDraft}
              disabled={!form.baseUrl || !form.model || busy !== ''}
            >
              {busy === 'test' ? <Loader2 className="animate-spin" /> : <FlaskConical />}
              {busy === 'test' ? 'Đang kiểm tra…' : 'Test kết nối'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving || busy !== ''}>
              Huỷ
            </Button>
            <Button type="submit" disabled={saving || busy !== ''}>
              {saving && <Loader2 className="animate-spin" />}
              {form.id ? 'Lưu provider' : 'Thêm provider'}
            </Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function CheckResult({ check, quotaUrl }: { check: TestResponse; quotaUrl?: string }) {
  const r = check.result;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {check.ok ? (
          <Badge variant="secondary" className="bg-success/10 text-success">
            Kết nối OK
          </Badge>
        ) : (
          <Badge variant="destructive">Lỗi</Badge>
        )}
        {!check.ok && <span className="text-destructive">{check.detail}</span>}
      </div>
      {r && (
        <dl className="grid grid-cols-[minmax(140px,220px)_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Model trả lời</dt>
          <dd className="font-mono text-xs">{r.model}</dd>
          <dt className="text-muted-foreground">Độ trễ</dt>
          <dd className="tabular-nums">{fmt(r.latencyMs)} ms</dd>
          <dt className="text-muted-foreground">Token lần test này</dt>
          <dd className="tabular-nums">
            {fmt(r.tokensIn)} vào + {fmt(r.tokensOut)} ra
          </dd>
          {r.rateLimit?.remainingTokens != null && (
            <>
              <dt className="text-muted-foreground">Token còn lại (phút này)</dt>
              <dd className="tabular-nums">
                {fmt(r.rateLimit.remainingTokens)} / {fmt(r.rateLimit.limitTokens)}
              </dd>
            </>
          )}
          {r.rateLimit?.remainingRequests != null && (
            <>
              <dt className="text-muted-foreground">Request còn lại</dt>
              <dd className="tabular-nums">
                {fmt(r.rateLimit.remainingRequests)} / {fmt(r.rateLimit.limitRequests)}
              </dd>
            </>
          )}
          {r.credits && (
            <>
              <dt className="text-muted-foreground">Credit đã dùng</dt>
              <dd className="tabular-nums">${r.credits.usage ?? 0}</dd>
              <dt className="text-muted-foreground">Credit còn lại</dt>
              <dd className="tabular-nums">
                {r.credits.remaining == null ? 'không giới hạn' : `$${r.credits.remaining} / $${r.credits.limit}`}
              </dd>
            </>
          )}
          {!r.rateLimit && !r.credits && (
            <>
              <dt className="text-muted-foreground">Hạn mức còn lại</dt>
              <dd className="text-muted-foreground">
                Provider không trả về qua API.{' '}
                {quotaUrl && (
                  <a href={quotaUrl} target="_blank" rel="noreferrer">
                    Xem trên trang của provider
                  </a>
                )}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
