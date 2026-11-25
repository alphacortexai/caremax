import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireTenantParam } from '../middleware/auth.js';
import { normalizeWaId } from '../services/channels/whatsapp-cloud.js';
import { loadWhatsAppConfig, senderForConfig } from '../services/channels/whatsapp-config.js';
import {
  assignConversation,
  conversationCounts,
  getConversation,
  ingestInbound,
  listContacts,
  listConversations,
  listMessages,
  markConversationRead,
  sendOutbound,
  setConversationStatus,
} from '../services/messaging/engine.js';
import type { InboxStatus } from '../services/messaging/types.js';

export const inboxRouter: Router = Router({ mergeParams: true });

inboxRouter.use(requireTenantParam);
inboxRouter.use(requireAuth);
inboxRouter.use(requireAdmin);

const statusSchema = z.enum(['open', 'pending', 'resolved']);

function isInboxStatus(value: string): value is InboxStatus {
  return value === 'open' || value === 'pending' || value === 'resolved';
}

inboxRouter.get('/conversations', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const requested = typeof req.query.status === 'string' ? req.query.status : 'all';
  if (requested !== 'all' && !isInboxStatus(requested)) {
    res.status(400).json({ error: 'Status must be open, pending, resolved, or all.' });
    return;
  }
  try {
    const [conversations, counts] = await Promise.all([
      listConversations(tenantId, requested),
      conversationCounts(tenantId),
    ]);
    res.json({ conversations, counts });
  } catch (error) {
    console.error('Inbox list error:', error);
    res.status(500).json({ error: 'Failed to load conversations.' });
  }
});

inboxRouter.get('/conversations/:conversationId', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const conversationId = req.params.conversationId;
  try {
    const conversation = await getConversation(tenantId, conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ conversation });
  } catch (error) {
    console.error('Inbox conversation error:', error);
    res.status(500).json({ error: 'Failed to load conversation.' });
  }
});

inboxRouter.get('/conversations/:conversationId/messages', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  try {
    const messages = await listMessages(tenantId, req.params.conversationId);
    if (messages.length === 0) {
      const conversation = await getConversation(tenantId, req.params.conversationId);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
    }
    res.json({ messages });
  } catch (error) {
    console.error('Inbox messages error:', error);
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

inboxRouter.post('/conversations/:conversationId/read', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  try {
    const conversation = await markConversationRead(tenantId, req.params.conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ conversation });
  } catch (error) {
    console.error('Inbox read error:', error);
    res.status(500).json({ error: 'Failed to mark conversation read.' });
  }
});

const replyBody = z.object({
  body: z.string().trim().min(1).max(4096),
});

inboxRouter.post('/conversations/:conversationId/messages', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const parsed = replyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A message body is required.' });
    return;
  }
  try {
    const config = await loadWhatsAppConfig(tenantId);
    const message = await sendOutbound({
      tenantId,
      conversationId: req.params.conversationId,
      body: parsed.data.body,
      authorType: 'agent',
      authorId: res.locals.uid as string | undefined,
      authorName: (res.locals.email as string | undefined) || 'Agent',
      sender: senderForConfig(config),
    });
    res.status(201).json({ message });
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Failed to send reply.';
    res.status(text === 'Conversation not found.' ? 404 : 500).json({ error: text });
  }
});

const statusBody = z.object({ status: statusSchema });

inboxRouter.post('/conversations/:conversationId/status', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const parsed = statusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Status must be open, pending, or resolved.' });
    return;
  }
  try {
    const conversation = await setConversationStatus(tenantId, req.params.conversationId, parsed.data.status);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ conversation });
  } catch (error) {
    console.error('Inbox status error:', error);
    res.status(500).json({ error: 'Failed to update conversation status.' });
  }
});

const assignBody = z.object({
  assigneeId: z.string().trim().min(1).nullable(),
  assigneeEmail: z.string().trim().email().optional(),
});

inboxRouter.post('/conversations/:conversationId/assign', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const parsed = assignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide assigneeId, or null to unassign.' });
    return;
  }
  try {
    const conversation = await assignConversation(
      tenantId,
      req.params.conversationId,
      parsed.data.assigneeId
        ? { id: parsed.data.assigneeId, email: parsed.data.assigneeEmail }
        : null,
    );
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ conversation });
  } catch (error) {
    console.error('Inbox assign error:', error);
    res.status(500).json({ error: 'Failed to assign conversation.' });
  }
});

inboxRouter.get('/contacts', async (_req, res) => {
  const tenantId = res.locals.tenantId as string;
  try {
    const contacts = await listContacts(tenantId);
    res.json({ contacts });
  } catch (error) {
    console.error('Inbox contacts error:', error);
    res.status(500).json({ error: 'Failed to load contacts.' });
  }
});

const simulateBody = z.object({
  from: z.string().trim().min(6),
  name: z.string().trim().max(120).optional(),
  text: z.string().trim().min(1).max(4096),
});

inboxRouter.post('/simulate', async (req, res) => {
  const tenantId = res.locals.tenantId as string;
  const parsed = simulateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide a customer phone, and the message text.' });
    return;
  }
  const from = normalizeWaId(parsed.data.from);
  if (from.length < 8) {
    res.status(400).json({ error: 'Enter a customer phone number with country code.' });
    return;
  }
  try {
    const result = await ingestInbound(tenantId, {
      channel: 'whatsapp',
      externalUserId: from,
      displayName: parsed.data.name,
      externalMessageId: `sim_${Date.now()}_${from}`,
      type: 'text',
      body: parsed.data.text,
      timestampMs: Date.now(),
    });
    res.status(201).json(result);
  } catch (error) {
    console.error('Inbox simulate error:', error);
    res.status(500).json({ error: 'Failed to simulate a WhatsApp message.' });
  }
});
