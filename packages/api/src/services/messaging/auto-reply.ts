import { loadWhatsAppConfig, senderForConfig } from '../channels/whatsapp-config.js';
import { draftInboxReply } from './ai-reply.js';
import { getConversation, listMessages, sendOutbound, setConversationStatus } from './engine.js';

export async function maybeAutoReply(tenantId: string, conversationId: string): Promise<void> {
  const config = await loadWhatsAppConfig(tenantId);
  if (!config.autoReplyEnabled) return;
  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation || conversation.assigneeId || conversation.status !== 'open') return;
  const messages = await listMessages(tenantId, conversationId);
  const draft = await draftInboxReply({
    businessName: config.businessName || config.verifiedName || 'the business',
    instructions: config.aiInstructions,
    history: messages.map((message) => ({
      direction: message.direction,
      authorType: message.authorType,
      body: message.body,
    })),
  });
  if (!draft?.reply) return;
  await sendOutbound({
    tenantId,
    conversationId,
    body: draft.reply,
    authorType: 'bot',
    authorName: config.businessName || 'AI assistant',
    sender: senderForConfig(config),
  });
  if (draft.needsHuman) {
    await setConversationStatus(tenantId, conversationId, 'pending');
  }
}
