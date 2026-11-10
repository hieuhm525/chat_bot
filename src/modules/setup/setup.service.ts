import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { DRIZZLE, Db } from '../../db/db.module';
import { users, workspaces } from '../../db/schema';
import { AuthService } from '../auth/auth.service';
import { safeEqualHex, sha256Hex } from '../../common/crypto';

export interface SetupInput {
  username: string;
  password: string;
  confirmPassword: string;
  setupToken?: string;
}

@Injectable()
export class SetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  async status(req: Request) {
    const [{ count }] = await this.db.select({ count: sql<number>`count(*)::int` }).from(users);
    const needsSetup = count === 0;
    const tokenRequired = !!this.config.getOrThrow<string>('SETUP_TOKEN');
    return {
      needsSetup,
      tokenRequired,
      localOnly: !tokenRequired,
      allowed: needsSetup && (tokenRequired || this.isLocal(req)),
    };
  }

  async create(input: SetupInput, req: Request) {
    const [{ count }] = await this.db.select({ count: sql<number>`count(*)::int` }).from(users);
    if (count > 0) throw new ForbiddenException('Hệ thống đã có admin');

    const configuredToken = this.config.getOrThrow<string>('SETUP_TOKEN');
    if (configuredToken) {
      if (!input.setupToken || !safeEqualHex(sha256Hex(input.setupToken), sha256Hex(configuredToken))) {
        throw new ForbiddenException('SETUP_TOKEN không đúng');
      }
    } else if (!this.isLocal(req)) {
      throw new ForbiddenException('Hãy đặt SETUP_TOKEN trong .env rồi khởi động lại server');
    }

    if (input.password !== input.confirmPassword) {
      throw new BadRequestException('Mật khẩu nhập lại không khớp');
    }
    if (input.password.length < 6) {
      throw new BadRequestException('Mật khẩu phải từ 6 ký tự');
    }

    const username = input.username.trim().toLowerCase();
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('first-admin-setup'))`);
      const [{ lockedCount }] = await tx.select({ lockedCount: sql<number>`count(*)::int` }).from(users);
      if (lockedCount > 0) throw new ForbiddenException('Hệ thống đã có admin');

      let [workspace] = await tx
        .select()
        .from(workspaces)
        .where(sql`${workspaces.isPlatform} = true`)
        .limit(1);
      if (!workspace) {
        [workspace] = await tx.insert(workspaces).values({ name: 'Platform', isPlatform: true }).returning();
      }

      await tx.insert(users).values({ workspaceId: workspace.id, username, passwordHash, role: 'admin' });
    });

    return this.auth.login(username, input.password, req.ip, req.headers['user-agent']);
  }

  private isLocal(req: Request): boolean {
    const address = req.socket.remoteAddress ?? '';
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
    const proxied = Boolean(req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    return loopback && !proxied;
  }
}
