import Anthropic from '@anthropic-ai/sdk';

/**
 * A short summary of a recorded private call, for the owner's booking timeline
 * (api/webhooks/telnyx-private-line.js, when Telnyx saves the transcript).
 *
 * Only the owner sees it. The Anthropic API does not train on API content, and
 * no voiceprint is made: the transcript is text, speakers are the two
 * recording channels (caller, person called).
 *
 * Never throws: a summary that cannot be written leaves the recording and its
 * transcript where they are, and says why.
 */
export const CALL_SUMMARY_MODEL = 'claude-opus-5-5';

const SYSTEM = [
  'You summarize recorded phone calls between a home-services customer and the service pro assigned to their booking, for the business owner.',
  'Write 3 to 5 short plain sentences: what was discussed; any change to the job (time, scope, access, parking, items); any problem, complaint or safety concern;',
  'and whether either person asked to deal outside the platform (sharing a personal phone number or email, cash, Venmo, Zelle, Cash App, or doing future work directly).',
  'Say "No off-platform request." when there was none. No headings or lists. If the transcript is empty or too unclear to summarize, say so in one sentence.',
].join(' ');

export async function summarizeCall({ transcript, callerType, client } = {}) {
  const text = String(transcript || '').trim();
  if (!text) return { ok: false, reason: 'empty_transcript' };
  if (!client && !process.env.ANTHROPIC_API_KEY) return { ok: false, reason: 'not_configured' };
  const anthropic = client || new Anthropic();
  const who = callerType === 'customer' ? 'the customer called the pro' : 'the pro called the customer';
  try {
    const response = await anthropic.beta.messages.create({
      model: CALL_SUMMARY_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `In this call ${who}. Channel 1 is the caller, channel 2 the person called.\n\nTranscript:\n${text.slice(0, 60000)}`,
      }],
    });
    if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
    const summary = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return summary ? { ok: true, summary, model: response.model || CALL_SUMMARY_MODEL } : { ok: false, reason: 'empty_summary' };
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return { ok: false, reason: 'rate_limited' };
    if (error instanceof Anthropic.APIError) return { ok: false, reason: `api_error_${error.status || 'unknown'}` };
    return { ok: false, reason: 'network_error' };
  }
}
