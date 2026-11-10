import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';

@Module({
  imports: [LlmProvidersModule],
  controllers: [BotController],
  providers: [BotService],
  exports: [BotService],
})
export class BotModule {}
