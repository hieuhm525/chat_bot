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
