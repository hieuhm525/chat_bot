import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

/**
 * Fixed key for the PostgreSQL advisory lock that serialises migrations. Any process applying
 * migrations to the same database (app boot, `pnpm db:migrate`, several replicas) takes this lock.
 */
const MIGRATION_LOCK_KEY = 727_001;

/**
 * Applies the Drizzle migrations in `migrationsFolder` under a PostgreSQL advisory lock.
 *
 * The Drizzle migrator has no lock of its own: it reads the last applied migration outside its
 * transaction, so two runs at once could both apply the same migration. Lock and migrations use
 * one connection, because an advisory lock belongs to the session that took it. A second run waits
 * for the first one, then finds nothing left to apply.
 */
export async function runMigrations(pool: Pool, migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } catch (err) {
    broken = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `Áp migration từ "${migrationsFolder}" thất bại (advisory lock ${MIGRATION_LOCK_KEY}). ` +
        `Xem lỗi gốc ở cause; kiểm tra DATABASE_URL và file SQL migration mới nhất.`,
      { cause: err },
    );
  } finally {
    // Destroy the connection on error so a lock that could not be released dies with the session.
    client.release(broken);
  }
}
