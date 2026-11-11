import 'dotenv/config';
import { Pool } from 'pg';
import { runMigrations } from './run-migrations';

/**
 * Manual `pnpm db:migrate`. The server also applies migrations at every boot (src/main.ts); both
 * go through runMigrations, which holds an advisory lock so concurrent runs cannot collide.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Thiếu biến DATABASE_URL. Đặt trong .env (xem .env.example), ví dụ: ' +
        'postgres://postgres:postgres@127.0.0.1:5433/bv_agent_msg',
    );
  }
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await runMigrations(pool, 'src/db/migrations');
    console.log('Đã áp toàn bộ migration');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
