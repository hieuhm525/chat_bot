import { ConfigService } from '@nestjs/config';
import { MessengerAdapter } from './adapters/messenger.adapter';
import { AdapterChannel } from './adapter.types';

const channel = {
  id: 'c1',
  workspaceId: 'w1',
  provider: 'messenger',
  externalId: 'PAGE',
  config: {},
  credentials: { accessToken: 'x' },
} as AdapterChannel;

describe('MessengerAdapter.canSend', () => {
  const adapter = new MessengerAdapter({ getOrThrow: () => 'secret' } as unknown as ConfigService);

  it('blocks when there is no inbound message', () => {
    expect(adapter.canSend(channel, {}, new Date()).ok).toBe(false);
  });

  it('blocks outside the 24h window', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const old = new Date('2025-12-31T23:59:59Z');
    expect(adapter.canSend(channel, { lastInboundAt: old }, now).ok).toBe(false);
  });

  it('allows inside the 24h window', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const recent = new Date('2026-01-01T00:00:00Z');
    expect(adapter.canSend(channel, { lastInboundAt: recent }, now)).toEqual({ ok: true });
  });
});

describe('MessengerAdapter Messenger features', () => {
  const adapter = new MessengerAdapter({ getOrThrow: () => 'secret' } as unknown as ConfigService);
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function mockFetch(responses: unknown[]) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(responses[calls.length - 1] ?? {}), { status: 200 });
    }) as unknown as typeof fetch;
    return calls;
  }

  it('parses a Get Started postback as a message carrying the payload', () => {
    const [event] = adapter.parse(
      {
        entry: [
          {
            messaging: [
              { sender: { id: 'U1' }, timestamp: 1, postback: { mid: 'm1', title: 'Bắt đầu', payload: 'GET_STARTED' } },
            ],
          },
        ],
      },
      channel,
    );
    expect(event).toMatchObject({ kind: 'message', text: 'Bắt đầu', postback: 'GET_STARTED', providerMessageId: 'm1' });
  });

  it('parses a menu postback using its title as the text', () => {
    const [event] = adapter.parse(
      { entry: [{ messaging: [{ sender: { id: 'U1' }, timestamp: 2, postback: { title: 'Xem giá', payload: 'Xem giá' } }] }] },
      channel,
    );
    expect(event).toMatchObject({ kind: 'message', text: 'Xem giá', providerEventId: 'postback:U1:2' });
  });

  it('sends quick replies with the message', async () => {
    const calls = mockFetch([{ message_id: 'mid.1' }]);
    await adapter.send(channel, 'U1', { text: 'Chọn giúp em ạ', quickReplies: [' Xem giá ', '', 'Gặp nhân viên'] });
    expect(JSON.parse(String(calls[0].init.body)).message).toEqual({
      text: 'Chọn giúp em ạ',
      quick_replies: [
        { content_type: 'text', title: 'Xem giá', payload: 'Xem giá' },
        { content_type: 'text', title: 'Gặp nhân viên', payload: 'Gặp nhân viên' },
      ],
    });
  });

  it('sets Get Started together with the menu', async () => {
    const calls = mockFetch([{ result: 'success' }]);
    await adapter.syncProfile(channel, {
      getStarted: false,
      persistentMenu: [{ title: 'Xem giá' }, { title: 'Website', url: 'https://example.com' }],
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.get_started).toEqual({ payload: 'GET_STARTED' });
    expect(body.persistent_menu[0].call_to_actions).toEqual([
      { type: 'postback', title: 'Xem giá', payload: 'Xem giá' },
      { type: 'web_url', title: 'Website', url: 'https://example.com', webview_height_ratio: 'full' },
    ]);
  });

  it('deletes both when everything is turned off', async () => {
    const calls = mockFetch([{ result: 'success' }]);
    await adapter.syncProfile(channel, { getStarted: false, persistentMenu: [] });
    expect(calls[0].init.method).toBe('DELETE');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ fields: ['persistent_menu', 'get_started'] });
  });

  it('reports Meta errors with the Graph code', async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ error: { code: 190, message: 'Token expired' } }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(adapter.syncProfile(channel, { getStarted: true, persistentMenu: [] })).rejects.toThrow(
      /Page PAGE thất bại: HTTP 400, mã Graph 190: Token expired/,
    );
  });
});
