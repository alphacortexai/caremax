export const INBOX_CHANNELS = ['whatsapp'] as const;

export type InboxChannel = (typeof INBOX_CHANNELS)[number];

export type InboxStatus = 'open' | 'pending' | 'resolved';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageAuthor = 'customer' | 'agent' | 'bot';

export type DeliveryStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'saved';

export type InboundMessageEvent = {
  channel: InboxChannel;
  externalUserId: string;
  displayName?: string;
  externalMessageId: string;
  type: string;
  body: string;
  timestampMs: number;
};

export type InboxConversation = {
  id: string;
  tenantId: string;
  channel: InboxChannel;
  contactId: string;
  customerName: string;
  customerPhone: string;
  status: InboxStatus;
  assigneeId: string | null;
  assigneeEmail: string | null;
  unreadCount: number;
  lastMessagePreview: string;
  lastMessageAtMs: number;
  lastDirection: MessageDirection;
  createdAtMs: number;
};

export type InboxMessage = {
  id: string;
  tenantId: string;
  conversationId: string;
  contactId: string;
  channel: InboxChannel;
  direction: MessageDirection;
  authorType: MessageAuthor;
  authorId: string | null;
  authorName: string | null;
  type: string;
  body: string;
  externalMessageId: string | null;
  status: DeliveryStatus;
  error: string | null;
  createdAtMs: number;
};

export type InboxContact = {
  id: string;
  tenantId: string;
  channel: InboxChannel;
  externalUserId: string;
  displayName: string;
  phone: string;
  lastMessageAtMs: number;
  conversationId: string;
};

export type ChannelSendResult = {
  externalMessageId?: string;
};

export type ChannelSender = {
  sendText: (to: string, body: string) => Promise<ChannelSendResult>;
};

export type IngestResult = {
  duplicate: boolean;
  conversation: InboxConversation;
  message: InboxMessage;
};
