import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { and, eq, gt, ne } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DRIZZLE, Db } from '../../db/db.module';
import { sessions, users, workspaces } from '../../db/schema';
import { AuthUser } from '../../common/current-user.decorator';
import { randomToken, sha256Hex } from '../../common/crypto';
import { tenantBlocked } from '../../common/tenant-status';
import { AuditService } from '../audit/audit.service';

/** At least 8 characters with both letters and digits. Mirrored in admin/app/routes/shared/account.tsx. */
export const PASSWORD_RULE = /^(?=.*[A-Za-zÀ-ỹ])(?=.*\d).{8,128}$/;
export const PASSWORD_RULE_MESSAGE = 'Mật khẩu mới cần 8-128 ký tự, có cả chữ và số';

const SESSION_DAYS = 7;

/** Hash of a random secret, same params as real password hashes; built once on first use. */
let dummyHashPromise: Promise<string> | undefined;
const dummyHash = () => (dummyHashPromise ??= argon2.hash(randomToken(), { type: argon2.argon2id }));

@Injectable()
export class AuthService {
  readonly cookieName: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    this.cookieName = config.getOrThrow<string>('NODE_ENV') === 'production' ? '__Host-bv_session' : 'bv_session';
  }

  cookieOptions() {
    const secure = this.config.getOrThrow<string>('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    };
  }

  async login(username: string, password: string, ip?: string, userAgent?: string) {
    const [row] = await this.db
      .select({ user: users, status: workspaces.status, expiresAt: workspaces.expiresAt })
      .from(users)
      .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
      .where(eq(users.username, username.trim().toLowerCase()))
      .limit(1);
    const user = row?.user;
    // Unknown user still pays one argon2 verify, so response time does not reveal which usernames exist.
    const passwordOk = await argon2.verify(user?.passwordHash ?? (await dummyHash()), password);
    if (!user || !passwordOk) {
      await this.audit.record(
        { user: null, ip, username: username.trim().toLowerCase() },
        { action: 'auth.login_failed', workspaceId: user?.workspaceId ?? null, metadata: { reason: user ? 'wrong_password' : 'unknown_user' } },
      );
      throw new UnauthorizedException('Tên đăng nhập hoặc mật khẩu không đúng');
    }
    if (user.disabledAt) throw new ForbiddenException('Tài khoản đã bị vô hiệu hoá');
    if (user.role !== 'admin' && tenantBlocked(row.status, row.expiresAt)) {
      throw new ForbiddenException('Tài khoản đã bị khóa hoặc hết hạn');
    }
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
    await this.db.insert(sessions).values({
      userId: user.id,
      tokenHash: sha256Hex(token),
      expiresAt,
      ip: ip?.slice(0, 64),
      userAgent: userAgent?.slice(0, 256),
    });
    const authUser = this.toAuthUser(user);
    await this.audit.record({ user: authUser, ip }, { action: 'auth.login', metadata: { userAgent: userAgent?.slice(0, 256) } });
    return { token, expiresAt, user: authUser };
  }

  /** Verifies the current password, stores the new one and ends every other session of this user. */
  async changePassword(user: AuthUser, currentToken: string, currentPassword: string, newPassword: string, ip?: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!row) throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    if (!(await argon2.verify(row.passwordHash, currentPassword))) {
      throw new BadRequestException({
        message: 'Mật khẩu hiện tại không đúng',
        errors: [{ field: 'currentPassword', message: 'Mật khẩu hiện tại không đúng' }],
      });
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException({
        message: 'Mật khẩu mới phải khác mật khẩu hiện tại',
        errors: [{ field: 'newPassword', message: 'Mật khẩu mới phải khác mật khẩu hiện tại' }],
      });
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const revoked = await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      return this.deleteOtherSessions(tx, user.id, currentToken);
    });
    await this.audit.record({ user, ip }, { action: 'auth.password_changed', metadata: { revokedSessions: revoked } });
    return { ok: true, revokedSessions: revoked };
  }

  async logoutOthers(user: AuthUser, currentToken: string, ip?: string) {
    const revoked = await this.deleteOtherSessions(this.db, user.id, currentToken);
    await this.audit.record({ user, ip }, { action: 'auth.sessions_revoked', metadata: { revokedSessions: revoked } });
    return { ok: true, revokedSessions: revoked };
  }

  private async deleteOtherSessions(db: Pick<Db, 'delete'>, userId: string, currentToken: string) {
    const deleted = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, sha256Hex(currentToken))))
      .returning({ id: sessions.id });
    return deleted.length;
  }

  async logout(token?: string) {
    if (token) await this.db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
  }

  async resolveSession(token?: string): Promise<AuthUser | null> {
    if (!token) return null;
    const [row] = await this.db
      .select({ user: users, status: workspaces.status, expiresAt: workspaces.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
      .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return null;
    if (row.user.disabledAt) return null;
    const user = this.toAuthUser(row.user);
    if (user.role !== 'admin' && tenantBlocked(row.status, row.expiresAt)) return null;
    return user;
  }

  private toAuthUser(user: typeof users.$inferSelect): AuthUser {
    return {
      id: user.id,
      workspaceId: user.workspaceId,
      username: user.username,
      role: user.role as 'admin' | 'owner',
    };
  }
}
