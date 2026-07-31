import { getSupabase } from './_supabase.js';
import { normalizeEmail, verifyUnsubToken } from './_broadcast.js';

// Public one-click unsubscribe. Both GET (link click) and POST (List-Unsubscribe-Post
// one-click from Gmail/Yahoo) are honored. Token-gated so only a valid link from
// an email we sent can suppress an address. On success the address is added to
// email_suppressions and removed from marketing opt-ins, and every future
// broadcast filters it out.
function page(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · AssembleAtEase</title>
<style>body{margin:0;background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}
.card{max-width:520px;margin:56px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;text-align:center}
h1{font-size:20px;margin:0 0 10px}p{color:#52525b;line-height:1.6;font-size:15px;margin:0 0 8px}
a{color:#00BFFF;text-decoration:none}</style></head>
<body><main class="card"><h1>${title}</h1><p>${message}</p>
<p style="margin-top:18px"><a href="https://www.assembleatease.com">Return to AssembleAtEase</a></p></main></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const email = normalizeEmail(req.query?.e || req.body?.e || '');
  const token = String(req.query?.t || req.body?.t || '');

  if (!email || !verifyUnsubToken(email, token)) {
    // Never confirm or deny whether the address exists; just fail closed.
    return res.status(400).send(page(
      'Link not valid',
      'This unsubscribe link is invalid or has expired. To stop emails, reply to any AssembleAtEase message with "unsubscribe" and we\'ll remove you.',
    ));
  }

  try {
    const sb = getSupabase();
    // Idempotent: re-clicking the link is fine.
    const { error: supErr } = await sb.from('email_suppressions')
      .upsert({ email, reason: 'unsubscribe', source: 'one_click' }, { onConflict: 'email' });
    if (supErr) {
      console.error('unsubscribe suppression upsert failed:', supErr.message);
      return res.status(500).send(page(
        'Something went wrong',
        'We couldn\'t process that just now. Please try again shortly, or reply "unsubscribe" to any of our emails.',
      ));
    }
    // Best-effort: also drop them from the marketing opt-in list.
    await sb.from('email_marketing_optins').delete().eq('email', email).then(() => {}, () => {});

    return res.status(200).send(page(
      'You\'re unsubscribed',
      'You will no longer receive marketing or announcement emails from AssembleAtEase. You may still receive transactional messages about an active booking (confirmations, status updates, receipts).',
    ));
  } catch (err) {
    console.error('unsubscribe handler error:', err?.message || err);
    return res.status(500).send(page(
      'Something went wrong',
      'We couldn\'t process that just now. Please try again shortly.',
    ));
  }
}
