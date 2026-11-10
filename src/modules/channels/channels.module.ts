import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { AdapterRegistry } from './adapter.registry';
import { MessengerAdapter } from './adapters/messenger.adapter';
import { ZaloAdapter } from './adapters/zalo.adapter';
import { WhatsappAdapter } from './adapters/whatsapp.adapter';

@Module({
  controllers: [ChannelsController],
  providers: [ChannelsService, AdapterRegistry, MessengerAdapter, ZaloAdapter, WhatsappAdapter],
  exports: [ChannelsService, AdapterRegistry],
})
export class ChannelsModule {}
