import Anthropic from '@anthropic-ai/sdk';

// Turn one published Guide into ready-to-review social posts for each channel.
// Owner-side only; never shown directly to customers.

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Generate a social content kit for one article.
 * @param {{title:string, url:string, tag?:string, hookStyle?:string}} article
 * @returns {Promise<object|null>} { facebook, instagram, linkedin, googleBusiness, videoScript, apartmentOutreach } or null on failure
 */
export async function generateContentKit({ title, url, tag, hookStyle: requestedHookStyle } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !title) return null;

  const anthropic = new Anthropic({ apiKey: key });
  const hookStyle = normalizeHookStyle(requestedHookStyle) || pickHookStyle(title || tag || url || '');

  const system = `You are the social-media manager for AssembleAtEase, a professional furniture assembly, TV mounting, smart-home, and home-setup service in Austin, TX.
Voice: warm, helpful, professional, local, confident, and alive. Honest - NEVER overpromise (no "guaranteed same-day", no fake urgency, no fake crime claims, no scare tactics). A little useful opinion is good; fake drama is not.
Turn ONE blog article into native, ready-to-review posts for each channel. Each must sound natural on its platform, mention Austin, and point people toward booking or following.

Use the assigned hook style to avoid boring recap posts:
- security: smart locks, cameras, porch visibility, "before you need it" urgency, without claiming a specific crime happened or implying a recent break-in.
- cost: what gets expensive when the job is done wrong or delayed.
- mistake: common DIY mistake, what to check first, what not to assume.
- local: Austin move-ins, apartments, heat, rentals, tight schedules, local homes.
- proof: careful work, clean finish, verified pro, job done right.
- direct-offer: short, clear service offer with one practical benefit.

Hard content rules:
- No emojis or emoji-style symbols on any platform.
- No fake crime claims, fake urgency, or scare tactics.
- No generic "Ready to..." opener unless it is the direct-offer style.
- Keep each post direct, useful, and easy to approve.`;

  const user = `Article title: "${title}"
Article URL: ${url || ''}
Category: ${tag || 'home services'}
Assigned hook style: ${hookStyle}

Return ONLY valid minified JSON (no markdown, no code fences) with EXACTLY these string keys:
{
"facebook":"A scroll-stopping Facebook Page post. Lead with the assigned hook style, then 2-3 useful sentences, then the article URL on its own line, then 1-2 local hashtags",
"instagram":"a punchy caption (Instagram links don't click, so end with a 'link in bio' nudge), then a new line with 6-10 relevant local hashtags",
"linkedin":"a slightly more professional post angled at Austin property managers, Airbnb hosts, realtors and offices, ending with the article URL",
"googleBusiness":"a short Google Business Profile update under 300 characters. Make it service-specific, local, and useful. End with a clear action like 'Book online' or 'Schedule setup'",
"videoScript":"a 20-30 second short-video script for Reels/TikTok/Shorts, with [HOOK], [VALUE] and [CTA] labels on separate lines",
"apartmentOutreach":"one short, friendly outreach message to a property manager or apartment complex offering move-in furniture assembly + TV mounting for their residents"
}
Plain text only (no HTML). Keep it genuine, specific to the topic, and different from the last service-summary post.`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1600,
      system,
      messages: [{ role: 'user', content: user }],
    });
    let text = (msg.content?.[0]?.text || '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) text = text.slice(start, end + 1);
    const kit = JSON.parse(text);
    const need = ['facebook', 'instagram', 'linkedin', 'googleBusiness', 'videoScript', 'apartmentOutreach'];
    for (const k of need) if (typeof kit[k] !== 'string') kit[k] = '';
    return kit;
  } catch (e) {
    console.error('content-kit generation error:', e?.message || String(e));
    return null;
  }
}

function pickHookStyle(seed) {
  const styles = ['security', 'cost', 'mistake', 'local', 'proof', 'direct-offer'];
  let total = 0;
  for (const ch of String(seed || '')) total += ch.charCodeAt(0);
  return styles[total % styles.length];
}

function normalizeHookStyle(value) {
  const v = String(value || '').trim().toLowerCase();
  return ['security', 'cost', 'mistake', 'local', 'proof', 'direct-offer'].includes(v) ? v : '';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a content kit as a clean, copy-friendly HTML email for the owner.
 */
export function renderContentKitEmailHtml({ title, url, kit }) {
  const sections = [
    ['Facebook', kit.facebook],
    ['Instagram', kit.instagram],
    ['LinkedIn', kit.linkedin],
    ['Google Business Profile', kit.googleBusiness],
    ['Short video script (Reel / TikTok / Short)', kit.videoScript],
    ['Apartment / property-manager outreach', kit.apartmentOutreach],
  ];
  const box = ([label, body]) => `
    <div style="margin:0 0 16px;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden">
      <div style="background:#f4f4f5;padding:8px 14px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#3f3f46">${esc(label)}</div>
      <div style="padding:12px 14px;font-size:14px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap">${esc(body) || '<span style="color:#a1a1aa">-</span>'}</div>
    </div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <p style="margin:0 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#71717a">Social content kit</p>
  <p style="margin:0 0 4px;font-size:20px;font-weight:800;color:#0d1117">${esc(title)}</p>
  <p style="margin:0 0 18px;font-size:13px"><a href="${esc(url)}" style="color:#0099CC">${esc(url)}</a></p>
  <p style="margin:0 0 18px;font-size:13px;color:#52525b;line-height:1.6">Copy any of these straight into the matching channel. Review before posting - tweak anything that does not sound like you.</p>
  ${sections.map(box).join('')}
  <p style="margin:18px 0 0;font-size:11px;color:#a1a1aa;text-align:center">AssembleAtEase &bull; auto-generated content kit</p>
</div></body></html>`;
}
