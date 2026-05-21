import Anthropic from '@anthropic-ai/sdk';
import { verifyOwner } from '../_email.js';
import { getSupabase } from '../_supabase.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'AI not configured' });

  const sb = getSupabase();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // ── Pull all platform data ───────────────────────────────────────
  const [bookingsRes, reviewsRes] = await Promise.all([
    sb.from('bookings').select('*').order('created_at', { ascending: false }),
    sb.from('reviews').select('*').order('created_at', { ascending: false }),
  ]);

  const bookings = bookingsRes.data || [];
  const reviews  = reviewsRes.data || [];

  // ── Compute platform health signals ─────────────────────────────
  const pending   = bookings.filter(b => b.status === 'pending');
  const confirmed = bookings.filter(b => b.status === 'confirmed');
  const completed = bookings.filter(b => b.status === 'completed');
  const cancelled = bookings.filter(b => b.status === 'cancelled');
  const today     = bookings.filter(b => b.date === todayStr);

  // Stale pending — older than 2 hours with no action
  const stale = pending.filter(b => {
    const age = (now - new Date(b.created_at)) / 3600000;
    return age > 2;
  });

  // Missed jobs — confirmed but date already passed, not completed
  const missed = confirmed.filter(b => b.date && b.date < todayStr);

  // Completed jobs with no review request sent
  const needsReview = completed.filter(b => !b.review_requested_at && b.customer_email);

  // Revenue metrics
  const gross = completed.reduce((s, b) => s + (Number(b.total_price) || 0), 0);
  const stripeFees = completed.reduce((s, b) => {
    const c = Number(b.total_price) || 0;
    return s + (c > 0 ? Math.round(c * 0.029) + 30 : 0);
  }, 0);
  const netRevenue = gross - stripeFees;
  const pendingPayouts = completed.filter(b => b.assembler_due && b.payout_status !== 'paid')
    .reduce((s, b) => s + (Number(b.assembler_due) || 0), 0);

  // Booking velocity — last 7 days vs prev 7 days
  const d7  = new Date(now - 7  * 86400000).toISOString();
  const d14 = new Date(now - 14 * 86400000).toISOString();
  const last7  = bookings.filter(b => b.created_at >= d7).length;
  const prev7  = bookings.filter(b => b.created_at >= d14 && b.created_at < d7).length;
  const velocityTrend = prev7 === 0 ? null : Math.round(((last7 - prev7) / prev7) * 100);

  // Review health
  const avgRating = reviews.length
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
    : null;
  const lowRatings = reviews.filter(r => r.rating <= 2);

  // Today's schedule
  const todayJobs = today.map(b => ({
    time: b.time, service: b.service, status: b.status,
    customer: b.customer_name, address: b.address,
  }));

  // Services breakdown
  const svcMap = {};
  bookings.forEach(b => { svcMap[b.service] = (svcMap[b.service] || 0) + 1; });

  const platformData = {
    snapshot: {
      totalBookings: bookings.length,
      pending: pending.length,
      confirmed: confirmed.length,
      completed: completed.length,
      cancelled: cancelled.length,
      todayJobCount: today.length,
    },
    alerts: {
      stalePendingCount: stale.length,
      stalePendingRefs: stale.map(b => b.ref).join(', ') || 'none',
      missedJobsCount: missed.length,
      missedJobRefs: missed.map(b => b.ref + ' (' + b.date + ')').join(', ') || 'none',
      needsReviewCount: needsReview.length,
      pendingPayoutsDollars: (pendingPayouts / 100).toFixed(2),
    },
    financials: {
      grossRevenueDollars: (gross / 100).toFixed(2),
      stripeFeeDollars: (stripeFees / 100).toFixed(2),
      netRevenueDollars: (netRevenue / 100).toFixed(2),
      avgJobValueDollars: completed.length ? ((gross / completed.length) / 100).toFixed(2) : 0,
      completionRate: bookings.length ? Math.round(completed.length / bookings.length * 100) + '%' : '0%',
    },
    growth: {
      bookingsLast7Days: last7,
      bookingsPrev7Days: prev7,
      velocityTrendPct: velocityTrend !== null ? (velocityTrend >= 0 ? '+' : '') + velocityTrend + '%' : 'Building baseline',
    },
    reviews: {
      totalReviews: reviews.length,
      avgRating: avgRating || 'no reviews yet',
      lowRatingCount: lowRatings.length,
      needsReviewRequestCount: needsReview.length,
    },
    todaySchedule: todayJobs,
    topServices: Object.entries(svcMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => s + ': ' + c + ' bookings'),
  };

  // ── Auto-dispatch confirmed unassigned bookings ─────────────────
  const unassigned = confirmed.filter(b => !b.assembler_id && !b.dispatch_offered_at);
  const dispatchResults = [];
  for (const b of unassigned) {
    try {
      const r = await dispatchBooking(b.id);
      dispatchResults.push({ ref: b.ref, result: r.message, dispatched: r.dispatched });
    } catch(e) { dispatchResults.push({ ref: b.ref, result: 'error: ' + e.message }); }
  }
  if (dispatchResults.length) {
    platformData.autoDispatchedNow = dispatchResults;
  }

  // ── Ask Claude Haiku to synthesize ──────────────────────────────
  const client = new Anthropic({ apiKey: key });

  const { message } = req.body;
  const isChat = !!message;

  const systemPrompt = `You are the business intelligence system for AssembleAtEase — a professional assembly and handyman service in Austin, TX growing toward national expansion.

You have full access to real-time platform data shown below. Your job is to surface what matters, flag problems before they cost money, and give the owner direct, actionable guidance.

Platform data:
${JSON.stringify(platformData, null, 2)}

CRITICAL FORMATTING RULES — you must follow these exactly:
- Never use markdown: no #, ##, **, *, backticks, or dashes as bullets
- Use plain section labels like "URGENT:", "REVENUE:", "GROWTH:" on their own line
- Use numbers for lists: 1. 2. 3.
- Separate sections with a blank line
- Be direct, specific, use real numbers from the data
- Priority order: revenue risk > customer problems > growth opportunities
- For alerts, tell the owner EXACTLY what to do
- For growth, think like a business scaling from 1 city to nationwide
- Keep responses under 250 words unless writing a draft email
- Never say "I notice" or "I'd suggest" — just state it`;

  const userMsg = isChat ? message.trim()
    : `Today is ${todayStr}. Run a full platform health check.

${dispatchResults.length ? `NOTE: I just auto-dispatched ${dispatchResults.length} confirmed unassigned booking(s) to Easers: ${dispatchResults.map(r => r.ref + ' (' + r.result + ')').join(', ')}.` : ''}

Give me:
1. URGENT — anything that needs attention right now (stale pending, missed jobs, uncontacted customers)
2. REVENUE — snapshot of money in/out, pending payouts
3. TODAY — what's on the schedule today
4. GROWTH — booking trend, what's working
5. ACTION — the single most important thing I should do in the next hour

Use the actual numbers from the data. Be direct.`;

  const aiMsg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }],
  });

  return res.status(200).json({
    reply: aiMsg.content[0]?.text?.trim(),
    data: platformData,
  });
}
