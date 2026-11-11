import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, FileText, Loader2, Save, Sparkles, Table2, TriangleAlert, Upload } from 'lucide-react';
import { api } from '../api';
import { findOverlaps, Overlap } from '../../../src/common/rule-overlap';
import { Notices, Page, PageHeader, Section, TableCard } from '@/components/page';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Draft {
  selected: boolean;
  name: string;
  keywords: string;
  answer: string;
  priority: number;
  /** 'new' or the id of the existing rule to overwrite. */
  action: string;
}

interface GeneratedRule {
  name: string;
  keywords: string[];
  answer: string;
}

interface ExistingRule {
  id: string;
  name: string;
  keywords: string[];
  priority: number;
}

const SAMPLE_CSV = [
  'name,keywords,answer,priority',
  'Giờ mở cửa,"giờ mở cửa; mấy giờ mở","Dạ shop mở cửa 8h-21h hằng ngày ạ.",0',
  'Phí ship,"phí ship; giao hàng","Dạ phí ship nội thành 30k, đơn từ 500k miễn phí ạ.",0',
].join('\n');

/** RFC 4180-ish: quoted cells may hold commas, quotes ("") and newlines. Also reads Excel's tab-separated paste. */
export function parseTable(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split('\n', 1)[0];
  const sep = firstLine.includes('\t') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

function rowsToDrafts(rows: string[][]): Draft[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('name') || header.includes('tên') || header.includes('answer');
  const col = (names: string[], fallback: number) => {
    const idx = header.findIndex((h) => names.includes(h));
    return hasHeader && idx >= 0 ? idx : fallback;
  };
  const iName = col(['name', 'tên'], 0);
  const iKeywords = col(['keywords', 'keyword', 'từ khoá', 'từ khóa'], 1);
  const iAnswer = col(['answer', 'câu trả lời', 'trả lời'], 2);
  const iPriority = col(['priority', 'ưu tiên'], 3);
  return (hasHeader ? rows.slice(1) : rows)
    .map((r) => ({
      selected: true,
      name: (r[iName] ?? '').trim(),
      keywords: (r[iKeywords] ?? '')
        .split(/[;,\n]/)
        .map((k) => k.trim())
        .filter(Boolean)
        .join(', '),
      answer: (r[iAnswer] ?? '').trim(),
      priority: Number(r[iPriority]) || 0,
      action: 'new',
    }))
    .filter((d) => d.name || d.answer);
}

const splitKeywords = (s: string) =>
  s
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

const isValid = (d: Draft) => Boolean(d.name.trim() && d.answer.trim() && splitKeywords(d.keywords).length);

/**
 * A draft that overlaps an existing rule starts unselected and pointed at that rule, keeping its
 * priority, so ticking it updates the old rule instead of creating a competing one.
 */
function applyOverlapDefaults(drafts: Draft[], existing: ExistingRule[]): Draft[] {
  return drafts.map((d) => {
    const [top] = findOverlaps({ name: d.name, keywords: splitKeywords(d.keywords) }, existing);
    if (!top) return d;
    const old = existing.find((r) => r.id === top.id)!;
    return { ...d, selected: false, action: top.id, priority: old.priority };
  });
}

export function RuleImport() {
  const { botId = '' } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'ai' | 'csv'>('ai');
  const [doc, setDoc] = useState('');
  const [table, setTable] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [existing, setExisting] = useState<ExistingRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<ExistingRule[]>(`/bots/${botId}/rules`)
      .then(setExisting)
      .catch((e) => setError(`Không tải được rule hiện có để kiểm tra trùng: ${e.message}`));
  }, [botId]);

  // Recomputed on every edit, so the warning follows the keywords the owner actually saves.
  const checks = useMemo(
    () =>
      drafts.map((d, i) => {
        const keywords = splitKeywords(d.keywords);
        const withExisting = findOverlaps({ name: d.name, keywords }, existing);
        const earlier = drafts
          .slice(0, i)
          .map((other, j) => ({ id: String(j), name: other.name, keywords: splitKeywords(other.keywords), selected: other.selected }))
          .filter((o) => o.selected);
        const withBatch = findOverlaps({ name: d.name, keywords }, earlier).map((o) => Number(o.id) + 1);
        const action = withExisting.some((o) => o.id === d.action) ? d.action : 'new';
        return { withExisting, withBatch, action };
      }),
    [drafts, existing],
  );

  const readFile = async (e: ChangeEvent<HTMLInputElement>, set: (v: string) => void) => {
    const file = e.target.files?.[0];
    if (file) set(await file.text());
    e.target.value = '';
  };

  const generate = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api<{ items: GeneratedRule[] }>(`/bots/${botId}/rules/generate`, {
        method: 'POST',
        body: JSON.stringify({ text: doc }),
      });
      setDrafts(
        applyOverlapDefaults(
          res.items.map((r) => ({
            selected: true,
            name: r.name,
            keywords: r.keywords.join(', '),
            answer: r.answer,
            priority: 0,
            action: 'new',
          })),
          existing,
        ),
      );
      if (!res.items.length) setError('Không tìm thấy câu hỏi-đáp nào trong tài liệu.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI không tạo được nháp, thử lại hoặc rút gọn tài liệu.');
    } finally {
      setBusy(false);
    }
  };

  const loadTable = () => {
    setError('');
    const parsed = applyOverlapDefaults(rowsToDrafts(parseTable(table)), existing);
    setDrafts(parsed);
    if (!parsed.length) setError('Không đọc được dòng nào. Kiểm tra lại cột name, keywords, answer.');
  };

  const downloadSample = () => {
    const url = URL.createObjectURL(new Blob(['﻿' + SAMPLE_CSV], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rule-mau.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const patch = (i: number, change: Partial<Draft>) =>
    setDrafts((list) => list.map((d, j) => (j === i ? { ...d, ...change } : d)));

  const chosen = drafts.map((d, i) => ({ ...d, action: checks[i]?.action ?? 'new' })).filter((d) => d.selected);
  const invalid = chosen.filter((d) => !isValid(d)).length;
  const replacing = chosen.filter((d) => d.action !== 'new');
  const doubleReplace = new Set(replacing.map((d) => d.action)).size !== replacing.length;
  const overlapCount = checks.filter((c) => c.withExisting.length).length;

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      await api(`/bots/${botId}/rules/bulk`, {
        method: 'POST',
        body: JSON.stringify({
          items: chosen.map((d) => ({
            ...(d.action !== 'new' ? { replaceId: d.action } : {}),
            name: d.name.trim(),
            keywords: splitKeywords(d.keywords),
            answer: d.answer.trim(),
            priority: Number(d.priority) || 0,
          })),
        }),
      });
      navigate(`/bots/${botId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không lưu được rule.');
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-7xl">
      <PageHeader
        back={
          <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1 text-muted-foreground">
            <ArrowLeft className="size-4" />
            Quay lại AI agent
          </Link>
        }
        title="Nhập rule hàng loạt"
        description="Tạo nhiều rule một lúc từ tài liệu (AI tự tách) hoặc từ bảng CSV / Excel. Bạn xem và sửa trước khi lưu."
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'ai' | 'csv')}>
        <TabsList>
          <TabsTrigger value="ai">
            <Sparkles />
            Từ tài liệu (AI)
          </TabsTrigger>
          <TabsTrigger value="csv">
            <Table2 />
            Từ CSV / Excel
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ai">
          <Card className="py-5">
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Dán FAQ, chính sách đổi trả, giao hàng… AI sẽ tách thành từng rule kèm keyword.
              </p>
              <Textarea
                aria-label="Nội dung tài liệu"
                rows={12}
                maxLength={30000}
                value={doc}
                placeholder="Ví dụ: Shop mở cửa 8h-21h hằng ngày. Phí ship nội thành 30k, đơn từ 500k miễn phí…"
                onChange={(e) => setDoc(e.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <FilePick label="Chọn file .txt / .md" accept=".txt,.md,text/plain,text/markdown" onChange={(e) => readFile(e, setDoc)} />
                <span className="text-xs text-muted-foreground tabular-nums">{doc.length.toLocaleString('vi-VN')} / 30.000 ký tự</span>
              </div>
              <Button onClick={generate} disabled={busy || !doc.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {busy ? 'AI đang đọc tài liệu…' : 'Tạo nháp bằng AI'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="csv">
          <Card className="py-5">
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Cột: <code>name</code>, <code>keywords</code> (phân cách bằng <code>;</code>), <code>answer</code>,{' '}
                <code>priority</code> (tuỳ chọn). Có thể dán thẳng các ô copy từ Excel / Google Sheets.
              </p>
              <Textarea
                aria-label="Dữ liệu CSV"
                rows={10}
                className="font-mono text-xs"
                value={table}
                onChange={(e) => setTable(e.target.value)}
                placeholder={SAMPLE_CSV}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <FilePick label="Chọn file .csv" accept=".csv,text/csv" onChange={(e) => readFile(e, setTable)} />
                <Button type="button" variant="ghost" size="sm" onClick={downloadSample}>
                  <Download />
                  Tải file mẫu
                </Button>
              </div>
              <Button onClick={loadTable} disabled={!table.trim()}>
                <FileText />
                Đọc dữ liệu
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Notices error={error} />

      {drafts.length > 0 && (
        <Section title={`Xem trước (${drafts.length} rule)`}>
          {overlapCount > 0 && (
            <Alert className="border-warning/50 bg-warning/10">
              <TriangleAlert />
              <AlertDescription className="text-foreground/80">
                {overlapCount} rule trùng chủ đề với rule đang có nên đã được bỏ chọn. Nếu muốn dùng nội dung mới, tick
                chọn và để "Ghi đè" để cập nhật rule cũ thay vì tạo thêm một rule cạnh tranh.
              </AlertDescription>
            </Alert>
          )}
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Chọn tất cả"
                      checked={chosen.length === drafts.length ? true : chosen.length ? 'indeterminate' : false}
                      onCheckedChange={(v) => setDrafts((list) => list.map((d) => ({ ...d, selected: v === true })))}
                    />
                  </TableHead>
                  <TableHead>Tên</TableHead>
                  <TableHead>Keyword (phân cách dấu phẩy)</TableHead>
                  <TableHead>Câu trả lời</TableHead>
                  <TableHead>Ưu tiên</TableHead>
                  <TableHead>Trùng</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.map((d, i) => (
                  <TableRow key={i} className={cn('align-top', !d.selected && 'opacity-50')}>
                    <TableCell className="align-top">
                      <Checkbox
                        aria-label={`Chọn dòng ${i + 1}`}
                        checked={d.selected}
                        onCheckedChange={(v) => patch(i, { selected: v === true })}
                      />
                    </TableCell>
                    <TableCell className="min-w-40 align-top">
                      <Input aria-label={`Tên rule dòng ${i + 1}`} value={d.name} onChange={(e) => patch(i, { name: e.target.value })} />
                      {d.selected && !isValid(d) && (
                        <Badge variant="destructive" className="mt-2">
                          Thiếu tên/keyword/trả lời
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="min-w-48 align-top">
                      <Textarea
                        aria-label={`Keyword dòng ${i + 1}`}
                        rows={2}
                        value={d.keywords}
                        onChange={(e) => patch(i, { keywords: e.target.value })}
                      />
                    </TableCell>
                    <TableCell className="min-w-64 align-top">
                      <Textarea
                        aria-label={`Câu trả lời dòng ${i + 1}`}
                        rows={3}
                        value={d.answer}
                        onChange={(e) => patch(i, { answer: e.target.value })}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <Input
                        aria-label={`Ưu tiên dòng ${i + 1}`}
                        type="number"
                        className="w-20"
                        value={d.priority}
                        onChange={(e) => patch(i, { priority: Number(e.target.value) })}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <OverlapCell
                        overlaps={checks[i].withExisting}
                        batchRows={checks[i].withBatch}
                        action={checks[i].action}
                        onAction={(action) => {
                          const old = existing.find((r) => r.id === action);
                          patch(i, old ? { action, priority: old.priority } : { action });
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
          <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur">
            <Button onClick={save} disabled={busy || !chosen.length || invalid > 0 || chosen.length > 200 || doubleReplace}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
              {busy
                ? 'Đang lưu…'
                : `Lưu: ${chosen.length - replacing.length} tạo mới` + (replacing.length ? `, ${replacing.length} ghi đè` : '')}
            </Button>
            {chosen.length > 200 && <span className="text-sm text-destructive">Tối đa 200 rule mỗi lần.</span>}
            {doubleReplace && (
              <span className="text-sm text-destructive">Có hai dòng cùng ghi đè một rule cũ, hãy chọn lại.</span>
            )}
          </div>
        </Section>
      )}
    </Page>
  );
}

function FilePick(props: { label: string; accept: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <label className="cursor-pointer">
        <Upload />
        {props.label}
        <input type="file" className="sr-only" accept={props.accept} onChange={props.onChange} />
      </label>
    </Button>
  );
}

function OverlapCell(props: {
  overlaps: Overlap[];
  batchRows: number[];
  action: string;
  onAction: (action: string) => void;
}) {
  const { overlaps, batchRows, action, onAction } = props;
  if (!overlaps.length && !batchRows.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex min-w-44 flex-col gap-1.5">
      {overlaps.map((o) => (
        <Badge key={o.id} variant="secondary" className="h-auto bg-warning/15 text-left whitespace-normal text-foreground">
          {o.name}
          {o.shared.length ? `: ${o.shared.join(', ')}` : ' (cùng tên)'}
        </Badge>
      ))}
      {batchRows.length > 0 && (
        <Badge variant="secondary" className="h-auto bg-warning/15 text-left whitespace-normal text-foreground">
          Trùng dòng {batchRows.join(', ')} trong danh sách này
        </Badge>
      )}
      {overlaps.length > 0 && (
        <NativeSelect
          size="sm"
          className="w-full"
          value={action}
          onChange={(e) => onAction(e.target.value)}
          aria-label="Cách xử lý rule trùng"
        >
          {overlaps.map((o) => (
            <NativeSelectOption key={o.id} value={o.id}>
              Ghi đè «{o.name}»
            </NativeSelectOption>
          ))}
          <NativeSelectOption value="new">Vẫn tạo rule mới</NativeSelectOption>
        </NativeSelect>
      )}
    </div>
  );
}
