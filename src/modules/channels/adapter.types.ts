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
  /** Payload of a tapped button (Get Started / persistent menu); `text` holds the button title. */
  postback?: string;
  occurredAt: Date;
  raw: unknown;
}

/** Public profile of a customer as the provider exposes it; missing fields stay undefined. */
export interface CustomerProfile {
  name?: string;
  avatarUrl?: string;
}

export interface OutgoingText {
  text: string;
  /** Tappable answers; providers without quick replies ignore them. */
  quickReplies?: string[];
}

/** Payload sent when the customer taps "Get Started" on a Messenger Page. */
export const GET_STARTED_PAYLOAD = 'GET_STARTED';

export interface MenuItem {
  title: string;
  /** Set: opens this link. Unset: sends `title` to the bot as if the customer typed it. */
  url?: string;
}

/** Page-level settings stored in channel.config.messengerProfile and pushed to Meta. */
export interface MessengerProfile {
  getStarted: boolean;
  persistentMenu: MenuItem[];
}

export interface Capabilities {
  text: true;
  media: false;
  quickReply: boolean;
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
  /** Optional: providers without a profile API simply leave customers unnamed. */
  fetchProfile?(channel: AdapterChannel, externalUserId: string): Promise<CustomerProfile>;
  /**
   * Optional: marks the customer's message as seen and shows "typing…" while the bot works out
   * its answer. The provider clears it when the reply arrives (or after ~20-25s on its own).
   * `inboundMessageId` is the provider id of the message being answered (WhatsApp needs it).
   */
  showTyping?(channel: AdapterChannel, to: string, inboundMessageId?: string): Promise<void>;
  /** Optional: pushes the Get Started button and persistent menu to the provider. */
  syncProfile?(channel: AdapterChannel, profile: MessengerProfile): Promise<void>;
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
