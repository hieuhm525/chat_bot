import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  AdapterChannel,
  Capabilities,
  ChannelAdapter,
  ConversationWindow,
  CustomerProfile,
  GET_STARTED_PAYLOAD,
  MessengerProfile,
  NormalizedEvent,
  OutgoingText,
  SendError,
} from '../adapter.types';
import { safeEqualHex } from '../../../common/crypto';

const WINDOW_MS = 24 * 3600 * 1000;
/** Meta limits: 13 quick replies of 20 characters; 20 top-level menu items of 30 characters. */
export const MAX_QUICK_REPLIES = 13;
export const QUICK_REPLY_TITLE_MAX = 20;
export const MAX_MENU_ITEMS = 20;
export const MENU_TITLE_MAX = 30;

@Injectable()
export class MessengerAdapter implements ChannelAdapter {
  readonly provider = 'messenger' as const;

  constructor(private readonly config: ConfigService) {}

  capabilities(): Capabilities {
    return { text: true, media: false, quickReply: true, template: false, maxTextLength: 2000 };
  }

  verify(req: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
    channel?: AdapterChannel;
  }): boolean {
    // Each tenant connects its own Meta App; META_APP_SECRET is the fallback for older channels.
    const secret = req.channel?.credentials.appSecret || this.config.getOrThrow<string>('META_APP_SECRET');
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
        } else if (item.postback) {
          // Tapping Get Started or a menu item: the title is what the customer "said".
          const payload = typeof item.postback.payload === 'string' ? item.postback.payload : '';
          const title = typeof item.postback.title === 'string' ? item.postback.title : payload;
          const mid = item.postback.mid ?? `postback:${sender}:${item.timestamp}`;
          events.push({
            kind: 'message',
            providerEventId: mid,
            externalUserId: sender,
            externalThreadId: sender,
            providerMessageId: mid,
            text: payload === GET_STARTED_PAYLOAD ? title || 'Bắt đầu' : title,
            contentType: 'text',
            postback: payload,
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
    const res = await graphFetch(`https://graph.facebook.com/${version}/me/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channel.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient: { id: to }, messaging_type: 'RESPONSE', message: toMessengerMessage(msg) }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const code = String(body?.error?.code ?? res.status);
      const retryable = res.status === 429 || res.status >= 500 || code === '2' || code === '4';
      throw new SendError(body?.error?.message ?? `Graph ${res.status}`, retryable, code, code === '190');
    }
    return { providerMessageId: body.message_id };
  }

  /** Messenger takes one sender_action per call: "seen" first, then the typing bubble. */
  async showTyping(channel: AdapterChannel, to: string): Promise<void> {
    const version = (channel.config.graphVersion as string) ?? 'v26.0';
    for (const action of ['mark_seen', 'typing_on'] as const) {
      const res = await graphFetch(`https://graph.facebook.com/${version}/me/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.credentials.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipient: { id: to }, sender_action: action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as any;
        throw new SendError(
          `Gửi sender_action "${action}" tới khách ${to} của Page ${channel.externalId} thất bại: HTTP ${res.status}, ` +
            `mã Graph ${body?.error?.code ?? '—'}: ${graphError(body, res.status)}`,
          res.status === 429 || res.status >= 500,
          String(body?.error?.code ?? res.status),
        );
      }
    }
  }

  /**
   * Messenger Profile API. Meta requires Get Started whenever a persistent menu exists,
   * so a menu forces it on. Empty settings delete both, leaving the Page as it was.
   */
  async syncProfile(channel: AdapterChannel, profile: MessengerProfile): Promise<void> {
    const version = (channel.config.graphVersion as string) ?? 'v26.0';
    const url = `https://graph.facebook.com/${version}/me/messenger_profile`;
    const headers = {
      Authorization: `Bearer ${channel.credentials.accessToken}`,
      'Content-Type': 'application/json',
    };
    const menu = profile.persistentMenu;
    const getStarted = profile.getStarted || menu.length > 0;

    const calls: Array<{ method: string; body: unknown; what: string }> = [];
    if (getStarted) {
      const set: Record<string, unknown> = { get_started: { payload: GET_STARTED_PAYLOAD } };
      if (menu.length) {
        set.persistent_menu = [
          {
            locale: 'default',
            composer_input_disabled: false,
            call_to_actions: menu.map((item) =>
              item.url
                ? { type: 'web_url', title: item.title, url: item.url, webview_height_ratio: 'full' }
                : { type: 'postback', title: item.title, payload: item.title },
            ),
          },
        ];
      }
      calls.push({ method: 'POST', body: set, what: menu.length ? 'Get Started + menu' : 'Get Started' });
    }
    // Remove what is no longer configured; the menu must go before Get Started.
    const remove = [...(menu.length ? [] : ['persistent_menu']), ...(getStarted ? [] : ['get_started'])];
    if (remove.length) calls.push({ method: 'DELETE', body: { fields: remove }, what: `xoá ${remove.join(', ')}` });

    for (const call of calls) {
      const res = await graphFetch(url, { method: call.method, headers, body: JSON.stringify(call.body) });
      const body = (await res.json().catch(() => ({}))) as any;
      if (!res.ok || body?.result !== 'success') {
        throw new SendError(
          `Cập nhật ${call.what} cho Page ${channel.externalId} thất bại: HTTP ${res.status}, ` +
            `mã Graph ${body?.error?.code ?? '—'}: ${graphError(body, res.status)}. ` +
            `Kiểm tra Page Access Token còn hạn và có quyền pages_messaging.`,
          res.status === 429 || res.status >= 500,
          String(body?.error?.code ?? res.status),
        );
      }
    }
  }

  canSend(_channel: AdapterChannel, conv: ConversationWindow, at: Date) {
    if (!conv.lastInboundAt) return { ok: false as const, reason: 'chưa có tin khách' };
    if (at.getTime() - conv.lastInboundAt.getTime() > WINDOW_MS) {
      return { ok: false as const, reason: 'ngoài cửa sổ 24h' };
    }
    return { ok: true as const };
  }

  /** Messenger User Profile API: needs only the Page token the bot already has. */
  async fetchProfile(channel: AdapterChannel, psid: string): Promise<CustomerProfile> {
    const version = (channel.config.graphVersion as string) ?? 'v26.0';
    const res = await graphFetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(psid)}?fields=first_name,last_name,profile_pic`,
      { headers: { Authorization: `Bearer ${channel.credentials.accessToken}` } },
    );
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      throw new SendError(
        `Không lấy được profile khách ${psid} của Page ${channel.externalId}: HTTP ${res.status}, ` +
          `mã Graph ${body?.error?.code ?? '—'}: ${graphError(body, res.status)}`,
        res.status === 429 || res.status >= 500,
        String(body?.error?.code ?? res.status),
      );
    }
    const name = [body.first_name, body.last_name].filter((v) => typeof v === 'string' && v.trim()).join(' ');
    return {
      name: name || undefined,
      avatarUrl: typeof body.profile_pic === 'string' ? body.profile_pic : undefined,
    };
  }

  /**
   * Subscribes the Page to the app's webhook (idempotent) so the tenant does not have
   * to do it in Meta's UI. Reading Page fields would need pages_read_engagement, which
   * a Messenger bot does not otherwise need, so this call is also the token check.
   */
  async healthCheck(channel: AdapterChannel) {
    const version = (channel.config.graphVersion as string) ?? 'v26.0';
    const token = channel.credentials.accessToken;
    if (!token) return { ok: false, detail: 'Thiếu Page Access Token' };
    const headers = { Authorization: `Bearer ${token}` };


    // Subscribing only succeeds with this Page's own token, so it also proves token and Page ID match.
    const fields = 'messages,messaging_postbacks,message_echoes,message_deliveries,message_reads';
    const subRes = await graphFetch(
      `https://graph.facebook.com/${version}/${channel.externalId}/subscribed_apps?subscribed_fields=${fields}`,
      { method: 'POST', headers },
    );
    const sub = (await subRes.json().catch(() => ({}))) as any;
    if (!subRes.ok || sub.success !== true) {
      return {
        ok: false,
        detail: `Không đăng ký được Page ${channel.externalId} nhận tin (token sai Page, hết hạn, hoặc thiếu quyền pages_messaging / pages_manage_metadata): ${graphError(sub, subRes.status)}`,
      };
    }
    return { ok: true, detail: `Đã kết nối Page ${channel.externalId}, Page đã đăng ký nhận tin nhắn` };
  }
}

/** Network failures surface as a bare `fetch failed`; keep the real reason (DNS, timeout, refused). */
async function graphFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = (err as Error).name === 'TimeoutError' ? 'timeout' : (cause?.code ?? cause?.message ?? String(err));
    throw new SendError(`Không kết nối được graph.facebook.com (${reason})`, true, 'network');
  }
}

function toMessengerMessage(msg: OutgoingText) {
  const replies = (msg.quickReplies ?? []).map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUICK_REPLIES);
  if (!replies.length) return { text: msg.text };
  return {
    text: msg.text,
    quick_replies: replies.map((title) => ({
      content_type: 'text',
      title: title.slice(0, QUICK_REPLY_TITLE_MAX),
      payload: title,
    })),
  };
}

function graphError(body: any, status: number): string {
  return body?.error?.message ?? `Graph ${status}`;
}
