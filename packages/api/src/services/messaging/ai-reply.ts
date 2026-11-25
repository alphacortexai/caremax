export type InboxAiDraft = {
  reply: string;
  needsHuman: boolean;
};

type HistoryTurn = {
  direction: 'inbound' | 'outbound';
  authorType: 'customer' | 'agent' | 'bot';
  body: string;
};

const DEFAULT_MODEL = process.env.INBOX_AI_MODEL?.trim() || 'gemini-3-flash-preview';
const FALLBACK_MODEL = 'gemini-2.0-flash';

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return '';
  const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> } } | undefined;
  const parts = first?.content?.parts ?? [];
  return parts.map((part) => part.text ?? '').join('').trim();
}

function parseDraft(text: string): InboxAiDraft | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as { reply?: unknown; needsHuman?: unknown };
      const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
      if (!reply) return null;
      return { reply: reply.slice(0, 4000), needsHuman: parsed.needsHuman === true };
    } catch {
      // Fall through to plain text.
    }
  }
  return { reply: trimmed.slice(0, 4000), needsHuman: false };
}

async function generate(model: string, apiKey: string, prompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 500,
          responseMimeType: 'application/json',
        },
      }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (payload as { error?: { message?: string } } | null)?.error?.message
      ?? `AI reply failed (${response.status})`;
    throw new Error(message);
  }
  return extractText(payload);
}

export async function draftInboxReply(params: {
  businessName: string;
  instructions: string;
  history: HistoryTurn[];
}): Promise<InboxAiDraft | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const transcript = params.history
    .slice(-12)
    .map((turn) => `${turn.authorType === 'customer' ? 'Customer' : turn.authorType === 'bot' ? 'Assistant' : 'Agent'}: ${turn.body}`)
    .join('\n');
  const prompt = [
    `You reply to customers on WhatsApp for ${params.businessName || 'this business'}.`,
    'Write a short, useful reply in the customer\'s language. Do not invent order numbers, prices, or policies.',
    'If the customer asks for a person, is upset, or the answer is not in the instructions, set needsHuman to true and tell them a teammate will follow up.',
    'Return JSON only: {"reply":"...","needsHuman":false}.',
    params.instructions.trim() ? `Business instructions:\n${params.instructions.trim()}` : 'Business instructions: Be helpful and concise.',
    `Conversation:\n${transcript || 'Customer: Hello'}`,
  ].join('\n\n');

  try {
    return parseDraft(await generate(DEFAULT_MODEL, apiKey, prompt));
  } catch (error) {
    if (DEFAULT_MODEL === FALLBACK_MODEL) throw error;
    return parseDraft(await generate(FALLBACK_MODEL, apiKey, prompt));
  }
}
