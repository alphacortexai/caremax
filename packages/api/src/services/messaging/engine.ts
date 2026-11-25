import { createHash, randomUUID } from 'crypto';
import type { DocumentData, Query } from 'firebase-admin/firestore';
import { db } from '../../config/firebase.js';
import type {
  ChannelSender,
  InboxChannel,
  InboxContact,
  InboxConversation,
  InboxMessage,
  InboxStatus,
  InboundMessageEvent,
  IngestResult,
  MessageAuthor,
} from './types.js';

const CONVERSATIONS = 'inbox_conversations';
const MESSAGES = 'inbox_messages';
const CONTACTS = 'inbox_contacts';
const DELIVERY_INDEX = 'inbox_delivery_index';

function docId(parts: string[]): string {
  const raw = parts.join('__');
  if (raw.includes('/') || raw.length > 700) {
    return createHash('sha256').update(raw).digest('hex');
  }
  return raw;
}

export function conversationDocId(tenantId: string, channel: InboxChannel, externalUserId: string): string {
  return docId([tenantId, channel, externalUserId]);
}

export function contactDocId(tenantId: string, channel: InboxChannel, externalUserId: string): string {
  return docId([tenantId, 'contact', channel, externalUserId]);
}

export function messageDocId(externalMessageId: string): string {
  const cleaned = externalMessageId.replace(/\//g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.length > 700) {
    return `m_${createHash('sha256').update(externalMessageId).digest('hex')}`;
  }
  return `m_${cleaned}`;
}

function deliveryIndexId(tenantId: string, externalMessageId: string): string {
  return createHash('sha256').update(`${tenantId}\n${externalMessageId}`).digest('hex');
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStatus(value: unknown): InboxStatus {
  if (value === 'pending' || value === 'resolved' || value === 'open') return value;
  return 'open';
}

function mapConversation(id: string, data: DocumentData): InboxConversation {
  return {
    id,
    tenantId: asString(data.tenantId),
    channel: 'whatsapp',
    contactId: asString(data.contactId),
    customerName: asString(data.customerName, 'WhatsApp customer'),
    customerPhone: asString(data.customerPhone),
    status: asStatus(data.status),
    assigneeId: asString(data.assigneeId) || null,
    assigneeEmail: asString(data.assigneeEmail) || null,
    unreadCount: asNumber(data.unreadCount),
    lastMessagePreview: asString(data.lastMessagePreview),
    lastMessageAtMs: asNumber(data.lastMessageAtMs),
    lastDirection: data.lastDirection === 'outbound' ? 'outbound' : 'inbound',
    createdAtMs: asNumber(data.createdAtMs),
  };
}

function mapMessage(id: string, data: DocumentData): InboxMessage {
  const authorType: MessageAuthor = data.authorType === 'agent' || data.authorType === 'bot'
    ? data.authorType
    : 'customer';
  return {
    id,
    tenantId: asString(data.tenantId),
    conversationId: asString(data.conversationId),
    contactId: asString(data.contactId),
    channel: 'whatsapp',
    direction: data.direction === 'outbound' ? 'outbound' : 'inbound',
    authorType,
    authorId: asString(data.authorId) || null,
    authorName: asString(data.authorName) || null,
    type: asString(data.type, 'text'),
    body: asString(data.body),
    externalMessageId: asString(data.externalMessageId) || null,
    status: (asString(data.status, 'received') as InboxMessage['status']),
    error: asString(data.error) || null,
    createdAtMs: asNumber(data.createdAtMs),
  };
}

function mapContact(id: string, data: DocumentData): InboxContact {
  return {
    id,
    tenantId: asString(data.tenantId),
    channel: 'whatsapp',
    externalUserId: asString(data.externalUserId),
    displayName: asString(data.displayName, 'WhatsApp customer'),
    phone: asString(data.phone),
    lastMessageAtMs: asNumber(data.lastMessageAtMs),
    conversationId: asString(data.conversationId),
  };
}

export async function ingestInbound(tenantId: string, event: InboundMessageEvent): Promise<IngestResult> {
  const conversationId = conversationDocId(tenantId, event.channel, event.externalUserId);
  const contactId = contactDocId(tenantId, event.channel, event.externalUserId);
  const messageId = messageDocId(event.externalMessageId);
  const conversationRef = db.collection(CONVERSATIONS).doc(conversationId);
  const contactRef = db.collection(CONTACTS).doc(contactId);
  const messageRef = db.collection(MESSAGES).doc(messageId);
  const indexRef = db.collection(DELIVERY_INDEX).doc(deliveryIndexId(tenantId, event.externalMessageId));
  const now = event.timestampMs || Date.now();
  const preview = event.body.slice(0, 180);
  const displayName = event.displayName?.trim() || event.externalUserId;

  const written = await db.runTransaction(async (tx) => {
    const existing = await tx.get(messageRef);
    const conversationSnap = await tx.get(conversationRef);
    const contactSnap = await tx.get(contactRef);
    if (existing.exists) {
      return {
        duplicate: true,
        conversation: conversationSnap.exists
          ? mapConversation(conversationId, conversationSnap.data() ?? {})
          : null,
        message: mapMessage(messageId, existing.data() ?? {}),
      };
    }

    const previous = conversationSnap.data() ?? {};
    const contact = contactSnap.data() ?? {};
    const createdAtMs = asNumber(previous.createdAtMs, now);
    const nextStatus: InboxStatus = previous.status === 'resolved' ? 'open' : asStatus(previous.status || 'open');
    const customerName = event.displayName?.trim()
      || asString(previous.customerName)
      || asString(contact.displayName)
      || displayName;

    const conversation: InboxConversation = {
      id: conversationId,
      tenantId,
      channel: event.channel,
      contactId,
      customerName,
      customerPhone: event.externalUserId,
      status: nextStatus,
      assigneeId: asString(previous.assigneeId) || null,
      assigneeEmail: asString(previous.assigneeEmail) || null,
      unreadCount: asNumber(previous.unreadCount) + 1,
      lastMessagePreview: preview,
      lastMessageAtMs: now,
      lastDirection: 'inbound',
      createdAtMs,
    };
    const message: InboxMessage = {
      id: messageId,
      tenantId,
      conversationId,
      contactId,
      channel: event.channel,
      direction: 'inbound',
      authorType: 'customer',
      authorId: null,
      authorName: customerName,
      type: event.type,
      body: event.body,
      externalMessageId: event.externalMessageId,
      status: 'received',
      error: null,
      createdAtMs: now,
    };

    tx.set(messageRef, message);
    tx.set(indexRef, { tenantId, messageId, externalMessageId: event.externalMessageId });
    tx.set(contactRef, {
      id: contactId,
      tenantId,
      channel: event.channel,
      externalUserId: event.externalUserId,
      displayName: customerName,
      phone: event.externalUserId,
      lastMessageAtMs: now,
      conversationId,
    }, { merge: true });
    tx.set(conversationRef, conversation, { merge: true });
    return { duplicate: false, conversation, message };
  });

  if (!written.conversation) {
    const conversation = await getConversation(tenantId, conversationId);
    if (!conversation) throw new Error('Conversation could not be loaded after a duplicate message.');
    return { duplicate: true, conversation, message: written.message };
  }
  return { duplicate: written.duplicate, conversation: written.conversation, message: written.message };
}

export async function getConversation(tenantId: string, conversationId: string): Promise<InboxConversation | null> {
  const snap = await db.collection(CONVERSATIONS).doc(conversationId).get();
  if (!snap.exists) return null;
  const conversation = mapConversation(snap.id, snap.data() ?? {});
  if (conversation.tenantId !== tenantId) return null;
  return conversation;
}

export async function listConversations(tenantId: string, status?: InboxStatus | 'all'): Promise<InboxConversation[]> {
  let query: Query = db.collection(CONVERSATIONS).where('tenantId', '==', tenantId);
  if (status && status !== 'all') query = query.where('status', '==', status);
  const snap = await query.orderBy('lastMessageAtMs', 'desc').limit(100).get();
  return snap.docs.map((doc) => mapConversation(doc.id, doc.data()));
}

export async function listMessages(tenantId: string, conversationId: string): Promise<InboxMessage[]> {
  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) return [];
  const snap = await db.collection(MESSAGES)
    .where('conversationId', '==', conversationId)
    .orderBy('createdAtMs', 'asc')
    .limit(300)
    .get();
  return snap.docs
    .map((doc) => mapMessage(doc.id, doc.data()))
    .filter((message) => message.tenantId === tenantId);
}

export async function listContacts(tenantId: string): Promise<InboxContact[]> {
  const snap = await db.collection(CONTACTS)
    .where('tenantId', '==', tenantId)
    .orderBy('lastMessageAtMs', 'desc')
    .limit(200)
    .get();
  return snap.docs.map((doc) => mapContact(doc.id, doc.data()));
}

export async function conversationCounts(tenantId: string): Promise<Record<InboxStatus, number>> {
  const statuses: InboxStatus[] = ['open', 'pending', 'resolved'];
  const counts = await Promise.all(statuses.map(async (status) => {
    const snap = await db.collection(CONVERSATIONS)
      .where('tenantId', '==', tenantId)
      .where('status', '==', status)
      .count()
      .get();
    return [status, snap.data().count] as const;
  }));
  return {
    open: counts.find(([status]) => status === 'open')?.[1] ?? 0,
    pending: counts.find(([status]) => status === 'pending')?.[1] ?? 0,
    resolved: counts.find(([status]) => status === 'resolved')?.[1] ?? 0,
  };
}

export async function markConversationRead(tenantId: string, conversationId: string): Promise<InboxConversation | null> {
  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) return null;
  await db.collection(CONVERSATIONS).doc(conversationId).set({ unreadCount: 0 }, { merge: true });
  return { ...conversation, unreadCount: 0 };
}

export async function setConversationStatus(
  tenantId: string,
  conversationId: string,
  status: InboxStatus,
): Promise<InboxConversation | null> {
  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) return null;
  await db.collection(CONVERSATIONS).doc(conversationId).set({ status }, { merge: true });
  return { ...conversation, status };
}

export async function assignConversation(
  tenantId: string,
  conversationId: string,
  assignee: { id: string; email?: string } | null,
): Promise<InboxConversation | null> {
  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) return null;
  const next = {
    assigneeId: assignee?.id ?? null,
    assigneeEmail: assignee?.email ?? null,
    status: assignee ? 'pending' as const : conversation.status,
  };
  await db.collection(CONVERSATIONS).doc(conversationId).set(next, { merge: true });
  return { ...conversation, ...next };
}

export async function sendOutbound(params: {
  tenantId: string;
  conversationId: string;
  body: string;
  authorType: Extract<MessageAuthor, 'agent' | 'bot'>;
  authorId?: string;
  authorName?: string;
  sender: ChannelSender | null;
}): Promise<InboxMessage> {
  const conversation = await getConversation(params.tenantId, params.conversationId);
  if (!conversation) throw new Error('Conversation not found.');
  const body = params.body.trim();
  if (!body) throw new Error('Message body is required.');

  const createdAtMs = Date.now();
  const localId = `out_${randomUUID()}`;
  const messageRef = db.collection(MESSAGES).doc(localId);
  const base: InboxMessage = {
    id: localId,
    tenantId: params.tenantId,
    conversationId: conversation.id,
    contactId: conversation.contactId,
    channel: conversation.channel,
    direction: 'outbound',
    authorType: params.authorType,
    authorId: params.authorId ?? null,
    authorName: params.authorName ?? (params.authorType === 'bot' ? 'AI assistant' : 'Agent'),
    type: 'text',
    body,
    externalMessageId: null,
    status: params.sender ? 'queued' : 'saved',
    error: params.sender ? null : 'WhatsApp is not connected, so this reply was saved in the inbox only.',
    createdAtMs,
  };
  await messageRef.set(base);
  await db.collection(CONVERSATIONS).doc(conversation.id).set({
    lastMessagePreview: body.slice(0, 180),
    lastMessageAtMs: createdAtMs,
    lastDirection: 'outbound',
    unreadCount: 0,
  }, { merge: true });

  if (!params.sender) return base;

  try {
    const sent = await params.sender.sendText(conversation.customerPhone, body);
    const delivered: InboxMessage = {
      ...base,
      externalMessageId: sent.externalMessageId ?? null,
      status: 'sent',
      error: null,
    };
    await messageRef.set(delivered, { merge: true });
    if (sent.externalMessageId) {
      await db.collection(DELIVERY_INDEX).doc(deliveryIndexId(params.tenantId, sent.externalMessageId)).set({
        tenantId: params.tenantId,
        messageId: localId,
        externalMessageId: sent.externalMessageId,
      });
    }
    return delivered;
  } catch (error) {
    const failed: InboxMessage = {
      ...base,
      status: 'failed',
      error: error instanceof Error ? error.message : 'WhatsApp send failed.',
    };
    await messageRef.set({ status: failed.status, error: failed.error }, { merge: true });
    return failed;
  }
}

export async function applyDeliveryStatus(params: {
  tenantId: string;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string | null;
}): Promise<void> {
  const index = await db.collection(DELIVERY_INDEX).doc(deliveryIndexId(params.tenantId, params.externalMessageId)).get();
  const messageId = asString(index.data()?.messageId);
  if (!messageId) return;
  const messageRef = db.collection(MESSAGES).doc(messageId);
  const message = await messageRef.get();
  if (!message.exists || message.data()?.tenantId !== params.tenantId) return;
  await messageRef.set({
    status: params.status,
    error: params.error ?? null,
  }, { merge: true });
}
