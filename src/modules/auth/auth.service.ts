import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { and, eq, gt } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DRIZZLE, Db } from '../../db/db.module';
import { sessions, users, workspaces } from '../../db/schema';
import { AuthUser } from '../../common/current-user.decorator';
import { randomToken, sha256Hex } from '../../common/crypto';
import { tenantBlocked } from '../../common/tenant-status';

const SESSION_DAYS = 7;

@Injectable()
export class AuthService {
  readonly cookieName: string;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
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
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
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
    return { token, expiresAt, user: this.toAuthUser(user) };
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
