export type Provider = 'messenger' | 'zalo' | 'whatsapp';

export interface AdapterChannel {
  id: string;
  workspaceId: string;
  provider: Provider;
  externalId: string;
  status?: string;
  botId?: string | null;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  credentialExpiresAt?: Date | null;
}

export interface ConversationWindow {
  lastInboundAt?: Date | null;
}

export interface NormalizedEvent {
  kind: 'message' | 'status' | 'ignored';
  providerEventId: string;
  externalUserId?: string;
  externalThreadId?: string;
  providerMessageId?: string;
  text?: string;
  contentType?: 'text' | 'image' | 'file' | 'unsupported';
  attachments?: { type: 'image' | 'file'; url: string }[];
  /** True for a Page Inbox reply echoed back by the provider; it is outbound, not from the customer. */
  echo?: boolean;
  status?: 'delivered' | 'read';
  occurredAt: Date;
  raw: unknown;
}

export interface OutgoingText {
  text: string;
}

export interface Capabilities {
  text: true;
  media: false;
  quickReply: false;
  template: boolean;
  maxTextLength: number;
}

export interface ChannelAdapter {
  readonly provider: Provider;
  capabilities(): Capabilities;
  verify(req: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; channel?: AdapterChannel }): boolean;
  parse(raw: unknown, channel: AdapterChannel): NormalizedEvent[];
  send(channel: AdapterChannel, to: string, msg: OutgoingText): Promise<{ providerMessageId: string }>;
  canSend(channel: AdapterChannel, conv: ConversationWindow, at: Date): { ok: true } | { ok: false; reason: string };
  healthCheck(channel: AdapterChannel): Promise<{ ok: boolean; detail?: string }>;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
    readonly markChannelError = false,
  ) {
    super(message);
  }
}
