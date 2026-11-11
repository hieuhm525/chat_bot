import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, SQL } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { auditLogs } from '../../db/schema';
import { AuthUser } from '../../common/current-user.decorator';

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.password_changed',
  'auth.sessions_revoked',
  'tenant.created',
  'tenant.signup',
  'tenant.updated',
  'tenant.suspended',
  'tenant.resumed',
  'tenant.owner_password_reset',
  'provider.created',
  'provider.updated',
  'provider.deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Who triggered an action and from where. `user` is null for anonymous events such as a failed login. */
export interface AuditActor {
  user: AuthUser | null;
  ip?: string;
  /** Used when there is no logged-in user, e.g. the username typed at a failed login. */
  username?: string;
}

export interface AuditEntry {
  action: AuditAction;
  workspaceId?: string | null;
  target?: { type: string; id: string; label?: string | null };
  metadata?: Record<string, unknown>;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  action?: string;
  q?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Writes one audit row. The business action has already succeeded by the time
   * this runs, so a failed write is logged as an error instead of failing the request.
   */
  async record(actor: AuditActor, entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        actorUserId: actor.user?.id ?? null,
        actorUsername: actor.user?.username ?? actor.username?.slice(0, 64) ?? null,
        workspaceId: entry.workspaceId ?? actor.user?.workspaceId ?? null,
        action: entry.action,
        targetType: entry.target?.type ?? null,
        targetId: entry.target?.id ?? null,
        targetLabel: entry.target?.label ?? null,
        metadata: entry.metadata ?? {},
        ip: actor.ip?.slice(0, 64) ?? null,
      });
    } catch (err) {
      this.logger.error(
        {
          msg: 'Ghi audit log thất bại, thao tác chính vẫn đã thực hiện',
          action: entry.action,
          actorUserId: actor.user?.id,
          targetType: entry.target?.type,
          targetId: entry.target?.id,
          err,
        },
      );
    }
  }

  async list(query: AuditQuery) {
    const filters: SQL[] = [];
    if (query.action) filters.push(eq(auditLogs.action, query.action));
    const q = query.q?.trim();
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      filters.push(or(ilike(auditLogs.actorUsername, like), ilike(auditLogs.targetLabel, like)) as SQL);
    }
    const where = filters.length ? and(...filters) : undefined;
    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: count() }).from(auditLogs).where(where),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
