import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
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

const WINDOW_MS = 48 * 3600 * 1000;

/**
 * Zalo OA (P5). Signature is NOT HMAC:
 * sha256(appId + rawBody + timestamp + oaSecretKey), header X-ZEvent-Signature.
 */
@Injectable()
export class ZaloAdapter implements ChannelAdapter {
  readonly provider = 'zalo' as const;

  constructor(private readonly config: ConfigService) {}

  capabilities(): Capabilities {
    return { text: true, media: false, quickReply: false, template: true, maxTextLength: 2000 };
  }

  verify(req: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
    channel?: AdapterChannel;
  }): boolean {
    const header = req.headers['x-zevent-signature'];
    if (!header || Array.isArray(header) || !req.channel) return false;
    const oaSecret = req.channel.credentials.oaSecret;
    if (!oaSecret) return false;
    let timestamp: string;
    try {
      timestamp = String((JSON.parse(req.rawBody.toString('utf8')) as any).timestamp ?? '');
    } catch {
      return false;
    }
    const expected = createHash('sha256')
      .update(this.config.getOrThrow<string>('ZALO_APP_ID') + req.rawBody.toString('utf8') + timestamp + oaSecret)
      .digest('hex');
    return safeEqualHex(header, expected);
  }

  parse(raw: unknown, _channel: AdapterChannel): NormalizedEvent[] {
    const payload = raw as any;
    const at = new Date(payload?.timestamp ?? Date.now());
    const sender = payload?.sender?.id ?? payload?.follower?.id;
    if (payload?.event_name === 'user_send_text' && payload?.message?.text) {
      return [
        {
          kind: 'message',
          providerEventId: String(payload.message.msg_id),
          externalUserId: sender,
          externalThreadId: sender,
          providerMessageId: String(payload.message.msg_id),
          text: payload.message.text,
          contentType: 'text',
          occurredAt: at,
          raw: payload,
        },
      ];
    }
    if (payload?.event_name === 'user_send_image' || payload?.event_name === 'user_send_file') {
      return [
        {
          kind: 'message',
          providerEventId: String(payload.message?.msg_id ?? at.getTime()),
          externalUserId: sender,
          externalThreadId: sender,
          providerMessageId: String(payload.message?.msg_id ?? at.getTime()),
          contentType: 'unsupported',
          occurredAt: at,
          raw: payload,
        },
      ];
    }
    return [{ kind: 'ignored', providerEventId: `zalo:${at.getTime()}`, occurredAt: at, raw: payload }];
  }

  async send(channel: AdapterChannel, to: string, msg: OutgoingText): Promise<{ providerMessageId: string }> {
    const res = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
      method: 'POST',
      headers: { access_token: channel.credentials.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { user_id: to }, message: { text: msg.text } }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || body?.error) {
      const code = String(body?.error ?? res.status);
      throw new SendError(body?.message ?? `Zalo ${res.status}`, res.status === 429 || res.status >= 500, code);
    }
    return { providerMessageId: String(body?.data?.message_id ?? '') };
  }

  canSend(_channel: AdapterChannel, conv: ConversationWindow, at: Date) {
    if (!conv.lastInboundAt) return { ok: false as const, reason: 'chưa có tin khách' };
    if (at.getTime() - conv.lastInboundAt.getTime() > WINDOW_MS) {
      return { ok: false as const, reason: 'ngoài cửa sổ 48h' };
    }
    return { ok: true as const };
  }

  async healthCheck(channel: AdapterChannel) {
    const res = await fetch('https://openapi.zalo.me/v3.0/oa/getoa', {
      headers: { access_token: channel.credentials.accessToken },
    });
    if (!res.ok) return { ok: false, detail: `Zalo ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as any;
    return body?.error ? { ok: false, detail: String(body.message) } : { ok: true, detail: 'kết nối OK' };
  }
}
