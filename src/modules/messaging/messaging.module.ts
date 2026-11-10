import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { BotModule } from '../bot/bot.module';
import { WebhookController } from './webhook.controller';
import { EventProcessor } from './event-processor.service';
import { OutboundService } from './outbound.service';
import { OutboxWorker } from './outbox.worker';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { HealthController, StatsController } from './stats.controller';

@Module({
  imports: [ChannelsModule, BotModule],
  controllers: [WebhookController, ConversationsController, StatsController, HealthController],
  providers: [EventProcessor, OutboundService, OutboxWorker, ConversationsService],
  exports: [OutboxWorker],
})
export class MessagingModule {}
