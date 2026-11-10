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

@Injectable()
export class MessengerAdapter implements ChannelAdapter {
  readonly provider = 'messenger' as const;

  constructor(private readonly config: ConfigService) {}

  capabilities(): Capabilities {
    return { text: true, media: false, quickReply: false, template: false, maxTextLength: 2000 };
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
      for (const item of entry?.messaging ?? []) {
        const at = new Date(item.timestamp ?? Date.now());
        const sender = item.sender?.id;
        if (item.message) {
          const text = typeof item.message.text === 'string' ? item.message.text : undefined;
          const attachments = (item.message.attachments ?? [])
            .filter((a: any) => a?.payload?.url)
            .map((a: any) => ({ type: a.type === 'image' ? 'image' : 'file', url: a.payload.url }));
          const contentType = attachments.length ? attachments[0].type : text ? 'text' : 'unsupported';
          if (item.message.is_echo) {
            // Page Inbox reply: sender is the Page, the customer is the recipient.
            const customer = item.recipient?.id;
            events.push({
              kind: 'message',
              providerEventId: item.message.mid,
              externalUserId: customer,
              externalThreadId: customer,
              providerMessageId: item.message.mid,
              text,
              contentType,
              attachments,
              echo: true,
              occurredAt: at,
              raw: item,
            });
            continue;
          }
          events.push({
            kind: 'message',
            providerEventId: item.message.mid,
            externalUserId: sender,
            externalThreadId: sender,
            providerMessageId: item.message.mid,
            text,
            contentType,
            attachments,
            occurredAt: at,
            raw: item,
          });
        } else if (item.delivery) {
          for (const mid of item.delivery.mids ?? []) {
            events.push({
              kind: 'status',
              providerEventId: `delivery:${mid}`,
              providerMessageId: mid,
              status: 'delivered',
              occurredAt: at,
              raw: item,
            });
          }
        } else if (item.read) {
          events.push({
            kind: 'status',
            providerEventId: `read:${item.read.watermark ?? item.timestamp}`,
            status: 'read',
            occurredAt: at,
            raw: item,
          });
        } else {
          events.push({ kind: 'ignored', providerEventId: `ignored:${item.timestamp}`, occurredAt: at, raw: item });
        }
      }
    }
    return events;
  }

  async send(channel: AdapterChannel, to: string, msg: OutgoingText): Promise<{ providerMessageId: string }> {
    const version = (channel.config.graphVersion as string) ?? 'v26.0';
    const res = await fetch(`https://graph.facebook.com/${version}/me/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channel.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient: { id: to }, messaging_type: 'RESPONSE', message: { text: msg.text } }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const code = String(body?.error?.code ?? res.status);
      const retryable = res.status === 429 || res.status >= 500 || code === '2' || code === '4';
      throw new SendError(body?.error?.message ?? `Graph ${res.status}`, retryable, code, code === '190');
    }
    return { providerMessageId: body.message_id };
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
      `https://graph.facebook.com/${version}/${channel.externalId}?fields=name&access_token=${encodeURIComponent(channel.credentials.accessToken)}`,
    );
    if (!res.ok) return { ok: false, detail: `Graph ${res.status}` };
    return { ok: true, detail: 'kết nối OK' };
  }
}
