import { Injectable, NotFoundException } from '@nestjs/common';
import { ChannelAdapter, Provider } from './adapter.types';
import { MessengerAdapter } from './adapters/messenger.adapter';
import { ZaloAdapter } from './adapters/zalo.adapter';
import { WhatsappAdapter } from './adapters/whatsapp.adapter';

@Injectable()
export class AdapterRegistry {
  private readonly byProvider: Record<Provider, ChannelAdapter>;

  constructor(messenger: MessengerAdapter, zalo: ZaloAdapter, whatsapp: WhatsappAdapter) {
    this.byProvider = { messenger, zalo, whatsapp };
  }

  get(provider: Provider): ChannelAdapter {
    const adapter = this.byProvider[provider];
    if (!adapter) throw new NotFoundException(`Không hỗ trợ kênh ${provider}`);
    return adapter;
  }
}
