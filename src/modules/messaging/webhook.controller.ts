import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { DRIZZLE, Db } from '../../db/db.module';
import { outbox, webhookEvents } from '../../db/schema';
import { Public } from '../../common/public.decorator';
import { sha256Hex } from '../../common/crypto';
import { ChannelsService } from '../channels/channels.service';
import { AdapterRegistry } from '../channels/adapter.registry';
import { Provider } from '../channels/adapter.types';

const PROVIDERS: Provider[] = ['messenger', 'zalo', 'whatsapp'];

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly channels: ChannelsService,
    private readonly adapters: AdapterRegistry,
  ) {}

  @Public()
  @Get(':provider')
  async verify(
    @Param('provider') provider: Provider,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (!PROVIDERS.includes(provider)) throw new BadRequestException('Kênh không hỗ trợ');
    if (mode === 'subscribe' && token) {
      const envToken = this.config.getOrThrow<string>('META_VERIFY_TOKEN');
      if ((envToken && token === envToken) || (await this.channels.hasVerifyToken(provider, token))) {
        return res.status(200).type('text/plain').send(challenge);
      }
    }
    return res.status(403).send('forbidden');
  }

  @Public()
  @Post(':provider')
  async receive(
    @Param('provider') provider: Provider,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ) {
    if (!PROVIDERS.includes(provider)) throw new BadRequestException('Kênh không hỗ trợ');
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    const externalId = this.resolveExternalId(provider, body);
    if (!externalId) {
      this.logger.warn(`Webhook ${provider} thiếu external id, bỏ qua`);
      return { ok: true, ignored: true };
    }

    const channel =
      (await this.channels.findForWebhook(provider, externalId)) ??
      (await this.channels.findDisabledForWebhook(provider, externalId));
    if (!channel) {
      this.logger.warn(`Webhook ${provider}/${externalId} chưa cấu hình kênh, bỏ qua`);
      return { ok: true, ignored: true };
    }

    const adapter = this.adapters.get(provider);
    if (!adapter.verify({ rawBody, headers: req.headers, channel })) {
      this.logger.warn(`Chữ ký ${provider}/${externalId} không hợp lệ`);
      return { ok: false };
    }

    const providerEventId = sha256Hex(rawBody);
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(webhookEvents)
        .values({
          channelId: channel.id,
          provider,
          providerEventId,
          payload: body as any,
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      if (!inserted.length) return;
      await tx.insert(outbox).values({
        workspaceId: channel.workspaceId,
        kind: 'process_event',
        payload: { webhookEventId: inserted[0].id },
      });
    });
    return { ok: true };
  }

  private resolveExternalId(provider: Provider, body: any): string | undefined {
    switch (provider) {
      case 'messenger':
        return body?.entry?.[0]?.id;
      case 'whatsapp':
        return body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
      case 'zalo':
        return body?.recipient?.id ?? body?.oa_id;
    }
  }
}
