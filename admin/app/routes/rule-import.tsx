import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { findOverlaps, Overlap } from '../../../src/common/rule-overlap';

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
      setError(err instanceof Error ? err.message : 'Lỗi tạo nháp');
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
      setError(err instanceof Error ? err.message : 'Lỗi lưu rule');
      setBusy(false);
    }
  };

  return (
    <div className="pad">
      <p className="muted">
        <Link to={`/bots/${botId}`}>← Quay lại AI agent</Link>
      </p>
      <h1>Nhập rule hàng loạt</h1>

      <div className="actions tabs">
        <button className={tab === 'ai' ? '' : 'ghost'} onClick={() => setTab('ai')}>
          Từ tài liệu (AI)
        </button>
        <button className={tab === 'csv' ? '' : 'ghost'} onClick={() => setTab('csv')}>
          Từ CSV / Excel
        </button>
      </div>

      {tab === 'ai' ? (
        <div className="import-source">
          <p className="muted">
            Dán FAQ, chính sách đổi trả, giao hàng… AI sẽ tách thành từng rule kèm keyword. Bạn xem và sửa trước khi lưu.
          </p>
          <textarea
            rows={12}
            maxLength={30000}
            value={doc}
            placeholder="Ví dụ: Shop mở cửa 8h-21h hằng ngày. Phí ship nội thành 30k, đơn từ 500k miễn phí…"
            onChange={(e) => setDoc(e.target.value)}
          />
          <div className="actions">
            <label className="file">
              Hoặc chọn file .txt / .md
              <input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(e) => readFile(e, setDoc)} />
            </label>
            <span className="muted">{doc.length.toLocaleString()} / 30.000 ký tự</span>
          </div>
          <div>
            <button onClick={generate} disabled={busy || !doc.trim()}>
              {busy ? 'AI đang đọc tài liệu…' : 'Tạo nháp bằng AI'}
            </button>
          </div>
        </div>
      ) : (
        <div className="import-source">
          <p className="muted">
            Cột: <code>name</code>, <code>keywords</code> (phân cách bằng <code>;</code>), <code>answer</code>,{' '}
            <code>priority</code> (tuỳ chọn). Có thể dán thẳng các ô copy từ Excel / Google Sheets.
          </p>
          <textarea rows={10} value={table} onChange={(e) => setTable(e.target.value)} placeholder={SAMPLE_CSV} />
          <div className="actions">
            <label className="file">
              Hoặc chọn file .csv
              <input type="file" accept=".csv,text/csv" onChange={(e) => readFile(e, setTable)} />
            </label>
            <button type="button" className="link" onClick={downloadSample}>
              Tải file mẫu
            </button>
          </div>
          <div>
            <button onClick={loadTable} disabled={!table.trim()}>
              Đọc dữ liệu
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {drafts.length > 0 && (
        <>
          <h2>Xem trước ({drafts.length} rule)</h2>
          {overlapCount > 0 && (
            <p className="warn">
              {overlapCount} rule trùng chủ đề với rule đang có nên đã được bỏ chọn. Nếu muốn dùng nội dung mới, tick
              chọn và để "Ghi đè" để cập nhật rule cũ thay vì tạo thêm một rule cạnh tranh.
            </p>
          )}
          <table className="import-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Chọn tất cả"
                    checked={chosen.length === drafts.length}
                    onChange={(e) => setDrafts((list) => list.map((d) => ({ ...d, selected: e.target.checked })))}
                  />
                </th>
                <th>Tên</th>
                <th>Keyword (phân cách dấu phẩy)</th>
                <th>Câu trả lời</th>
                <th>Ưu tiên</th>
                <th>Trùng</th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d, i) => (
                <tr key={i} className={d.selected ? '' : 'off'}>
                  <td>
                    <input type="checkbox" checked={d.selected} onChange={(e) => patch(i, { selected: e.target.checked })} />
                  </td>
                  <td>
                    <input value={d.name} onChange={(e) => patch(i, { name: e.target.value })} />
                    {d.selected && !isValid(d) && <span className="badge error">Thiếu tên/keyword/trả lời</span>}
                  </td>
                  <td>
                    <textarea rows={2} value={d.keywords} onChange={(e) => patch(i, { keywords: e.target.value })} />
                  </td>
                  <td>
                    <textarea rows={3} value={d.answer} onChange={(e) => patch(i, { answer: e.target.value })} />
                  </td>
                  <td>
                    <input
                      type="number"
                      className="narrow"
                      value={d.priority}
                      onChange={(e) => patch(i, { priority: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <OverlapCell
                      overlaps={checks[i].withExisting}
                      batchRows={checks[i].withBatch}
                      action={checks[i].action}
                      onAction={(action) => {
                        const old = existing.find((r) => r.id === action);
                        patch(i, old ? { action, priority: old.priority } : { action });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="actions">
            <button onClick={save} disabled={busy || !chosen.length || invalid > 0 || chosen.length > 200 || doubleReplace}>
              {busy
                ? 'Đang lưu…'
                : `Lưu: ${chosen.length - replacing.length} tạo mới` + (replacing.length ? `, ${replacing.length} ghi đè` : '')}
            </button>
            {chosen.length > 200 && <span className="error">Tối đa 200 rule mỗi lần.</span>}
            {doubleReplace && <span className="error">Có hai dòng cùng ghi đè một rule cũ, hãy chọn lại.</span>}
          </p>
        </>
      )}
    </div>
  );
}

function OverlapCell(props: {
  overlaps: Overlap[];
  batchRows: number[];
  action: string;
  onAction: (action: string) => void;
}) {
  const { overlaps, batchRows, action, onAction } = props;
  if (!overlaps.length && !batchRows.length) return <span className="muted">—</span>;
  return (
    <div className="overlap">
      {overlaps.map((o) => (
        <span key={o.id} className="badge warn">
          {o.name}
          {o.shared.length ? `: ${o.shared.join(', ')}` : ' (cùng tên)'}
        </span>
      ))}
      {batchRows.length > 0 && <span className="badge warn">Trùng dòng {batchRows.join(', ')} trong danh sách này</span>}
      {overlaps.length > 0 && (
        <select value={action} onChange={(e) => onAction(e.target.value)} aria-label="Cách xử lý rule trùng">
          {overlaps.map((o) => (
            <option key={o.id} value={o.id}>
              Ghi đè «{o.name}»
            </option>
          ))}
          <option value="new">Vẫn tạo rule mới</option>
        </select>
      )}
    </div>
  );
}
