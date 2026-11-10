import { Module } from '@nestjs/common';
import { LlmService } from '../bot/llm.service';
import { LlmProvidersController } from './llm-providers.controller';
import { LlmProvidersService } from './llm-providers.service';

@Module({
  controllers: [LlmProvidersController],
  providers: [LlmProvidersService, LlmService],
  exports: [LlmService],
})
export class LlmProvidersModule {}
