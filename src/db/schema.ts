import { sql } from 'drizzle-orm';
import { DEFAULT_SYSTEM_PROMPT } from '../common/bot-defaults';
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    isPlatform: boolean('is_platform').notNull().default(false),
    status: text('status').notNull().default('trial'),
    plan: text('plan').notNull().default('trial'),
    maxBots: integer('max_bots').notNull().default(1),
    maxChannels: integer('max_channels').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [check('workspaces_status_check', sql`${t.status} in ('trial','active','suspended','expired')`)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('owner'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt,
  },
  (t) => [check('users_role_check', sql`${t.role} in ('admin','owner')`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt,
  },
  (t) => [index('sessions_expires_idx').on(t.expiresAt)],
);

export const bots = pgTable('bots', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  greeting: text('greeting').notNull().default(''),
  fallbackMessage: text('fallback_message').notNull().default('Dạ em chưa có thông tin này, anh/chị chờ nhân viên hỗ trợ ạ.'),
  handoffMessage: text('handoff_message').notNull().default('Em đã chuyển anh/chị tới nhân viên hỗ trợ ạ.'),
  llmEnabled: boolean('llm_enabled').notNull().default(true),
  systemPrompt: text('system_prompt').notNull().default(DEFAULT_SYSTEM_PROMPT),
  pauseAfterFallbacks: integer('pause_after_fallbacks').notNull().default(3),
  /** Buttons shown under the greeting; tapping one sends its title as a normal message. */
  greetingQuickReplies: text('greeting_quick_replies').array().notNull().default(sql`'{}'::text[]`),
  /** Sent when the LLM is slow so the customer knows the bot is working; empty turns it off. */
  waitMessage: text('wait_message').notNull().default('Dạ anh/chị chờ em một chút, em đang kiểm tra thông tin ạ.'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    externalId: text('external_id').notNull(),
    botId: uuid('bot_id').references(() => bots.id),
    status: text('status').notNull().default('active'),
    credentialsEnc: text('credentials_enc'),
    keyId: text('key_id'),
    credentialExpiresAt: timestamp('credential_expires_at', { withTimezone: true }),
    config: jsonb('config').notNull().default({}),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique('channels_workspace_provider_external_uq').on(t.workspaceId, t.provider, t.externalId),
    // One live Page/OA id may only belong to one tenant, so a webhook always resolves to one workspace.
    uniqueIndex('channels_provider_external_active_uq')
      .on(t.provider, t.externalId)
      .where(sql`${t.status} <> 'disabled'`),
    check('channels_provider_check', sql`${t.provider} in ('messenger','zalo','whatsapp')`),
    check('channels_status_check', sql`${t.status} in ('active','error','disabled')`),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    channelId: uuid('channel_id').notNull().references(() => channels.id),
    externalUserId: text('external_user_id').notNull(),
    displayName: text('display_name'),
    profile: jsonb('profile').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('customers_channel_external_uq').on(t.channelId, t.externalUserId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    channelId: uuid('channel_id').notNull().references(() => channels.id),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    externalThreadId: text('external_thread_id').notNull(),
    mode: text('mode').notNull().default('bot'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id),
    botId: uuid('bot_id').references(() => bots.id),
    messageCount: integer('message_count').notNull().default(0),
    fallbackCount: integer('fallback_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique('conversations_channel_thread_uq').on(t.channelId, t.externalThreadId),
    unique('conversations_channel_id_id_uq').on(t.channelId, t.id),
    index('conversations_workspace_last_message_idx').on(t.workspaceId, t.lastMessageAt),
    check('conversations_mode_check', sql`${t.mode} in ('bot','human','off')`),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
    channelId: uuid('channel_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    direction: text('direction').notNull(),
    senderType: text('sender_type').notNull(),
    senderUserId: uuid('sender_user_id').references(() => users.id),
    botId: uuid('bot_id').references(() => bots.id),
    contentType: text('content_type').notNull().default('text'),
    content: text('content').notNull().default(''),
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull().default('received'),
    errorCode: text('error_code'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt,
    updatedAt,
  },
  (t) => [
    foreignKey({
      columns: [t.channelId, t.conversationId],
      foreignColumns: [conversations.channelId, conversations.id],
      name: 'messages_conversation_channel_fk',
    }),
    uniqueIndex('messages_channel_provider_msg_uq')
      .on(t.channelId, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    index('messages_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('messages_content_trgm_idx').using('gin', sql`${t.content} gin_trgm_ops`),
    check('messages_direction_check', sql`${t.direction} in ('in','out')`),
    check('messages_sender_check', sql`${t.senderType} in ('customer','bot','agent','system')`),
    // Page Inbox replies are typed by a human we cannot identify, so they are the only userId-less agent messages.
    check(
      'messages_sender_user_check',
      sql`${t.senderType} <> 'agent' or ${t.senderUserId} is not null or ${t.metadata}->>'via' = 'page_inbox'`,
    ),
    check('messages_bot_check', sql`${t.senderType} <> 'bot' or ${t.botId} is not null`),
    check('messages_content_type_check', sql`${t.contentType} in ('text','image','file','unsupported')`),
    check(
      'messages_status_check',
      sql`${t.status} in ('received','queued','sent','delivered','read','failed','blocked_by_policy')`,
    ),
  ],
);

export const llmProviders = pgTable(
  'llm_providers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('openai_compatible'),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    apiKeyEnc: text('api_key_enc'),
    keyId: text('key_id'),
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    lastCheckOk: boolean('last_check_ok'),
    lastError: text('last_error'),
    createdAt,
    updatedAt,
  },
  (t) => [check('llm_providers_kind_check', sql`${t.kind} in ('openai_compatible')`)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    channelId: uuid('channel_id').references(() => channels.id),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    unique('webhook_events_channel_event_uq').on(t.channelId, t.providerEventId),
    index('webhook_events_received_idx').on(t.receivedAt),
  ],
);

export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt,
  },
  (t) => [
    check('outbox_kind_check', sql`${t.kind} in ('process_event','send_message')`),
    check('outbox_status_check', sql`${t.status} in ('pending','running','done','failed')`),
    index('outbox_poll_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} in ('pending','running')`),
  ],
);

export const botRules = pgTable(
  'bot_rules',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keywords: text('keywords').array().notNull(),
    matchMode: text('match_mode').notNull().default('contains'),
    priority: integer('priority').notNull().default(0),
    answer: text('answer').notNull(),
    /** Buttons shown under the answer (Messenger quick replies). */
    quickReplies: text('quick_replies').array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt,
    updatedAt,
  },
  (t) => [
    check('bot_rules_match_mode_check', sql`${t.matchMode} in ('contains','exact')`),
    index('bot_rules_keywords_gin').using('gin', t.keywords),
    index('bot_rules_bot_priority_idx').on(t.botId, t.priority),
  ],
);
