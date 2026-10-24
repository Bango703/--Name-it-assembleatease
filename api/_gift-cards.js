// Gift cards and the Move-In Pass: the one owner of every stored-value rule.
//
// Owner, 2026-10-24. Two products on one ledger (migration 119):
//   gift_card     $25-$500 of credit, bought for someone else or yourself
//   move_in_pass  $49 paid, plus an $11 bonus and priority booking for 30 days
//
// Paid value never expires (federal CARD Act). Only the disclosed bonus does.
// A card is a way to pay, not a discount: tax and Easer pay are figured on
// the full service price. Balances live in Postgres (gift_card_balances_v1),
// never in this file, so the owner panel, the balance check and redemption
// can never disagree about what is left on a card.
//
// The code a customer types is never stored. It is derived from the Stripe
// Checkout session with GIFT_CARD_CODE_SECRET, so issuing is idempotent and a
// failed email can be sent again; only its hash and last four are kept.
import { createHash, createHmac } from 'crypto';
import { esc, sendEmail as sendEmailDefault, ownerEmail } from './_email.js';

// Wrapped so tests can stand in for delivery; every real send goes through sendEmail().
function sendEmail(message) { return sendEmailDefault(message); }
import { normalizePersonName } from './_person-name.js';

export const SITE = 'https://www.assembleatease.com';
export const GIFT_CARD_PRODUCT = 'stored_value';
export const GIFT_CARD_MIN_CENTS = 2500;
export const GIFT_CARD_MAX_CENTS = 50000;
export const GIFT_CARD_PRESET_CENTS = Object.freeze([2500, 5000, 10000, 15000, 25000]);
export const MOVE_IN_PASS = Object.freeze({
  paidCents: 4900,
  bonusCents: 1100,
  bonusDays: 30,
  priorityDays: 30,
});
export const GIFT_CARD_KINDS = Object.freeze(['gift_card', 'move_in_pass']);
const MESSAGE_MAX = 400;
const NAME_MAX = 80;
const EMAIL_MAX = 160;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'AAEG';
const DELIVERY_CLAIM_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Codes can be used at checkout (stage 2, api/booking.js). While this is
// false nothing can be sold, even with GIFT_CARDS_ENABLED=true: a card that
// cannot be spent must never be bought. Sales are switched on separately with
// GIFT_CARDS_ENABLED; a card already sold stays usable when sales are off.
export const GIFT_CARD_REDEMPTION_READY = true;

export function isGiftCardsEnabled(env = process.env) {
  return GIFT_CARD_REDEMPTION_READY && String(env.GIFT_CARDS_ENABLED || '').trim().toLowerCase() === 'true';
}

function codeSecret(env = process.env) {
  return String(env.GIFT_CARD_CODE_SECRET || '').trim();
}

export function isGiftCardsConfigured(env = process.env) {
  return Boolean(env.STRIPE_SECRET_KEY) && codeSecret(env).length >= 32;
}

export function formatCents(cents) {
  const n = Number(cents || 0) / 100;
  return '$' + (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2));
}

export function productName(kind) {
  return kind === 'move_in_pass' ? 'Move-In Pass' : 'AssembleAtEase gift card';
}

// ── Codes ────────────────────────────────────────────────────────────────

export function codeForSession(sessionId, env = process.env) {
  const secret = codeSecret(env);
  if (secret.length < 32) throw new Error('GIFT_CARD_CODE_SECRET must be set (32+ characters) before gift cards can be issued.');
  if (!sessionId) throw new Error('A Stripe Checkout session is required to derive a gift card code.');
  const digest = createHmac('sha256', secret).update(`gift-card:${sessionId}`).digest();
  let chars = '';
  for (let i = 0; i < 12; i++) chars += CODE_ALPHABET[digest[i] % CODE_ALPHABET.length];
  return `${CODE_PREFIX}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function normalizeCode(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^AAEG[A-Z0-9]{12}$/.test(compact)) return null;
  return compact;
}

export function hashCode(value) {
  const compact = normalizeCode(value);
  if (!compact) return null;
  return createHash('sha256').update(compact).digest('hex');
}

export function codeLast4(value) {
  const compact = normalizeCode(value);
  return compact ? compact.slice(-4) : null;
}

// ── Purchase input ──────────────────────────────────────────────────────

function cleanText(value, max) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, max);
}

function cleanMessage(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MESSAGE_MAX);
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > EMAIL_MAX) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

/** What the customer pays for one purchase. The server decides it; the
 * browser's number is never used. */
export function expectedPaidCents(kind, amountCents) {
  if (kind === 'move_in_pass') return MOVE_IN_PASS.paidCents;
  if (kind !== 'gift_card') return null;
  const cents = Number(amountCents);
  if (!Number.isInteger(cents) || cents % 100 !== 0) return null;
  if (cents < GIFT_CARD_MIN_CENTS || cents > GIFT_CARD_MAX_CENTS) return null;
  return cents;
}

export function validatePurchase(body = {}) {
  const kind = String(body.kind || '').trim();
  if (!GIFT_CARD_KINDS.includes(kind)) return { ok: false, error: 'Choose a gift card or the Move-In Pass.' };
  const amountCents = kind === 'move_in_pass'
    ? MOVE_IN_PASS.paidCents
    : Math.round(Number(body.amountDollars) * 100);
  const paidCents = expectedPaidCents(kind, amountCents);
  if (!paidCents) {
    return { ok: false, error: `Choose a whole-dollar amount from ${formatCents(GIFT_CARD_MIN_CENTS)} to ${formatCents(GIFT_CARD_MAX_CENTS)}.` };
  }
  const purchaserEmail = cleanEmail(body.purchaserEmail);
  if (!purchaserEmail) return { ok: false, error: 'Enter your email address.' };
  const purchaserName = normalizePersonName(cleanText(body.purchaserName, NAME_MAX)) || '';
  const forSomeoneElse = body.forSomeoneElse === true || body.forSomeoneElse === 'true';
  let recipientEmail = purchaserEmail;
  let recipientName = purchaserName;
  if (forSomeoneElse) {
    recipientEmail = cleanEmail(body.recipientEmail);
    if (!recipientEmail) return { ok: false, error: "Enter the recipient's email address." };
    recipientName = normalizePersonName(cleanText(body.recipientName, NAME_MAX)) || '';
  }
  const message = forSomeoneElse ? cleanMessage(body.message) : '';
  return {
    ok: true,
    purchase: { kind, paidCents, purchaserEmail, purchaserName, recipientEmail, recipientName, message, forSomeoneElse },
  };
}

export function checkoutSessionParams(purchase, { site = SITE } = {}) {
  const isPass = purchase.kind === 'move_in_pass';
  const description = isPass
    ? `${formatCents(MOVE_IN_PASS.paidCents + MOVE_IN_PASS.bonusCents)} of setup credit and ${MOVE_IN_PASS.priorityDays} days of priority booking`
    : `${formatCents(purchase.paidCents)} of credit toward any AssembleAtEase service`;
  const metadata = {
    aae_product: GIFT_CARD_PRODUCT,
    kind: purchase.kind,
    paid_cents: String(purchase.paidCents),
    purchaser_name: purchase.purchaserName || '',
    recipient_email: purchase.recipientEmail,
    recipient_name: purchase.recipientName || '',
    message: purchase.message || '',
  };
  return {
    mode: 'payment',
    customer_email: purchase.purchaserEmail,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: purchase.paidCents,
        product_data: { name: productName(purchase.kind), description },
      },
    }],
    payment_intent_data: {
      description: productName(purchase.kind),
      metadata: { aae_product: GIFT_CARD_PRODUCT, kind: purchase.kind },
    },
    metadata,
    allow_promotion_codes: false,
    success_url: `${site}/gift-cards?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/gift-cards?purchase=cancelled`,
  };
}

// ── Issuing ─────────────────────────────────────────────────────────────

export function isOurSession(session) {
  return session?.metadata?.aae_product === GIFT_CARD_PRODUCT;
}

/** The card a paid Checkout session buys, or the reason it buys nothing. */
export function cardFromSession(session, env = process.env) {
  if (!isOurSession(session)) return { ok: false, reason: 'not_gift_card' };
  if (session.payment_status !== 'paid' || session.status !== 'complete') return { ok: false, reason: 'unpaid' };
  const meta = session.metadata || {};
  const kind = String(meta.kind || '');
  const paidCents = expectedPaidCents(kind, Number(meta.paid_cents));
  if (!paidCents || session.currency !== 'usd' || Number(session.amount_total) !== paidCents) {
    return { ok: false, reason: 'amount_mismatch', detail: { kind, metaPaidCents: meta.paid_cents, amountTotal: session.amount_total, currency: session.currency } };
  }
  const purchaserEmail = cleanEmail(session.customer_details?.email || session.customer_email);
  const recipientEmail = cleanEmail(meta.recipient_email) || purchaserEmail;
  if (!purchaserEmail || !recipientEmail) return { ok: false, reason: 'missing_email' };
  const code = codeForSession(session.id, env);
  const bought = new Date(Number(session.created) * 1000 || Date.now());
  const isPass = kind === 'move_in_pass';
  return {
    ok: true,
    code,
    row: {
      code_hash: hashCode(code),
      code_last4: codeLast4(code),
      kind,
      paid_cents: paidCents,
      bonus_cents: isPass ? MOVE_IN_PASS.bonusCents : 0,
      bonus_expires_at: isPass ? new Date(bought.getTime() + MOVE_IN_PASS.bonusDays * DAY_MS).toISOString() : null,
      priority_until: isPass ? new Date(bought.getTime() + MOVE_IN_PASS.priorityDays * DAY_MS).toISOString() : null,
      purchaser_email: purchaserEmail,
      purchaser_name: cleanText(meta.purchaser_name, NAME_MAX) || null,
      recipient_email: recipientEmail,
      recipient_name: cleanText(meta.recipient_name, NAME_MAX) || null,
      message: cleanMessage(meta.message) || null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    },
  };
}

export function isMissingGiftCardTable(error) {
  const message = String(error?.message || '');
  return error?.code === 'PGRST205' || error?.code === '42P01'
    || (/gift_card/i.test(message) && /does not exist|could not find/i.test(message));
}

async function findCardBySession(sb, sessionId) {
  const { data, error } = await sb.from('gift_cards').select('*').eq('stripe_checkout_session_id', sessionId).maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Issue the card a paid session bought and deliver it. Safe to call any
 * number of times, from the success page and the reconcile cron at once. */
export async function issueFromCheckoutSession(sb, session, { env = process.env, deliver = deliverCard } = {}) {
  const built = cardFromSession(session, env);
  if (!built.ok) {
    if (built.reason === 'amount_mismatch') await alertOwner('Gift card payment did not match its price', { sessionId: session?.id, ...built.detail });
    return built;
  }
  let card = await findCardBySession(sb, session.id);
  if (!card) {
    const { error } = await sb.from('gift_cards').insert(built.row);
    if (error && error.code !== '23505') throw error;
    card = await findCardBySession(sb, session.id);
    if (!card) throw new Error('The gift card could not be saved.');
  }
  const { error: ledgerError } = await sb.from('gift_card_ledger').insert({
    gift_card_id: card.id,
    entry_type: 'issue',
    paid_delta_cents: card.paid_cents,
    bonus_delta_cents: card.bonus_cents,
    note: card.kind === 'move_in_pass' ? 'Move-In Pass purchased' : 'gift card purchased',
  });
  if (ledgerError && ledgerError.code !== '23505') throw ledgerError;
  let delivery = { ok: true, alreadyDelivered: Boolean(card.delivered_at) };
  if (!card.delivered_at && card.status === 'active') delivery = await deliver(sb, card, built.code);
  return { ok: true, card, delivery };
}

// ── Delivery ────────────────────────────────────────────────────────────

async function claimDelivery(sb, cardId, now = new Date()) {
  const stale = new Date(now.getTime() - DELIVERY_CLAIM_MS).toISOString();
  const { data, error } = await sb.from('gift_cards')
    .update({ delivery_claimed_at: now.toISOString() })
    .eq('id', cardId)
    .is('delivered_at', null)
    .or(`delivery_claimed_at.is.null,delivery_claimed_at.lt.${stale}`)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

function firstName(name) {
  const clean = normalizePersonName(name || '');
  return clean ? clean.split(' ')[0] : '';
}

function longDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
}

export function buildRecipientEmail(card, code) {
  const isPass = card.kind === 'move_in_pass';
  const hi = firstName(card.recipient_name);
  const fromName = normalizePersonName(card.purchaser_name || '');
  const gifted = card.recipient_email !== card.purchaser_email;
  const total = formatCents(card.paid_cents + card.bonus_cents);
  const subject = isPass
    ? 'Your Move-In Pass is ready'
    : gifted ? `${fromName || 'Someone'} sent you an AssembleAtEase gift card` : 'Your AssembleAtEase gift card';
  const lines = [];
  lines.push(`<p style="margin:0 0 16px">${hi ? `Hi ${esc(hi)},` : 'Hi,'}</p>`);
  if (gifted && !isPass) lines.push(`<p style="margin:0 0 16px">${esc(fromName || 'Someone')} sent you ${formatCents(card.paid_cents)} toward furniture assembly, TV mounting and home setup.</p>`);
  if (gifted && isPass) lines.push(`<p style="margin:0 0 16px">${esc(fromName || 'Someone')} sent you a Move-In Pass for your new place.</p>`);
  if (card.message) lines.push(`<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="border-left:3px solid #00BFFF;padding:4px 0 4px 14px;color:#3f3f46;font-style:italic">${esc(card.message).replace(/\n/g, '<br>')}</td></tr></table>`);
  lines.push(`<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;margin:0 0 16px"><tr><td style="padding:18px 20px">
    <div style="font-size:24px;font-weight:700;color:#0f172a">${total} credit</div>
    <div style="font-size:13px;color:#475569;margin-top:10px">Your code</div>
    <div style="font-size:20px;font-weight:700;letter-spacing:1px;color:#0f172a;font-family:Menlo,Consolas,monospace">${esc(code)}</div>
  </td></tr></table>`);
  if (isPass) {
    lines.push(`<p style="margin:0 0 8px"><strong>Priority booking</strong> until ${longDate(card.priority_until)}.</p>`);
    lines.push(`<p style="margin:0 0 16px;font-size:13px;color:#52525b">${formatCents(card.paid_cents)} of the credit never expires. The ${formatCents(card.bonus_cents)} bonus expires ${longDate(card.bonus_expires_at)} and is used first.</p>`);
  } else {
    lines.push(`<p style="margin:0 0 16px;font-size:13px;color:#52525b">The credit never expires. Enter the code when you book.</p>`);
  }
  lines.push(`<p style="text-align:center;margin:24px 0"><a href="${SITE}/book" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600">Book a setup</a></p>`);
  lines.push(`<p style="margin:0 0 4px;font-size:13px;color:#52525b">Check your balance any time at <a href="${SITE}/gift-cards#balance" style="color:#0369a1">assembleatease.com/gift-cards</a>. The credit is not cash and cannot be withdrawn.</p>`);
  lines.push(`<p style="margin:16px 0 0">Thanks,<br>The AssembleAtEase Team</p>`);
  return { subject, html: lines.join('\n') };
}

export function buildPurchaserReceipt(card) {
  const isPass = card.kind === 'move_in_pass';
  const hi = firstName(card.purchaser_name);
  const recipient = normalizePersonName(card.recipient_name || '') || card.recipient_email;
  const subject = `Receipt: ${productName(card.kind)}, ${formatCents(card.paid_cents)}`;
  const html = [
    `<p style="margin:0 0 16px">${hi ? `Hi ${esc(hi)},` : 'Hi,'}</p>`,
    `<p style="margin:0 0 16px">Your ${isPass ? 'Move-In Pass' : 'gift card'} was sent to ${esc(recipient)}${recipient === card.recipient_email ? '' : ` at ${esc(card.recipient_email)}`}.</p>`,
    `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:0 0 16px"><tr><td style="padding:16px 20px;font-size:14px;color:#3f3f46">
      ${productName(card.kind)}: <strong>${formatCents(card.paid_cents)}</strong><br>
      Card ending in ${esc(card.code_last4)}
    </td></tr></table>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#52525b">Questions? Reply to this email.</p>`,
    `<p style="margin:0">Thanks,<br>The AssembleAtEase Team</p>`,
  ].join('\n');
  return { subject, html };
}

export async function deliverCard(sb, card, code, { send = sendEmail, resendTag = null } = {}) {
  if (!resendTag && !(await claimDelivery(sb, card.id))) return { ok: true, skipped: 'claimed_elsewhere' };
  const deliveryKey = resendTag ? `gift-card-resend:${card.id}:${resendTag}` : `gift-card-delivery:${card.id}`;
  const recipient = buildRecipientEmail(card, code);
  const sent = await send({
    to: card.recipient_email,
    subject: recipient.subject,
    html: recipient.html,
    replyTo: 'service@assembleatease.com',
    meta: { recipientType: 'customer', notificationType: 'gift_card_delivery', priority: 'critical', notificationKey: deliveryKey, giftCardId: card.id },
  });
  if (!sent?.ok) {
    await sb.from('gift_cards').update({ delivery_claimed_at: null, delivery_error: String(sent?.error || 'Email was not accepted').slice(0, 300) }).eq('id', card.id);
    return { ok: false, error: sent?.error || 'Email was not accepted' };
  }
  await sb.from('gift_cards').update({ delivered_at: card.delivered_at || new Date().toISOString(), delivery_error: null }).eq('id', card.id);
  if (!resendTag && card.recipient_email !== card.purchaser_email) {
    const receipt = buildPurchaserReceipt(card);
    await send({
      to: card.purchaser_email,
      subject: receipt.subject,
      html: receipt.html,
      replyTo: 'service@assembleatease.com',
      meta: { recipientType: 'customer', notificationType: 'gift_card_receipt', notificationKey: `gift-card-receipt:${card.id}`, giftCardId: card.id },
    }).catch(() => null);
  }
  return { ok: true };
}

// ── Reading ─────────────────────────────────────────────────────────────

export async function readBalances(sb) {
  const { data, error } = await sb.rpc('gift_card_balances_v1');
  if (error) throw error;
  const map = new Map();
  for (const row of data || []) map.set(row.gift_card_id, { paidCents: Number(row.paid_cents || 0), bonusCents: Number(row.bonus_cents || 0) });
  return map;
}

/** What a customer may see about a card: no names, no emails. */
export function publicBalance(card, balance) {
  const bonusLive = balance.bonusCents > 0 && card.bonus_expires_at && new Date(card.bonus_expires_at) > new Date();
  const priorityLive = card.priority_until && new Date(card.priority_until) > new Date();
  return {
    kind: card.kind,
    name: productName(card.kind),
    last4: card.code_last4,
    active: card.status === 'active',
    balanceCents: balance.paidCents + balance.bonusCents,
    paidCents: balance.paidCents,
    bonusCents: balance.bonusCents,
    bonusExpiresAt: bonusLive ? card.bonus_expires_at : null,
    priorityUntil: priorityLive ? card.priority_until : null,
  };
}

export async function lookupBalance(sb, rawCode) {
  const codeHash = hashCode(rawCode);
  if (!codeHash) return { ok: false, status: 400, error: 'Enter the code exactly as it appears in your email.' };
  const { data: card, error } = await sb.from('gift_cards').select('*').eq('code_hash', codeHash).maybeSingle();
  if (error) throw error;
  if (!card) return { ok: false, status: 404, error: 'That code was not found. Check it against your email.' };
  const { data: rows, error: balanceError } = await sb.rpc('gift_card_balance_v1', { p_gift_card_id: card.id });
  if (balanceError) throw balanceError;
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { ok: true, card: publicBalance(card, { paidCents: Number(row?.paid_cents || 0), bonusCents: Number(row?.bonus_cents || 0) }) };
}

/** Owner view: what was sold, what is still owed in service, what failed. */
export function summarizeForOwner(cards, balances, now = new Date()) {
  const summary = {
    soldCount: 0, soldCents: 0,
    giftCardCount: 0, moveInPassCount: 0,
    outstandingPaidCents: 0, outstandingBonusCents: 0,
    redeemedCents: 0, undelivered: 0, activePriority: 0, voided: 0,
  };
  const rows = cards.map((card) => {
    const balance = balances.get(card.id) || { paidCents: 0, bonusCents: 0 };
    summary.soldCount += 1;
    summary.soldCents += card.paid_cents;
    if (card.kind === 'move_in_pass') summary.moveInPassCount += 1; else summary.giftCardCount += 1;
    if (card.status === 'void') summary.voided += 1;
    if (card.status === 'active') {
      summary.outstandingPaidCents += balance.paidCents;
      summary.outstandingBonusCents += balance.bonusCents;
      summary.redeemedCents += card.paid_cents - balance.paidCents;
      if (!card.delivered_at) summary.undelivered += 1;
      if (card.priority_until && new Date(card.priority_until) > now) summary.activePriority += 1;
    }
    return {
      id: card.id,
      kind: card.kind,
      name: productName(card.kind),
      last4: card.code_last4,
      status: card.status,
      paidCents: card.paid_cents,
      bonusCents: card.bonus_cents,
      balancePaidCents: balance.paidCents,
      balanceBonusCents: balance.bonusCents,
      bonusExpiresAt: card.bonus_expires_at,
      priorityUntil: card.priority_until,
      purchaserEmail: card.purchaser_email,
      purchaserName: card.purchaser_name,
      recipientEmail: card.recipient_email,
      recipientName: card.recipient_name,
      deliveredAt: card.delivered_at,
      deliveryError: card.delivery_error,
      stripePaymentIntentId: card.stripe_payment_intent_id,
      createdAt: card.created_at,
    };
  });
  return { summary, cards: rows };
}

/** Void a card: nothing left on it can be used. Used for a refunded or
 * disputed purchase. The ledger keeps what was on it. */
export async function voidCard(sb, card, note) {
  const balances = await readBalances(sb);
  const balance = balances.get(card.id) || { paidCents: 0, bonusCents: 0 };
  const { data, error } = await sb.from('gift_cards').update({ status: 'void' }).eq('id', card.id).eq('status', 'active').select('id');
  if (error) throw error;
  if (!data?.length) return { ok: true, alreadyVoid: true };
  if (balance.paidCents || balance.bonusCents) {
    const { error: ledgerError } = await sb.from('gift_card_ledger').insert({
      gift_card_id: card.id, entry_type: 'void',
      paid_delta_cents: -balance.paidCents, bonus_delta_cents: -balance.bonusCents,
      note: String(note || 'voided').slice(0, 300),
    });
    if (ledgerError) throw ledgerError;
  }
  return { ok: true, voidedCents: balance.paidCents + balance.bonusCents };
}

export async function alertOwner(subject, detail = {}, { send = sendEmail, key = null } = {}) {
  const rows = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#71717a">${esc(k)}</td><td style="padding:4px 0">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`)
    .join('');
  try {
    await send({
      to: ownerEmail(),
      subject: `Gift cards: ${subject}`,
      html: `<p style="margin:0 0 12px"><strong>${esc(subject)}</strong></p><table cellpadding="0" cellspacing="0" style="font-size:13px">${rows}</table><p style="margin:16px 0 0"><a href="${SITE}/owner/">Open the dashboard, Gift Cards</a></p>`,
      meta: { recipientType: 'owner', notificationType: 'gift_card_owner_alert', ...(key ? { notificationKey: `gift-card-alert:${key}` } : {}) },
    });
  } catch (error) {
    console.error('[gift-cards] owner alert failed:', error?.message || error);
  }
}

// ── Using a card on a booking (stage 2) ─────────────────────────────────

const STRIPE_MINIMUM_CHARGE_CENTS = 50;

/**
 * The most a gift card may pay on one booking. The customer's card always
 * keeps a hold large enough for the largest cancellation fee and Stripe's
 * minimum charge, so cancelling, capturing and refunding work exactly as on
 * a booking paid entirely by card. What is left stays on the gift card.
 */
export function maxGiftCardCents({ totalCents, serviceSubtotalCents, maxCancellationFeePct }) {
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const subtotal = Math.max(0, Math.round(Number(serviceSubtotalCents) || 0));
  const largestFee = Math.ceil(subtotal * Math.max(0, Number(maxCancellationFeePct) || 0) / 100);
  return Math.max(0, total - Math.max(STRIPE_MINIMUM_CHARGE_CENTS, largestFee));
}

async function findActiveCard(sb, rawCode) {
  const codeHash = hashCode(rawCode);
  if (!codeHash) return { ok: false, status: 400, code: 'GIFT_CARD_INVALID', error: 'Enter the gift card code exactly as it appears in your email.' };
  const { data: card, error } = await sb.from('gift_cards').select('*').eq('code_hash', codeHash).maybeSingle();
  if (error) throw error;
  if (!card) return { ok: false, status: 404, code: 'GIFT_CARD_NOT_FOUND', error: 'That gift card code was not found. Check it against your email.' };
  if (card.status !== 'active') return { ok: false, status: 409, code: 'GIFT_CARD_VOID', error: 'This gift card can no longer be used.' };
  return { ok: true, card, codeHash };
}

export function priorityFromCard(card, now = new Date()) {
  return card?.kind === 'move_in_pass' && Boolean(card.priority_until) && new Date(card.priority_until) > now;
}

/** What a card would pay on this total, without taking anything. */
export async function previewGiftCard(sb, { code, totalCents, serviceSubtotalCents, maxCancellationFeePct }) {
  const found = await findActiveCard(sb, code);
  if (!found.ok) return found;
  const { data: rows, error } = await sb.rpc('gift_card_balance_v1', { p_gift_card_id: found.card.id });
  if (error) throw error;
  const row = Array.isArray(rows) ? rows[0] : rows;
  const balanceCents = Number(row?.paid_cents || 0) + Number(row?.bonus_cents || 0);
  if (balanceCents <= 0) return { ok: false, status: 409, code: 'GIFT_CARD_EMPTY', error: 'This gift card has no balance left.' };
  const appliedCents = Math.min(balanceCents, maxGiftCardCents({ totalCents, serviceSubtotalCents, maxCancellationFeePct }));
  return {
    ok: true,
    appliedCents,
    balanceCents,
    remainingCents: balanceCents - appliedCents,
    last4: found.card.code_last4,
    priority: priorityFromCard(found.card),
  };
}

/** Take the credit for one booking, atomically. Repeating for the same
 * booking ref returns the same amount instead of taking more. */
export async function applyGiftCardToBooking(sb, { code, bookingRef, totalCents, serviceSubtotalCents, maxCancellationFeePct }) {
  const found = await findActiveCard(sb, code);
  if (!found.ok) return found;
  const want = maxGiftCardCents({ totalCents, serviceSubtotalCents, maxCancellationFeePct });
  if (want <= 0) return { ok: true, appliedCents: 0, giftCardId: found.card.id, last4: found.card.code_last4, priority: false };
  const { data, error } = await sb.rpc('gift_card_redeem_v1', { p_code_hash: found.codeHash, p_amount_cents: want, p_booking_ref: bookingRef });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  const appliedCents = Number(row?.paid_used || 0) + Number(row?.bonus_used || 0);
  if (appliedCents <= 0) return { ok: false, status: 409, code: 'GIFT_CARD_EMPTY', error: 'This gift card has no balance left.' };
  return {
    ok: true,
    appliedCents,
    giftCardId: found.card.id,
    last4: found.card.code_last4,
    priority: priorityFromCard(found.card),
  };
}

/** Return whatever a booking ref took, before the booking row exists or
 * after it failed to save. */
export async function releaseGiftCardReservation(sb, bookingRef, reason) {
  if (!bookingRef) return { ok: true, releasedCents: 0 };
  try {
    const { data, error } = await sb.rpc('gift_card_release_v1', { p_booking_ref: bookingRef, p_note: String(reason || 'returned to card').slice(0, 200) });
    if (error) throw error;
    return { ok: true, releasedCents: Number(data || 0) };
  } catch (error) {
    await alertOwner('Gift card credit was not returned', {
      booking: bookingRef, reason, error: error?.message || String(error),
      action: 'Use Return credit in Gift Cards with this booking reference.',
    }, { key: `release-failed:${bookingRef}` });
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Return a saved booking's credit to its card and clear it from the booking. */
export async function releaseBookingGiftCard(sb, booking, reason) {
  const applied = Number(booking?.gift_card_applied_cents || 0);
  if (!booking?.ref || applied <= 0) return { ok: true, releasedCents: 0 };
  const released = await releaseGiftCardReservation(sb, booking.ref, reason);
  if (!released.ok) return released;
  const { error } = await sb.from('bookings')
    .update({ gift_card_applied_cents: 0, gift_card_priority: false })
    .eq('id', booking.id);
  if (error) {
    await alertOwner('Gift card credit returned but the booking still shows it', {
      booking: booking.ref, amount: formatCents(applied), error: error.message,
    }, { key: `release-booking-update:${booking.ref}` });
    return { ok: false, error: error.message };
  }
  return { ok: true, releasedCents: released.releasedCents };
}
