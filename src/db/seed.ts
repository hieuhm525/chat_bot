import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const RULES = [
  {
    name: 'Giờ mở cửa',
    keywords: ['giờ mở cửa', 'mở cửa', 'làm việc'],
    answer: 'Dạ shop mở cửa Thứ 2 – Thứ 7: 8:00 – 20:00, Chủ nhật: 9:00 – 17:00 ạ.',
    priority: 10,
  },
  {
    name: 'Địa chỉ',
    keywords: ['địa chỉ', 'ở đâu', 'cửa hàng'],
    answer: 'Dạ shop ở 123 Đường Ví Dụ, Quận 1, TP.HCM ạ.',
    priority: 9,
  },
  {
    name: 'Giao hàng',
    keywords: ['giao hàng', 'ship', 'phí ship', 'vận chuyển'],
    answer:
      'Dạ nội thành TP.HCM giao 1–2 ngày, phí 25.000đ, miễn phí cho đơn từ 300.000đ. Tỉnh thành khác 2–4 ngày, phí theo bảng giá đơn vị vận chuyển ạ.',
    priority: 8,
  },
  {
    name: 'Đổi trả',
    keywords: ['đổi trả', 'đổi size', 'hoàn tiền', 'bảo hành'],
    answer: 'Dạ shop đổi trong 7 ngày nếu sản phẩm còn nguyên tem, chưa qua sử dụng. Hoàn tiền trong 3 ngày làm việc ạ.',
    priority: 7,
  },
  {
    name: 'Thanh toán',
    keywords: ['thanh toán', 'chuyển khoản', 'cod'],
    answer: 'Dạ shop nhận COD khi nhận hàng hoặc chuyển khoản trước qua tài khoản ngân hàng của shop ạ.',
    priority: 6,
  },
];

/** Seeds workspace, bot and starter rules only. Admins are created with `npm run admin:create`. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    let [workspace] = await db.select().from(schema.workspaces).limit(1);
    if (!workspace) {
      [workspace] = await db.insert(schema.workspaces).values({ name: 'Demo workspace' }).returning();
      console.log('seeded workspace');
    }

    let [bot] = await db.select().from(schema.bots).where(eq(schema.bots.workspaceId, workspace.id)).limit(1);
    if (!bot) {
      [bot] = await db.insert(schema.bots).values({ workspaceId: workspace.id, name: 'CSKH' }).returning();
      await db.insert(schema.botRules).values(RULES.map((rule) => ({ ...rule, botId: bot.id })));
      console.log('seeded bot + 5 rules');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
