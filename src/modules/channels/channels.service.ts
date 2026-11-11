import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { channels, bots, conversations, customers, webhookEvents, workspaces } from '../../db/schema';
import { decryptCredential, encryptCredential } from '../../common/crypto';
import { uuidv7 } from '../../common/uuidv7';
import { AdapterChannel, MessengerProfile, Provider, SendError } from './adapter.types';
import { AdapterRegistry } from './adapter.registry';

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: string }).code === '23505') return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

export interface ChannelInput {
  provider: Provider;
  name: string;
  externalId: string;
  credentials: Record<string, string>;
  botId?: string | null;
  status?: 'active' | 'disabled';
  config?: Record<string, unknown>;
  credentialExpiresAt?: string | null;
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly adapters: AdapterRegistry,
  ) {}

  async list(workspaceId: string) {
    const [workspace] = await this.db
      .select({ maxChannels: workspaces.maxChannels })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const rows = await this.db
      .select()
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId))
      .orderBy(channels.createdAt);
    return { items: rows.map((row) => this.toPublic(row)), maxChannels: workspace?.maxChannels ?? 0 };
  }

  async create(workspaceId: string, input: ChannelInput) {
    if (!input.botId) throw new BadRequestException('Kênh phải chọn AI agent');
    if (input.provider === 'messenger') {
      const token = input.config?.verifyToken;
      // The verify token is what routes Meta's subscribe handshake, so it must be long and unguessable.
      if (typeof token !== 'string' || token.length < 16) {
        input = { ...input, config: { ...input.config, verifyToken: randomBytes(16).toString('hex') } };
      }
    }
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the workspace row so concurrent creates cannot both pass the plan limit.
        const [workspace] = await tx
          .select({ maxChannels: workspaces.maxChannels })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .for('update');
        if (!workspace) throw new NotFoundException('Không tìm thấy workspace');

        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(channels)
          .where(and(eq(channels.workspaceId, workspaceId), ne(channels.status, 'disabled')));
        if (count >= workspace.maxChannels) throw new ForbiddenException('Gói thuê đã đạt giới hạn số kênh');

        await this.assertBot(workspaceId, input.botId!, tx);
        const id = uuidv7();
        const [row] = await tx
          .insert(channels)
          .values({
            id,
            workspaceId,
            provider: input.provider,
            name: input.name,
            externalId: input.externalId,
            botId: input.botId,
            config: input.config ?? {},
            credentialsEnc: this.encrypt(input.credentials, id),
            keyId: this.config.getOrThrow<string>('CREDENTIAL_KEY_ID'),
            credentialExpiresAt: input.credentialExpiresAt ? new Date(input.credentialExpiresAt) : null,
          })
          .returning();
        return this.toPublic(row);
      });
    } catch (err) {
      this.throwIfDuplicateChannel(err);
      throw err;
    }
  }

  async update(workspaceId: string, id: string, input: Partial<ChannelInput>) {
    const existing = await this.getRow(workspaceId, id);
    if (input.botId) await this.assertBot(workspaceId, input.botId);

    const effectiveBotId = input.botId !== undefined ? input.botId : existing.botId;
    const effectiveStatus = input.status ?? existing.status;
    if (effectiveStatus === 'active' && !effectiveBotId) {
      throw new BadRequestException('Kênh đang hoạt động phải chọn AI agent');
    }

    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) values.name = input.name;
    if (input.externalId !== undefined) values.externalId = input.externalId;
    if (input.botId !== undefined) values.botId = input.botId;
    if (input.status !== undefined) values.status = input.status;
    if (input.config !== undefined) {
      // The menu is edited through its own endpoint; a general edit must not wipe it.
      const kept = (existing.config as Record<string, unknown> | null)?.messengerProfile;
      values.config = kept !== undefined ? { messengerProfile: kept, ...input.config } : input.config;
    }
    if (input.credentialExpiresAt !== undefined) {
      values.credentialExpiresAt = input.credentialExpiresAt ? new Date(input.credentialExpiresAt) : null;
    }
    if (input.credentials !== undefined) {
      values.credentialsEnc = this.encrypt(input.credentials, existing.id);
      values.keyId = this.config.getOrThrow<string>('CREDENTIAL_KEY_ID');
    }

    try {
      // Reactivating a disabled channel must obey the plan limit too.
      if (existing.status !== 'active' && effectiveStatus === 'active') {
        return this.toPublic(await this.activate(workspaceId, id, values));
      }
      const [row] = await this.db
        .update(channels)
        .set(values)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, id)))
        .returning();
      return this.toPublic(row);
    } catch (err) {
      this.throwIfDuplicateChannel(err);
      throw err;
    }
  }

  /** History references the channel, so a used channel is disabled instead of deleted. */
  async remove(workspaceId: string, id: string) {
    const row = await this.getRow(workspaceId, id);
    const [{ used }] = await this.db
      .select({ used: sql<number>`count(*)::int` })
      .from(conversations)
      .where(eq(conversations.channelId, id));
    const [{ knownCustomers }] = await this.db
      .select({ knownCustomers: sql<number>`count(*)::int` })
      .from(customers)
      .where(eq(customers.channelId, id));
    // Webhook events are kept for retry/audit and also block a hard delete.
    const [{ events }] = await this.db
      .select({ events: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .where(eq(webhookEvents.channelId, id));
    if (used > 0 || knownCustomers > 0 || events > 0) {
      await this.db.update(channels).set({ status: 'disabled', updatedAt: new Date() }).where(eq(channels.id, id));
      return { ok: true, disabled: true, status: 'disabled' };
    }
    await this.db.delete(channels).where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, row.id)));
    return { ok: true, disabled: false };
  }

  async test(workspaceId: string, id: string) {
    const row = await this.getRow(workspaceId, id);
    const adapter = this.adapters.get(row.provider as Provider);
    const result = await adapter.healthCheck(this.toAdapterChannel(row)).catch((err) => ({
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown',
    }));
    // A health check never re-enables a channel the tenant disabled on purpose.
    if (row.status === 'disabled') return result;

    try {
      if (result.ok && row.botId) {
        if (row.status !== 'active') await this.activate(workspaceId, id);
      } else {
        await this.db.update(channels).set({ status: 'error', updatedAt: new Date() }).where(eq(channels.id, id));
      }
    } catch (err) {
      this.throwIfDuplicateChannel(err);
      throw err;
    }
    return result;
  }

  /** Pushes Get Started + persistent menu to Meta first; it is saved only when Meta accepted it. */
  async updateMessengerProfile(workspaceId: string, id: string, profile: MessengerProfile) {
    const row = await this.getRow(workspaceId, id);
    const adapter = this.adapters.get(row.provider as Provider);
    if (!adapter.syncProfile) {
      throw new BadRequestException({
        code: 'PROFILE_NOT_SUPPORTED',
        message: `Kênh ${row.provider} không hỗ trợ nút Bắt đầu và menu cố định, chỉ kênh Messenger có.`,
      });
    }
    try {
      await adapter.syncProfile(this.toAdapterChannel(row), profile);
    } catch (err) {
      if (!(err instanceof SendError)) throw err;
      this.logger.warn({ msg: 'Đồng bộ Messenger profile thất bại', workspaceId, channelId: id, code: err.code, error: err.message });
      throw new BadRequestException({ code: 'PROFILE_SYNC_FAILED', message: err.message });
    }
    const config = { ...((row.config ?? {}) as Record<string, unknown>), messengerProfile: profile };
    const [updated] = await this.db
      .update(channels)
      .set({ config, updatedAt: new Date() })
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, id)))
      .returning();
    return this.toPublic(updated);
  }

  async findForWebhook(provider: Provider, externalId: string) {
    const [row] = await this.db
      .select()
      .from(channels)
      .where(
        and(eq(channels.provider, provider), eq(channels.externalId, externalId), ne(channels.status, 'disabled')),
      )
      .limit(1);
    return row ? this.toAdapterChannel(row) : null;
  }

  /** Meta's subscribe handshake only carries the verify token, so that is how the channel is found. */
  async hasVerifyToken(provider: Provider, token: string): Promise<boolean> {
    if (!token) return false;
    const [row] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.provider, provider), sql`${channels.config}->>'verifyToken' = ${token}`))
      .limit(1);
    return !!row;
  }

  /**
   * A disabled channel still stores inbound messages when no live tenant owns the
   * Page. Ambiguous ownership (more than one disabled row) is dropped, never guessed.
   */
  async findDisabledForWebhook(provider: Provider, externalId: string) {
    const rows = await this.db
      .select()
      .from(channels)
      .where(
        and(eq(channels.provider, provider), eq(channels.externalId, externalId), eq(channels.status, 'disabled')),
      )
      .limit(2);
    if (rows.length > 1) {
      this.logger.warn(`Bỏ qua webhook ${provider}/${externalId}: có nhiều kênh disabled trùng`);
      return null;
    }
    return rows.length === 1 ? this.toAdapterChannel(rows[0]) : null;
  }

  async getAdapterChannel(workspaceId: string, id: string) {
    return this.toAdapterChannel(await this.getRow(workspaceId, id));
  }

  /** Internal worker lookup: the webhook event already carries the channel id. */
  async getAdapterChannelById(id: string): Promise<AdapterChannel | null> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id)).limit(1);
    return row ? this.toAdapterChannel(row) : null;
  }

  /**
   * Single path for every disabled/error → active transition: lock the workspace
   * and count non-disabled channels (excluding this one) before enforcing the plan.
   */
  private async activate(workspaceId: string, id: string, values: Record<string, unknown> = {}) {
    return this.db.transaction(async (tx) => {
      const [workspace] = await tx
        .select({ maxChannels: workspaces.maxChannels })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('update');
      if (!workspace) throw new NotFoundException('Không tìm thấy workspace');

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(channels)
        .where(
          and(eq(channels.workspaceId, workspaceId), ne(channels.status, 'disabled'), ne(channels.id, id)),
        );
      if (count >= workspace.maxChannels) throw new ForbiddenException('Gói thuê đã đạt giới hạn số kênh');

      const [row] = await tx
        .update(channels)
        .set({ ...values, status: 'active', updatedAt: new Date() })
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, id)))
        .returning();
      if (!row) throw new NotFoundException('Không tìm thấy kênh');
      return row;
    });
  }

  private throwIfDuplicateChannel(err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ConflictException('Page/OA ID này đã được kết nối ở một kênh khác');
    }
  }

  private async assertBot(workspaceId: string, botId: string, db: Db = this.db) {
    const [bot] = await db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.workspaceId, workspaceId), eq(bots.id, botId), isNull(bots.deletedAt)))
      .limit(1);
    if (!bot) throw new BadRequestException('AI agent không thuộc workspace này');
  }

  private async getRow(workspaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Không tìm thấy kênh');
    return row;
  }

  private encrypt(credentials: Record<string, string>, channelId: string) {
    return encryptCredential(
      JSON.stringify(credentials ?? {}),
      channelId,
      this.config.getOrThrow<string>('CREDENTIAL_KEY'),
      this.config.getOrThrow<string>('CREDENTIAL_KEY_ID'),
    );
  }

  private decrypt(row: typeof channels.$inferSelect): Record<string, string> {
    if (!row.credentialsEnc) return {};
    try {
      return JSON.parse(decryptCredential(row.credentialsEnc, row.id, this.config.getOrThrow<string>('CREDENTIAL_KEY')));
    } catch {
      throw new BadRequestException('Không giải mã được credential của kênh');
    }
  }

  private toAdapterChannel(row: typeof channels.$inferSelect): AdapterChannel {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider as Provider,
      externalId: row.externalId,
      status: row.status,
      botId: row.botId,
      config: (row.config ?? {}) as Record<string, unknown>,
      credentials: this.decrypt(row),
      credentialExpiresAt: row.credentialExpiresAt,
    };
  }

  private toPublic(row: typeof channels.$inferSelect) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      name: row.name,
      externalId: row.externalId,
      botId: row.botId,
      status: row.status,
      config: row.config,
      credentialExpiresAt: row.credentialExpiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
