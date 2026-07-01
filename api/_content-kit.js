import Anthropic from '@anthropic-ai/sdk';

// Turn one published Blog into ready-to-review social posts for each channel.
// Owner-side only; never shown directly to customers.

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Generate a social content kit for one blog article.
 * @param {{title:string, url:string, tag?:string, hookStyle?:string}} article
 * @returns {Promise<object|null>} { facebook, linkedin, googleBusiness, videoScript, apartmentOutreach, hashtags } or null on failure
 */
export async function generateContentKit({ title, url, tag, hookStyle: requestedHookStyle } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !title) return null;

  const anthropic = new Anthropic({ apiKey: key });
  const hookStyle = normalizeHookStyle(requestedHookStyle) || pickHookStyle(title || tag || url || '');

  const system = `You are the social-media manager for AssembleAtEase, a professional furniture assembly, TV mounting, smart-home, and home-setup service. Austin is the launch market, but the brand must be able to expand into other cities later.
Voice: warm, helpful, professional, local, confident, and alive. Honest - NEVER overpromise (no "guaranteed same-day", no fake urgency, no fake crime claims, no scare tactics). A little useful opinion is good; fake drama is not.
Turn ONE blog article into native, ready-to-review posts for each channel. Each must sound natural on its platform and point people toward reading the blog, booking the matching service, or following.
Mention Austin when the article, URL, or hook is Austin-local. For broader service-first blogs, lead with the service and customer problem first so the copy can work beyond Austin.

Important LinkedIn context:
- The LinkedIn post is for the founder's personal profile, not a corporate page.
- It should feel like a founder/operator sharing a practical observation, customer pattern, or local business insight.
- Keep it credible for property managers, apartment operators, office managers, realtors, and referral partners.
- Avoid sounding like a generic ad, discount blast, or social-media intern recap.

Use the assigned hook style to avoid boring recap posts:
- security: smart locks, cameras, porch visibility, "before you need it" urgency, without claiming a specific crime happened or implying a recent break-in.
- cost: what gets expensive when the job is done wrong or delayed.
- mistake: common DIY mistake, what to check first, what not to assume.
- local: city move-ins, apartments, weather, rentals, tight schedules, local homes. Use Austin when the article is Austin-local.
- proof: careful work, clean finish, verified pro, job done right.
- direct-offer: short, clear service offer with one practical benefit.

Hard content rules:
- No emojis or emoji-style symbols on any platform.
- No fake crime claims, fake urgency, or scare tactics.
- No generic "Ready to..." opener unless it is the direct-offer style.
- Keep each post direct, useful, and easy to approve.
- Hashtags must be clean, specific, and platform-appropriate. Do not use unrelated viral tags.`;

  const user = `Article title: "${title}"
Article URL: ${url || ''}
Category: ${tag || 'home services'}
Assigned hook style: ${hookStyle}

Return ONLY valid minified JSON (no markdown, no code fences) with EXACTLY these string keys:
{
"facebook":"A scroll-stopping Facebook Page post. Lead with the assigned hook style, then 2-3 useful sentences, then the article URL on its own line, then 1-3 specific hashtags",
"linkedin":"a founder-style LinkedIn personal-profile post from the founder of AssembleAtEase. Make it sound like an operator sharing something useful he is seeing in the field. Keep it thoughtful, practical, and lightly commercial at most. End with the article URL and 0-3 professional hashtags",
"googleBusiness":"a short Google Business Profile update under 300 characters. Make it service-specific, local when appropriate, and useful. End with a clear action like 'Book online' or 'Schedule setup'",
"videoScript":"a 20-30 second short-video script for Reels/TikTok/Shorts, with [HOOK], [VALUE] and [CTA] labels on separate lines",
"apartmentOutreach":"one short, friendly outreach message to a property manager or apartment complex offering move-in furniture assembly + TV mounting for their residents",
"hashtags":"separate owner-review hashtag recommendations grouped by platform, like Facebook: ... LinkedIn: ... Google Business: ..."
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
    const need = ['facebook', 'linkedin', 'googleBusiness', 'videoScript', 'apartmentOutreach', 'hashtags'];
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
    ['LinkedIn', kit.linkedin],
    ['Google Business Profile', kit.googleBusiness],
    ['Hashtags', kit.hashtags],
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
