import 'dotenv/config';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

function arg(name: string, env: string, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return process.env[env] ?? fallback;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const username = arg('username', 'ADMIN_USERNAME').trim().toLowerCase();
  const password = arg('password', 'ADMIN_PASSWORD');

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Thiếu tên đăng nhập 3-32 ký tự (chữ, số, . _ -): --username admin');
  }
  if (password.length < 6) {
    throw new Error('Mật khẩu phải từ 6 ký tự: --password "..."');
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).limit(1);
    if (existing) throw new Error(`Tài khoản ${username} đã tồn tại`);

    let [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.isPlatform, true)).limit(1);
    if (!workspace) {
      [workspace] = await db.insert(schema.workspaces).values({ name: 'Platform', isPlatform: true }).returning();
    }

    await db.insert(schema.users).values({
      workspaceId: workspace.id,
      username,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: 'admin',
    });
    console.log(`Đã tạo admin ${username}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
