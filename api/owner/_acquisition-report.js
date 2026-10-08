import { parseServiceLocation } from '../_booking-location.js';
import { cleanBookingAttribution } from '../_booking-attribution.js';
import { chicagoTodayIso } from '../booking/_appt-date.js';

const LABELS = { organic_search: 'Organic search', organic_social: 'Organic social', referral: 'Referral', email: 'Email', campaign: 'Other tagged campaign', paid_search: 'Paid search', paid_unclassified: 'Paid source, type unknown', search_unclassified: 'Search source, medium unknown', owner_recorded: 'Owner recorded, original source unknown', unattributed: 'Original source unknown' };

export function acquisitionForBooking(booking = {}) {
  const a = booking.booking_attribution && typeof booking.booking_attribution === 'object' && !Array.isArray(booking.booking_attribution) ? booking.booking_attribution : {};
  // Apply the capture boundary's evidence rules, never trust a supplied channel
  // or infer organic from a historical Google label. No record is rewritten.
  let channel = cleanBookingAttribution(a).channel;
  if (!LABELS[channel]) channel = 'unattributed';
  if (channel === 'unattributed') {
    const source = String(a.source || booking.source || '').trim().toLowerCase();
    if (/^(google|bing|duckduckgo|ecosia|yahoo)(?:\.[a-z.]+)?$/.test(source)) channel = 'search_unclassified';
    else if (String(booking.source || '').trim().toLowerCase() === 'owner_manual') channel = 'owner_recorded';
  }
  return { channel, label: LABELS[channel], evidence: ['unattributed', 'owner_recorded', 'search_unclassified', 'paid_unclassified'].includes(channel) ? 'incomplete' : 'recorded' };
}

function chicagoDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? chicagoTodayIso(date) : null;
}

export function acquisitionRange(period = '90', now = new Date()) {
  period = String(period);
  if (!['28', '90', 'all'].includes(period)) throw new Error('Period must be 28, 90 or all');
  const today = chicagoDate(now);
  if (!today) throw new Error('Invalid snapshot time');
  if (period === 'all') return { period, from: null, to: null, basis: 'Booking creation date; outcomes as of this snapshot', timezone: 'America/Chicago' };
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Number(period) + 1);
  return { period: String(period), from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), basis: 'Booking creation date; outcomes as of this snapshot', timezone: 'America/Chicago' };
}

function emptyGroup(key, label, financeAvailable) {
  return { key, label, bookings: 0, completed: 0, cancelled: 0, open: 0, uniqueContacts: 0, missingContact: 0, recordedPaymentsCents: financeAvailable ? 0 : null, platformGrossCents: financeAvailable ? 0 : null, organicBookings: 0, organicCompleted: 0, organicRecordedPaymentsCents: financeAvailable ? 0 : null, financeMissing: 0, incompleteAttribution: 0, rows: [] };
}

function contactKeys(booking) {
  const email = String(booking.customer_email || '').trim().toLowerCase();
  const phone = String(booking.customer_phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return [/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `email:${email}` : null, phone.length === 10 ? `phone:${phone}` : null].filter(Boolean);
}

function contactIdentity(bookings) {
  const parents = new Map();
  function root(key) {
    if (!parents.has(key)) parents.set(key, key);
    if (parents.get(key) !== key) parents.set(key, root(parents.get(key)));
    return parents.get(key);
  }
  // Finish unions before counting groups, including later email/phone bridges.
  // These private keys never leave this authenticated calculation.
  for (const booking of bookings) {
    const keys = contactKeys(booking);
    for (const key of keys) parents.set(root(key), root(keys[0]));
  }
  return booking => { const key = contactKeys(booking)[0]; return key ? root(key) : null; };
}

function financeAmounts(row, booking) {
  // The canonical finance loader has a legacy quote fallback. Do not promote
  // that fallback to recorded acquisition revenue for an uncaptured web job.
  const recordedAmount = Number.isSafeInteger(booking.amount_charged) && booking.amount_charged > 0
    && row?.charged === booking.amount_charged;
  const recorded = row && (row.hasLedger === true
    || (recordedAmount && ['captured', 'partially_refunded', 'refunded'].includes(row.paymentStatus))
    || (row.source === 'owner_manual' && row.paymentStatus === 'offline_recorded'));
  const cents = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  return { payments: recorded ? cents(row.netCharged) : null, gross: recorded ? cents(row.platformRevenue) : null };
}

export function buildAcquisitionReport(bookings = [], finance = null, { period = '90', now = new Date(), totalCount = null } = {}) {
  const range = acquisitionRange(period, now);
  const financeAvailable = !!finance && !finance.error && Array.isArray(finance.rows);
  const finances = new Map((financeAvailable ? finance.rows : []).filter(r => !r.isTestBooking && r.status === 'completed').map(r => [r.bookingId, r]));
  const summary = emptyGroup('total', 'All recorded bookings', financeAvailable);
  const channels = new Map(), markets = new Map(), seen = new Set();
  const contacts = new Map();
  let excludedTests = 0, excludedInvalidDates = 0, estimatedGrossRows = 0;
  const cohort = [];
  for (const booking of bookings) {
    if (!booking.id || seen.has(booking.id)) continue;
    seen.add(booking.id);
    if (booking.is_test_booking === true) { excludedTests++; continue; }
    const date = chicagoDate(booking.created_at);
    if (range.from && !date) { excludedInvalidDates++; continue; }
    if (range.from && (date < range.from || date > range.to)) continue;
    cohort.push(booking);
  }
  const identityFor = contactIdentity(cohort);
  for (const booking of cohort) {
    const date = chicagoDate(booking.created_at);
    const acquisition = acquisitionForBooking(booking);
    const organic = acquisition.channel === 'organic_search';
    const location = parseServiceLocation({ city: booking.service_city, state: booking.service_state, zip: booking.service_zip, address: booking.address });
    const marketLabel = location.city && location.state ? `${location.city}, ${location.state}` : 'Service city unknown';
    const marketKey = marketLabel.toLowerCase();
    if (!channels.has(acquisition.channel)) channels.set(acquisition.channel, emptyGroup(acquisition.channel, acquisition.label, financeAvailable));
    if (!markets.has(marketKey)) markets.set(marketKey, emptyGroup(marketKey, marketLabel, financeAvailable));
    const status = String(booking.status || '').toLowerCase();
    const completed = status === 'completed';
    const cancelled = ['cancelled', 'declined', 'refunded'].includes(status);
    const fin = completed ? finances.get(booking.id) : null;
    // Reuse the existing finance projection; never substitute quote/cart totals.
    const { payments, gross } = completed ? financeAmounts(fin, booking) : { payments: financeAvailable ? 0 : null, gross: financeAvailable ? 0 : null };
    const financeMissing = completed && (payments == null || gross == null);
    const estimatedGross = gross != null && completed && fin.stripeFeeIsActual !== true;
    if (estimatedGross) estimatedGrossRows++;
    const row = { bookingId: booking.id, ref: booking.ref || booking.id, createdDate: date, city: marketLabel, status, channel: acquisition.label, channelKey: acquisition.channel, attributionEvidence: acquisition.evidence,
      recordedPaymentsCents: payments, platformGrossCents: gross, financeEstimated: estimatedGross,
      financeBasis: financeMissing ? 'Finance unavailable or needs review' : fin ? `${fin.legacyDerived ? 'Legacy finance projection' : 'Finance ledger projection'}${estimatedGross ? '; processing fee estimated' : ''}` : 'Not completed' };
    // Contact dedupe is local to this authenticated calculation; identities are
    // never returned or sent to analytics. Missing contacts remain explicit.
    const identity = identityFor(booking);
    for (const group of [summary, channels.get(acquisition.channel), markets.get(marketKey)]) {
      group.bookings++;
      if (completed) group.completed++;
      else if (cancelled) group.cancelled++;
      else group.open++;
      if (organic) { group.organicBookings++; if (completed) group.organicCompleted++; }
      if (acquisition.evidence === 'incomplete') group.incompleteAttribution++;
      if (financeMissing) group.financeMissing++;
      if (payments == null || group.recordedPaymentsCents == null) group.recordedPaymentsCents = null;
      else group.recordedPaymentsCents += payments;
      if (gross == null || group.platformGrossCents == null) group.platformGrossCents = null;
      else group.platformGrossCents += gross;
      if (organic) {
        if (payments == null || group.organicRecordedPaymentsCents == null) group.organicRecordedPaymentsCents = null;
        else group.organicRecordedPaymentsCents += payments;
      }
      if (!identity) group.missingContact++;
      else { if (!contacts.has(group)) contacts.set(group, new Set()); contacts.get(group).add(identity); group.uniqueContacts = contacts.get(group).size; }
      group.rows.push(row);
    }
  }
  const warnings = [];
  const countKnown = Number.isSafeInteger(totalCount) && totalCount >= 0;
  const bookingSourcePartial = !countKnown || totalCount !== bookings.length;
  // The shared finance loader uses bounded PostgREST reads, including its
  // ledger lookup. Do not claim completeness at a possible default row ceiling.
  const financeLimitRisk = financeAvailable && (bookings.filter(booking => ['completed', 'cancelled'].includes(booking.status)).length >= 1000
    || finance.rows.length >= 1000 || finance.reconciliation?.ledgerRows >= 1000);
  if (!financeAvailable) warnings.push('Financial source unavailable. Payment and gross figures are unknown.');
  if (summary.financeMissing) warnings.push(`${summary.financeMissing} completed booking(s) have missing or unverifiable finance projections. Affected group totals are unknown.`);
  if (estimatedGrossRows) warnings.push(`${estimatedGrossRows} completed booking(s) use estimated processing fees in platform gross.`);
  if (excludedInvalidDates) warnings.push(`${excludedInvalidDates} record(s) lack a usable creation date and are outside this dated cohort.`);
  if (!countKnown) warnings.push('Stored booking count is unavailable; booking completeness cannot be verified.');
  else if (bookingSourcePartial) warnings.push(`Received ${bookings.length} of ${totalCount} stored booking records. This is a partial report.`);
  if (financeLimitRisk) warnings.push('Financial source uses bounded database reads and may have reached a row limit. Financial completeness is unverified.');
  if (financeAvailable && (finance.reconciliation?.mismatchedCount || finance.reconciliation?.duplicateLedgerBookingCount)) warnings.push('The financial source reports reconciliation differences. Review Financials before relying on projected gross.');
  if (summary.incompleteAttribution) warnings.push(`${summary.incompleteAttribution} booking(s) lack complete original channel evidence; they are not credited to organic search.`);
  return { generatedAt: now.toISOString(), range, summary, channels: [...channels.values()].sort((a, b) => b.bookings - a.bookings), markets: [...markets.values()].sort((a, b) => b.bookings - a.bookings), excludedTests, excludedInvalidDates, financeAvailable,
    partial: bookingSourcePartial || !financeAvailable || summary.financeMissing > 0 || excludedInvalidDates > 0 || financeLimitRisk, warnings,
    notes: ['Booking records are not a count of qualified leads. Repeat jobs remain separate; known contacts are deduplicated by exact normalized email or phone, not verified individual people.', 'Organic outcome columns mean organic search only. Cancelled/lost counts include cancelled, declined and refunded booking statuses.', 'Amounts reuse Financials for completed jobs in this creation-date cohort, through the snapshot date. They exclude cancellation earnings and are not period cash flow or net profit.', 'Original source cannot be recovered from self-referrals or missing historical tracking. No source or test flags are changed by this report.'] };
}
