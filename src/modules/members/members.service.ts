import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { conversations, sessions, users } from '../../db/schema';

const publicColumns = {
  id: users.id,
  username: users.username,
  role: users.role,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
};

@Injectable()
export class MembersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(workspaceId: string) {
    return this.db.select(publicColumns).from(users).where(eq(users.workspaceId, workspaceId)).orderBy(users.createdAt);
  }

  async create(workspaceId: string, input: { username: string; password: string }) {
    const username = input.username.trim().toLowerCase();
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (existing) throw new BadRequestException('Tên đăng nhập đã tồn tại');

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const [row] = await this.db
      .insert(users)
      .values({ workspaceId, username, passwordHash, role: 'agent' })
      .returning(publicColumns);
    return row;
  }

  async updatePassword(workspaceId: string, id: string, password: string) {
    await this.getMember(workspaceId, id);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, id));
      await tx.delete(sessions).where(eq(sessions.userId, id));
    });
    return { ok: true };
  }

  /** Soft delete: old messages keep sender_user_id, the account can no longer log in. */
  async disable(workspaceId: string, actorId: string, id: string) {
    if (actorId === id) throw new BadRequestException('Không thể tự vô hiệu hoá chính mình');
    const member = await this.getMember(workspaceId, id);
    if (member.disabledAt) return { ok: true };

    if (member.role === 'owner') {
      const [{ count }] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.workspaceId, workspaceId), eq(users.role, 'owner'), isNull(users.disabledAt)));
      if (count <= 1) throw new BadRequestException('Không thể vô hiệu hoá owner cuối cùng');
    }

    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ disabledAt: new Date() }).where(eq(users.id, id));
      await tx.delete(sessions).where(eq(sessions.userId, id));
      // Keep mode='human': the thread stays with a human, just no assignee.
      await tx
        .update(conversations)
        .set({ assignedUserId: null, updatedAt: new Date() })
        .where(eq(conversations.assignedUserId, id));
    });
    return { ok: true };
  }

  private async getMember(workspaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.workspaceId, workspaceId), eq(users.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Không tìm thấy thành viên');
    return row;
  }
}
