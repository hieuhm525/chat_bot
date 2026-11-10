import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  AdapterChannel,
  Capabilities,
  ChannelAdapter,
  ConversationWindow,
  NormalizedEvent,
  OutgoingText,
  SendError,
} from '../adapter.types';
import { safeEqualHex } from '../../../common/crypto';

const WINDOW_MS = 24 * 3600 * 1000;

/** WhatsApp Cloud (P6). */
@Injectable()
export class WhatsappAdapter implements ChannelAdapter {
  readonly provider = 'whatsapp' as const;

  constructor(private readonly config: ConfigService) {}

  capabilities(): Capabilities {
    return { text: true, media: false, quickReply: false, template: true, maxTextLength: 4096 };
  }

  verify(req: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): boolean {
    const secret = this.config.getOrThrow<string>('META_APP_SECRET');
    const header = req.headers['x-hub-signature-256'];
    if (!secret || !header || Array.isArray(header)) return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex');
    return safeEqualHex(header, expected);
  }

  parse(raw: unknown, _channel: AdapterChannel): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const payload = raw as any;
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        for (const msg of value.messages ?? []) {
          const at = new Date(Number(msg.timestamp) * 1000);
          events.push({
            kind: 'message',
            providerEventId: msg.id,
            externalUserId: msg.from,
            externalThreadId: msg.from,
            providerMessageId: msg.id,
            text: msg.text?.body,
            contentType: msg.type === 'text' ? 'text' : 'unsupported',
            occurredAt: at,
            raw: msg,
          });
        }
        for (const status of value.statuses ?? []) {
          events.push({
            kind: 'status',
            providerEventId: `status:${status.id}:${status.status}`,
            providerMessageId: status.id,
            status: status.status === 'read' ? 'read' : 'delivered',
            occurredAt: new Date(Number(status.timestamp) * 1000),
            raw: status,
          });
        }
      }
    }
    return events;
  }

  async send(channel: AdapterChannel, to: string, msg: OutgoingText): Promise<{ providerMessageId: string }> {
    const version = (channel.config.graphVersion as string) ?? 'v26.0';
    const res = await fetch(`https://graph.facebook.com/${version}/${channel.externalId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channel.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.text } }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const code = String(body?.error?.code ?? res.status);
      const retryable = res.status === 429 || res.status >= 500 || code === '4';
      throw new SendError(body?.error?.message ?? `Graph ${res.status}`, retryable, code, code === '190');
    }
    return { providerMessageId: body.messages?.[0]?.id ?? '' };
  }

  canSend(_channel: AdapterChannel, conv: ConversationWindow, at: Date) {
    if (!conv.lastInboundAt) return { ok: false as const, reason: 'chưa có tin khách' };
    if (at.getTime() - conv.lastInboundAt.getTime() > WINDOW_MS) {
      return { ok: false as const, reason: 'ngoài cửa sổ 24h' };
    }
    return { ok: true as const };
  }

  async healthCheck(channel: AdapterChannel) {
    const version = (channel.config.graphVersion as string) ?? 'v26.0';
    const res = await fetch(
      `https://graph.facebook.com/${version}/${channel.externalId}?fields=display_phone_number&access_token=${encodeURIComponent(channel.credentials.accessToken)}`,
    );
    return res.ok ? { ok: true, detail: 'kết nối OK' } : { ok: false, detail: `Graph ${res.status}` };
  }
}
