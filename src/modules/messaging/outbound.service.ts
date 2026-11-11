import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { channels, conversations, messages, workspaces } from '../../db/schema';
import { tenantBlocked } from '../../common/tenant-status';
import { ChannelsService } from '../channels/channels.service';
import { AdapterRegistry } from '../channels/adapter.registry';
import { Provider, SendError } from '../channels/adapter.types';

@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly channels: ChannelsService,
    private readonly adapters: AdapterRegistry,
  ) {}

  /** Sends one queued message. Throws only for retryable errors. */
  async send(messageId: string): Promise<void> {
    const [message] = await this.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!message || message.status !== 'queued') return;

    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, message.conversationId))
      .limit(1);
    const [channelRow] = await this.db.select().from(channels).where(eq(channels.id, message.channelId)).limit(1);
    if (!conversation || !channelRow) {
      await this.fail(message.id, 'channel_or_conversation_missing');
      return;
    }

    // A queued bot reply must not reach the customer after the tenant was suspended or expired.
    if (message.senderType === 'bot') {
      const [workspace] = await this.db
        .select({ status: workspaces.status, expiresAt: workspaces.expiresAt })
        .from(workspaces)
        .where(eq(workspaces.id, channelRow.workspaceId))
        .limit(1);
      if (!workspace || tenantBlocked(workspace.status, workspace.expiresAt)) {
        await this.fail(message.id, 'tenant_blocked');
        return;
      }
    }

    // Bot must stay silent while a human owns the thread. The last answer and the handoff notice still go out.
    const meta = message.metadata as { kind?: string; handoff?: boolean } | null;
    if (message.senderType === 'bot' && conversation.mode !== 'bot' && meta?.kind !== 'handoff' && meta?.handoff !== true) {
      await this.fail(message.id, 'mode_human');
      return;
    }

    // Multi-part replies: never overtake an earlier message still waiting in this thread.
    const [earlier] = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, message.conversationId),
          eq(messages.status, 'queued'),
          sql`(${messages.createdAt}, ${messages.id}) < (${message.createdAt}, ${message.id})`,
        ),
      )
      .limit(1);
    if (earlier) throw new Error('Còn tin trước chưa gửi trong hội thoại');

    const adapterChannel = await this.channels.getAdapterChannel(channelRow.workspaceId, channelRow.id);
    const adapter = this.adapters.get(channelRow.provider as Provider);
    const canSend = adapter.canSend(adapterChannel, { lastInboundAt: conversation.lastInboundAt }, new Date());
    if (!canSend.ok) {
      await this.db
        .update(messages)
        .set({ status: 'blocked_by_policy', errorCode: canSend.reason, updatedAt: new Date() })
        .where(eq(messages.id, message.id));
      return;
    }

    try {
      const { providerMessageId } = await adapter.send(adapterChannel, conversation.externalThreadId, {
        text: message.content,
      });
      try {
        await this.db
          .update(messages)
          .set({ status: 'sent', providerMessageId: providerMessageId || null, updatedAt: new Date() })
          .where(eq(messages.id, message.id));
      } catch (err) {
        // Meta may echo the reply before this update stores the mid; do not resend, just mark it sent.
        if ((err as { code?: string }).code !== '23505') throw err;
        await this.db.update(messages).set({ status: 'sent', updatedAt: new Date() }).where(eq(messages.id, message.id));
      }
      await this.db
        .update(conversations)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(conversations.id, conversation.id));
    } catch (err) {
      if (err instanceof SendError) {
        if (err.markChannelError) {
          await this.db.update(channels).set({ status: 'error', updatedAt: new Date() }).where(eq(channels.id, channelRow.id));
          this.logger.error(`Token kênh ${channelRow.id} lỗi, đã đánh dấu error`);
        }
        if (!err.retryable) {
          await this.fail(message.id, err.code ?? 'send_failed');
          return;
        }
      }
      throw err;
    }
  }

  /** Called when the outbox stops retrying, so the message no longer blocks later ones. */
  async giveUp(id: string) {
    await this.db
      .update(messages)
      .set({ status: 'failed', errorCode: 'send_gave_up', updatedAt: new Date() })
      .where(and(eq(messages.id, id), eq(messages.status, 'queued')));
  }

  private async fail(id: string, code: string) {
    await this.db
      .update(messages)
      .set({ status: 'failed', errorCode: code.slice(0, 100), updatedAt: new Date() })
      .where(eq(messages.id, id));
  }
}
