import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PG_POOL } from '../../db/db.module';
import { Pool } from 'pg';
import { EventProcessor } from './event-processor.service';
import { OutboundService } from './outbound.service';

interface Job {
  id: number;
  kind: 'process_event' | 'send_message';
  payload: { webhookEventId?: string; messageId?: string };
  attempts: number;
}

const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];
const MAX_ATTEMPTS = 5;

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly events: EventProcessor,
    private readonly outbound: OutboundService,
  ) {}

  onModuleInit() {
    if (this.config.getOrThrow<string>('WORKER_ENABLED') === 'false') return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error(err instanceof Error ? err.message : String(err)));
    }, 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverStuck();
      const jobs = await this.claim(20);
      for (const job of jobs) await this.dispatch(job);
    } finally {
      this.running = false;
    }
  }

  private async claim(limit: number): Promise<Job[]> {
    const { rows } = await this.pool.query<Job>(
      `UPDATE outbox SET status='running', locked_at=now(), attempts=attempts+1
       WHERE id IN (
         SELECT id FROM outbox
         WHERE status='pending' AND next_attempt_at <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       RETURNING id, kind, payload, attempts`,
      [limit],
    );
    return rows.sort((a, b) => a.id - b.id);
  }

  private async recoverStuck() {
    await this.pool.query(
      `UPDATE outbox SET status='pending', locked_at=NULL
       WHERE status='running' AND locked_at < now() - interval '5 minutes'`,
    );
  }

  private async dispatch(job: Job): Promise<void> {
    try {
      if (job.kind === 'process_event' && job.payload.webhookEventId) {
        await this.events.process(job.payload.webhookEventId);
      } else if (job.kind === 'send_message' && job.payload.messageId) {
        await this.outbound.send(job.payload.messageId);
      }
      await this.pool.query(`UPDATE outbox SET status='done', last_error=NULL WHERE id=$1`, [job.id]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= MAX_ATTEMPTS) {
        await this.pool.query(`UPDATE outbox SET status='failed', last_error=$2 WHERE id=$1`, [job.id, message]);
        // A message left 'queued' would block every later reply in its conversation (ordering guard).
        if (job.kind === 'send_message' && job.payload.messageId) await this.outbound.giveUp(job.payload.messageId);
        this.logger.error(`Outbox ${job.id} thất bại sau ${job.attempts} lần: ${message}`);
        return;
      }
      const delay = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
      await this.pool.query(
        `UPDATE outbox SET status='pending', last_error=$2, next_attempt_at=now() + ($3::text || ' milliseconds')::interval WHERE id=$1`,
        [job.id, message, delay],
      );
    }
  }
}
