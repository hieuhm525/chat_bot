import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { bots, channels, conversations, customers, messages, outbox, users, workspaces } from '../../db/schema';
import { writeMessage } from './message-writer';

export interface ListQuery {
  cursor?: string;
  mode?: string;
  search?: string;
  channelId?: string;
  botId?: string;
  assignedUserId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

interface ListCursor {
  at: string | null;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const EXCERPT_LENGTH = 160;

/** Cursor carries the (last_message_at, id) pair so equal timestamps never lose rows. */
function encodeCursor(row: { lastMessageAt: Date | null; id: string }) {
  return Buffer.from(JSON.stringify({ at: row.lastMessageAt?.toISOString() ?? null, id: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): ListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const at = parsed?.at;
    if (typeof parsed?.id !== 'string' || !UUID_RE.test(parsed.id)) throw new Error('bad id');
    if (at !== null && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) throw new Error('bad date');
    return { at, id: parsed.id };
  } catch {
    throw new BadRequestException('cursor không hợp lệ');
  }
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class ConversationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(workspaceId: string, query: ListQuery) {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const filters = [eq(conversations.workspaceId, workspaceId)];
    if (query.channelId) filters.push(eq(conversations.channelId, query.channelId));
    if (query.botId) filters.push(eq(conversations.botId, query.botId));
    if (query.mode) filters.push(eq(conversations.mode, query.mode));
    if (query.assignedUserId) filters.push(eq(conversations.assignedUserId, query.assignedUserId));

    // A YYYY-MM-DD bound is a whole day in the tenant's timezone, not UTC.
    const dateOnly = [query.from, query.to].some((value) => value && DATE_ONLY_RE.test(value));
    const timezone = dateOnly ? await this.workspaceTimezone(workspaceId) : '';
    if (query.from) {
      filters.push(
        DATE_ONLY_RE.test(query.from)
          ? sql`${conversations.lastMessageAt} >= (${query.from}::date::timestamp AT TIME ZONE ${timezone})`
          : gte(conversations.lastMessageAt, new Date(query.from)),
      );
    }
    if (query.to) {
      filters.push(
        DATE_ONLY_RE.test(query.to)
          ? sql`${conversations.lastMessageAt} < ((${query.to}::date + 1)::timestamp AT TIME ZONE ${timezone})`
          : lte(conversations.lastMessageAt, new Date(query.to)),
      );
    }

    if (query.search) {
      // User input is a literal: escape LIKE metacharacters instead of treating them as wildcards.
      const pattern = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
      filters.push(
        or(
          sql`${customers.displayName} ilike ${pattern} escape '\\'`,
          sql`${customers.externalUserId} ilike ${pattern} escape '\\'`,
          sql`exists (select 1 from messages m where m.conversation_id = ${conversations.id} and m.workspace_id = ${workspaceId} and m.content ilike ${pattern} escape '\\')`,
        )!,
      );
    }

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.at === null) {
        filters.push(and(isNull(conversations.lastMessageAt), lt(conversations.id, cursor.id))!);
      } else {
        const at = new Date(cursor.at);
        filters.push(
          or(
            // DESC NULLS LAST puts null timestamps after every non-null cursor.
            isNull(conversations.lastMessageAt),
            lt(conversations.lastMessageAt, at),
            and(eq(conversations.lastMessageAt, at), lt(conversations.id, cursor.id)),
          )!,
        );
      }
    }

    const rows = await this.db
      .select({
        id: conversations.id,
        mode: conversations.mode,
        fallbackCount: conversations.fallbackCount,
        messageCount: conversations.messageCount,
        lastMessageAt: conversations.lastMessageAt,
        lastInboundAt: conversations.lastInboundAt,
        botId: conversations.botId,
        assignedUserId: conversations.assignedUserId,
        customerId: customers.id,
        customerName: customers.displayName,
        externalUserId: customers.externalUserId,
        channelId: channels.id,
        channelName: channels.name,
        provider: channels.provider,
        botName: sql<
          string | null
        >`(select b.name from bots b where b.id = ${conversations.botId})`,
        assignedUserName: sql<
          string | null
        >`(select u.username from users u where u.id = ${conversations.assignedUserId})`,
        lastMessage: sql<
          string | null
        >`(select left(m.content, ${EXCERPT_LENGTH}) from messages m where m.conversation_id = ${conversations.id} order by m.created_at desc, m.id desc limit 1)`,
      })
      .from(conversations)
      .innerJoin(customers, eq(customers.id, conversations.customerId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(...filters))
      .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
    };
  }

  async options(workspaceId: string) {
    const [channelRows, botRows, memberRows] = await Promise.all([
      this.db
        .select({ id: channels.id, name: channels.name, status: channels.status })
        .from(channels)
        .where(eq(channels.workspaceId, workspaceId))
        .orderBy(asc(channels.name)),
      this.db
        .select({ id: bots.id, name: bots.name })
        .from(bots)
        .where(and(eq(bots.workspaceId, workspaceId), isNull(bots.deletedAt)))
        .orderBy(asc(bots.name)),
      this.db
        .select({ id: users.id, username: users.username, role: users.role })
        .from(users)
        .where(and(eq(users.workspaceId, workspaceId), isNull(users.disabledAt)))
        .orderBy(asc(users.username)),
    ]);
    return { channels: channelRows, bots: botRows, members: memberRows };
  }

  async detail(workspaceId: string, id: string) {
    const conversation = await this.getConversation(workspaceId, id);
    const [customer] = await this.db.select().from(customers).where(eq(customers.id, conversation.customerId)).limit(1);
    const [channel] = await this.db.select().from(channels).where(eq(channels.id, conversation.channelId)).limit(1);
    const [names] = await this.db
      .select({
        botName: sql<
          string | null
        >`(select b.name from bots b where b.id = ${conversations.botId})`,
        assignedUserName: sql<
          string | null
        >`(select u.username from users u where u.id = ${conversations.assignedUserId})`,
      })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    const thread = await this.db
      .select(this.messageColumns())
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(50);
    return {
      ...conversation,
      ...names,
      customer,
      channel: channel ? { id: channel.id, name: channel.name, provider: channel.provider } : null,
      messages: thread.reverse(),
    };
  }

  async messagesBefore(workspaceId: string, id: string, before?: string) {
    await this.getConversation(workspaceId, id);
    const filters = [eq(messages.conversationId, id)];
    if (before) {
      if (!UUID_RE.test(before)) throw new BadRequestException('before không hợp lệ');
      const [cursor] = await this.db
        .select({ createdAt: messages.createdAt, id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, id), eq(messages.id, before)))
        .limit(1);
      if (!cursor) throw new BadRequestException('before không hợp lệ');
      filters.push(sql`(${messages.createdAt}, ${messages.id}) < (${cursor.createdAt}, ${cursor.id})`);
    }
    const rows = await this.db
      .select(this.messageColumns())
      .from(messages)
      .where(and(...filters))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(50);
    return rows.reverse();
  }

  async takeover(workspaceId: string, id: string, userId: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(conversations)
        .set({ mode: 'human', assignedUserId: userId, updatedAt: new Date() })
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, id)))
        .returning();
      if (!row) throw new NotFoundException('Không tìm thấy hội thoại');
      const username = await this.username(tx, userId);
      await writeMessage(tx, {
        workspaceId,
        channelId: row.channelId,
        conversationId: row.id,
        direction: 'out',
        senderType: 'system',
        content: `${username} đã tiếp quản hội thoại`,
        status: 'sent',
        metadata: { kind: 'takeover', userId },
      });
      return row;
    });
  }

  async release(workspaceId: string, id: string, userId: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(conversations)
        .set({ mode: 'bot', assignedUserId: null, fallbackCount: 0, updatedAt: new Date() })
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, id)))
        .returning();
      if (!row) throw new NotFoundException('Không tìm thấy hội thoại');
      const username = await this.username(tx, userId);
      await writeMessage(tx, {
        workspaceId,
        channelId: row.channelId,
        conversationId: row.id,
        direction: 'out',
        senderType: 'system',
        content: `${username} đã trả hội thoại về cho bot`,
        status: 'sent',
        metadata: { kind: 'release', userId },
      });
      return row;
    });
  }

  async sendAgentMessage(workspaceId: string, id: string, userId: string, content: string) {
    const conversation = await this.getConversation(workspaceId, id);
    return this.db.transaction(async (tx) => {
      const message = await writeMessage(tx, {
        workspaceId,
        channelId: conversation.channelId,
        conversationId: conversation.id,
        direction: 'out',
        senderType: 'agent',
        senderUserId: userId,
        content,
        status: 'queued',
        metadata: { source: 'agent' },
      });
      await tx.insert(outbox).values({ workspaceId, kind: 'send_message', payload: { messageId: message.id } });
      return message;
    });
  }

  async stats(workspaceId: string) {
    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(conversations)
      .where(eq(conversations.workspaceId, workspaceId));
    const [{ human }] = await this.db
      .select({ human: sql<number>`count(*)::int` })
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.mode, 'human')));
    const [{ inboundToday }] = await this.db
      .select({ inboundToday: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.direction, 'in'),
          sql`${messages.createdAt} >= date_trunc('day', now())`,
        ),
      );
    const [{ outboundToday }] = await this.db
      .select({ outboundToday: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.direction, 'out'),
          sql`${messages.createdAt} >= date_trunc('day', now())`,
        ),
      );
    return { conversations: total, humanMode: human, inboundToday, outboundToday };
  }

  async health() {
    const [{ lag }] = await this.db
      .select({ lag: sql<number>`count(*)::int` })
      .from(outbox)
      .where(eq(outbox.status, 'pending'));
    return { outboxPending: lag };
  }

  private messageColumns() {
    return {
      id: messages.id,
      direction: messages.direction,
      senderType: messages.senderType,
      senderUserId: messages.senderUserId,
      botId: messages.botId,
      contentType: messages.contentType,
      content: messages.content,
      providerMessageId: messages.providerMessageId,
      status: messages.status,
      errorCode: messages.errorCode,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
      senderName: sql<string>`case
        when ${messages.senderType} = 'customer' then 'Khách'
        when ${messages.senderType} = 'system' then 'Hệ thống'
        when ${messages.metadata}->>'via' = 'page_inbox' then 'Page Inbox'
        when ${messages.senderType} = 'bot' then coalesce((select b.name from bots b where b.id = ${messages.botId}), 'AI agent')
        when ${messages.senderType} = 'agent' then coalesce((select u.username from users u where u.id = ${messages.senderUserId}), 'Nhân viên')
        else ${messages.senderType}
      end`,
    };
  }

  private async username(tx: Db, userId: string) {
    const [user] = await tx.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1);
    return user?.username ?? 'Nhân viên';
  }

  private async workspaceTimezone(workspaceId: string) {
    const [row] = await this.db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return row?.timezone ?? 'Asia/Ho_Chi_Minh';
  }

  private async getConversation(workspaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Không tìm thấy hội thoại');
    return row;
  }
}
