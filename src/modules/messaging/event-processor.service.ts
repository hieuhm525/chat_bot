import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { botRules, bots, conversations, customers, messages, outbox, webhookEvents, workspaces } from '../../db/schema';
import { ChannelsService } from '../channels/channels.service';
import { AdapterRegistry } from '../channels/adapter.registry';
import { AdapterChannel, NormalizedEvent, Provider } from '../channels/adapter.types';
import { BotService, RuleCandidate } from '../bot/bot.service';
import { ChatMessage } from '../bot/llm.service';
import { writeMessage } from './message-writer';
import { tenantBlocked } from '../../common/tenant-status';

const UNSUPPORTED_REPLY = 'Dạ em chưa xem được ảnh/file, anh/chị nhắn chữ giúp em ạ.';
const HISTORY_LIMIT = 10;

@Injectable()
export class EventProcessor {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly channels: ChannelsService,
    private readonly adapters: AdapterRegistry,
    private readonly bot: BotService,
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

      if (!inserted.length) return { duplicate: true as const, conversation };

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id));

      await tx
        .update(conversations)
        .set({ lastMessageAt: event.occurredAt, messageCount: count, updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));

      return { duplicate: false as const, conversation, isFirst: count === 1 };
    });

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
    const rules = (await this.db.select().from(botRules).where(eq(botRules.botId, bot.id))) as RuleCandidate[];

    const result =
      event.contentType && event.contentType !== 'text'
        ? { text: UNSUPPORTED_REPLY, source: 'fallback' as const }
        : await this.bot.resolve(bot, rules, await this.loadHistory(inbound.conversation.id), event.text ?? '');

    const greeting = inbound.isFirst && bot.greeting ? bot.greeting : null;
    const fallbackCount = result.source === 'fallback' ? inbound.conversation.fallbackCount + 1 : 0;
    const handoff = fallbackCount >= bot.pauseAfterFallbacks;

    const parts: Array<{
      senderType: 'bot' | 'system';
      content: string;
      metadata: Record<string, unknown>;
    }> = [];
    if (greeting) parts.push({ senderType: 'bot', content: greeting, metadata: { kind: 'greeting' } });
    parts.push({
      senderType: 'bot',
      content: result.text,
      metadata: {
        kind: 'answer',
        source: result.source,
        ruleId: result.ruleId,
        model: result.model,
        provider: result.provider,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
        ...(handoff ? { handoff: true } : {}),
      },
    });
    if (handoff) {
      parts.push({ senderType: 'bot', content: bot.handoffMessage, metadata: { kind: 'handoff', afterFallbacks: fallbackCount } });
      parts.push({
        senderType: 'system',
        content: `Tự động chuyển cho nhân viên sau ${fallbackCount} lần chưa trả lời được`,
        metadata: { kind: 'auto_handoff', fallbackCount },
      });
    }

    await this.db.transaction(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, inbound.conversation.id))
        .limit(1);
      if (!fresh || fresh.mode !== 'bot') return;

      // One millisecond apart: now() is the transaction time, so (created_at, id) needs a real order.
      const base = Date.now();
      for (const [index, part] of parts.entries()) {
        const message = await writeMessage(tx, {
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          conversationId: fresh.id,
          direction: 'out',
          senderType: part.senderType,
          botId: part.senderType === 'bot' ? bot.id : null,
          content: part.content,
          status: part.senderType === 'bot' ? 'queued' : 'sent',
          metadata: part.metadata,
          createdAt: new Date(base + index),
        });
        if (part.senderType === 'bot') {
          await tx.insert(outbox).values({
            workspaceId: channel.workspaceId,
            kind: 'send_message',
            payload: { messageId: message.id },
          });
        }
      }

      await tx
        .update(conversations)
        .set({
          fallbackCount,
          mode: handoff ? 'human' : fresh.mode,
          botId: bot.id,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, fresh.id));
    });
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
      .filter((m) => m.contentType === 'text')
      .map((m) => ({ role: m.senderType === 'customer' ? 'user' : 'assistant', content: m.content }) as ChatMessage);
  }

  private async markProcessed(id: string) {
    await this.db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, id));
  }
}
