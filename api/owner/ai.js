import Anthropic from '@anthropic-ai/sdk';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'AI not configured' });

  const { message, context } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  const client = new Anthropic({ apiKey: key });

  const system = `You are a sharp, concise business assistant for AssembleAtEase — a professional furniture assembly and handyman service in Austin, TX.
You help the owner manage bookings, understand revenue, and run a growing service business.

Business context provided by the dashboard:
${context ? JSON.stringify(context, null, 2) : 'No context provided.'}

Rules:
- Be direct and brief — owner is busy
- Give actionable advice, not generic tips
- When asked to write something (email, message, review reply), produce it ready to copy-paste
- Reference actual numbers from the context when available
- Think like a business operator, not a chatbot`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: message.trim() }],
    });

    return res.status(200).json({ reply: msg.content[0]?.text?.trim() || 'No response.' });
  } catch (e) {
    console.error('AI error:', e);
    return res.status(500).json({ error: 'AI request failed' });
  }
}
