import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { botRules, bots, conversations, customers, messages, outbox, webhookEvents, workspaces } from '../../db/schema';
import { ChannelsService } from '../channels/channels.service';
import { AdapterRegistry } from '../channels/adapter.registry';
import { AdapterChannel, GET_STARTED_PAYLOAD, NormalizedEvent, Provider } from '../channels/adapter.types';
import { BotService, ResolveResult, RuleCandidate, wantsHuman } from '../bot/bot.service';
import { ChatMessage } from '../bot/llm.service';
import { writeMessage } from './message-writer';
import { tenantBlocked } from '../../common/tenant-status';
import { splitReply, typingDelayMs } from './reply-pacing';
import { OutboundService } from './outbound.service';

const UNSUPPORTED_REPLY = 'Dạ em chưa xem được ảnh/file, anh/chị nhắn chữ giúp em ạ.';
const HISTORY_LIMIT = 10;
/** Past this, the customer gets the bot's wait message while the LLM keeps working. */
const WAIT_MESSAGE_AFTER_MS = 6000;
/** Messenger avatar URLs are signed and expire, so profiles are refreshed about daily. */
const PROFILE_TTL_MS = 24 * 3600 * 1000;
/** A human-mode thread with no staff activity this long goes back to the bot on the customer's next message. */
export const HUMAN_IDLE_RELEASE_MS = 30 * 60 * 1000;

type CustomerRow = typeof customers.$inferSelect;

interface ReplyPart {
  senderType: 'bot' | 'system';
  content: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class EventProcessor {
  private readonly logger = new Logger(EventProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly channels: ChannelsService,
    private readonly adapters: AdapterRegistry,
    private readonly bot: BotService,
    private readonly outbound: OutboundService,
  ) {}

  async process(webhookEventId: string): Promise<void> {
    const [event] = await this.db.select().from(webhookEvents).where(eq(webhookEvents.id, webhookEventId)).limit(1);
    if (!event || event.processedAt) return;
    if (!event.channelId) {
      await this.markProcessed(event.id);
      return;
    }

    const channel = await this.channels.getAdapterChannelById(event.channelId);
    if (!channel) {
      await this.markProcessed(event.id);
      return;
    }

    const adapter = this.adapters.get(event.provider as Provider);
    for (const normalized of adapter.parse(event.payload, channel)) {
      if (normalized.kind === 'message') await this.ingestMessage(channel, normalized);
      else if (normalized.kind === 'status') await this.updateStatus(channel, normalized);
    }
    await this.markProcessed(event.id);
  }

  private async ingestMessage(channel: AdapterChannel, event: NormalizedEvent): Promise<void> {
    if (!event.externalUserId || !event.externalThreadId) return;
    if (event.echo) {
      await this.ingestEcho(channel, event);
      return;
    }

    const inbound = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`conv:${channel.id}:${event.externalThreadId}`}))`);

      const [customer] = await tx
        .insert(customers)
        .values({
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          externalUserId: event.externalUserId!,
          lastSeenAt: event.occurredAt,
        })
        .onConflictDoUpdate({
          target: [customers.channelId, customers.externalUserId],
          set: { lastSeenAt: event.occurredAt },
        })
        .returning();

      const [conversation] = await tx
        .insert(conversations)
        .values({
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          customerId: customer.id,
          externalThreadId: event.externalThreadId!,
          lastInboundAt: event.occurredAt,
          lastMessageAt: event.occurredAt,
        })
        .onConflictDoUpdate({
          target: [conversations.channelId, conversations.externalThreadId],
          set: { lastInboundAt: event.occurredAt, updatedAt: new Date() },
        })
        .returning();

      const inserted = await tx
        .insert(messages)
        .values({
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          conversationId: conversation.id,
          direction: 'in',
          senderType: 'customer',
          contentType: event.contentType ?? 'text',
          content: event.text ?? '',
          providerMessageId: event.providerMessageId,
          status: 'received',
          metadata: event.attachments?.length ? { attachments: event.attachments } : {},
          createdAt: event.occurredAt,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });

      if (!inserted.length) return { duplicate: true as const, conversation, customer };

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id));

      await tx
        .update(conversations)
        .set({ lastMessageAt: event.occurredAt, messageCount: count, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));

      if (conversation.mode === 'human' && (await this.humanIdle(tx, conversation.id, new Date()))) {
        // Staff forgot "Trả lại bot": a customer waiting on nobody gets the bot back instead of silence.
        await tx
          .update(conversations)
          .set({ mode: 'bot', assignedUserId: null, fallbackCount: 0, updatedAt: new Date() })
          .where(eq(conversations.id, conversation.id));
        await writeMessage(tx, {
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          conversationId: conversation.id,
          direction: 'out',
          senderType: 'system',
          content: `Tự trả hội thoại về bot vì không có người trả lời trong ${HUMAN_IDLE_RELEASE_MS / 60_000} phút`,
          status: 'sent',
          metadata: { kind: 'auto_release', idleMs: HUMAN_IDLE_RELEASE_MS },
        });
        this.logger.log({ msg: 'Tự trả hội thoại về bot', conversationId: conversation.id, channelId: channel.id });
        return {
          duplicate: false as const,
          conversation: { ...conversation, mode: 'bot', fallbackCount: 0 },
          customer,
          isFirst: count === 1,
        };
      }

      return { duplicate: false as const, conversation, customer, isFirst: count === 1 };
    });

    // Runs beside the bot reply: a slow or failing profile API must never delay or block the answer.
    this.refreshProfile(channel, inbound.customer).catch((err) =>
      this.logger.warn({
        msg: 'Cập nhật profile khách thất bại, hội thoại vẫn hiện ID khách',
        channelId: channel.id,
        customerId: inbound.customer.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    if (inbound.duplicate || inbound.conversation.mode !== 'bot') return;

    // Disabled channel: keep the stored inbound message, but the bot stays silent.
    if (channel.status === 'disabled') return;

    // Inactive tenant: keep the stored inbound message, but the bot stays silent.
    const [workspace] = await this.db
      .select({ status: workspaces.status, expiresAt: workspaces.expiresAt })
      .from(workspaces)
      .where(eq(workspaces.id, channel.workspaceId))
      .limit(1);
    if (!workspace || tenantBlocked(workspace.status, workspace.expiresAt)) return;

    const bot = await this.resolveBot(channel);
    if (!bot || !bot.enabled) return;

    // Cosmetic only: runs beside the answer, so a failing typing call never delays or blocks the reply.
    this.showTyping(channel, event).catch((err) =>
      this.logger.warn({
        msg: 'Không hiện được trạng thái "đang nhắn", bot vẫn trả lời bình thường',
        channelId: channel.id,
        provider: channel.provider,
        externalUserId: event.externalUserId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    // Get Started is a greeting request, not a question: answer with the greeting and never count a fallback.
    if (event.postback === GET_STARTED_PAYLOAD) {
      if (!bot.greeting) return;
      await this.queueReply(channel, bot.id, inbound.conversation.id, [
        {
          senderType: 'bot',
          content: bot.greeting,
          metadata: { kind: 'greeting', ...(bot.greetingQuickReplies.length ? { quickReplies: bot.greetingQuickReplies } : {}) },
        },
      ]);
      return;
    }

    if (event.text && wantsHuman(event.text)) {
      await this.queueReply(
        channel,
        bot.id,
        inbound.conversation.id,
        [
          { senderType: 'bot', content: bot.handoffMessage, metadata: { kind: 'handoff', reason: 'customer_request' } },
          { senderType: 'system', content: 'Khách yêu cầu gặp nhân viên, bot tạm dừng', metadata: { kind: 'auto_handoff', reason: 'customer_request' } },
        ],
        false,
        (tx, id) =>
          tx.update(conversations).set({ mode: 'human', fallbackCount: 0, botId: bot.id, updatedAt: new Date() }).where(eq(conversations.id, id)),
      );
      return;
    }

    const rules = (await this.db.select().from(botRules).where(eq(botRules.botId, bot.id))) as RuleCandidate[];

    const resolving: Promise<ResolveResult> =
      event.contentType && event.contentType !== 'text'
        ? Promise.resolve({ text: UNSUPPORTED_REPLY, source: 'fallback' as const })
        : this.loadHistory(inbound.conversation.id).then((history) =>
            this.bot.resolve(bot, rules, history, event.text ?? ''),
          );
    const { result, waited } = await this.awaitWithWaitMessage(channel, bot, inbound.conversation.id, resolving);

    const greeting = inbound.isFirst && bot.greeting ? bot.greeting : null;
    const fallbackCount = result.source === 'fallback' ? inbound.conversation.fallbackCount + 1 : 0;
    const handoff = fallbackCount >= bot.pauseAfterFallbacks;

    const parts: ReplyPart[] = [];
    if (greeting) parts.push({ senderType: 'bot', content: greeting, metadata: { kind: 'greeting' } });
    const chunks = splitReply(result.text, this.adapters.get(channel.provider).capabilities().maxTextLength);
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      parts.push({
        senderType: 'bot',
        content: chunk,
        metadata:
          index === 0
            ? {
                kind: 'answer',
                source: result.source,
                ruleId: result.ruleId,
                model: result.model,
                provider: result.provider,
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
                latencyMs: result.latencyMs,
                ...(chunks.length > 1 ? { part: 1, parts: chunks.length } : {}),
                ...(handoff ? { handoff: true } : {}),
                ...(last && !handoff && result.quickReplies?.length ? { quickReplies: result.quickReplies } : {}),
              }
            : {
                kind: 'answer',
                source: result.source,
                part: index + 1,
                parts: chunks.length,
                ...(handoff ? { handoff: true } : {}),
                ...(last && !handoff && result.quickReplies?.length ? { quickReplies: result.quickReplies } : {}),
              },
      });
    }
    if (handoff) {
      parts.push({ senderType: 'bot', content: bot.handoffMessage, metadata: { kind: 'handoff', afterFallbacks: fallbackCount } });
      parts.push({
        senderType: 'system',
        content: `Tự động chuyển cho nhân viên sau ${fallbackCount} lần chưa trả lời được`,
        metadata: { kind: 'auto_handoff', fallbackCount },
      });
    }

    // A slow LLM already made the customer wait, so its first message goes out at once.
    const skipFirstDelay = !greeting && (result.source === 'llm' || waited);
    await this.queueReply(channel, bot.id, inbound.conversation.id, parts, skipFirstDelay, (tx, id) =>
      tx
        .update(conversations)
        .set({ fallbackCount, mode: handoff ? 'human' : 'bot', botId: bot.id, updatedAt: new Date() })
        .where(eq(conversations.id, id)),
    );
  }

  /**
   * Stores the reply and schedules each bot message a "typing time" after the previous one,
   * so the typing bubble shows for a believable moment and multi-part replies arrive one by one.
   * Nothing is written when a human took over the thread in the meantime.
   */
  private async queueReply(
    channel: AdapterChannel,
    botId: string,
    conversationId: string,
    parts: ReplyPart[],
    skipFirstDelay = false,
    afterWrite?: (tx: Db, conversationId: string) => Promise<unknown>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [fresh] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
      if (!fresh || fresh.mode !== 'bot') return;

      // One millisecond apart: now() is the transaction time, so (created_at, id) needs a real order.
      const base = Date.now();
      let sendAt = base;
      let firstBot = true;
      for (const [index, part] of parts.entries()) {
        const message = await writeMessage(tx, {
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          conversationId: fresh.id,
          direction: 'out',
          senderType: part.senderType,
          botId: part.senderType === 'bot' ? botId : null,
          content: part.content,
          status: part.senderType === 'bot' ? 'queued' : 'sent',
          metadata: part.metadata,
          createdAt: new Date(base + index),
        });
        if (part.senderType !== 'bot') continue;
        if (!(firstBot && skipFirstDelay)) sendAt += typingDelayMs(part.content);
        firstBot = false;
        await tx.insert(outbox).values({
          workspaceId: channel.workspaceId,
          kind: 'send_message',
          payload: { messageId: message.id },
          nextAttemptAt: new Date(sendAt),
        });
      }
      await afterWrite?.(tx, fresh.id);
    });
  }

  /**
   * Waits for the answer; if it takes longer than WAIT_MESSAGE_AFTER_MS (slow LLM), sends the bot's
   * wait message first so the customer is not left staring at a typing bubble that eventually times out.
   */
  private async awaitWithWaitMessage(
    channel: AdapterChannel,
    bot: typeof bots.$inferSelect,
    conversationId: string,
    resolving: Promise<ResolveResult>,
  ): Promise<{ result: ResolveResult; waited: boolean }> {
    if (!bot.waitMessage.trim()) return { result: await resolving, waited: false };
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), WAIT_MESSAGE_AFTER_MS);
    });
    const first = await Promise.race([resolving, slow]);
    clearTimeout(timer);
    if (first !== 'slow') return { result: first, waited: false };

    await this.sendWaitMessage(channel, bot, conversationId).catch((err) =>
      this.logger.warn({
        msg: 'Gửi tin chờ khi LLM chậm thất bại, vẫn chờ câu trả lời chính',
        channelId: channel.id,
        conversationId,
        botId: bot.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { result: await resolving, waited: true };
  }

  /**
   * Sent right away instead of via the outbox: the worker is busy running this very event,
   * so a queued job would only go out after the answer. The outbox only takes over on retry.
   */
  private async sendWaitMessage(channel: AdapterChannel, bot: typeof bots.$inferSelect, conversationId: string) {
    const messageId = await this.db.transaction(async (tx) => {
      const [fresh] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
      if (!fresh || fresh.mode !== 'bot') return null;
      const message = await writeMessage(tx, {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        conversationId,
        direction: 'out',
        senderType: 'bot',
        botId: bot.id,
        content: bot.waitMessage.trim(),
        status: 'queued',
        metadata: { kind: 'wait', afterMs: WAIT_MESSAGE_AFTER_MS },
      });
      return message.id;
    });
    if (!messageId) return;
    try {
      await this.outbound.send(messageId);
    } catch (err) {
      // Retryable failure: hand it to the outbox so it is retried and does not block the answer forever.
      await this.db.insert(outbox).values({ workspaceId: channel.workspaceId, kind: 'send_message', payload: { messageId } });
      throw err;
    }
  }

  /**
   * Fills in the customer's name and avatar from the provider. Failures are recorded on the
   * profile too, so a Page without the needed permission is not asked again on every message.
   */
  private async refreshProfile(channel: AdapterChannel, customer: CustomerRow): Promise<void> {
    const adapter = this.adapters.get(channel.provider);
    if (!adapter.fetchProfile) return;
    const profile = (customer.profile ?? {}) as { fetchedAt?: string };
    const fetchedAt = profile.fetchedAt ? Date.parse(profile.fetchedAt) : NaN;
    // Never fetched (NaN) or older than a day: fetch again.
    if (Date.now() - fetchedAt < PROFILE_TTL_MS) return;

    const now = new Date().toISOString();
    try {
      const fetched = await adapter.fetchProfile(channel, customer.externalUserId);
      await this.db
        .update(customers)
        .set({
          displayName: fetched.name ?? customer.displayName,
          profile: { ...profile, avatarUrl: fetched.avatarUrl ?? null, fetchedAt: now, error: null },
        })
        .where(eq(customers.id, customer.id));
    } catch (err) {
      await this.db
        .update(customers)
        .set({ profile: { ...profile, fetchedAt: now, error: err instanceof Error ? err.message : String(err) } })
        .where(eq(customers.id, customer.id));
      throw err;
    }
  }

  /**
   * True when nobody acted as a human in this thread (takeover, auto handoff or a staff reply, incl. Page Inbox)
   * for HUMAN_IDLE_RELEASE_MS before `now`.
   */
  private async humanIdle(tx: Db, conversationId: string, now: Date): Promise<boolean> {
    const [{ last }] = await tx
      .select({ last: sql<Date | null>`max(${messages.createdAt})` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          sql`(${messages.senderType} = 'agent' or ${messages.metadata}->>'kind' in ('takeover', 'auto_handoff'))`,
        ),
      );
    // No marker at all (mode set before markers existed): treat as idle so the thread is not stuck forever.
    return !last || now.getTime() - new Date(last).getTime() > HUMAN_IDLE_RELEASE_MS;
  }

  /** A reply typed directly in the Page Inbox: store it as an outbound agent message. */
  private async ingestEcho(channel: AdapterChannel, event: NormalizedEvent): Promise<void> {
    const providerMessageId = event.providerMessageId;
    if (!providerMessageId) return;

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`conv:${channel.id}:${event.externalThreadId}`}))`);

      const [existing] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, channel.id), eq(messages.providerMessageId, providerMessageId)))
        .limit(1);
      if (existing) return;

      const [customer] = await tx
        .insert(customers)
        .values({
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          externalUserId: event.externalUserId!,
          lastSeenAt: event.occurredAt,
        })
        .onConflictDoUpdate({
          target: [customers.channelId, customers.externalUserId],
          set: { lastSeenAt: event.occurredAt },
        })
        .returning();

      const [conversation] = await tx
        .insert(conversations)
        .values({
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          customerId: customer.id,
          externalThreadId: event.externalThreadId!,
          lastMessageAt: event.occurredAt,
        })
        .onConflictDoUpdate({
          target: [conversations.channelId, conversations.externalThreadId],
          set: { updatedAt: new Date() },
        })
        .returning();

      const [inserted] = await tx
        .insert(messages)
        .values({
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          conversationId: conversation.id,
          direction: 'out',
          senderType: 'agent',
          senderUserId: null,
          contentType: event.contentType ?? 'text',
          content: event.text ?? '',
          providerMessageId,
          status: 'sent',
          metadata: {
            via: 'page_inbox',
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          },
          createdAt: event.occurredAt,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      if (!inserted) return;

      await tx
        .update(conversations)
        .set({
          messageCount: sql`${conversations.messageCount} + 1`,
          lastMessageAt: event.occurredAt,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversation.id));
    });
  }

  private async updateStatus(channel: AdapterChannel, event: NormalizedEvent): Promise<void> {
    if (!event.providerMessageId || !event.status) return;
    const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
    const [message] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), eq(messages.providerMessageId, event.providerMessageId)))
      .limit(1);
    if (!message) return;
    if ((rank[event.status] ?? 0) <= (rank[message.status] ?? 0)) return;
    await this.db.update(messages).set({ status: event.status, updatedAt: new Date() }).where(eq(messages.id, message.id));
  }

  private async showTyping(channel: AdapterChannel, event: NormalizedEvent): Promise<void> {
    const adapter = this.adapters.get(channel.provider);
    if (!adapter.showTyping || !event.externalUserId) return;
    await adapter.showTyping(channel, event.externalUserId, event.providerMessageId);
  }

  /** Only the channel's own bot; no fallback, so the answer is always predictable. */
  private async resolveBot(channel: AdapterChannel) {
    if (!channel.botId) return null;
    const [bot] = await this.db
      .select()
      .from(bots)
      .where(and(eq(bots.workspaceId, channel.workspaceId), eq(bots.id, channel.botId), isNull(bots.deletedAt)))
      .limit(1);
    return bot ?? null;
  }

  private async loadHistory(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_LIMIT);
    return rows
      .reverse()
      // The wait message is filler (feeding it back teaches the LLM to stall); system lines ("… đã tiếp quản") were never said to the customer.
      .filter(
        (m) => m.contentType === 'text' && m.senderType !== 'system' && (m.metadata as { kind?: string } | null)?.kind !== 'wait',
      )
      .map((m) => ({ role: m.senderType === 'customer' ? 'user' : 'assistant', content: m.content }) as ChatMessage);
  }

  private async markProcessed(id: string) {
    await this.db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, id));
  }
}
