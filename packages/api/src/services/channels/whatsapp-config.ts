import { db } from '../../config/firebase.js';
import type { ChannelSender } from '../messaging/types.js';
import {
  createVerifyToken,
  fetchPhoneNumberProfile,
  sendWhatsAppText,
  type WhatsAppCloudConfig,
} from './whatsapp-cloud.js';

const COLLECTION = 'tenant_integrations';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function emptyWhatsAppConfig(): WhatsAppCloudConfig {
  return {
    connected: false,
    phoneNumberId: '',
    wabaId: '',
    displayPhoneNumber: '',
    verifiedName: '',
    accessToken: '',
    verifyToken: '',
    appSecret: '',
    autoReplyEnabled: false,
    businessName: '',
    aiInstructions: '',
    updatedAt: null,
  };
}

export function mapWhatsAppConfig(value: unknown): WhatsAppCloudConfig {
  const data = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  const base = emptyWhatsAppConfig();
  return {
    ...base,
    connected: data.connected === true,
    phoneNumberId: asString(data.phoneNumberId),
    wabaId: asString(data.wabaId),
    displayPhoneNumber: asString(data.displayPhoneNumber),
    verifiedName: asString(data.verifiedName),
    accessToken: asString(data.accessToken),
    verifyToken: asString(data.verifyToken),
    appSecret: asString(data.appSecret),
    autoReplyEnabled: data.autoReplyEnabled === true,
    businessName: asString(data.businessName),
    aiInstructions: asString(data.aiInstructions),
    updatedAt: asString(data.updatedAt) || null,
  };
}

export async function loadWhatsAppConfig(tenantId: string): Promise<WhatsAppCloudConfig> {
  const snap = await db.collection(COLLECTION).doc(tenantId).get();
  return mapWhatsAppConfig(snap.data()?.whatsappCloud);
}

export async function saveWhatsAppConfig(tenantId: string, config: WhatsAppCloudConfig): Promise<void> {
  await db.collection(COLLECTION).doc(tenantId).set({
    tenantId,
    whatsappCloud: config,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

export async function ensureVerifyToken(tenantId: string): Promise<WhatsAppCloudConfig> {
  const current = await loadWhatsAppConfig(tenantId);
  if (current.verifyToken) return current;
  const next = { ...current, verifyToken: createVerifyToken(), updatedAt: new Date().toISOString() };
  await saveWhatsAppConfig(tenantId, next);
  return next;
}

export function senderForConfig(config: WhatsAppCloudConfig): ChannelSender | null {
  if (!config.connected || !config.phoneNumberId || !config.accessToken) return null;
  return {
    sendText: (to, body) => sendWhatsAppText({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken,
      to,
      body,
    }),
  };
}

export async function verifyWhatsAppConnection(config: WhatsAppCloudConfig): Promise<WhatsAppCloudConfig> {
  const profile = await fetchPhoneNumberProfile(config);
  return {
    ...config,
    connected: true,
    displayPhoneNumber: profile.displayPhoneNumber || config.displayPhoneNumber,
    verifiedName: profile.verifiedName || config.verifiedName,
    updatedAt: new Date().toISOString(),
  };
}

export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 4) return '*'.repeat(secret.length);
  return `${'*'.repeat(Math.max(secret.length - 4, 0))}${secret.slice(-4)}`;
}
