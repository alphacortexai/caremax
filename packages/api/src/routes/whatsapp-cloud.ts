import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireTenantParam } from '../middleware/auth.js';
import {
  markWhatsAppRead,
  normalizeWaId,
  parseWhatsAppWebhook,
  subscriptionChallenge,
  verifyWebhookSignature,
} from '../services/channels/whatsapp-cloud.js';
import {
  emptyWhatsAppConfig,
  ensureVerifyToken,
  loadWhatsAppConfig,
  maskSecret,
  saveWhatsAppConfig,
  verifyWhatsAppConnection,
} from '../services/channels/whatsapp-config.js';
import { maybeAutoReply } from '../services/messaging/auto-reply.js';
import { applyDeliveryStatus, ingestInbound } from '../services/messaging/engine.js';

type RequestWithRawBody = Request & { rawBody?: Buffer };

export const whatsAppCloudWebhookRouter: Router = Router();
export const whatsAppCloudTenantRouter: Router = Router({ mergeParams: true });

function publicApiBase(req: Request): string {
  const configured = process.env.API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function publicConfig(config: Awaited<ReturnType<typeof loadWhatsAppConfig>>, webhookUrl: string) {
  return {
    connected: config.connected,
    phoneNumberId: config.phoneNumberId,
    wabaId: config.wabaId,
    displayPhoneNumber: config.displayPhoneNumber,
    verifiedName: config.verifiedName,
    accessTokenSet: Boolean(config.accessToken),
    accessTokenMasked: maskSecret(config.accessToken),
    verifyToken: config.verifyToken,
    appSecretSet: Boolean(config.appSecret),
    appSecretMasked: maskSecret(config.appSecret),
    autoReplyEnabled: config.autoReplyEnabled,
    businessName: config.businessName,
    aiInstructions: config.aiInstructions,
    updatedAt: config.updatedAt,
    webhookUrl,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  };
}

whatsAppCloudWebhookRouter.get('/webhook/:tenantId', async (req, res) => {
  try {
    const config = await loadWhatsAppConfig(req.params.tenantId);
    const challenge = subscriptionChallenge(req.query as Record<string, unknown>, config.verifyToken);
    if (!challenge) {
      res.sendStatus(403);
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  } catch (error) {
    console.error('WhatsApp webhook verification error:', error);
    res.sendStatus(500);
  }
});

whatsAppCloudWebhookRouter.post('/webhook/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  try {
    const config = await loadWhatsAppConfig(tenantId);
    if (config.appSecret) {
      const rawBody = (req as RequestWithRawBody).rawBody;
      const valid = rawBody
        ? verifyWebhookSignature(rawBody, req.get('x-hub-signature-256'), config.appSecret)
        : false;
      if (!valid) {
        res.sendStatus(403);
        return;
      }
    }

    const parsed = parseWhatsAppWebhook(req.body);
    for (const item of parsed.messages) {
      if (config.phoneNumberId && item.phoneNumberId && item.phoneNumberId !== config.phoneNumberId) continue;
      const result = await ingestInbound(tenantId, item.message);
      if (!result.duplicate && config.connected && config.accessToken && config.phoneNumberId) {
        void markWhatsAppRead({
          phoneNumberId: config.phoneNumberId,
          accessToken: config.accessToken,
          externalMessageId: item.message.externalMessageId,
        }).catch((error) => {
          console.error('WhatsApp read receipt error:', error);
        });
      }
      if (!result.duplicate) {
        await maybeAutoReply(tenantId, result.conversation.id);
      }
    }
    for (const status of parsed.statuses) {
      if (config.phoneNumberId && status.phoneNumberId && status.phoneNumberId !== config.phoneNumberId) continue;
      await applyDeliveryStatus({
        tenantId,
        externalMessageId: status.externalMessageId,
        status: status.status,
        error: status.error,
      });
    }
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    res.status(500).json({ error: 'Failed to process WhatsApp webhook.' });
  }
});

whatsAppCloudTenantRouter.use(requireTenantParam);
whatsAppCloudTenantRouter.use(requireAuth);
whatsAppCloudTenantRouter.use(requireAdmin);

whatsAppCloudTenantRouter.get('/', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  try {
    const config = await ensureVerifyToken(tenantId);
    const webhookUrl = `${publicApiBase(req)}/integrations/whatsapp/webhook/${encodeURIComponent(tenantId)}`;
    res.json(publicConfig(config, webhookUrl));
  } catch (error) {
    console.error('WhatsApp config fetch error:', error);
    res.status(500).json({ error: 'Failed to load WhatsApp settings.' });
  }
});

const saveBody = z.object({
  phoneNumberId: z.string().trim().min(1),
  wabaId: z.string().trim().optional().default(''),
  displayPhoneNumber: z.string().trim().optional().default(''),
  accessToken: z.string().trim().optional().default(''),
  verifyToken: z.string().trim().optional().default(''),
  appSecret: z.string().trim().optional().default(''),
  autoReplyEnabled: z.boolean().optional().default(false),
  businessName: z.string().trim().max(120).optional().default(''),
  aiInstructions: z.string().trim().max(4000).optional().default(''),
});

whatsAppCloudTenantRouter.put('/', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const parsed = saveBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Phone number ID is required.' });
    return;
  }
  try {
    const current = await ensureVerifyToken(tenantId);
    const phoneNumberId = normalizeWaId(parsed.data.phoneNumberId) || parsed.data.phoneNumberId.trim();
    const next = {
      ...current,
      phoneNumberId,
      wabaId: parsed.data.wabaId,
      displayPhoneNumber: parsed.data.displayPhoneNumber,
      accessToken: parsed.data.accessToken || current.accessToken,
      verifyToken: parsed.data.verifyToken || current.verifyToken,
      appSecret: parsed.data.appSecret || current.appSecret,
      autoReplyEnabled: parsed.data.autoReplyEnabled,
      businessName: parsed.data.businessName,
      aiInstructions: parsed.data.aiInstructions,
      connected: Boolean((parsed.data.accessToken || current.accessToken) && phoneNumberId),
      updatedAt: new Date().toISOString(),
    };
    if (!next.accessToken) {
      res.status(400).json({ error: 'Access token is required the first time you connect WhatsApp.' });
      return;
    }
    const verified = await verifyWhatsAppConnection(next);
    await saveWhatsAppConfig(tenantId, verified);
    const webhookUrl = `${publicApiBase(req)}/integrations/whatsapp/webhook/${encodeURIComponent(tenantId)}`;
    res.json(publicConfig(verified, webhookUrl));
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Failed to connect WhatsApp.';
    res.status(400).json({ error: text });
  }
});

const assistantBody = z.object({
  autoReplyEnabled: z.boolean(),
  businessName: z.string().trim().max(120).optional().default(''),
  aiInstructions: z.string().trim().max(4000).optional().default(''),
});

whatsAppCloudTenantRouter.patch('/assistant', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const parsed = assistantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Assistant settings are invalid.' });
    return;
  }
  try {
    const current = await ensureVerifyToken(tenantId);
    const next = {
      ...current,
      autoReplyEnabled: parsed.data.autoReplyEnabled,
      businessName: parsed.data.businessName,
      aiInstructions: parsed.data.aiInstructions,
      updatedAt: new Date().toISOString(),
    };
    await saveWhatsAppConfig(tenantId, next);
    const webhookUrl = `${publicApiBase(req)}/integrations/whatsapp/webhook/${encodeURIComponent(tenantId)}`;
    res.json(publicConfig(next, webhookUrl));
  } catch (error) {
    console.error('WhatsApp assistant settings error:', error);
    res.status(500).json({ error: 'Failed to save assistant settings.' });
  }
});

whatsAppCloudTenantRouter.delete('/', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  try {
    const current = await loadWhatsAppConfig(tenantId);
    const cleared = {
      ...emptyWhatsAppConfig(),
      verifyToken: current.verifyToken,
      businessName: current.businessName,
      aiInstructions: current.aiInstructions,
      updatedAt: new Date().toISOString(),
    };
    await saveWhatsAppConfig(tenantId, cleared);
    const webhookUrl = `${publicApiBase(req)}/integrations/whatsapp/webhook/${encodeURIComponent(tenantId)}`;
    res.json(publicConfig(cleared, webhookUrl));
  } catch (error) {
    console.error('WhatsApp disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect WhatsApp.' });
  }
});
