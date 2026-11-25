import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { InboundMessageEvent } from '../messaging/types.js';

export const DEFAULT_GRAPH_VERSION = 'v21.0';

export type WhatsAppCloudConfig = {
  connected: boolean;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  autoReplyEnabled: boolean;
  businessName: string;
  aiInstructions: string;
  updatedAt: string | null;
};

export type ParsedWhatsAppMessage = {
  phoneNumberId: string;
  displayPhoneNumber: string;
  message: InboundMessageEvent;
};

export type ParsedWhatsAppStatus = {
  phoneNumberId: string;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestampMs: number;
  error: string | null;
};

export type ParsedWhatsAppWebhook = {
  messages: ParsedWhatsAppMessage[];
  statuses: ParsedWhatsAppStatus[];
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeWaId(value: string): string {
  return value.replace(/[^\d]/g, '');
}

export function graphVersion(): string {
  const configured = process.env.WHATSAPP_GRAPH_VERSION?.trim();
  return configured || DEFAULT_GRAPH_VERSION;
}

export function createVerifyToken(): string {
  return randomBytes(24).toString('hex');
}

export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !appSecret || rawBody.length === 0) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const actual = Buffer.from(signatureHeader);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

function messageBody(message: UnknownRecord): { type: string; body: string } {
  const type = asString(message.type) || 'unsupported';
  if (type === 'text') {
    const text = asRecord(message.text);
    return { type, body: asString(text?.body) || '[Empty message]' };
  }
  if (type === 'button') {
    const button = asRecord(message.button);
    return { type, body: asString(button?.text) || '[Button]' };
  }
  if (type === 'interactive') {
    const interactive = asRecord(message.interactive);
    const buttonReply = asRecord(interactive?.button_reply);
    const listReply = asRecord(interactive?.list_reply);
    return {
      type,
      body: asString(buttonReply?.title) || asString(listReply?.title) || '[Interactive reply]',
    };
  }
  const media = asRecord(message[type]);
  const caption = asString(media?.caption);
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return { type, body: caption ? `[${label}] ${caption}` : `[${label}]` };
}

export function parseWhatsAppWebhook(payload: unknown): ParsedWhatsAppWebhook {
  const root = asRecord(payload);
  const messages: ParsedWhatsAppMessage[] = [];
  const statuses: ParsedWhatsAppStatus[] = [];
  if (!root || root.object !== 'whatsapp_business_account') {
    return { messages, statuses };
  }

  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const entryRecord = asRecord(entry);
    const changes = Array.isArray(entryRecord?.changes) ? entryRecord.changes : [];
    for (const change of changes) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      const metadata = asRecord(value.metadata);
      const phoneNumberId = asString(metadata?.phone_number_id);
      const displayPhoneNumber = asString(metadata?.display_phone_number);
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const names = new Map<string, string>();
      for (const contact of contacts) {
        const record = asRecord(contact);
        const waId = normalizeWaId(asString(record?.wa_id));
        const profile = asRecord(record?.profile);
        const name = asString(profile?.name);
        if (waId && name) names.set(waId, name);
      }

      const rawMessages = Array.isArray(value.messages) ? value.messages : [];
      for (const rawMessage of rawMessages) {
        const message = asRecord(rawMessage);
        if (!message) continue;
        const externalUserId = normalizeWaId(asString(message.from));
        const externalMessageId = asString(message.id);
        if (!externalUserId || !externalMessageId) continue;
        const content = messageBody(message);
        if (!content.body.trim()) continue;
        const timestampSeconds = Number(asString(message.timestamp));
        messages.push({
          phoneNumberId,
          displayPhoneNumber,
          message: {
            channel: 'whatsapp',
            externalUserId,
            displayName: names.get(externalUserId),
            externalMessageId,
            type: content.type,
            body: content.body.trim(),
            timestampMs: Number.isFinite(timestampSeconds) && timestampSeconds > 0
              ? timestampSeconds * 1000
              : Date.now(),
          },
        });
      }

      const rawStatuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const rawStatus of rawStatuses) {
        const statusRecord = asRecord(rawStatus);
        if (!statusRecord) continue;
        const externalMessageId = asString(statusRecord.id);
        const status = asString(statusRecord.status);
        if (!externalMessageId || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
        const errors = Array.isArray(statusRecord.errors) ? statusRecord.errors : [];
        const firstError = asRecord(errors[0]);
        const timestampSeconds = Number(asString(statusRecord.timestamp));
        statuses.push({
          phoneNumberId,
          externalMessageId,
          status: status as ParsedWhatsAppStatus['status'],
          timestampMs: Number.isFinite(timestampSeconds) && timestampSeconds > 0
            ? timestampSeconds * 1000
            : Date.now(),
          error: asString(firstError?.title) || asString(firstError?.message) || null,
        });
      }
    }
  }

  return { messages, statuses };
}

export function subscriptionChallenge(query: Record<string, unknown>, verifyToken: string): string | null {
  const mode = asString(query['hub.mode']);
  const token = asString(query['hub.verify_token']);
  const challenge = asString(query['hub.challenge']);
  if (mode === 'subscribe' && verifyToken && token === verifyToken && challenge) return challenge;
  return null;
}

async function graphFetch(path: string, accessToken: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { error: { message: text } };
    }
  }
  if (!response.ok) {
    const error = asRecord(asRecord(body)?.error);
    const message = asString(error?.message) || `WhatsApp API request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export async function fetchPhoneNumberProfile(config: Pick<WhatsAppCloudConfig, 'phoneNumberId' | 'accessToken'>): Promise<{
  displayPhoneNumber: string;
  verifiedName: string;
}> {
  const body = await graphFetch(
    `${encodeURIComponent(config.phoneNumberId)}?fields=display_phone_number,verified_name`,
    config.accessToken,
    { method: 'GET' },
  );
  const record = asRecord(body);
  return {
    displayPhoneNumber: asString(record?.display_phone_number),
    verifiedName: asString(record?.verified_name),
  };
}

export async function sendWhatsAppText(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
}): Promise<{ externalMessageId?: string }> {
  const to = normalizeWaId(params.to);
  if (!to) throw new Error('Customer phone number is missing.');
  const body = await graphFetch(`${encodeURIComponent(params.phoneNumberId)}/messages`, params.accessToken, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: params.body },
    }),
  });
  const record = asRecord(body);
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const first = asRecord(messages[0]);
  const externalMessageId = asString(first?.id);
  return externalMessageId ? { externalMessageId } : {};
}

export async function markWhatsAppRead(params: {
  phoneNumberId: string;
  accessToken: string;
  externalMessageId: string;
}): Promise<void> {
  await graphFetch(`${encodeURIComponent(params.phoneNumberId)}/messages`, params.accessToken, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: params.externalMessageId,
    }),
  });
}
