import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { ConversationsService } from './conversations.service';
import { PG_POOL } from '../../db/db.module';
import { Pool } from 'pg';
import { Public } from '../../common/public.decorator';
import { Roles } from '../../common/roles.decorator';

@Controller('stats')
export class StatsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Roles('owner')
  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.conversations.stats(user.workspaceId);
  }
}

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly conversations: ConversationsService,
  ) {}

  @Public()
  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    try {
      await this.pool.query('select 1');
      const outbox = await this.conversations.health();
      return { status: 'ok', db: 'up', ...outbox };
    } catch (err) {
      // Public endpoint: never leak host, database or driver details to the caller.
      this.logger.error('Health check failed', err instanceof Error ? err.stack : String(err));
      res.status(503);
      return { status: 'error', db: 'down' };
    }
  }
}
