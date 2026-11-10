import { FormEvent, UIEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api';

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
    setError('');
    loadDetail(id).catch((e) => setError(e.message));
  };

  const act = async (path: string) => {
    if (!selected) return;
    await api(`/conversations/${selected.id}/${path}`, { method: 'POST' });
    await Promise.all([loadDetail(selected.id), loadPage(undefined, filters)]);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected || !text.trim()) return;
    await api(`/conversations/${selected.id}/messages`, { method: 'POST', body: JSON.stringify({ content: text }) });
    setText('');
    await loadDetail(selected.id);
  };

  const loadOlder = async () => {
    if (!selected?.messages.length) return;
    const older = await api<Message[]>(
      `/conversations/${selected.id}/messages?before=${encodeURIComponent(selected.messages[0].id)}`,
    );
    setSelected({ ...selected, messages: [...older, ...selected.messages] });
  };

  const onScroll = (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (nextCursor && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      loadPage(nextCursor, filters);
    }
  };

  return (
    <div className="split">
      <section className="list" onScroll={onScroll}>
        <h1>Hội thoại</h1>
        <form className="filters" onSubmit={applyFilters}>
          <input
            className="search"
            placeholder="Tìm tên khách, ID khách, nội dung tin…"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <select value={filters.channelId} onChange={(e) => setFilters({ ...filters, channelId: e.target.value })}>
            <option value="">Mọi kênh</option>
            {options.channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === 'disabled' ? ' (đã tắt)' : ''}
              </option>
            ))}
          </select>
          <select value={filters.botId} onChange={(e) => setFilters({ ...filters, botId: e.target.value })}>
            <option value="">Mọi AI agent</option>
            {options.bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select value={filters.mode} onChange={(e) => setFilters({ ...filters, mode: e.target.value })}>
            <option value="">Mọi chế độ</option>
            <option value="bot">Bot</option>
            <option value="human">Người thật</option>
            <option value="off">Đã tắt</option>
          </select>
          <select
            value={filters.assignedUserId}
            onChange={(e) => setFilters({ ...filters, assignedUserId: e.target.value })}
          >
            <option value="">Mọi người tiếp quản</option>
            {options.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.username}
              </option>
            ))}
          </select>
          <label className="date">
            Từ ngày
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </label>
          <label className="date">
            Đến ngày
            <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </label>
          <button type="submit">Lọc</button>
        </form>

        {error && <p className="error">{error}</p>}
        {items.map((item) => (
          <button
            key={item.id}
            className={`row ${selected?.id === item.id ? 'active' : ''}`}
            onClick={() => open(item.id)}
          >
            <div>
              <strong>{item.customerName ?? item.externalUserId}</strong>
              <span className="muted"> · {item.channelName}</span>
            </div>
            <small className="muted">
              {MODE_LABEL[item.mode] ?? item.mode}
              {item.botName ? ` · ${item.botName}` : ''}
              {item.assignedUserName ? ` · ${item.assignedUserName}` : ''} · {formatTime(item.lastMessageAt)}
            </small>
            {item.lastMessage && <small className="excerpt">{item.lastMessage}</small>}
          </button>
        ))}
        {!items.length && !loading && <p className="muted">Không có hội thoại phù hợp.</p>}
        {loading && <p className="muted">Đang tải…</p>}
      </section>

      <section className="thread">
        {!selected ? (
          <p className="muted">Chọn một hội thoại.</p>
        ) : (
          <>
            <header className="thread-head">
              <div>
                <h2>{selected.customer.displayName ?? selected.customer.externalUserId}</h2>
                <small className="muted">
                  {selected.channel?.name} · {MODE_LABEL[selected.mode] ?? selected.mode}
                  {selected.botName ? ` · ${selected.botName}` : ''}
                  {selected.assignedUserName ? ` · ${selected.assignedUserName}` : ''}
                </small>
              </div>
              <div className="actions">
                {selected.mode === 'human' ? (
                  <button onClick={() => act('release')}>Trả lại bot</button>
                ) : (
                  <button onClick={() => act('takeover')}>Tiếp quản</button>
                )}
              </div>
            </header>

            <button className="link" onClick={loadOlder}>
              Tải tin cũ hơn
            </button>

            <div className="messages">
              {selected.messages.map((m) => (
                <div
                  key={m.id}
                  className={`msg ${m.senderType} ${m.direction}${m.senderType === 'bot' ? ' clickable' : ''}`}
                  role={m.senderType === 'bot' ? 'button' : undefined}
                  tabIndex={m.senderType === 'bot' ? 0 : undefined}
                  onClick={m.senderType === 'bot' ? () => setDetail(m) : undefined}
                  onKeyDown={
                    m.senderType === 'bot'
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setDetail(m);
                          }
                        }
                      : undefined
                  }
                >
                  <div className="msg-head">
                    <strong>{m.senderName}</strong>
                    <time>{formatTime(m.createdAt)}</time>
                  </div>
                  <div>{m.content}</div>
                  <small className="muted">
                    {STATUS_LABEL[m.status] ?? m.status}
                    {m.errorCode ? ` · Lý do: ${m.errorCode}` : ''}
                    {m.senderType === 'bot' ? ' · Bấm để xem chi tiết' : ''}
                  </small>
                </div>
              ))}
            </div>

            <form className="composer" onSubmit={send}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Gửi tin cho khách…" />
              <button type="submit">Gửi</button>
            </form>
          </>
        )}
      </section>

      {detail && (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Chi tiết tin của bot</h2>
              <button className="link" onClick={() => setDetail(null)}>
                Đóng
              </button>
            </header>
            <dl>
              <dt>Nguồn trả lời</dt>
              <dd>{SOURCE_LABEL[String(detail.metadata.source)] ?? String(detail.metadata.source ?? '—')}</dd>
              <dt>Rule</dt>
              <dd>{String(detail.metadata.ruleId ?? '—')}</dd>
              <dt>Model</dt>
              <dd>{String(detail.metadata.model ?? '—')}</dd>
              <dt>Provider</dt>
              <dd>{String(detail.metadata.provider ?? '—')}</dd>
              <dt>Token vào / ra</dt>
              <dd>
                {String(detail.metadata.tokensIn ?? '—')} / {String(detail.metadata.tokensOut ?? '—')}
              </dd>
              <dt>Độ trễ</dt>
              <dd>{detail.metadata.latencyMs ? `${String(detail.metadata.latencyMs)} ms` : '—'}</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
