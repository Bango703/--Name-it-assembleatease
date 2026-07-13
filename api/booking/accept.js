/**
 * Legacy email-link mutation endpoint.
 *
 * Assignment accept/decline now requires an authenticated Easer session via
 * POST /api/booking/accept-dispatch. Keep this route as a non-mutating landing
 * page so old emails fail safely and direct users to the current dashboard.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in required - AssembleAtEase</title><style>body{margin:0;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif}.card{max-width:520px;margin:48px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px}.btn{display:inline-block;background:#00bfff;color:#002b3a;padding:12px 20px;border-radius:7px;text-decoration:none;font-weight:700}</style></head><body><main class="card"><h1>Sign in required</h1><p>For your security, assignment links no longer accept or decline jobs directly. Sign in to review the job, earnings, requirements, and current availability.</p><a class="btn" href="/assembler/my-assignments">Open Easer dashboard</a></main></body></html>`);
}
