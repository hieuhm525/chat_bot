import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { bots, sessions, users, workspaces } from '../../db/schema';

export interface CreateTenantInput {
  name: string;
  username: string;
  password: string;
  plan?: string;
  maxBots?: number;
  maxChannels?: number;
  expiresAt?: string | null;
}

export interface UpdateTenantInput {
  name?: string;
  plan?: string;
  maxBots?: number;
  maxChannels?: number;
  expiresAt?: string | null;
}

@Injectable()
export class TenantsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Scalar subqueries keep one row per tenant even with many bots/owners. */
  list() {
    return this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        status: workspaces.status,
        plan: workspaces.plan,
        maxBots: workspaces.maxBots,
        maxChannels: workspaces.maxChannels,
        expiresAt: workspaces.expiresAt,
        createdAt: workspaces.createdAt,
        username: sql<
          string | null
        >`(select u.username from users u where u.workspace_id = workspaces.id and u.role = 'owner' order by u.created_at limit 1)`,
        bots: sql<number>`(select count(*)::int from bots b where b.workspace_id = workspaces.id and b.deleted_at is null)`,
        channels: sql<number>`(select count(*)::int from channels c where c.workspace_id = workspaces.id)`,
        conversations: sql<number>`(select count(*)::int from conversations cv where cv.workspace_id = workspaces.id)`,
        messagesThisMonth: sql<number>`(select count(*)::int from messages m where m.workspace_id = workspaces.id and m.created_at >= date_trunc('month', now()))`,
      })
      .from(workspaces)
      .where(eq(workspaces.isPlatform, false))
      .orderBy(desc(workspaces.createdAt));
  }

  async create(input: CreateTenantInput) {
    const username = input.username.trim().toLowerCase();
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) throw new BadRequestException('Tên đăng nhập đã tồn tại');

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    return this.db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          name: input.name.trim(),
          plan: input.plan?.trim() || 'trial',
          maxBots: input.maxBots ?? 1,
          maxChannels: input.maxChannels ?? 1,
          expiresAt,
        })
        .returning();
      await tx.insert(bots).values({ workspaceId: workspace.id, name: 'CSKH' });
      const [user] = await tx
        .insert(users)
        .values({ workspaceId: workspace.id, username, passwordHash, role: 'owner' })
        .returning();
      return {
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        plan: workspace.plan,
        maxBots: workspace.maxBots,
        maxChannels: workspace.maxChannels,
        expiresAt: workspace.expiresAt,
        createdAt: workspace.createdAt,
        username: user.username,
        bots: 1,
        channels: 0,
        conversations: 0,
        messagesThisMonth: 0,
      };
    });
  }

  async update(id: string, input: UpdateTenantInput) {
    await this.getRow(id);
    const values: Record<string, unknown> = {};
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.plan !== undefined) values.plan = input.plan.trim();
    if (input.maxBots !== undefined) values.maxBots = input.maxBots;
    if (input.maxChannels !== undefined) values.maxChannels = input.maxChannels;
    if (input.expiresAt !== undefined) values.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (Object.keys(values).length) {
      await this.db.update(workspaces).set(values).where(eq(workspaces.id, id));
    }
    return { ok: true };
  }

  async suspend(id: string) {
    return this.setStatus(id, 'suspended');
  }

  async resume(id: string) {
    return this.setStatus(id, 'active');
  }

  async resetOwnerPassword(id: string, password: string) {
    await this.getRow(id);
    const [owner] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.workspaceId, id), eq(users.role, 'owner')))
      .orderBy(users.createdAt)
      .limit(1);
    if (!owner) throw new NotFoundException('Tenant chưa có tài khoản owner');

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, owner.id));
      await tx.delete(sessions).where(eq(sessions.userId, owner.id));
    });
    return { ok: true };
  }

  private async setStatus(id: string, status: 'suspended' | 'active') {
    await this.getRow(id);
    await this.db.update(workspaces).set({ status }).where(eq(workspaces.id, id));
    return { ok: true, status };
  }

  private async getRow(id: string) {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.isPlatform, false)))
      .limit(1);
    if (!row) throw new NotFoundException('Không tìm thấy tenant');
    return row;
  }
}
