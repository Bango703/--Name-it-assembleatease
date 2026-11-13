// LOCAL ONLY. Actual page renderers, fictional data, in-memory API replies.
// No environment files, provider clients, credentials, or production writes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { buildApprovalPage } from '../api/owner/quote-approve.js';
import { customerQuoteForEarnings, quoteRequestForEaser, validateOfferSubmission } from '../api/booking/_quote-offers.js';
import { PARTNER_STAGES, PARTNER_KINDS, projectPartner, summarizePartners, summarizeAccountBookings, validateAccountUpdate } from '../api/_partners.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const owner = await read('owner/index.html');
const bookingId = '11111111-1111-4111-8111-111111111111';
const easerId = '22222222-2222-4222-8222-222222222222';
const partnerId = '33333333-3333-4333-8333-333333333333';
const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const booking = { id: bookingId, ref: 'DEMO-QUOTE', customer_name: 'Taylor Example',
  service: 'Office furniture assembly', service_city: 'Austin', service_zip: '78701',
  date, time: '10:00 AM – 12:00 PM', status: 'pending', payment_status: 'not_required', payment_method_type: 'card',
  quote_offer_scope: 'Assemble two sit-stand desks and two office chairs. Products are boxed on the ground floor. Bring assembly tools.',
};
let offer = { id: '44444444-4444-4444-8444-444444444444', easer_id: easerId,
  status: 'submitted', earnings_cents: 35000, hours: 4, crew_size: 1,
  note: 'I can assemble both desks and chairs in this visit.',
  respond_by: new Date(Date.now() + 86400000).toISOString(), updated_at: new Date().toISOString() };
let partner = { id: partnerId, name: 'Example Property Group', kind: 'property_manager', stage: 'partner',
  city: 'Austin', ref_code: 'demo123', social: [], history: [], source: 'manual',
  account_status: 'active', account_code: 'PDEMO234', account_discount_pct: 10,
  account_preferred_easer_ids: [easerId], updated_at: new Date().toISOString() };
const reportRows = [
  { id: 'demo-job-1', ref: 'DEMO-101', status: 'completed', payment_status: 'captured', created_at: '2026-11-02T15:00:00Z', amount_charged: 54125, tax_amount: 4125, assembler_due: 35000, stripe_fee: 1600 },
  { id: 'demo-job-2', ref: 'DEMO-102', status: 'completed', payment_status: 'capture_failed', created_at: '2026-11-04T15:00:00Z', total_price: 21650, amount_charged: null },
  { id: 'demo-job-3', ref: 'DEMO-103', status: 'confirmed', payment_status: 'authorized', created_at: '2026-11-06T15:00:00Z', total_price: 32475 },
];
const priced = () => customerQuoteForEarnings(offer.earnings_cents);
const offersPayload = () => ({ enabled: true, migrationNeeded: false, offers: [{
  id: offer.id, status: offer.status, open: offer.status === 'submitted',
  earningsCents: offer.earnings_cents, hours: offer.hours, crewSize: offer.crew_size,
  note: offer.note, respondBy: offer.respond_by, updatedAt: offer.updated_at,
  easer: { id: easerId, name: 'Alex Example', rating: 4.9, completedJobs: 12 }, customerQuote: priced(),
}] });
const ribbon = '<aside class="preview-ribbon">Local preview · Fictional records · No payments or messages are sent <nav><a href="/">Overview</a><a href="/owner-preview">Owner quote</a><a href="/easer-preview">Easer</a><a href="/customer-preview">Customer</a><a href="/partners-preview">Partner account</a></nav></aside>';
const ribbonStyle = '<style>.preview-ribbon{position:relative;z-index:100000;padding:14px 20px;background:#082f49;color:white;font:14px/1.5 Arial,sans-serif}.preview-ribbon nav{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px}.preview-ribbon a{color:#b9efff}.preview-ribbon+main{margin-top:24px}*{box-sizing:border-box}</style>';
function decorate(html) { return html.replace('</head>', `${ribbonStyle}</head>`).replace(/<body([^>]*)>/, `<body$1>${ribbon}`); }
function shell(body, script = '', css = '') { return decorate(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hybrid marketplace preview</title>${css}</head><body>${body}<script>${script}</script></body></html>`); }
const escapeScript = `function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));} function jsAttr(v){return esc(v)} function fmt$(v){return '$'+(Number(v)/100).toFixed(2)} function headers(){return {'Content-Type':'application/json'}} function toast(v){document.getElementById('preview-status').textContent=v} var selectedId=null; async function loadBookings(){} function selectBooking(){} function updateQuoteBreakdown(){}`;
const quoteFragment = owner.slice(owner.indexOf('<div class="modal-overlay" id="quote-modal">'), owner.indexOf('<!-- ─── Change Order Modal'));
const quoteFunctions = owner.slice(owner.indexOf('  var quoteOffersFor = null;'), owner.indexOf("  document.getElementById('qm-cancel').addEventListener"));
const partnerFragment = owner.slice(owner.indexOf('<div id="partners-view"'), owner.indexOf('<!-- Gift cards and the Move-In Pass.')).replace('style="display:none"', '');
const ownerCss = '<link rel="stylesheet" href="/owner/assets/owner.css"><link rel="stylesheet" href="/owner/assets/partners.css"><style>body{margin:0;background:#f5f7fa;color:#132337;font-family:Arial,sans-serif}.modal-overlay{position:relative;display:flex!important;background:none;min-height:0;padding:24px}.modal{max-height:none!important;width:100%}.partners-view{padding:24px;max-width:1200px;margin:auto}#preview-status{padding:12px 24px;color:#082f49}</style>';
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-src 'none'; form-action 'none'");
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const json = data => res.end(JSON.stringify(data));
      let body = {};
      if (req.method === 'POST') { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw new Error('Fixture request too large'); } body = JSON.parse(raw || '{}'); }
      if (url.pathname === '/api/owner/quote-offers') {
        if (body.action === 'close') offer.status = 'closed';
        return json(offersPayload());
      }
      if (url.pathname === '/api/assembler/price-requests') {
        if (req.method === 'POST') {
          if (offer.status === 'selected') { res.statusCode = 409; return json({ error: 'This price request is closed.' }); }
          if (body.action === 'withdraw') offer.status = 'withdrawn';
          else { const checked = validateOfferSubmission(body); if (!checked.ok) { res.statusCode = 400; return json({ error: checked.error }); }
            Object.assign(offer, { status: 'submitted', earnings_cents: checked.value.earningsCents, hours: checked.value.hours, crew_size: checked.value.crewSize, note: checked.value.note, updated_at: new Date().toISOString() }); }
          return json({ ok: true });
        }
        const view = quoteRequestForEaser(offer, booking);
        return json({ enabled: true, requests: [view] });
      }
      if (url.pathname === '/api/owner/quote-approve') {
        if (body.quoteOfferId) { offer.status = 'selected'; booking.selected_quote_offer_id = offer.id; }
        return json({ ok: true, confirmed: true, amount: priced().totalCents, easerEarningsCents: priced().easerEarningsCents, warnings: [] });
      }
      if (url.pathname === '/api/owner/partners') {
        if (body.action === 'account') { const checked = validateAccountUpdate(partner, body); if (checked.error) { res.statusCode = 400; return json({ error: checked.error }); } partner = { ...partner, ...checked.patch }; }
        if (req.method === 'POST') return json({ partner: projectPartner(partner, new Map()) });
        const p = projectPartner(partner, new Map());
        p.account.report = summarizeAccountBookings(reportRows, { month: url.searchParams.get('month') });
        return json({ stages: PARTNER_STAGES, kinds: PARTNER_KINDS, partners: [p], summary: summarizePartners([partner]),
          bookingCountsAvailable: true, accounts: { enabled: true, columnsReady: true, maxDiscountPct: 20, reportsAvailable: true,
            easers: [{ id: easerId, name: 'Alex Example', city: 'Austin' }] } });
      }
      res.statusCode = 404; return json({ error: 'Not part of this local preview.' });
    }
    if (url.pathname === '/owner-preview') return res.end(shell('<p id="preview-status" role="status"></p>' + quoteFragment,
      escapeScript + quoteFunctions + `document.getElementById('qm-id').value=${JSON.stringify(bookingId)};document.getElementById('qm-date').value=${JSON.stringify(date)};document.getElementById('qm-time').selectedIndex=1;document.getElementById('qm-scope').textContent=${JSON.stringify(booking.quote_offer_scope)};loadQuoteOffers(${JSON.stringify(bookingId)});document.getElementById('qm-submit').onclick=()=>toast('Use an Easer price above to preview this flow.');`, ownerCss));
    if (url.pathname === '/partners-preview') return res.end(shell(partnerFragment,
      `window._ownerHeaders=()=>({});`, ownerCss).replace('</body>', '<script src="/owner/assets/partners.js"></script><script>OwnerPartners.load();</script></body>'));
    if (url.pathname === '/easer-preview') {
      let html = (await read('assembler/price-requests.html')).replace(/<script\b[^>]*\bsrc=[^>]*>[\s\S]*?<\/script>/gi, '');
      const auth = `<script>var supabaseClient={auth:{getSession:async()=>({data:{session:{access_token:'fictional'}}})}};var APP={requireAuth:async()=>({user:{id:'fictional'},session:{access_token:'fictional'}}),bindPrivateSession:async()=>true,revealPrivatePage:()=>document.body.classList.remove('easer-booting'),showAlert:(id,text)=>{let e=document.getElementById(id);e.textContent=text;e.classList.remove('hidden')}};</script>`;
      html = html.replace('<script>\n(function', auth + '<script>\n(function');
      return res.end(decorate(html));
    }
    if (url.pathname === '/customer-preview') {
      const q = priced();
      let html = buildApprovalPage({ booking: { ...booking, quote_subtotal_cents: q.subtotalCents, quote_tax_cents: q.taxCents, quote_amount_cents: q.totalCents }, token: 'fictional', publishableKey: 'fixture', needsCard: true });
      html = html.replace('<script src="https://js.stripe.com/v3/"></script>', `<script>function Stripe(){return {elements:()=>({create:()=>({mount:s=>{document.querySelector(s).textContent='Demo card field. No card information is collected.'},on:(e,fn)=>fn({complete:true}),unmount:()=>{}})}),confirmCardPayment:async()=>({})}}</script>`);
      return res.end(decorate(html));
    }
    if (url.pathname === '/') return res.end(shell(`<main style="max-width:800px;margin:40px auto;padding:24px;font:16px/1.6 Arial"><h1>The hybrid marketplace</h1><p>Review a private Easer price, the single customer quote, and a partner account.</p><ol><li><a href="/easer-preview">Easer: send or update a price</a></li><li><a href="/owner-preview">Owner: review and select the offer</a></li><li><a href="/customer-preview">Customer: see the quote and payment terms</a></li><li><a href="/partners-preview">Owner: account pricing and monthly report</a></li></ol><p>The platform share is 30% of the service subtotal. An Easer requesting $100 produces a $142.86 subtotal before tax.</p><p><strong>Scope still open:</strong> approved net-30 invoicing and account-specific item price sheets. This preview uses a catalog discount and card payment per job.</p><p>Fixture changes reset when this preview server restarts.</p></main>`));
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || !/^\/(assets|owner\/assets|images)\//.test(url.pathname) || !/\.(css|js|png|jpg|svg|woff2?)$/.test(path)) { res.statusCode = 404; return res.end('Preview route not found'); }
    res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'image/jpeg');
    res.end(await readFile(path));
  } catch (e) { console.error(e.message); res.statusCode = 500; res.end('Local preview could not be rendered.'); }
});
server.listen(4197, '127.0.0.1', () => console.log('Hybrid preview: http://127.0.0.1:4197 (fictional data only)'));
