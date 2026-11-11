import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { and, count, desc, eq, ilike, or, sql, SQL } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { bots, sessions, users, workspaces } from '../../db/schema';
import { AuditActor, AuditService } from '../audit/audit.service';

export const TENANT_STATUSES = ['trial', 'active', 'suspended', 'expired'] as const;

export interface TenantListQuery {
  page: number;
  pageSize: number;
  q?: string;
  status?: (typeof TENANT_STATUSES)[number];
}

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Scalar subqueries keep one row per tenant even with many bots/owners. */
  async list(query: TenantListQuery) {
    const ownerUsername = sql<string | null>`(select u.username from users u where u.workspace_id = workspaces.id and u.role = 'owner' order by u.created_at limit 1)`;
    const filters: SQL[] = [eq(workspaces.isPlatform, false)];
    if (query.status) filters.push(eq(workspaces.status, query.status));
    const q = query.q?.trim();
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      filters.push(
        or(
          ilike(workspaces.name, like),
          sql`exists (select 1 from users u where u.workspace_id = workspaces.id and u.username ilike ${like})`,
        ) as SQL,
      );
    }
    const where = and(...filters);
    const [items, [{ total }]] = await Promise.all([
      this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        status: workspaces.status,
        plan: workspaces.plan,
        maxBots: workspaces.maxBots,
        maxChannels: workspaces.maxChannels,
        expiresAt: workspaces.expiresAt,
        createdAt: workspaces.createdAt,
        username: ownerUsername,
        bots: sql<number>`(select count(*)::int from bots b where b.workspace_id = workspaces.id and b.deleted_at is null)`,
        channels: sql<number>`(select count(*)::int from channels c where c.workspace_id = workspaces.id)`,
        conversations: sql<number>`(select count(*)::int from conversations cv where cv.workspace_id = workspaces.id)`,
        messagesThisMonth: sql<number>`(select count(*)::int from messages m where m.workspace_id = workspaces.id and m.created_at >= date_trunc('month', now()))`,
      })
      .from(workspaces)
      .where(where)
      .orderBy(desc(workspaces.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: count() }).from(workspaces).where(where),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async create(input: CreateTenantInput, actor: AuditActor, source: 'admin' | 'signup' = 'admin') {
    const username = input.username.trim().toLowerCase();
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) throw new BadRequestException('Tên đăng nhập đã tồn tại');

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    const created = await this.db.transaction(async (tx) => {
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
    await this.audit.record(source === 'signup' ? { ...actor, username: created.username } : actor, {
      action: source === 'signup' ? 'tenant.signup' : 'tenant.created',
      workspaceId: created.id,
      target: { type: 'tenant', id: created.id, label: created.name },
      metadata: { owner: created.username, plan: created.plan, expiresAt: created.expiresAt },
    });
    return created;
  }

  async update(id: string, input: UpdateTenantInput, actor: AuditActor) {
    const before = await this.getRow(id);
    const values: Record<string, unknown> = {};
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.plan !== undefined) values.plan = input.plan.trim();
    if (input.maxBots !== undefined) values.maxBots = input.maxBots;
    if (input.maxChannels !== undefined) values.maxChannels = input.maxChannels;
    if (input.expiresAt !== undefined) values.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (Object.keys(values).length) {
      await this.db.update(workspaces).set(values).where(eq(workspaces.id, id));
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, to] of Object.entries(values)) {
        const from = before[key as keyof typeof before];
        if (String(from ?? '') !== String(to ?? '')) changes[key] = { from, to };
      }
      if (Object.keys(changes).length) {
        await this.audit.record(actor, {
          action: 'tenant.updated',
          workspaceId: id,
          target: { type: 'tenant', id, label: (values.name as string | undefined) ?? before.name },
          metadata: { changes },
        });
      }
    }
    return { ok: true };
  }

  async suspend(id: string, actor: AuditActor) {
    return this.setStatus(id, 'suspended', actor);
  }

  async resume(id: string, actor: AuditActor) {
    return this.setStatus(id, 'active', actor);
  }

  async resetOwnerPassword(id: string, password: string, actor: AuditActor) {
    const tenant = await this.getRow(id);
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
    await this.audit.record(actor, {
      action: 'tenant.owner_password_reset',
      workspaceId: id,
      target: { type: 'tenant', id, label: tenant.name },
      metadata: { owner: owner.username },
    });
    return { ok: true };
  }

  private async setStatus(id: string, status: 'suspended' | 'active', actor: AuditActor) {
    const tenant = await this.getRow(id);
    await this.db.update(workspaces).set({ status }).where(eq(workspaces.id, id));
    await this.audit.record(actor, {
      action: status === 'suspended' ? 'tenant.suspended' : 'tenant.resumed',
      workspaceId: id,
      target: { type: 'tenant', id, label: tenant.name },
      metadata: { from: tenant.status, to: status },
    });
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
