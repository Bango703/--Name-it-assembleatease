

// ----------------------------------------------------------------------------

// SOURCE OF TRUTH (catalog + service area)

// ----------------------------------------------------------------------------

var AAE_BOOKING_SOURCE = window.AAE_BOOKING_SOURCE || {};

var SUBCATS = AAE_BOOKING_SOURCE.subcategories || {};

var SERVICE_AREA = AAE_BOOKING_SOURCE.serviceArea || { city:'Texas', state:'TX', label:'Statewide Texas service', statewideTexas:true, zipPrefixes:['787'], zipCodes:[] };

var SERVICE_CALL_ZONES = {
  austin_core: { label: 'Austin core', fee: 5, minPretax: 129 },
  central_texas: { label: 'Participating Central Texas communities', fee: 5, minPretax: 149 },
  texas_statewide: { label: 'Statewide Texas service', fee: 5, minPretax: 149 }
};

var ACTIVE_MARKET_LABEL = 'Statewide Texas booking coverage';


(function() {
  var d = new Date(); d.setDate(d.getDate() + 1);
  var label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  var el = document.getElementById('urgency-next');
  if (el) el.textContent = label;
})();



// ----------------------------------------------------------------------------

// STATE

// ----------------------------------------------------------------------------

var BOOK = {
  _formStartedAt: Date.now(),

  selectedServices: [],

  selectedItems: {},   // { ServiceName: [{name, price, priceMax, addon, customQuote, qty}] }
  currentSvc: null,
  currentGroup: '',
  itemStage: 'service',
  servicePickerMode: 'initial',
  servicePickerReturnSvc: '',

  details: '',

  wantsQuote: false,

  accountMode: '',

  date: '',

  time: '',

  address: '',

  city: '',

  state: 'TX',

  zip: '',

  isEmergingMarket: false,

  firstName: '',

  lastName: '',

  email: '',

  phone: '',

  promoCode: '',

  _promoPreview: null,

  _promoApplied: false,

  _stripe: null,

  _elements: null,

  _cardEl: null,

  _cardComplete: false,

  paymentMethod: 'card',

  _klarnaMessageEl: null

};



var TIME_SLOTS = ['8:00 AM \u2013 10:00 AM','10:00 AM \u2013 12:00 PM','12:00 PM \u2013 2:00 PM','2:00 PM \u2013 4:00 PM','4:00 PM \u2013 6:00 PM','6:00 PM \u2013 8:00 PM'];
var BOOKING_WINDOW_DAYS = 30;
// Mirrors api/booking/_booking-window.js. Bounded by the shortest card
// authorization window (Visa merchant-initiated, 4 days 18 hours), not chosen
// freely. Change it there first.
var IMMEDIATE_AUTHORIZATION_DAYS = 2;

function captureBookingAttribution() {
  return window.AAE_ATTRIBUTION ? window.AAE_ATTRIBUTION.capture() : {};
}

// Owner "rebook" links (utm_campaign=rebook) prefill the customer's contact step from
// the URL so a returning customer lands ready to go. Additive: only fills empty fields,
// never overwrites anything the customer types.
document.addEventListener('DOMContentLoaded', function() {
  try {
    var rp = new URLSearchParams(window.location.search || '');
    var rName = (rp.get('name') || '').trim();
    var rEmail = (rp.get('email') || '').trim();
    var rPhone = (rp.get('phone') || '').trim();
    if (rName) {
      var rParts = rName.split(/\s+/);
      var rf = document.getElementById('s4-first'); if (rf && !rf.value) rf.value = rParts.shift() || '';
      var rl = document.getElementById('s4-last'); if (rl && !rl.value) rl.value = rParts.join(' ');
    }
    if (rEmail) { var re = document.getElementById('s4-email'); if (re && !re.value) re.value = rEmail; }
    if (rPhone) {
      var rph = document.getElementById('s4-phone');
      if (rph && !rph.value) { rph.value = (typeof formatUsPhone === 'function') ? formatUsPhone(rPhone) : rPhone; }
    }
  } catch (e) {}
});

var BOOKING_ANALYTICS_ATTEMPT = Date.now().toString(36) + Math.random().toString(36).slice(2);
var bookingAnalyticsQueue = [];
function flushBookingAnalytics() {
  if (!window.AAEAnalytics) return;
  var pending = bookingAnalyticsQueue.splice(0);
  pending.forEach(function (entry) {
    try { window.AAEAnalytics.trackOnce(entry.name, entry.params, entry.key); } catch (e) { /* Measurement cannot block booking. */ }
  });
}
function trackBookingFunnelOnce(eventName, params, bookingRef) {
  try {
  // Cookieless until Accept (Consent Mode); nothing after Decline or a GPC signal.
  if (window.AAEAnalytics) { if (!window.AAEAnalytics.canMeasure()) return; }
  else if (navigator.globalPrivacyControl === true || localStorage.getItem('cookie-consent') === 'declined') return;
  // Funnel milestones belong to this attempt; confirmations belong to their booking.
  // A second real booking in one tab must be counted, while a repeated confirmation must not.
  var key = (bookingRef ? 'booking:' + bookingRef : 'attempt:' + BOOKING_ANALYTICS_ATTEMPT) + ':' + eventName;
  bookingAnalyticsQueue.push({ name: eventName, key: key, params: Object.assign({
    booking_flow: 'standard',
    service_count: BOOK.selectedServices.length,
    service_market: 'unknown', service_city: 'unknown'
  }, BOOK._analytics || {}, params || {}) });
  if (window.__AAE_GTAG_READY__) flushBookingAnalytics();
  } catch (e) { /* Measurement cannot block booking. */ }
}
window.addEventListener('aae-analytics-ready', function () {
  flushBookingAnalytics();
  trackBookingFunnelOnce('job_plan_started');
});
window.addEventListener('aae-analytics-consent-changed', function () {
  if (!window.AAEAnalytics.canMeasure()) bookingAnalyticsQueue = [];
});
trackBookingFunnelOnce('job_plan_started');

var CHICAGO_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
});

var CHICAGO_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function formatIsoDateParts(parts) {
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function chicagoDateParts(date) {
  var values = {};
  CHICAGO_DATE_FORMATTER.formatToParts(date || new Date()).forEach(function(part) {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return values;
}

function getChicagoTodayIso() {
  return formatIsoDateParts(chicagoDateParts(new Date()));
}

function addIsoDays(isoDate, days) {
  var date = new Date(isoDate + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getIsoWeekday(isoDate) {
  return new Date(isoDate + 'T12:00:00Z').getUTCDay();
}

function getChicagoMinutesNow() {
  var values = {};
  CHICAGO_TIME_FORMATTER.formatToParts(new Date()).forEach(function(part) {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return (parseInt(values.hour, 10) || 0) * 60 + (parseInt(values.minute, 10) || 0);
}

function getSlotStartMinutes(slot) {
  var match = String(slot || '').match(/^(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return null;
  var hour = parseInt(match[1], 10);
  var minute = parseInt(match[2], 10);
  if (match[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (match[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function isPublishedSlotAvailable(isoDate, slot) {
  var todayIso = getChicagoTodayIso();
  var maxIso = addIsoDays(todayIso, BOOKING_WINDOW_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || '')) || isoDate < todayIso || isoDate > maxIso) return false;
  var slotIndex = TIME_SLOTS.indexOf(slot);
  if (slotIndex < 0) return false;   // 8 AM–8 PM, every day; only past same-day slots are filtered below
  if (isoDate === todayIso) {
    var startMinutes = getSlotStartMinutes(slot);
    var sdCfg = (window.AAE_BOOKING_SOURCE && window.AAE_BOOKING_SOURCE.sameDay) || {};
    var leadMin = sdCfg.enabled ? Math.max(0, Number(sdCfg.minLeadMinutes || 0)) : 0;
    if (startMinutes == null || startMinutes <= getChicagoMinutesNow() + leadMin) return false;
  }
  return true;
}

var CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';

function escAttr(s) { return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;'); }

function itemRowHtml(svc, item) {

  var sel = isItemSelected(svc, item.name);

  var qty = getItemQty(svc, item.name);

  var badge = item.popular ? '<span class="subcat-item-badge">Popular</span>' : '';

  var price = '<span class="subcat-item-price' + (item.addon ? ' addon' : '') + '">' + esc(fmtPrice(item)) + '</span>';

  return '<div class="subcat-item' + (sel ? ' selected' : '') + '"'

    + ' data-item-svc="' + escAttr(svc) + '"'

    + ' data-item-name="' + escAttr(item.name) + '"'

    + ' data-item-price="' + (item.price||0) + '"'

    + ' data-item-price-max="' + (item.priceMax||0) + '"'

    + ' data-item-addon="' + (!!item.addon) + '"'

    + ' data-item-custom="' + (!!item.customQuote) + '">'

    + '<div class="subcat-item-left">'

    + '<div class="subcat-item-cb">' + CHECK_SVG + '</div>'

    + '<span class="subcat-item-name">' + esc(item.name) + '</span>'

    + badge

    + '</div>'

    + '<div class="subcat-item-meta">'

    + price

    + '<div class="subcat-qty">'

    + '<button type="button" class="qty-btn" aria-label="Decrease ' + escAttr(item.name) + ' quantity" data-qty-svc="' + escAttr(svc) + '" data-qty-name="' + escAttr(item.name) + '" data-qty-delta="-1"' + (qty <= 1 ? ' disabled' : '') + '>\u2212</button>'

    + '<span class="qty-val" aria-live="polite">' + qty + '</span>'

    + '<button type="button" class="qty-btn" aria-label="Increase ' + escAttr(item.name) + ' quantity" data-qty-svc="' + escAttr(svc) + '" data-qty-name="' + escAttr(item.name) + '" data-qty-delta="1"' + (qty >= 99 ? ' disabled' : '') + '>+</button>'

    + '</div>'

    + '</div>'

    + '</div>';

}




// ----------------------------------------------------------------------------

// HELPERS

// ----------------------------------------------------------------------------

function esc(s) { var d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }

function showErr(id, msg) { var el = document.getElementById(id); if (!el) return; if (msg) el.textContent = msg; el.classList.add('show'); }

function hideErr(id) { var el = document.getElementById(id); if (el) el.classList.remove('show'); }

function fieldErr(inId, errId, show) {

  var inp = document.getElementById(inId);

  if (inp) inp.classList.toggle('error', show);

  if (show) showErr(errId); else hideErr(errId);

}

function isValidZip(zip) {
  return !!zip && zip.length === 5 && /^\d{5}$/.test(zip);
}

function isTexasZip(zip) {
  if (!isValidZip(zip)) return false;
  var prefix = String(zip).slice(0, 3);
  var numericPrefix = Number(prefix);
  return prefix === '733' || prefix === '885' || (numericPrefix >= 750 && numericPrefix <= 799);
}

function isValidUsPhone(phone) {
  var digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  return /^\d{10}$/.test(digits);
}

function formatUsPhoneForDisplay(phone) {
  var original = String(phone || '').trim();
  var digits = original.replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  if (digits.length !== 10) return original;
  return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
}

function isActiveServiceZip(zip) {
  // Booking is open statewide (any Texas ZIP). This is safe because a booking
  // outside the Austin auto-dispatch area is flagged needs_manual_dispatch on
  // the server and never auto-offers to a far Easer; it waits for the owner to
  // assign. The server check in api/_source-of-truth.js is authoritative.
  return isTexasZip(zip);
}

function isAutomaticDispatchZip(zip) {
  if (!isTexasZip(zip)) return false;
  var normalized = String(zip);
  var prefixes = Array.isArray(SERVICE_AREA.zipPrefixes) ? SERVICE_AREA.zipPrefixes : [];
  var exact = Array.isArray(SERVICE_AREA.zipCodes) ? SERVICE_AREA.zipCodes : [];
  return prefixes.indexOf(normalized.slice(0,3)) !== -1 || exact.indexOf(normalized) !== -1;
}

function getServiceCallFee(zip) {
  var zone = getServiceCallZoneInfo(zip);
  return zone ? zone.fee : 0;
}

function getServiceCallZoneInfo(zip) {
  if (!isTexasZip(zip)) return null;
  if (String(zip).slice(0, 3) === '787') return SERVICE_CALL_ZONES.austin_core;
  if (isAutomaticDispatchZip(zip)) return SERVICE_CALL_ZONES.central_texas;
  return SERVICE_CALL_ZONES.texas_statewide;
}

var USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

function dollars(value) {
  var n = Number(value || 0);
  return USD_FORMATTER.format(Number.isFinite(n) ? n : 0);
}

var ACTIVE_PROMO_OFFER = null;

function centsFromDollars(value) {
  return Math.max(0, Math.round(Number(value || 0) * 100));
}

function getActivePromoCode() {
  return String(ACTIVE_PROMO_OFFER && ACTIVE_PROMO_OFFER.code || '').trim().toUpperCase();
}

function getActivePromoLabel() {
  return String(ACTIVE_PROMO_OFFER && ACTIVE_PROMO_OFFER.label || 'Promo discount');
}

function applyPromoUiState() {
  var box = document.getElementById('s5-promo-box');
  var input = document.getElementById('s5-promo-code');
  if (!box || !input) return;

  var activeCode = getActivePromoCode();
  // Review thank-you codes are private and are not returned by /api/promo.
  // Keep the field available even when the public promotion is turned off.
  var shouldShow = true;
  box.style.display = shouldShow ? '' : 'none';
  if (!shouldShow) return;

  input.placeholder = activeCode || 'Coupon code';
}

async function loadPromoConfig() {
  try {
    var resp = await fetch('/api/promo', { cache: 'no-store' });
    var data = await resp.json();
    ACTIVE_PROMO_OFFER = resp.ok && data && data.promo && data.promo.enabled ? data.promo : null;
  } catch (_err) {
    ACTIVE_PROMO_OFFER = null;
  }
  applyPromoUiState();
  setPromoStatus(getPromoStatusMessage('', BOOK.promoCode), '');
  if (BOOK.promoCode) refreshPromoPreview({ silentFailure: true });
}

function getEnteredPromoCode() {
  var input = document.getElementById('s5-promo-code');
  return String(input ? input.value : BOOK.promoCode || '').trim().toUpperCase();
}

function setPromoStatus(message, tone) {
  var statusEl = document.getElementById('s5-promo-status');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.className = 'promo-status' + (tone ? ' ' + tone : '');
}

function getPromoStatusMessage(reason, code) {
  if (!code) return getActivePromoCode() ? 'Enter ' + getActivePromoCode() + ' to apply your discount.' : 'Have a promo code? Add it here.';
  if (!reason) return 'Tap Apply to add your discount.';
  if (reason === 'applied') return code + ' applied!';
  if (reason === 'invalid_code') return 'That code was not found. Double-check the spelling.';
  if (reason === 'email_required') return 'Add your email first to apply this offer.';
  if (reason === 'quote_request_not_eligible') return 'This offer applies to instant-price bookings, not custom quotes.';
  if (reason === 'no_eligible_items') return 'Add a standard priced item to use this offer.';
  if (reason === 'not_first_booking') return 'This offer is only for a first booking with a new email.';
  if (reason === 'minimum_not_met') return 'This thank-you offer requires a service subtotal of at least $100.';
  if (reason === 'invalid_or_used_code') return 'That thank-you code is invalid, expired, or already used. Check the code and booking email.';
  return 'This offer is not available for the current booking.';
}

function getLocalPricingPreview(snapshot) {
  return {
    itemSubtotalCents: centsFromDollars(snapshot.itemSubtotal),
    bundleDiscountCents: centsFromDollars(snapshot.discountAmount),
    serviceCallFeeCents: centsFromDollars(snapshot.serviceCallFee),
    sameDayFeeCents: centsFromDollars(snapshot.sameDayFee),
    taxCents: centsFromDollars(snapshot.taxAmount),
    totalCents: centsFromDollars(snapshot.grandTotal),
    hasCustomQuote: !!snapshot.hasCustom,
    isAddonOnly: !!snapshot.isAddonOnly
  };
}

function buildStep5ItemLinesHtml() {
  var hasCustom = false;
  var html = '';

  BOOK.selectedServices.forEach(function(svc) {
    (BOOK.selectedItems[svc] || []).forEach(function(item) {
      if (item.customQuote) {
        hasCustom = true;
        html += '<div class="booking-money-row"><span>' + esc(item.qty > 1 ? item.name + ' \xD7' + item.qty : item.name) + '</span><span>Custom quote</span></div>';
      } else if (item.price > 0) {
        html += '<div class="booking-money-row"><span>' + esc(item.qty > 1 ? item.name + ' \xD7' + item.qty : item.name) + '</span><span>' + esc(fmtLinePrice(item)) + '</span></div>';
      }
    });
  });

  return { html: html, hasCustom: hasCustom };
}

function renderStep5OrderTotal() {
  var summaryEl = document.getElementById('booking-summary');
  if (!summaryEl) return;

  var snapshot = getPricingSnapshot(BOOK.zip);
  var localPricing = getLocalPricingPreview(snapshot);
  var promoState = BOOK._promoPreview && BOOK._promoPreview.pricing ? BOOK._promoPreview : null;
  var promoApplied = !!(promoState && promoState.promo && promoState.promo.applied);
  var promoDiscountCents = promoApplied ? Math.max(0, Number(promoState.promo.discountCents || 0)) : 0;
  var assemblecashAppliedCents = promoState && promoState.assemblecash ? Math.max(0, Number(promoState.assemblecash.appliedCents || 0)) : 0;
  var pricing = promoState ? promoState.pricing : localPricing;
  // Same-day fee is additive and client-known; ensure it shows on the promo path
  // too (the server preview may omit it). The server stays authoritative at submit.
  if (localPricing.sameDayFeeCents > 0 && !(pricing.sameDayFeeCents > 0)) {
    var sdFeeCents = localPricing.sameDayFeeCents;
    var sdTaxCents = Math.round(sdFeeCents * 0.0825);
    pricing = Object.assign({}, pricing, {
      sameDayFeeCents: sdFeeCents,
      taxCents: (Number(pricing.taxCents) || 0) + sdTaxCents,
      totalCents: (Number(pricing.totalCents) || 0) + sdFeeCents + sdTaxCents
    });
  }
  var itemsBlock = buildStep5ItemLinesHtml();

  BOOK._discountPct = snapshot.bundle.pct;
  BOOK._discountAmount = snapshot.discountAmount;
  BOOK._promoApplied = promoApplied;
  BOOK.promoCode = getEnteredPromoCode();
  BOOK._promoCode = promoApplied ? (promoState.promo.appliedCode || BOOK.promoCode) : BOOK.promoCode;
  BOOK._promoDiscountAmount = promoDiscountCents / 100;
  BOOK._grandTotalCents = itemsBlock.hasCustom && localPricing.itemSubtotalCents === 0 ? 0 : Math.max(0, Number(pricing.totalCents || 0));

  var existing = document.getElementById('s5-order-total-row');
  if (existing) existing.remove();

  var discountLineHtml = snapshot.bundle.pct > 0 && snapshot.discountAmount > 0
    ? '<div class="booking-money-row" style="color:#0d9488;font-weight:600"><span>Bundle discount (' + snapshot.bundle.pct + '% &mdash; ' + snapshot.bundle.count + ' items)</span><span>&minus;' + dollars(snapshot.discountAmount) + '</span></div>'
    : '';
  var promoLineHtml = promoDiscountCents > 0
    ? '<div class="booking-money-row" style="color:#0369a1;font-weight:700"><span>' + esc((promoState && promoState.promo && promoState.promo.label) || getActivePromoLabel()) + '</span><span>&minus;' + dollars(promoDiscountCents / 100) + '</span></div>'
    : '';
  var assemblecashLineHtml = assemblecashAppliedCents > 0
    ? '<div class="booking-money-row" style="color:#0369a1;font-weight:700"><span>AssembleCash applied</span><span>&minus;' + dollars(assemblecashAppliedCents / 100) + '</span></div>'
    : '';
  var callFeeLineHtml = pricing.serviceCallFeeCents > 0
    ? '<div class="booking-money-row"><span>Service call fee</span><span>' + dollars(pricing.serviceCallFeeCents / 100) + '</span></div>'
    : '';
  var sameDayLineHtml = pricing.sameDayFeeCents > 0
    ? '<div class="booking-money-row"><span>Same-day service<br><small style="color:var(--muted);font-weight:400">Priority scheduling &mdash; you booked for today</small></span><span>' + dollars(pricing.sameDayFeeCents / 100) + '</span></div>'
    : '';
  var taxLineHtml = pricing.totalCents > 0
    ? '<div class="booking-money-row"><span>Subtotal</span><span>' + dollars(pricing.itemSubtotalCents / 100) + '</span></div>'
      + discountLineHtml
      + promoLineHtml
      + assemblecashLineHtml
      + callFeeLineHtml
      + sameDayLineHtml
      + '<div class="booking-money-row"><span>Sales tax (' + (window.AAE_RATES ? window.AAE_RATES.salesTaxPctLabel() : '8.25') + '%)</span><span>' + dollars(pricing.taxCents / 100) + '</span></div>'
    : '';
  var totalDisplay = itemsBlock.hasCustom && localPricing.itemSubtotalCents === 0
    ? 'Custom quote'
    : dollars((pricing.totalCents || 0) / 100) + (itemsBlock.hasCustom ? '+ (some items need a quote)' : '');
  var totalNote = BOOK.isEmergingMarket ? 'No payment collected' : (assemblecashAppliedCents > 0 ? 'Rewards applied' : (promoApplied ? 'Offer applied' : 'Secure checkout'));

  summaryEl.insertAdjacentHTML('beforeend',
    '<div class="summary-row" id="s5-order-total-row" style="border-top:2px solid var(--border);margin-top:0.25rem;padding-top:1rem">'
      + '<span class="summary-row-icon"><svg viewBox="0 0 24 24" width="18" height="18" style="fill:var(--teal)"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg></span>'
      + '<div style="flex:1">'
      + '<div class="summary-row-label" style="font-weight:600;color:var(--ink)">Order total</div>'
      + (itemsBlock.html ? '<div style="margin-top:0.4rem">' + itemsBlock.html + '</div>' : '')
      + (taxLineHtml ? '<div style="margin-top:0.4rem;padding-top:0.4rem;border-top:1px dashed var(--border)">' + taxLineHtml + '</div>' : '')
      + '<div class="booking-total-line">'
      + '<span style="font-size:1.1rem;font-weight:700;color:var(--ink)">' + totalDisplay + '</span>'
      + '<span style="font-size:0.75rem;color:var(--muted)">' + totalNote + '</span>'
      + '</div>'
      + '</div></div>'
  );
}

function getPricingSnapshot(zip) {
  var itemSubtotal = 0;
  var baseSubtotal = 0;
  var addonSubtotal = 0;
  var hasCustom = false;

  BOOK.selectedServices.forEach(function(svc) {
    (BOOK.selectedItems[svc] || []).forEach(function(item) {
      if (item.customQuote) {
        hasCustom = true;
        return;
      }

      var qty = Math.min(99, Math.max(1, parseInt(item.qty, 10) || 1));
      var unit = Number(item.price || 0);
      if (!Number.isFinite(unit) || unit <= 0) return;

      var lineTotal = Math.round(unit * qty * 100) / 100;
      itemSubtotal += lineTotal;
      if (item.addon) addonSubtotal += lineTotal;
      else baseSubtotal += lineTotal;
    });
  });

  var bundle = getBundleDiscount();
  var discountAmount = itemSubtotal > 0 ? Math.round(itemSubtotal * bundle.pct) / 100 : 0;
  var discountedSubtotal = Math.max(0, Math.round((itemSubtotal - discountAmount) * 100) / 100);
  var zoneInfo = getServiceCallZoneInfo(zip);
  var serviceCallFee = itemSubtotal > 0 && zoneInfo ? zoneInfo.fee : 0;
  var sameDayCfg = (window.AAE_BOOKING_SOURCE && window.AAE_BOOKING_SOURCE.sameDay) || {};
  var sameDayApplies = !!sameDayCfg.enabled && itemSubtotal > 0 && !!BOOK.date && BOOK.date === getChicagoTodayIso();
  var sameDayFee = sameDayApplies ? (Number(sameDayCfg.feeCents || 0) / 100) : 0;
  var taxableSubtotal = Math.round((discountedSubtotal + serviceCallFee + sameDayFee) * 100) / 100;
  var taxAmount = Math.round(taxableSubtotal * 0.0825 * 100) / 100;
  var grandTotal = Math.round((taxableSubtotal + taxAmount) * 100) / 100;

  return {
    itemSubtotal: itemSubtotal,
    baseSubtotal: baseSubtotal,
    addonSubtotal: addonSubtotal,
    hasCustom: hasCustom,
    hasPricedBaseItem: baseSubtotal > 0,
    hasPricedAddonItem: addonSubtotal > 0,
    isAddonOnly: addonSubtotal > 0 && baseSubtotal === 0,
    bundle: bundle,
    discountAmount: discountAmount,
    discountedSubtotal: discountedSubtotal,
    zoneInfo: zoneInfo,
    serviceCallFee: serviceCallFee,
    sameDayFee: sameDayFee,
    taxableSubtotal: taxableSubtotal,
    taxAmount: taxAmount,
    grandTotal: grandTotal
  };
}

function getOnlineBookingPolicyMessage() {
  if (BOOK.wantsQuote || BOOK.isEmergingMarket) return '';

  var snapshot = getPricingSnapshot(BOOK.zip);
  if (snapshot.hasCustom || snapshot.taxableSubtotal <= 0) return '';

  if (snapshot.isAddonOnly) {
    return 'Add-ons are for same-visit work. Please add a main service item, or choose the custom quote option so we can review it manually.';
  }

  var zoneInfo = snapshot.zoneInfo;
  if (!zoneInfo || !zoneInfo.minPretax) return '';

  if (snapshot.taxableSubtotal < zoneInfo.minPretax) {
    var shortfall = Math.round((zoneInfo.minPretax - snapshot.taxableSubtotal) * 100) / 100;
    return '';  // no minimum block: the service-call fee already covers small-job overhead, so never block the sale
  }

  return '';
}

async function refreshPromoPreview(options) {
  var opts = options || {};
  var applyBtn = document.getElementById('s5-promo-apply');
  var promoCode = getEnteredPromoCode();

  BOOK.promoCode = promoCode;
  BOOK._promoPreview = null;
  renderStep5OrderTotal();

  if (!promoCode) {
    setPromoStatus(getPromoStatusMessage('', ''), '');
    return;
  }

  if (!BOOK.email) {
    setPromoStatus(getPromoStatusMessage('email_required', promoCode), 'warning');
    return;
  }

  if (BOOK.isEmergingMarket || BOOK._isQuoteFlow) {
    setPromoStatus(getPromoStatusMessage('quote_request_not_eligible', promoCode), 'warning');
    return;
  }

  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Checking...';
  }

  try {
    var resp = await fetch('/api/booking/promo-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: BOOK.selectedServices,
        items: buildItemsPayload(),
        zip: BOOK.zip,
        email: BOOK.email,
        promoCode: promoCode,
        isQuoteRequest: BOOK._isQuoteFlow || false
      })
    });
    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not verify this offer right now.');

    BOOK._promoPreview = data;
    renderStep5OrderTotal();

    var tone = data.promo && data.promo.applied
      ? 'success'
      : (data.promo && data.promo.reason === 'invalid_code' ? 'error' : 'warning');
    setPromoStatus(getPromoStatusMessage(data.promo ? data.promo.reason : '', promoCode), tone);
  } catch (e) {
    BOOK._promoPreview = null;
    renderStep5OrderTotal();
    if (!opts.silentFailure) setPromoStatus(e.message || 'Could not verify this offer right now.', 'error');
  } finally {
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply';
    }
  }
}

async function applyPromoCode() {
  await refreshPromoPreview();
}


function checkServiceZip(val) {

  var okEl   = document.getElementById('svc-area-ok');

  var leadEl = document.getElementById('svc-area-lead');

  var errEl  = document.getElementById('s3-zip-err');

  var inEl   = document.getElementById('s3-zip');

  var zip = String(val || '').trim();

  var valid = isValidZip(zip);

  var active = isActiveServiceZip(zip);

  if (okEl) okEl.style.display = valid && active ? 'block' : 'none';

  if (leadEl) leadEl.style.display = valid && !active ? 'block' : 'none';

  if (!errEl) return;

  if (valid && active) {

    errEl.style.display = 'none';

    if (inEl) inEl.style.borderColor = '#22c55e';
    if (window.AAELocation) {
      var resolved = window.AAELocation.set(zip);
      var cityEl = document.getElementById('s3-city');
      if (resolved && cityEl && !cityEl.value.trim()) cityEl.value = resolved;
    }

  } else if (valid && !active) {

    errEl.style.display = 'none';

    if (inEl) inEl.style.borderColor = '#0ea5e9';

  } else {

    errEl.style.display = 'none';

    if (inEl) inEl.style.borderColor = '';

  }

}

function fmtPrice(item) {

  if (item.customQuote) return 'Custom quote';

  if (item.price === 0) return 'Free';

  var sign = item.addon ? '+' : '';

  var s = sign + dollars(item.price);

  if (item.priceMax) s = sign + dollars(item.price) + '\u2013' + dollars(item.priceMax);

  return s;

}

function fmtLinePrice(item) {
  if (item.customQuote) return 'Custom quote';
  var qty = Math.min(99, Math.max(1, parseInt(item.qty, 10) || 1));
  var minTotal = Number(item.price || 0) * qty;
  var maxTotal = Number(item.priceMax || 0) * qty;
  var prefix = item.addon ? '+' : '';
  return prefix + dollars(minTotal) + (maxTotal > minTotal ? '\u2013' + dollars(maxTotal) : '');
}



// ----------------------------------------------------------------------------

// SCREEN NAVIGATION

// ----------------------------------------------------------------------------

function serviceFromLabel(serviceName) {
  var prices = (SUBCATS[serviceName] || []).reduce(function(allPrices, group) {
    return allPrices.concat((group.items || []).filter(function(item) {
      return !item.addon && !item.customQuote && Number(item.price) > 0;
    }).map(function(item) { return Number(item.price); }));
  }, []);
  return prices.length ? 'From $' + Math.min.apply(Math, prices) : 'Custom quote';
}

var SVC_FROM = Object.keys(SUBCATS).reduce(function(labels, serviceName) {
  labels[serviceName] = serviceFromLabel(serviceName);
  return labels;
}, {});

var SVC_DETAILS = {
  'Furniture Assembly': {
    placeholder: 'Brand/model, room, floor level, stairs/elevator, or anything heavy.'
  },
  'Mounting & Hanging': {
    placeholder: 'TV size, mount type, wall type, cord plans, height, or photo notes.'
  },
  'Smart Home': {
    placeholder: 'Device brand, Wi-Fi access, account/login notes, placement, or existing wiring.'
  },
  'Fitness Equipment': {
    placeholder: 'Brand/model, room, floor level, stairs/elevator, box location, or clearance notes.'
  },
  'Outdoor & Playsets': {
    placeholder: 'Kit size, yard access, surface type, shade, box location, or photos you can send.'
  },
  'Office Assembly': {
    placeholder: 'Number of desks/chairs, rooms, delivery timing, access, or business-site notes.'
  },
  'Other': {
    placeholder: 'Describe the project, item brand/model, room count, photos you can send, access notes, or anything unusual.'
  }
};

var SUBCAT_NOTES = {
  'Seating & Sofas': 'Start with the biggest seating pieces so the room plan is clear.',
  'Bedroom': 'Beds, frames, dressers, and wardrobes usually drive the time estimate.',
  'Home Office Furniture': 'Pick each desk, chair, and storage item that needs assembly.',
  'Dining & Kitchen': 'Tables, chairs, carts, and islands are easiest to price together.',
  'Living Room': 'Entertainment centers, coffee tables, and bookcases can be bundled.',
  'Storage & Entryway': 'Shelving and entry pieces may need wall space or anchoring notes.',
  'Outdoor & Patio': 'Outdoor kits depend on size, access, and where the boxes are located.',
  'Add-ons': 'Add-ons are for the same visit after a main item is selected.'
};

function startCustomQuoteFlow() {
  var quoteItemName = 'Describe your project in the notes below (custom quote)';
  BOOK.selectedServices = ['Other'];
  BOOK.selectedItems = {
    'Other': [{ name: quoteItemName, price: 0, priceMax: 0, addon: false, customQuote: true, qty: 1 }]
  };
  BOOK.wantsQuote = true;
  BOOK.currentGroup = 'Custom Project';
  BOOK.itemStage = 'notes';
  showItemScreen('Other', 'notes');

  var quoteBox = document.getElementById('s1-quote');
  if (quoteBox) quoteBox.checked = true;

  var details = document.getElementById('s1-details');
  if (details) details.placeholder = 'Describe the project, item brand/model, room count, photos you can send, access notes, or anything unusual.';

  updateSvcRows();
  updateOrderSummary();
}

function isAddonGroup(group) {
  var items = (group && group.items) || [];
  return !!items.length && items.every(function(item) { return !!item.addon; });
}

function getPrimaryGroups(svc) {
  return (SUBCATS[svc] || []).filter(function(group) { return !isAddonGroup(group); });
}

function getExtraGroups(svc) {
  return (SUBCATS[svc] || []).filter(function(group) { return isAddonGroup(group); });
}

function getGroupSelectionCount(svc, groupName) {
  var names = ((SUBCATS[svc] || []).find(function(group) { return group.group === groupName; }) || { items: [] }).items
    .map(function(item) { return item.name; });

  return (BOOK.selectedItems[svc] || []).reduce(function(total, item) {
    if (names.indexOf(item.name) === -1) return total;
    return total + Math.max(1, parseInt(item.qty, 10) || 1);
  }, 0);
}

function hasSelectedPrimaryItems(svc) {
  return (BOOK.selectedItems[svc] || []).some(function(item) { return !item.addon; });
}

function serviceCanOfferExtras(svc) {
  return !!svc && svc !== 'Other';
}

function getDefaultPrimaryGroup(svc) {
  var groups = getPrimaryGroups(svc);
  if (!groups.length) return '';

  if (BOOK.currentGroup && groups.some(function(group) { return group.group === BOOK.currentGroup; })) {
    return BOOK.currentGroup;
  }

  var selected = BOOK.selectedItems[svc] || [];
  for (var i = 0; i < selected.length; i++) {
    var groupName = findItemGroup(svc, selected[i].name);
    if (groups.some(function(group) { return group.group === groupName; })) return groupName;
  }

  return groups[0].group;
}

function getItemStagePath(svc) {
  if (!svc || svc === 'Other') return ['notes'];
  // Open straight into the item browser (which already shows category pills via
  // renderSectionSwitcher). The old standalone 'group' category-card screen was a
  // redundant extra step — removed. 'items' defaults its group via getDefaultPrimaryGroup.
  // Add-ons are folded into the items list (no separate 'extras' stage), so the
  // flow is just items → notes — one fewer transition, no "Continue to extras".
  var path = ['items', 'notes'];
  return path;
}

function ensureValidItemStage(svc) {
  var path = getItemStagePath(svc);
  if (path.indexOf(BOOK.itemStage) === -1) {
    BOOK.itemStage = path[0];
  }

  if (BOOK.itemStage === 'items' || BOOK.itemStage === 'extras') {
    BOOK.currentGroup = getDefaultPrimaryGroup(svc);
  }
}

function showItemScreen(svc, desiredStage) {
  var switchingService = BOOK.currentSvc !== svc;

  if (svc !== 'Other' && BOOK.selectedServices.indexOf('Other') !== -1 && BOOK.wantsQuote) {
    BOOK.selectedServices = BOOK.selectedServices.filter(function(name) { return name !== 'Other'; });
    delete BOOK.selectedItems.Other;
    BOOK.wantsQuote = false;
    var staleQuoteBox = document.getElementById('s1-quote');
    if (staleQuoteBox) staleQuoteBox.checked = false;
  }

  BOOK.currentSvc = svc;
  if (switchingService) {
    BOOK.currentGroup = '';
    BOOK.itemSearchOpen = false;
    BOOK.itemHelpOpen = false;
  }

  if (BOOK.selectedServices.indexOf(svc) === -1) {
    BOOK.selectedServices.push(svc);
    if (!BOOK.selectedItems[svc]) BOOK.selectedItems[svc] = [];
  }

  BOOK.itemStage = desiredStage || (svc === 'Other' ? 'notes' : 'items');
  ensureValidItemStage(svc);

  document.getElementById('item-screen-heading').textContent = getDisplayServiceName(svc);
  var itemFromEl = document.getElementById('item-screen-from');
  if (itemFromEl) {
    if (svc === 'Other') {
      itemFromEl.textContent = 'Tell us what you need. We review it before scheduling.';
      itemFromEl.style.display = '';
    } else {
      itemFromEl.textContent = '';
      itemFromEl.style.display = 'none';
    }
  }

  var details = document.getElementById('s1-details');
  if (details) {
    details.value = BOOK.details || '';
    var detail = SVC_DETAILS[svc] || SVC_DETAILS.Other;
    details.placeholder = detail.placeholder || 'Any extra details: brand, model, floor, access info...';
  }

  var quoteBox = document.getElementById('s1-quote');
  if (quoteBox) quoteBox.checked = !!BOOK.wantsQuote;

  renderItemScreen(svc);
  updateOrderSummary();

  document.getElementById('svc-screen').style.display = 'none';
  document.getElementById('item-screen').style.display = '';

  var panel = document.getElementById('step-1');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function getFirstSelectedServiceWithItems() {
  for (var i = 0; i < BOOK.selectedServices.length; i++) {
    var svc = BOOK.selectedServices[i];
    if (getSelectedItemCountForService(svc) > 0) return svc;
  }
  return '';
}

function renderServicePickerMode() {
  var adding = BOOK.servicePickerMode === 'add';
  var kicker = document.getElementById('svc-screen-kicker');
  var title = document.getElementById('svc-screen-title');
  var subtitle = document.getElementById('svc-screen-subtitle');
  var complete = document.getElementById('service-picker-complete');
  var customQuote = document.querySelector('.svc-row[data-service="Other"]');

  if (kicker) kicker.textContent = adding ? 'Build your visit' : 'Start your booking';
  if (title) title.textContent = adding ? 'Add another service' : 'What do you need done?';
  if (subtitle) {
    subtitle.textContent = adding
      ? 'Choose another service, or continue with your current selections.'
      : 'Pick the kind of help you need, then choose the exact items in the next step.';
  }
  if (complete) complete.hidden = !adding;
  if (customQuote) customQuote.hidden = adding;
}

function openAddServicePicker() {
  BOOK.details = (document.getElementById('s1-details') || {}).value || BOOK.details;
  BOOK.wantsQuote = !!((document.getElementById('s1-quote') || {}).checked);
  BOOK.servicePickerMode = 'add';
  BOOK.servicePickerReturnSvc = BOOK.currentSvc || getFirstSelectedServiceWithItems();
  showSvcScreen();
}

function finishAddingServices() {
  var returnSvc = BOOK.servicePickerReturnSvc;
  if (!returnSvc || getSelectedItemCountForService(returnSvc) === 0) {
    returnSvc = getFirstSelectedServiceWithItems();
  }

  BOOK.servicePickerMode = 'initial';
  BOOK.servicePickerReturnSvc = '';

  if (!returnSvc) {
    showSvcScreen();
    return;
  }

  showItemScreen(returnSvc, 'notes');
}

function showSvcScreen() {

  if (BOOK.currentSvc) {
    var items = BOOK.selectedItems[BOOK.currentSvc] || [];
    if (BOOK.servicePickerMode === 'add' && items.length > 0) {
      BOOK.servicePickerReturnSvc = BOOK.currentSvc;
    }
    if (items.length === 0 && !BOOK.wantsQuote) {
      var idx = BOOK.selectedServices.indexOf(BOOK.currentSvc);
      if (idx !== -1) BOOK.selectedServices.splice(idx, 1);
      delete BOOK.selectedItems[BOOK.currentSvc];
    }
  }

  BOOK.currentSvc = null;
  BOOK.currentGroup = '';
  BOOK.itemStage = 'service';
  BOOK.itemSearchOpen = false;
  BOOK.itemHelpOpen = false;

  document.getElementById('item-screen').style.display = 'none';
  document.getElementById('svc-screen').style.display = '';

  renderServicePickerMode();
  updateSvcRows();
  updateOrderSummary();

  var panel = document.getElementById('step-1');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateSvcRows() {
  document.querySelectorAll('.svc-row').forEach(function(row) {
    var svc = row.dataset.service;
    var itemCount = getSelectedItemCountForService(svc);
    row.classList.toggle('has-items', itemCount > 0);
    var badge = row.querySelector('.svc-row-badge');
    if (badge) {
      var svcSubtotal = 0;
      (BOOK.selectedItems[svc] || []).forEach(function(it) {
        if (it.customQuote) return;
        var unit = Number(it.price || 0);
        var qty = Math.min(99, Math.max(1, parseInt(it.qty, 10) || 1));
        if (unit > 0) svcSubtotal += unit * qty;
      });
      badge.textContent = itemCount > 0
        ? ('Selected - ' + (itemCount === 1 ? '1 item' : itemCount + ' items') + (svcSubtotal > 0 ? ' - $' + svcSubtotal.toFixed(0) : ''))
        : '';
    }
  });
}

function normalizeItemLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCatalogItem(svc, itemName) {
  var groups = SUBCATS[svc] || [];
  var target = normalizeItemLabel(itemName);

  for (var i = 0; i < groups.length; i++) {
    var items = groups[i].items || [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (item.name === itemName || normalizeItemLabel(item.name) === target) return item;
    }
  }

  return null;
}

function getSelectedItemCountForService(svc) {
  return (BOOK.selectedItems[svc] || []).reduce(function(total, item) {
    return total + Math.max(1, parseInt(item.qty, 10) || 1);
  }, 0);
}

function getSelectedLineCountForService(svc) {
  return (BOOK.selectedItems[svc] || []).length;
}

function getTotalSelectedItemCount() {
  return BOOK.selectedServices.reduce(function(total, svc) {
    return total + getSelectedItemCountForService(svc);
  }, 0);
}

function moneyDisplay(amount) {
  return dollars(amount);
}

function getActiveBundle() {
  if (!BOOK.bundleSlug || !window.AAE_BOOKING_SOURCE || !AAE_BOOKING_SOURCE.bundles) return null;
  return AAE_BOOKING_SOURCE.bundles.find(function(bundle) {
    return bundle.slug === BOOK.bundleSlug && bundle.active !== false;
  }) || null;
}

function getBundleIncludedSubtotal(bundle) {
  if (!bundle) return 0;
  return (bundle.included || []).reduce(function(total, ref) {
    var item = findCatalogItem(ref.service, ref.name);
    return total + (item ? (Number(item.price) || 0) : 0);
  }, 0);
}

function getBundleLeadService(bundle) {
  if (!bundle) return '';
  var first = (bundle.included || []).find(function(ref) {
    return ref && ref.service;
  });
  return first ? first.service : '';
}

function openBundleLeadService() {
  var bundle = getActiveBundle();
  if (!bundle) return;
  var leadService = getBundleLeadService(bundle) || BOOK.currentSvc || BOOK.selectedServices[0];
  if (!leadService) return;
  showItemScreen(leadService, 'items');
}

function renderBundleWelcome() {
  var serviceBanner = document.getElementById('bundle-welcome-services');
  var itemBanner = document.getElementById('bundle-welcome-items');
  var bundle = getActiveBundle();
  var banners = [serviceBanner, itemBanner];

  if (!bundle) {
    banners.forEach(function(node) {
      if (!node) return;
      node.classList.remove('show');
      node.innerHTML = '';
    });
    return;
  }

  var included = (bundle.included || []).map(function(ref) { return esc(ref.name); }).join(' &middot; ');
  var itemCount = (bundle.included || []).length;
  var serviceCount = bundle.included
    ? bundle.included.reduce(function(total, ref, index, arr) {
        return total + (arr.findIndex(function(other) { return other.service === ref.service; }) === index ? 1 : 0);
      }, 0)
    : 0;
  var subtotal = getBundleIncludedSubtotal(bundle);
  var reward = Math.round(subtotal * 5) / 100;
  var leadService = getBundleLeadService(bundle);

  if (serviceBanner) {
    serviceBanner.innerHTML =
      '<div class="bundle-welcome-top">'
        + '<div>'
          + '<div class="bundle-welcome-kicker">Room-ready bundle loaded</div>'
          + '<div class="bundle-welcome-title">' + esc(bundle.name) + ' is already set up for this booking.</div>'
          + '<div class="bundle-welcome-copy">We preselected the core items so you can review the setup instead of building the room from scratch. You can still add or remove anything before checkout.</div>'
        + '</div>'
      + '</div>'
      + '<div class="bundle-welcome-metrics">'
        + '<div class="bundle-welcome-metric"><span class="bundle-welcome-metric-label">Included items</span><strong>' + itemCount + '</strong><span>Across ' + serviceCount + ' service' + (serviceCount === 1 ? '' : 's') + '</span></div>'
        + '<div class="bundle-welcome-metric"><span class="bundle-welcome-metric-label">Starts at</span><strong>' + moneyDisplay(subtotal) + '</strong><span>Before service fee and tax</span></div>'
        + '<div class="bundle-welcome-metric"><span class="bundle-welcome-metric-label">Estimated reward</span><strong>' + moneyDisplay(reward) + '</strong><span>Final reward is 5% of the captured total</span></div>'
      + '</div>'
      + (included ? '<div class="bundle-welcome-includes"><span>Included</span>' + included + '</div>' : '')
      + '<div class="bundle-welcome-actions">'
        + '<button type="button" class="bundle-welcome-btn" onclick="openBundleLeadService()">' + (leadService ? ('Review ' + esc(getDisplayServiceName(leadService))) : 'Review loaded items') + ' &rarr;</button>'
        + '<a class="bundle-welcome-link" href="/bundles">See bundle details</a>'
      + '</div>';
    serviceBanner.classList.add('show');
  }

  if (itemBanner) {
    itemBanner.innerHTML =
      '<div class="bundle-welcome-top">'
        + '<div>'
          + '<div class="bundle-welcome-kicker">Bundle booking</div>'
          + '<div class="bundle-welcome-title">' + esc(bundle.name) + ' loaded for this visit.</div>'
          + '<div class="bundle-welcome-copy">The included items are already selected. Keep them as-is, remove anything that does not fit, or add more before you continue.</div>'
        + '</div>'
      + '</div>'
      + '<div class="bundle-welcome-metrics">'
        + '<div class="bundle-welcome-metric"><span class="bundle-welcome-metric-label">This room</span><strong>' + itemCount + ' core item' + (itemCount === 1 ? '' : 's') + '</strong><span>Ready to review and edit</span></div>'
        + '<div class="bundle-welcome-metric"><span class="bundle-welcome-metric-label">Starts at</span><strong>' + moneyDisplay(subtotal) + '</strong><span>Based on the loaded bundle items</span></div>'
        + '<div class="bundle-welcome-metric"><span class="bundle-welcome-metric-label">Estimated reward</span><strong>' + moneyDisplay(reward) + '</strong><span>Final reward is 5% of the captured total</span></div>'
      + '</div>';
    itemBanner.classList.add('show');
  }
}

function buildServiceChipHtml(svc, active) {
  var count = getSelectedItemCountForService(svc);
  var displayName = getDisplayServiceName(svc);
  var countLabel = count > 0 ? (count === 1 ? '1 item' : count + ' items') : 'Open';
  return '<button type="button" class="selected-service-chip' + (active ? ' is-active' : '') + '"'
    + ' data-service="' + escAttr(svc) + '" onclick="showItemScreen(this.dataset.service, \'items\')">'
    + '<span>' + esc(displayName) + '</span>'
    + '<span class="selected-service-chip-count">' + esc(countLabel) + '</span>'
    + '</button>';
}

function renderSelectedServiceStrip() {
  var strip = document.getElementById('selected-service-strip');
  if (!strip) return;

  if (BOOK.selectedServices.length === 0
      || (BOOK.selectedServices.length === 1 && BOOK.servicePickerMode !== 'add')) {
    strip.classList.remove('show');
    strip.innerHTML = '';
    return;
  }

  var copy = BOOK.selectedServices.length === 1
    ? '1 service selected for this visit.'
    : BOOK.selectedServices.length + ' services selected for this visit.';

  strip.innerHTML = '<div class="selected-service-copy">' + copy + '</div>'
    + '<div class="selected-service-chips">' + BOOK.selectedServices.map(function(svc) {
      return buildServiceChipHtml(svc, false);
    }).join('') + '</div>';
  strip.classList.add('show');
}

function renderItemSummaryStrip() {
  var strip = document.getElementById('item-summary-strip');
  if (!strip) return;

  if (!BOOK.currentSvc || BOOK.selectedServices.length <= 1) {
    strip.classList.remove('show');
    strip.innerHTML = '';
    return;
  }

  var currentSvc = BOOK.currentSvc;
  var lineCount = getSelectedLineCountForService(currentSvc);
  var itemCount = getSelectedItemCountForService(currentSvc);
  var copy = lineCount > 0
    ? '<strong>' + esc(getDisplayServiceName(currentSvc)) + '</strong> has ' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + ' selected.'
    : 'Switch services in this visit.';

  var chips = BOOK.selectedServices.length > 1
    ? '<div class="selected-service-chips">' + BOOK.selectedServices.map(function(svc) {
        return buildServiceChipHtml(svc, svc === currentSvc);
      }).join('') + '</div>'
    : '';

  strip.innerHTML = '<div class="selected-service-copy">' + copy + '</div>' + chips;
  strip.classList.add('show');
}

function renderItemStageRail(svc) {
  var rail = document.getElementById('item-stage-rail');
  if (!rail) return;

  if (!svc || svc === 'Other') {
    rail.innerHTML = '';
    rail.style.display = 'none';
    return;
  }

  var stages = getItemStagePath(svc);
  var labels = {
    group: 'Section',
    items: 'Items',
    extras: 'Add-ons',
    notes: 'Notes'
  };
  var activeIndex = stages.indexOf(BOOK.itemStage);
  var currentLabel = labels[BOOK.itemStage] || 'Service';
  var nextStage = stages[activeIndex + 1];
  rail.innerHTML = '<div class="item-stage-status">'
    + '<div class="item-stage-status-title"><span>Inside service</span>' + (activeIndex + 1) + ' of ' + stages.length + ': ' + esc(currentLabel) + '</div>'
    + (nextStage ? '<div class="item-stage-status-next">Next: ' + esc(labels[nextStage] || '') + '</div>' : '')
    + '</div>';
  rail.style.display = '';
}

function renderGroupCards(svc) {
  var grid = document.getElementById('item-group-grid');
  if (!grid) return;

  var groups = getPrimaryGroups(svc).filter(function(group) { return group.group !== 'Custom Project'; });
  if (!groups.length) {
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = groups.map(function(group) {
    var selectedCount = getGroupSelectionCount(svc, group.group);
    var note = SUBCAT_NOTES[group.group] || 'Pick the section that best matches the main item.';
    return '<button type="button" class="item-group-card' + (BOOK.currentGroup === group.group ? ' is-selected' : '') + '"'
      + ' data-group="' + escAttr(group.group) + '" onclick="openServiceGroup(this.dataset.group)">'
      + '<div class="item-group-card-head">'
      + '<div class="item-group-card-title">' + esc(group.group) + '</div>'
      + '<div class="item-group-card-count">' + group.items.length + ' items</div>'
      + '</div>'
      + '<p class="item-group-card-copy">' + esc(note) + '</p>'
      + '<div class="item-group-card-meta">'
      + '<span>' + (selectedCount > 0 ? (selectedCount + ' selected') : 'Start here') + '</span>'
      + '<span class="item-group-card-pick">Open</span>'
      + '</div>'
      + '</button>';
  }).join('');
}

function renderSectionSwitcher(svc, stage) {
  var wrap = document.getElementById('item-section-switcher');
  if (!wrap) return;

  if (stage !== 'items') {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  var groups = getPrimaryGroups(svc).filter(function(group) { return group.group !== 'Custom Project'; });
  if (groups.length <= 1) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  wrap.innerHTML = groups.map(function(group) {
    var count = getGroupSelectionCount(svc, group.group);
    return '<button type="button" class="item-section-btn' + (group.group === BOOK.currentGroup ? ' is-active' : '') + '"'
      + ' data-group="' + escAttr(group.group) + '" onclick="switchServiceGroup(this.dataset.group)">'
      + esc(group.group) + (count > 0 ? '<span class="item-section-count" aria-label="' + count + ' selected">' + count + '</span>' : '')
      + '</button>';
  }).join('');
  wrap.style.display = '';
}

function buildStaticGroupHtml(svc, group, badgeText) {
  var groupNote = SUBCAT_NOTES[group.group] || 'Choose the items that match your job so the estimate stays clear.';
  var countLabel = badgeText || group.items.length;
  var rows = (group.items || []).map(function(item) { return itemRowHtml(svc, item); }).join('');
  return '<div class="subcat-group open" data-group="' + escAttr(group.group) + '">'
    + '<div class="subcat-group-head is-static"><span class="subcat-group-label">' + esc(group.group) + '<span class="subcat-group-note">' + esc(groupNote) + '</span></span><span class="subcat-group-count">' + esc(String(countLabel)) + '</span></div>'
    + '<div class="subcat-group-body">' + rows + '</div>'
    + '</div>';
}

function renderBrowserPane(svc, stage) {
  var wrap = document.getElementById('item-list-wrap');
  var searchWrap = document.getElementById('item-search-wrap');
  var searchInput = document.getElementById('item-search');
  var clearBtn = document.getElementById('item-search-clear');
  var noRes = document.getElementById('item-no-results');
  var kicker = document.getElementById('item-browser-kicker');
  var title = document.getElementById('item-browser-title');
  var copy = document.getElementById('item-browser-copy');
  if (!wrap) return;

  if (stage === 'items') {
    var primaryGroups = getPrimaryGroups(svc);
    var activeName = BOOK.currentGroup || getDefaultPrimaryGroup(svc);
    var group = primaryGroups.find(function(entry) { return entry.group === activeName; })
      || primaryGroups.find(function(entry) { return entry.group === getDefaultPrimaryGroup(svc); })
      || primaryGroups[0];
    BOOK.currentGroup = group ? group.group : '';
    activeName = BOOK.currentGroup;
    kicker.textContent = 'Pick what you need';
    title.textContent = activeName || 'Choose items';
    copy.textContent = (SUBCAT_NOTES[activeName] || 'Choose the exact items in this section.');
    var itemsHtml = group ? buildStaticGroupHtml(svc, group, group.items.length) : '';
    // Fold same-visit add-ons in at the bottom of the same list — no separate
    // "extras" stage/transition. Each extra group keeps its own header.
    var foldedExtraGroups = getExtraGroups(svc);
    if (foldedExtraGroups.length) {
      itemsHtml += foldedExtraGroups.map(function(g) { return buildStaticGroupHtml(svc, g, g.items.length); }).join('');
    }
    wrap.innerHTML = itemsHtml;
    if (searchWrap) searchWrap.style.display = '';
    if (searchInput) searchInput.placeholder = 'Search items... e.g. queen bed';
    if (searchInput && searchInput.value) BOOK.itemSearchOpen = true;
    if (clearBtn) clearBtn.classList.toggle('vis', !!(searchInput && searchInput.value));
    if (searchInput && searchInput.value) filterItemList(searchInput.value.trim().toLowerCase());
    else if (noRes) noRes.style.display = 'none';
    syncMobileItemAssistivePanels(stage);
    try { renderRecoShelf(''); } catch(e) {}
    return;
  }

  var extraGroups = getExtraGroups(svc);
  kicker.textContent = 'Same-visit extras';
  title.textContent = 'Add extras if you need them';
  copy.textContent = hasSelectedBaseItems(svc)
    ? 'Optional same-visit add-ons only.'
    : 'Add-ons unlock after the main item is selected.';

  wrap.innerHTML = extraGroups.length
    ? extraGroups.map(function(group) { return buildStaticGroupHtml(svc, group, group.items.length); }).join('')
    : '<div class="quote-helper" style="margin-top:0">No extra add-ons are listed for this service.</div>';

  if (searchWrap) searchWrap.style.display = 'none';
  if (searchInput) searchInput.value = '';
  if (clearBtn) clearBtn.classList.remove('vis');
  if (noRes) noRes.style.display = 'none';
  syncMobileItemAssistivePanels(stage);
  try { renderRecoShelf(svc); } catch(e) {}
}

function updateItemStageActions(svc) {
  var backBtn = document.getElementById('item-stage-back-btn');
  var secondaryBtn = document.getElementById('item-stage-secondary-btn');
  var nextBtn = document.getElementById('s1-next');
  if (!nextBtn) return;

  if (!svc) {
    if (backBtn) backBtn.hidden = true;
    if (secondaryBtn) secondaryBtn.hidden = true;
    return;
  }

  var stage = BOOK.itemStage;
  if (backBtn) backBtn.hidden = false;
  nextBtn.disabled = false;

  if (secondaryBtn) {
    secondaryBtn.hidden = stage !== 'notes';
    secondaryBtn.textContent = 'Add another service';
  }

  if (stage === 'group') nextBtn.innerHTML = 'Continue to items <span>&#8594;</span>';
  else if (stage === 'items') {
    if (!hasSelectedPrimaryItems(svc)) {
      nextBtn.disabled = true;
      nextBtn.innerHTML = 'Choose an item first';
    } else {
      nextBtn.innerHTML = 'Continue to notes <span>&#8594;</span>';
    }
  }
  else if (stage === 'extras') nextBtn.innerHTML = 'Continue to notes <span>&#8594;</span>';
  else nextBtn.innerHTML = 'Review job plan &amp; schedule <span>&#8594;</span>';
}

function openServiceGroup(groupName) {
  if (!BOOK.currentSvc) return;
  BOOK.currentGroup = groupName;
  BOOK.itemStage = 'items';
  renderItemScreen(BOOK.currentSvc);
}

function switchServiceGroup(groupName) {
  if (!BOOK.currentSvc) return;
  BOOK.currentGroup = groupName;
  renderItemScreen(BOOK.currentSvc);
}

function goBackInServiceFlow() {
  if (!BOOK.currentSvc) {
    showSvcScreen();
    return;
  }

  var path = getItemStagePath(BOOK.currentSvc);
  var idx = path.indexOf(BOOK.itemStage);
  if (idx <= 0) {
    showSvcScreen();
    return;
  }

  BOOK.itemStage = path[idx - 1];
  renderItemScreen(BOOK.currentSvc);
}

function handleServiceSecondaryAction() {
  openAddServicePicker();
}

function handleServiceStageContinue() {
  if (!BOOK.currentSvc) {
    showErr('s1-err', 'Please select at least one service.');
    return;
  }

  BOOK.details = (document.getElementById('s1-details') || {}).value || BOOK.details;
  BOOK.wantsQuote = !!((document.getElementById('s1-quote') || {}).checked);
  hideErr('s1-err');

  if (BOOK.currentSvc === 'Other') {
    goToStep2Account();
    return;
  }

  if (BOOK.itemStage === 'group') {
    BOOK.currentGroup = getDefaultPrimaryGroup(BOOK.currentSvc);
    BOOK.itemStage = 'items';
    renderItemScreen(BOOK.currentSvc);
    return;
  }

  if (BOOK.itemStage === 'items') {
    if (!hasSelectedPrimaryItems(BOOK.currentSvc)) {
      showErr('s1-err', 'Pick the main item first so we can price the visit correctly.');
      return;
    }

    // Add-ons now live inline in the items list, so continue goes straight to notes.
    BOOK.itemStage = 'notes';
    renderItemScreen(BOOK.currentSvc);
    return;
  }

  if (BOOK.itemStage === 'extras') {
    BOOK.itemStage = 'notes';
    renderItemScreen(BOOK.currentSvc);
    return;
  }

  goToStep2Account();
}

function updateMobileStepSummary() {
  var summary = document.getElementById('mobile-step-summary');
  if (!summary) return;

  var currentCount = BOOK.currentSvc ? getSelectedItemCountForService(BOOK.currentSvc) : 0;
  if (!BOOK.currentSvc || BOOK.itemStage === 'group' || (BOOK.itemStage === 'items' && currentCount === 0)) {
    summary.style.display = 'none';
    summary.innerHTML = '';
    return;
  }

  var totalServices = BOOK.selectedServices.length;
  summary.innerHTML = '<strong>' + esc(getDisplayServiceName(BOOK.currentSvc)) + '</strong>'
    + '<span>' + (currentCount > 0 ? (currentCount + ' item' + (currentCount === 1 ? '' : 's') + ' selected') : 'Choose your first item')
    + (totalServices > 1 ? ' • ' + totalServices + ' services in visit' : '') + '</span>';
  summary.style.display = '';
}

function isMobileKeyboardViewport() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
}

function setMobileStepActionsHidden(hidden) {
  if (!isMobileKeyboardViewport()) return;
  document.querySelectorAll('.step-actions').forEach(function(el) {
    el.classList.toggle('kb-hidden', !!hidden);
  });
}

function activeElementNeedsKeyboardRoom() {
  var el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'IFRAME') return true;
  if (el.matches && el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="hidden"]), textarea, select')) {
    return true;
  }
  return !!(el.closest && el.closest('#stripe-card-wrap'));
}

function syncMobileStepActionsForKeyboard() {
  var viewport = window.visualViewport;
  var keyboardLikelyOpen = !!(viewport && viewport.height < (window.innerHeight - 120));
  setMobileStepActionsHidden(keyboardLikelyOpen && activeElementNeedsKeyboardRoom());
}

function syncMobileActionClearance() {
  if (!window.matchMedia || !window.matchMedia('(max-width: 768px)').matches) {
    document.documentElement.style.removeProperty('--mobile-actions-clearance');
    return;
  }
  var actions = document.querySelector('.step-panel:not(.hidden) .step-actions:not(.kb-hidden)');
  var height = actions ? Math.ceil(actions.getBoundingClientRect().height) : 88;
  document.documentElement.style.setProperty('--mobile-actions-clearance', Math.max(88, height) + 'px');
}

function syncMobileItemAssistivePanels(stage) {
  var tools = document.getElementById('item-mobile-tools');
  var searchWrap = document.getElementById('item-search-wrap');
  var searchBtn = document.getElementById('item-search-toggle');
  if (!tools || !searchWrap || !searchBtn) return;

  var isCompactMobile = !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
  if (!isCompactMobile || stage !== 'items') {
    tools.style.display = 'none';
    if (stage === 'items') searchWrap.style.display = '';
    return;
  }

  if (!BOOK.itemSearchOpen && document.getElementById('item-search') && document.getElementById('item-search').value) {
    BOOK.itemSearchOpen = true;
  }

  // Phones keep the compact search visible at all times — no "Hide search"
  // toggle (a control whose only job is hiding another control is needless
  // friction). Customers can filter items immediately.
  BOOK.itemSearchOpen = true;
  tools.style.display = 'none';
  searchWrap.style.display = '';
}

function toggleItemSearch(forceOpen) {
  var input = document.getElementById('item-search');
  var open = typeof forceOpen === 'boolean' ? forceOpen : !BOOK.itemSearchOpen;
  BOOK.itemSearchOpen = !!open;
  if (!BOOK.itemSearchOpen && input && input.value) {
    input.value = '';
    filterItemList('');
  }
  syncMobileItemAssistivePanels('items');
  if (BOOK.itemSearchOpen && input) setTimeout(function(){ input.focus(); }, 0);
}

function jumpToGroup(groupName, skipScroll) {
  var wrap = document.getElementById('item-list-wrap');
  if (!wrap) return;

  var target = null;
  wrap.querySelectorAll('.subcat-group').forEach(function(group) {
    if (!target && group.dataset.group === groupName) target = group;
  });
  if (!target) return;

  BOOK.currentGroup = groupName;

  if (!wrap.classList.contains('searching')) {
    wrap.querySelectorAll('.subcat-group.open').forEach(function(group) {
      if (group !== target) group.classList.remove('open');
    });
  }

  target.classList.add('open');

  if (!skipScroll) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openQuickPick(svc, itemName) {
  showItemScreen(svc, 'items');

  if (!itemName) return;

  var item = findCatalogItem(svc, itemName);
  if (!item) return;

  BOOK.currentGroup = findItemGroup(svc, item.name);

  if (!isItemSelected(svc, item.name)) {
    toggleItem(svc, item.name, item.price, item.priceMax, !!item.addon, !!item.customQuote);
  } else {
    jumpToGroup(BOOK.currentGroup);
  }
}



// ----------------------------------------------------------------------------

// RENDER ITEM SCREEN (Screen B)

// ----------------------------------------------------------------------------

function toggleSubcat(btn) {
  var group = btn.closest('.subcat-group');
  if (!group) return;
  if (group.classList.contains('is-locked')) return;

  var wrap = document.getElementById('item-list-wrap');
  var willOpen = !group.classList.contains('open');

  if (willOpen && wrap && !wrap.classList.contains('searching')) {
    wrap.querySelectorAll('.subcat-group.open').forEach(function(other) {
      if (other !== group) other.classList.remove('open');
    });
  }

  group.classList.toggle('open');

  if (group.classList.contains('open')) {
    BOOK.currentGroup = group.dataset.group || '';
  }
}

function renderItemScreen(svc) {
  ensureValidItemStage(svc);

  var stage = BOOK.itemStage;
  var groupsPane = document.getElementById('item-stage-groups-pane');
  var browserPane = document.getElementById('item-stage-browser-pane');
  var notesPane = document.getElementById('item-stage-notes-pane');
  var details = document.getElementById('s1-details');
  var quoteBox = document.getElementById('s1-quote');
  var noRes = document.getElementById('item-no-results');

  if (details) details.value = BOOK.details || '';
  if (quoteBox) quoteBox.checked = !!BOOK.wantsQuote;

  renderItemSummaryStrip();
  renderItemStageRail(svc);
  renderGroupCards(svc);
  renderSectionSwitcher(svc, stage);

  if (groupsPane) groupsPane.classList.toggle('is-active', stage === 'group');
  if (browserPane) browserPane.classList.toggle('is-active', stage === 'items' || stage === 'extras');
  if (notesPane) notesPane.classList.toggle('is-active', stage === 'notes');

  if (stage === 'items' || stage === 'extras') {
    renderBrowserPane(svc, stage);
  } else {
    try { renderRecoShelf(''); } catch(e) {}
    var wrap = document.getElementById('item-list-wrap');
    if (wrap) wrap.innerHTML = '';
    if (noRes) noRes.style.display = 'none';
  }

  updateMobileStepSummary();
  updateItemStageActions(svc);
}



function filterItemList(q) {

  var wrap = document.getElementById('item-list-wrap');

  if (!wrap) return;

  var clearBtn = document.getElementById('item-search-clear');

  var noRes = document.getElementById('item-no-results');

  if (clearBtn) clearBtn.classList.toggle('vis', q.length > 0);

  wrap.classList.toggle('searching', q.length > 0);
  wrap.classList.toggle('guided', q.length === 0);

  var groups = wrap.querySelectorAll('.subcat-group');

  var totalVisible = 0;

  groups.forEach(function(group) {

    var items = group.querySelectorAll('.subcat-item');

    var groupVisible = 0;

    items.forEach(function(item) {

      var name = (item.dataset.itemName || '').toLowerCase();

      var show = !q || name.indexOf(q) !== -1;

      item.style.display = show ? '' : 'none';

      if (show) groupVisible++;

    });

    group.style.display = groupVisible > 0 ? '' : 'none';

    totalVisible += groupVisible;

  });

  if (noRes) {

    noRes.style.display = totalVisible === 0 && q ? 'block' : 'none';

    var sp = noRes.querySelector('span');

    if (sp) sp.textContent = q;

  }

}



// Event delegation for item list

document.getElementById('item-list-wrap').addEventListener('click', function(e) {

  var qBtn = e.target.closest('[data-qty-delta]');

  if (qBtn) {

    e.stopPropagation();

    changeQty(qBtn.dataset.qtySvc, qBtn.dataset.qtyName, parseInt(qBtn.dataset.qtyDelta, 10));

    return;

  }

  var itemRow = e.target.closest('[data-item-svc]');

  if (itemRow && !e.target.closest('.subcat-qty')) {

    toggleItem(

      itemRow.dataset.itemSvc,

      itemRow.dataset.itemName,

      parseFloat(itemRow.dataset.itemPrice),

      parseFloat(itemRow.dataset.itemPriceMax),

      itemRow.dataset.itemAddon === 'true',

      itemRow.dataset.itemCustom === 'true'

    );

  }

});



document.getElementById('item-search').addEventListener('input', function() {

  filterItemList(this.value.trim().toLowerCase());

});



document.getElementById('item-search-clear').addEventListener('click', function() {

  var inp = document.getElementById('item-search');

  if (inp) { inp.value = ''; filterItemList(''); inp.focus(); }

});

document.getElementById('s1-details').addEventListener('input', function() {
  BOOK.details = this.value;
});

document.getElementById('s1-quote').addEventListener('change', function() {
  BOOK.wantsQuote = !!this.checked;
  updateOrderSummary();
});

// Hide fixed CTA when the mobile keyboard is open so it never covers inputs or card entry.
document.addEventListener('focusin', function() {
  syncMobileStepActionsForKeyboard();
});
document.addEventListener('focusout', function() {
  window.setTimeout(syncMobileStepActionsForKeyboard, 60);
});
window.addEventListener('resize', function() {
  syncMobileStepActionsForKeyboard();
  syncMobileActionClearance();
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncMobileStepActionsForKeyboard);
}
if (window.ResizeObserver) {
  var mobileActionsObserver = new ResizeObserver(syncMobileActionClearance);
  document.querySelectorAll('.step-actions').forEach(function(actions) { mobileActionsObserver.observe(actions); });
}
syncMobileActionClearance();



function deselectService(svc) {

  var idx = BOOK.selectedServices.indexOf(svc);

  if (idx !== -1) BOOK.selectedServices.splice(idx, 1);

  delete BOOK.selectedItems[svc];

  if (BOOK.currentSvc === svc) {
    BOOK.currentSvc = null;
    BOOK.currentGroup = '';
  }

  updateSvcRows();

  updateOrderSummary();

}



function getDisplayServiceName(svc) {

  if (svc === 'Other') return 'Custom Quote';
  if (svc === 'Mounting & Hanging') return 'TV Mounting';
  return svc;

}

function formatSelectedServices(separator) {

  return (BOOK.selectedServices || [])
    .map(function(svc) { return getDisplayServiceName(svc); })
    .filter(Boolean)
    .join(separator || ' / ');

}

function normalizeServiceToken(value) {

  return String(value || '').toLowerCase().replace(/[^a-z]/g, '');

}

function resolveServiceSelection(value) {

  var normalized = normalizeServiceToken(value);
  if (!normalized) return '';

  var aliases = {
    furnitureassembly: 'Furniture Assembly',
    tvmounting: 'Mounting & Hanging',
    mounting: 'Mounting & Hanging',
    mountinghanging: 'Mounting & Hanging',
    smarthome: 'Smart Home',
    smarthomeinstallation: 'Smart Home',
    fitnessequipment: 'Fitness Equipment',
    fitnessequipmentassembly: 'Fitness Equipment',
    outdoorplaysets: 'Outdoor & Playsets',
    outdoorplayset: 'Outdoor & Playsets',
    playsetassembly: 'Outdoor & Playsets',
    officeassembly: 'Office Assembly',
    officefurniture: 'Office Assembly',
    officefurnitureassembly: 'Office Assembly',
    other: 'Other',
    customquote: 'Other',
    quote: 'Other'
  };

  if (aliases[normalized]) return aliases[normalized];

  var match = '';
  document.querySelectorAll('.svc-row').forEach(function(row) {
    var rowClean = normalizeServiceToken(row.dataset.service || '');
    if (!match && (rowClean.indexOf(normalized) !== -1 || normalized.indexOf(rowClean) !== -1)) {
      match = row.dataset.service;
    }
  });

  return match;

}

function getSelectedItemLabel(item) {

  return item.qty > 1 ? item.name + ' \xD7' + item.qty : item.name;

}

function getVisibleBookingStep() {

  for (var i = 1; i <= TOTAL_STEPS; i++) {

    var panel = document.getElementById('step-' + i);

    if (panel && !panel.classList.contains('hidden')) return i;

  }

  return 1;

}

function editServiceFromSummary(svc) {

  goToStep(1);

  showItemScreen(svc, 'items');

}

function removeServiceFromSummary(svc) {

  var activeStep = getVisibleBookingStep();
  var wasCurrentService = BOOK.currentSvc === svc;

  deselectService(svc);

  if (wasCurrentService) {
    var itemScreen = document.getElementById('item-screen');
    var svcScreen = document.getElementById('svc-screen');
    if (itemScreen) itemScreen.style.display = 'none';
    if (svcScreen) svcScreen.style.display = '';
  }

  if (!BOOK.selectedServices.length || activeStep >= 5) {
    goToStep(1);
  }

}

function removeItemFromSummary(svc, itemName) {

  var activeStep = getVisibleBookingStep();
  var items = BOOK.selectedItems[svc] || [];
  var nextItems = items.filter(function(item) { return item.name !== itemName; });

  if (nextItems.length === items.length) return;

  if (nextItems.length === 0) {
    removeServiceFromSummary(svc);
    return;
  }

  BOOK.selectedItems[svc] = nextItems;

  if (BOOK.currentSvc === svc) renderItemScreen(svc);

  updateSvcRows();
  updateOrderSummary();

  if (activeStep >= 5) goToStep(1);

}

function renderReviewServiceSummary() {

  if (!BOOK.selectedServices.length) {
    return '<div class="summary-service-items">No services selected yet.</div>';
  }

  return '<div class="summary-service-list">' + BOOK.selectedServices.map(function(svc) {
    var items = BOOK.selectedItems[svc] || [];
    var itemsHtml = items.length
      ? items.map(function(item) { return esc(getSelectedItemLabel(item)); }).join(', ')
      : '<span style="font-style:italic">No items selected yet</span>';

    return '<div class="summary-service-row">'
      + '<div class="summary-service-main">'
      + '<div class="summary-service-name">' + esc(getDisplayServiceName(svc)) + '</div>'
      + '<div class="summary-service-items">' + itemsHtml + '</div>'
      + '</div>'
      + '<div class="summary-service-actions">'
      + '<button type="button" class="summary-service-btn" data-summary-action="edit-service" data-summary-service="' + escAttr(svc) + '">Edit</button>'
      + '<button type="button" class="summary-service-btn remove" data-summary-action="remove-service" data-summary-service="' + escAttr(svc) + '">Remove</button>'
      + '</div>'
      + '</div>';
  }).join('') + '</div>';

}

function isItemSelected(svc, name) {

  return (BOOK.selectedItems[svc] || []).some(function(i) { return i.name === name; });

}

function getItemQty(svc, name) {

  var found = (BOOK.selectedItems[svc] || []).find(function(i) { return i.name === name; });

  return found ? found.qty : 1;

}

function findItemGroup(svc, itemName) {

  var groups = SUBCATS[svc] || [];

  for (var i = 0; i < groups.length; i++) {

    var items = groups[i].items || [];

    for (var j = 0; j < items.length; j++) {

      if (items[j].name === itemName) return groups[i].group || svc;

    }

  }

  return svc;

}



function toggleItem(svc, name, price, priceMax, isAddon, isCustomQuote) {

  if (!BOOK.selectedItems[svc]) BOOK.selectedItems[svc] = [];
  BOOK.currentGroup = findItemGroup(svc, name);

  var items = BOOK.selectedItems[svc];

  var idx = items.findIndex(function(i) { return i.name === name; });

  if (idx === -1) {

    items.push({ name: name, price: price, priceMax: priceMax, addon: isAddon, customQuote: isCustomQuote, qty: 1 });

  } else {

    items.splice(idx, 1);

  }

  renderItemScreen(BOOK.currentSvc);

  updateOrderSummary();

}



// ----------------------------------------------------------------------------
// RECOMMENDATION SHELF
// Pure UX layer. Adds existing catalog items or opens another catalog-backed service.
// Server remains the source of truth for prices, taxes, and validation.
// ----------------------------------------------------------------------------
function hasSelectedBaseItems(svc) {
  return (BOOK.selectedItems[svc] || []).some(function(i) { return !i.addon && !i.customQuote; });
}

function getSelectedItemNamesLower(svc) {
  return (BOOK.selectedItems[svc] || []).map(function(i) { return String(i.name || "").toLowerCase(); });
}

function appliesToSelection(list, selectedNames) {
  if (!list || !list.length) return true;
  return selectedNames.some(function(name) {
    return list.some(function(keyword) {
      return name.indexOf(String(keyword).toLowerCase()) !== -1;
    });
  });
}

function collectRecoCandidates(svc) {
  if (!svc || svc === "Other" || !hasSelectedBaseItems(svc)) return [];
  var groups = SUBCATS[svc] || [];
  var selected = BOOK.selectedItems[svc] || [];
  var selectedNames = getSelectedItemNamesLower(svc);
  function chosen(name) {
    return selected.some(function(i) { return i.name === name; });
  }
  var out = [];
  groups.forEach(function(group) {
    (group.items || []).forEach(function(item) {
      if (item.customQuote || chosen(item.name)) return;
      var tags = item.tags || [];
      if (!tags.length) return;
      if (!appliesToSelection(item.appliesTo, selectedNames)) return;
      out.push({
        item: item,
        priority: tags.indexOf("safety") !== -1 ? 1 : (tags.indexOf("convenience") !== -1 ? 2 : (tags.indexOf("upgrade") !== -1 ? 3 : 0))
      });
    });
  });
  return out;
}

function recommendItems(svc) {
  var candidates = collectRecoCandidates(svc);
  var addOns = candidates.filter(function(entry) { return entry.priority === 1 || entry.priority === 2; });
  var upgrades = candidates.filter(function(entry) { return entry.priority === 3; });
  addOns.sort(function(a, b) { return a.priority - b.priority; });
  return {
    addOns: addOns.slice(0, 3),
    upgrades: upgrades.slice(0, 2)
  };
}

function renderRecoItemSection(title, entries) {
  if (!entries.length) return "";
  var html = "<div class=\"reco-shelf-block\"><div class=\"reco-shelf-head\">" + esc(title) + "</div><div class=\"reco-shelf-row\">";
  entries.forEach(function(entry) {
    var item = entry.item;
    var label = esc(item.recoLabel || item.name);
    var why = esc(item.recoWhy || "");
    html += "<button type=\"button\" class=\"reco-chip\""
      + " data-name=\"" + escAttr(item.name) + "\""
      + " data-price=\"" + (item.price || 0) + "\""
      + " data-pricemax=\"" + (item.priceMax || 0) + "\""
      + " data-addon=\"" + (item.addon ? "true" : "false") + "\""
      + " onclick=\"recoAdd(this)\">"
      + "<span class=\"reco-chip-text\"><span class=\"reco-chip-name\">" + label + "</span>"
      + (why ? "<span class=\"reco-chip-why\">" + why + "</span>" : "")
      + "</span>"
      + "<span class=\"reco-chip-price\">" + esc(fmtPrice(item)) + "</span>"
      + "<span class=\"reco-chip-add\" aria-hidden=\"true\">+</span>"
      + "</button>";
  });
  return html + "</div></div>";
}

function renderAddServiceChoice() {
  return "<div class=\"reco-shelf-block\">"
    + "<div class=\"reco-shelf-head\">Optional</div>"
    + "<div class=\"reco-shelf-title\">Add another service</div>"
    + "<div class=\"reco-shelf-note\">Browse all available services and choose only what you need for this visit.</div>"
    + "<div class=\"reco-shelf-row\">"
    + "<button type=\"button\" class=\"reco-chip\" onclick=\"openAddServicePicker()\">"
    + "<span class=\"reco-chip-text\"><span class=\"reco-chip-name\">Browse all services</span>"
    + "<span class=\"reco-chip-why\">Your current selections will stay saved.</span></span>"
    + "<span class=\"reco-chip-price action\">Browse</span>"
    + "<span class=\"reco-chip-add\" aria-hidden=\"true\">&rarr;</span>"
    + "</button></div></div>";
}

function renderRecoShelf(svc) {
  var shelf = document.getElementById("reco-shelf");
  if (!shelf) return;
  if (!svc || svc === "Other") {
    shelf.style.display = "none";
    shelf.innerHTML = "";
    return;
  }
  if (!hasSelectedBaseItems(svc)) {
    shelf.style.display = "none";
    shelf.innerHTML = "";
    return;
  }
  var itemSections = recommendItems(svc);
  var isExtrasStage = BOOK.itemStage === "extras";
  var html = "";

  if (isExtrasStage) {
    html = renderAddServiceChoice();
  } else {
    html = ""
      + "<div class=\"reco-shelf-block\">"
      + "<div class=\"reco-shelf-title\">Add-ons for this visit</div>"
      + "<div class=\"reco-shelf-note\">Pick any extras that belong on the same appointment.</div>"
      + "</div>"
      + renderRecoItemSection("Add to this visit", itemSections.addOns)
      + renderRecoItemSection("Upgrade the finish", itemSections.upgrades);
  }

  if (!html) {
    shelf.style.display = "none";
    shelf.innerHTML = "";
    return;
  }
  shelf.innerHTML = html;
  shelf.style.display = "flex";
}

function recoAdd(btn) {
  var svc = BOOK.currentSvc;
  if (!svc) return;
  toggleItem(svc, btn.getAttribute("data-name"),
    parseFloat(btn.getAttribute("data-price")) || 0,
    parseFloat(btn.getAttribute("data-pricemax")) || 0,
    btn.getAttribute("data-addon") === "true",
    false);
}

function changeQty(svc, name, delta) {

  var found = (BOOK.selectedItems[svc] || []).find(function(i) { return i.name === name; });

  if (found) {
    BOOK.currentGroup = findItemGroup(svc, name);
    found.qty = Math.min(99, Math.max(1, (parseInt(found.qty, 10) || 1) + delta));
    renderItemScreen(BOOK.currentSvc);
    updateOrderSummary();
  }

}



// ----------------------------------------------------------------------------

// ORDER SUMMARY

// ----------------------------------------------------------------------------

function getJobPlanItemCount() {
  return BOOK.selectedServices.reduce(function(total, svc) {
    return total + (BOOK.selectedItems[svc] || []).reduce(function(serviceTotal, item) {
      return serviceTotal + Math.min(99, Math.max(1, parseInt(item.qty, 10) || 1));
    }, 0);
  }, 0);
}

function renderJobPlanCards() {
  var preview = document.getElementById('job-plan-preview');
  var ready = document.getElementById('job-plan-ready');
  var cards = [preview, ready].filter(Boolean);
  if (!cards.length) return;

  var itemCount = getJobPlanItemCount();
  if (!BOOK.selectedServices.length || itemCount === 0) {
    cards.forEach(function(card) {
      card.classList.remove('show');
      card.innerHTML = '';
    });
    return;
  }

  var snapshot = getPricingSnapshot(BOOK.zip || '');
  var serviceNames = formatSelectedServices(', ');
  var selectedSubtotal = Math.max(0, Number(snapshot.discountedSubtotal || 0));
  var schedulePrice = snapshot.hasCustom && selectedSubtotal === 0 ? 'Custom quote' : dollars(selectedSubtotal);
  var finalPrice = BOOK.isEmergingMarket
    ? 'Service request'
    : (snapshot.hasCustom && snapshot.itemSubtotal === 0 ? 'Custom quote' : dollars(snapshot.grandTotal));
  var appointment = BOOK.date
    ? new Date(BOOK.date + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }) + (BOOK.time ? ' at ' + BOOK.time : '')
    : 'Choose an appointment';

  if (preview) {
    preview.innerHTML = '<div class="job-plan-head">'
      + '<div><div class="job-plan-kicker">Your job plan</div><div class="job-plan-title">Selected work is ready to schedule</div></div>'
      + '<div class="job-plan-price">' + esc(schedulePrice) + '<span>' + (snapshot.hasCustom ? 'Priced items only' : 'Items subtotal') + '</span></div>'
      + '</div>'
      + '<div class="job-plan-meta">'
      + '<div class="job-plan-meta-item"><span>Services</span><strong>' + esc(serviceNames) + '</strong></div>'
      + '<div class="job-plan-meta-item"><span>Selected work</span><strong>' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + '</strong></div>'
      + '</div>'
      + '<div class="job-plan-note">Choose the service address next. Any service-area fee and sales tax will be itemized before payment.</div>';
    preview.classList.add('show');
  }

  if (ready) {
    ready.innerHTML = '<div class="job-plan-head">'
      + '<div><div class="job-plan-kicker">Plan summary</div><div class="job-plan-title">' + esc(serviceNames) + '</div></div>'
      + '<div class="job-plan-price">' + esc(finalPrice) + '<span>' + (BOOK.isEmergingMarket ? 'No payment collected' : (snapshot.hasCustom ? 'Estimated priced total' : 'Estimated total')) + '</span></div>'
      + '</div>'
      + '<div class="job-plan-meta">'
      + '<div class="job-plan-meta-item"><span>Appointment</span><strong>' + esc(appointment) + '</strong></div>'
      + '<div class="job-plan-meta-item"><span>Service address</span><strong>' + esc(BOOK.address || 'Address not saved yet') + '</strong></div>'
      + '</div>'
      + '<div class="job-plan-note">You can still go back and adjust the plan. We&rsquo;ll verify the final price and availability before your booking is confirmed.</div>';
    ready.classList.add('show');
  }
}

function updateOrderSummary() {

  var linesEl   = document.getElementById('order-lines');

  var changeBtn = document.getElementById('change-services-btn');
  var summaryCard = document.getElementById('order-summary-card');
  var servicesWithItems = BOOK.selectedServices.filter(function(svc) {
    return (BOOK.selectedItems[svc] || []).length > 0;
  });



  if (servicesWithItems.length === 0) {

    linesEl.innerHTML = '';

    changeBtn.style.display = 'none';
    if (summaryCard) summaryCard.style.display = 'none';
    renderBundleWelcome();
    renderSelectedServiceStrip();
    renderItemSummaryStrip();
    updateMobileStepSummary();
    renderJobPlanCards();

    return;

  }



  changeBtn.style.display = 'inline';
  if (summaryCard) summaryCard.style.display = '';

  var html = '';

  servicesWithItems.forEach(function(svc) {

    var items = BOOK.selectedItems[svc] || [];

    var displaySvc = getDisplayServiceName(svc);
    html += '<div class="order-group">';
    html += '<div class="order-group-head"><div class="order-group-label">' + esc(displaySvc) + '</div><div class="order-group-actions">'
      + '<button type="button" class="order-action-btn" data-summary-action="edit-service" data-summary-service="' + escAttr(svc) + '">Edit</button>'
      + '<button type="button" class="order-action-btn remove" data-summary-action="remove-service" data-summary-service="' + escAttr(svc) + '">Remove</button>'
      + '</div></div>';

    items.forEach(function(item) {
      html += '<div class="order-line"><span class="order-line-name">' + esc(getSelectedItemLabel(item)) + '</span><span class="order-line-right"><span class="order-line-price">' + esc(fmtLinePrice(item)) + '</span><button type="button" class="order-line-remove" data-summary-action="remove-item" data-summary-service="' + escAttr(svc) + '" data-summary-item="' + escAttr(item.name) + '">Remove</button></span></div>';
    });

    html += '</div>';

  });

  linesEl.innerHTML = html;
  renderBundleWelcome();
  renderSelectedServiceStrip();
  renderItemSummaryStrip();
  updateMobileStepSummary();
  renderJobPlanCards();

}



// ----------------------------------------------------------------------------

// BUNDLE DISCOUNT

// ----------------------------------------------------------------------------

function handleSummaryActionClick(target) {

  var btn = target.closest('[data-summary-action]');

  if (!btn) return;

  var action = btn.dataset.summaryAction;
  var svc = btn.dataset.summaryService || '';
  var itemName = btn.dataset.summaryItem || '';

  if (action === 'edit-service') {
    editServiceFromSummary(svc);
    return;
  }

  if (action === 'remove-service') {
    removeServiceFromSummary(svc);
    return;
  }

  if (action === 'remove-item') {
    removeItemFromSummary(svc, itemName);
  }

}

document.getElementById('order-lines').addEventListener('click', function(e) {

  handleSummaryActionClick(e.target);

});

document.getElementById('booking-summary').addEventListener('click', function(e) {

  handleSummaryActionClick(e.target);

});

function getBundleDiscount() {

  // Requires 2+ different services; picking multiple items within one service doesn't qualify

  var servicesWithItems = BOOK.selectedServices.filter(function(svc) {

    return (BOOK.selectedItems[svc] || []).some(function(i) { return !i.customQuote; });

  });

  if (servicesWithItems.length < 2) return { pct: 0, count: 0 };

  var count = 0;

  servicesWithItems.forEach(function(svc) {

    (BOOK.selectedItems[svc] || []).forEach(function(item) {

      if (!item.customQuote) count += Math.min(99, Math.max(1, parseInt(item.qty, 10) || 1));

    });

  });

  if (count >= 6) return { pct: 15, count: count };

  if (count >= 3) return { pct: 10, count: count };

  return { pct: 0, count: count };

}



// ----------------------------------------------------------------------------

// STEP 2: ACCOUNT MODE

// ----------------------------------------------------------------------------

function selectAccountMode(mode) {

  BOOK.accountMode = mode;

  document.getElementById('opt-guest').classList.toggle('selected', mode === 'guest');

  document.getElementById('opt-account').classList.toggle('selected', mode === 'account');

  document.getElementById('signup-link').style.display = (mode === 'account') ? 'block' : 'none';

  hideErr('s2-err');

}



// ----------------------------------------------------------------------------

// PROGRESS & NAV

// ----------------------------------------------------------------------------

var TOTAL_STEPS = 5;

var DISPLAY_STEPS = 4;

// Internal step -> display step (step 2 removed from UI)

var STEP_DISPLAY = {1:1, 2:1, 3:2, 4:3, 5:4};



function setProgress(step) {

  var d = STEP_DISPLAY[step] || step;

  for (var i = 1; i <= DISPLAY_STEPS; i++) {

    var el = document.getElementById('prog-' + i);

    if (!el) continue;

    el.classList.remove('active','done');

    if (i < d) el.classList.add('done');

    else if (i === d) el.classList.add('active');

  }

  for (var j = 1; j < DISPLAY_STEPS; j++) {

    var line = document.getElementById('prog-line-' + j);

    if (line) line.classList.toggle('done', j < d);

  }

  var hint = document.getElementById('book-progress-hint');

  if (hint) {

    var hints = ['Step 1 of 4 &mdash; Job plan','Step 1 of 4 &mdash; Job plan','Step 2 of 4 &mdash; Schedule','Step 3 of 4 &mdash; Your info','Step 4 of 4 &mdash; Payment'];

    hint.innerHTML = hints[step - 1] || '';

  }

}

function syncBookingChrome(isConfirm) {
  var page = document.getElementById('book-page');
  var footer = document.getElementById('book-footer');

  if (page) page.classList.toggle('is-confirm', !!isConfirm);
  if (footer) footer.classList.toggle('is-visible', !!isConfirm);
}



function goToStep(n) {

  // Step 2 was removed from the live flow; never navigate to its hidden panel.
  if (n === 2) n = 1;

  for (var i = 1; i <= TOTAL_STEPS; i++) {

    var p = document.getElementById('step-' + i);

    if (p) p.classList.toggle('hidden', i !== n);

  }

  var confirm = document.getElementById('step-confirm');

  if (confirm) confirm.classList.add('hidden');

  syncBookingChrome(false);
  setProgress(n);
  window.requestAnimationFrame(syncMobileActionClearance);

  (function(){var panel=document.getElementById('step-'+n);if(!panel){window.scrollTo({top:0,behavior:'smooth'});return;}var y=panel.getBoundingClientRect().top+window.pageYOffset-12;window.scrollTo({top:Math.max(0,y),behavior:'smooth'});if(n===4){setTimeout(function(){var fld=panel.querySelector('input[type=text], input[type=email]');if(fld&&!fld.value){try{fld.focus({preventScroll:true});}catch(e){}}},380);}})();

}



function goToStep2Account() {

  var hasService = BOOK.selectedServices.length > 0;

  if (!hasService) { showErr('s1-err', 'Please select at least one service.'); return; }

  var missingItems = BOOK.selectedServices.filter(function(svc) {

    if (svc === 'Other') return false;

    return (BOOK.selectedItems[svc] || []).length === 0;

  });

  if (missingItems.length > 0 && !document.getElementById('s1-quote').checked) {

    showErr('s1-err', 'Please select at least one item under: ' + missingItems.join(', ') + '. Or use the custom quote option.');

    return;

  }

  var selectedQuote = document.getElementById('s1-quote').checked;
  var selectionSnapshot = getPricingSnapshot('');
  if (!selectedQuote && selectionSnapshot.isAddonOnly) {
    showErr('s1-err', 'Add-ons are for same-visit work. Please add a main service item, or use the custom quote option so we can review it manually.');
    return;
  }

  hideErr('s1-err');

  BOOK.details = document.getElementById('s1-details').value.trim();

  BOOK.wantsQuote = selectedQuote;

  BOOK.accountMode = 'guest'; // auto guest, no friction step

  renderJobPlanCards();

  goToStep(3);
  trackBookingFunnelOnce('job_plan_completed', { service_count: BOOK.selectedServices.length });
  trackBookingFunnelOnce('schedule_started');

}



function goToStep3DateTime() {

  hideErr('s2-err');

  goToStep(3);

}



function goToStep4Contact() {

  var street = (document.getElementById('s3-street').value || '').trim();

  var apt    = (document.getElementById('s3-apt').value || '').trim();

  var city   = (document.getElementById('s3-city').value || '').trim();

  var state  = (document.getElementById('s3-state').value || '').trim();

  var zip    = (document.getElementById('s3-zip').value || '').trim();

  var ok = true;

  var zipIsValid = isValidZip(zip);

  var zipInArea = isActiveServiceZip(zip);

  var isEmergingMarket = zipIsValid && !zipInArea;

  if (!BOOK.date) { showErr('s3-date-err', 'Please select a date.'); ok = false; } else hideErr('s3-date-err');

  if (!BOOK.time) { showErr('s3-time-err', 'Please select a time slot.'); ok = false; } else hideErr('s3-time-err');

  if (!street && !isEmergingMarket) { fieldErr('s3-street', 's3-addr-err', true); ok = false; } else fieldErr('s3-street', 's3-addr-err', false);

  var zipEl  = document.getElementById('s3-zip');

  var zipErr = document.getElementById('s3-zip-err');

  if (!zip) {

    zipErr.textContent = 'Please enter your ZIP code.';

    zipErr.style.display = 'block';

    if (zipEl) zipEl.style.borderColor = '#ef4444';

    ok = false;

  } else if (!zipIsValid) {

    zipErr.textContent = 'Please enter a valid 5-digit ZIP code.';

    zipErr.style.display = 'block';

    if (zipEl) zipEl.style.borderColor = '#ef4444';

    ok = false;

  } else {

    if (zipInArea) {

      zipErr.style.display = 'none';

      if (zipEl) zipEl.style.borderColor = '#22c55e';

    } else {

      zipErr.style.display = 'none';

      if (zipEl) zipEl.style.borderColor = '#0ea5e9';

    }

  }

  var cityEl = document.getElementById('s3-city');
  var resolvedCity = city;
  if (!resolvedCity && zipInArea && window.AAELocation) {
    resolvedCity = window.AAELocation.set(zip) || window.AAELocation.get() || '';
    if (resolvedCity && cityEl) cityEl.value = resolvedCity;
  }
  if (!resolvedCity) { fieldErr('s3-city', 's3-city-err', true); ok = false; } else fieldErr('s3-city', 's3-city-err', false);

  if (!ok) return;

  BOOK.city = resolvedCity;

  BOOK.state = (state || 'TX').toUpperCase();

  BOOK.zip = zip;

  BOOK.isEmergingMarket = isEmergingMarket;

  BOOK.address = (street ? street + (apt ? ', ' + apt : '') + ', ' : '') + BOOK.city + ', ' + BOOK.state + ' ' + zip;

  renderJobPlanCards();

  goToStep(4);
  trackBookingFunnelOnce('schedule_completed', { days_ahead: Math.max(0, Math.round((new Date(BOOK.date + 'T12:00:00Z') - new Date(getChicagoTodayIso() + 'T12:00:00Z')) / 86400000)) });
  trackBookingFunnelOnce('contact_started');

  // Update step-4 CTA label so quote flow never says "Continue to payment"
  var allCustom = Object.keys(BOOK.selectedItems).length > 0 &&
    Object.keys(BOOK.selectedItems).every(function(svc) {
      var items = BOOK.selectedItems[svc] || [];
      return items.length > 0 && items.every(function(i) { return i.customQuote; });
    });
  var s4Btn = document.getElementById('s4-next-btn');
  if (s4Btn) {
    if (BOOK.isEmergingMarket) {
      s4Btn.innerHTML = 'Review service request <span>&#8594;</span>';
    } else if (BOOK.wantsQuote || allCustom) {
      s4Btn.innerHTML = 'Review quote request <span>&#8594;</span>';
    } else {
      s4Btn.innerHTML = 'Continue to payment <span>&#8594;</span>';
    }
  }

}



// Pure formatters for the step-5 summary rows. They used to live INSIDE
// goToStep5Payment, so saveDtEdit and saveContactEdit — both declared at this
// outer level — threw "Can't find variable: renderSummaryDateTime" the moment
// an owner edited the date or the contact details. Two latent ReferenceErrors,
// one of which reached Live Ops. They depend only on esc and
// formatUsPhoneForDisplay, both defined out here, so out here is where they go.
function renderSummaryContact(first, last, email, phone) {

  return '<span class="summary-contact-details">'

    + '<span>' + esc(first + ' ' + last) + '</span>'

    + '<span>' + esc(email) + '</span>'

    + '<span>' + esc(formatUsPhoneForDisplay(phone)) + '</span>'

    + '</span>';

}
function renderSummaryDateTime(dateLabel, timeLabel) {

  return '<span class="summary-datetime-details">'

    + '<span>' + esc(dateLabel) + '</span>'

    + '<span>' + esc(timeLabel) + '</span>'

    + '</span>';

}

// Saves a started custom quote as a lead (api/booking/quote-lead.js). Sending
// the quote marks it converted; one that is never sent stays in the owner's
// Unbooked Requests. Never blocks or slows the page.
function captureQuoteLead() {
  try {
    var key = [BOOK.email, BOOK.zip, JSON.stringify(BOOK.selectedServices)].join('|');
    if (BOOK._quoteLeadKey === key) return;
    BOOK._quoteLeadKey = key;
    fetch('/api/booking/quote-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        name: (BOOK.firstName + ' ' + BOOK.lastName).trim(),
        email: BOOK.email, phone: BOOK.phone,
        address: BOOK.address, city: BOOK.city, state: BOOK.state, zip: BOOK.zip,
        date: BOOK.date, time: BOOK.time, details: BOOK.details,
        services: BOOK.selectedServices, items: buildItemsPayload(),
        company: (document.getElementById('bk-company') || {}).value || '',
        formStartedAt: BOOK._formStartedAt || null
      })
    }).catch(function () { /* A lead that fails to save never stops the quote. */ });
  } catch (e) { /* never blocks the page */ }
}

async function goToStep5Payment() {

  var first = document.getElementById('s4-first').value.trim();

  var last  = document.getElementById('s4-last').value.trim();

  var email = document.getElementById('s4-email').value.trim();

  var phone = document.getElementById('s4-phone').value.trim();

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var ok = true;

  if (!first) { fieldErr('s4-first','s4-first-err',true); ok=false; } else fieldErr('s4-first','s4-first-err',false);

  if (!last)  { fieldErr('s4-last', 's4-last-err', true); ok=false; } else fieldErr('s4-last', 's4-last-err', false);

  if (!EMAIL_RE.test(email)) { fieldErr('s4-email','s4-email-err',true); ok=false; } else fieldErr('s4-email','s4-email-err',false);

  if (!isValidUsPhone(phone)) { fieldErr('s4-phone','s4-phone-err',true); var pw=document.getElementById('s4-phone-wrap'); if(pw) pw.style.borderColor='#ef4444'; ok=false; } else { fieldErr('s4-phone','s4-phone-err',false); var pw=document.getElementById('s4-phone-wrap'); if(pw) pw.style.borderColor=''; }

  if (!ok) return;

  BOOK.firstName = first; BOOK.lastName = last; BOOK.email = email; BOOK.phone = phone;
  trackBookingFunnelOnce('contact_completed');
  trackBookingFunnelOnce('begin_checkout', { value: Number(BOOK._grandTotalCents || 0) / 100, currency: 'USD' });

  hideErr('s4-err');
  var policyMessage = getOnlineBookingPolicyMessage();
  if (policyMessage) {
    showErr('s4-err', policyMessage);
    return;
  }

  var pricingSnapshotForFlow = getPricingSnapshot(BOOK.zip);
  BOOK._hasCustomQuoteItems = pricingSnapshotForFlow.hasCustom;



  var summaryDate = BOOK.date ? new Date(BOOK.date + 'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) : '\u2014';

  var SVGPIN = '<svg viewBox="0 0 24 24" width="18" height="18" style="fill:var(--teal)"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>';

  var SVGCAL = '<svg viewBox="0 0 24 24" width="18" height="18" style="fill:var(--teal)"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/></svg>';

  var SVGUSER = '<svg viewBox="0 0 24 24" width="18" height="18" style="fill:var(--teal)"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

  var SVGSVC = '<svg viewBox="0 0 24 24" width="18" height="18" style="fill:var(--teal)"><path d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>';



  function editRow(id, icon, label, displayHtml, formHtml, editOnclick) {

    return '<div class="summary-row" id="srow-' + id + '">'

      + '<span class="summary-row-icon">' + icon + '</span>'

      + '<div style="flex:1">'

      + '<div class="summary-row-label">' + label

      + '<button class="summary-row-edit" onclick="' + (editOnclick || ('toggleS5Edit(\'' + id + '\')')) + '">Edit</button>'

      + '</div>'

      + '<div class="summary-row-value" id="s5-' + id + '-val">' + displayHtml + '</div>'

      + '<div id="s5-' + id + '-form" style="display:none;margin-top:0.5rem">' + formHtml + '</div>'

      + '</div></div>';

  }





  var minBookableDate = getChicagoTodayIso();

  var maxBookableDate = addIsoDays(minBookableDate, BOOKING_WINDOW_DAYS);

  _s5SelTime = BOOK.time;



  document.getElementById('booking-summary').innerHTML =

    // Services row: go back to step 1

    '<div class="summary-row"><span class="summary-row-icon">' + SVGSVC + '</span>'

      + '<div style="flex:1"><div class="summary-row-label">Services</div>'

      + '<div class="summary-row-value">' + renderReviewServiceSummary() + '</div>'

      + '</div></div>' +



    // Date & time row: inline pickers

    editRow('dt', SVGCAL, 'Date &amp; time',

      renderSummaryDateTime(summaryDate, BOOK.time),

      '<input type="date" class="summary-addr-input" id="s5-dt-date" value="' + escAttr(BOOK.date) + '" min="' + escAttr(minBookableDate) + '" max="' + escAttr(maxBookableDate) + '" onchange="renderS5TimeButtons(this.value)" />'

      + '<div id="s5-dt-times" style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.5rem"></div>'

      + '<button onclick="saveDtEdit()" class="summary-addr-save" style="margin-top:0.5rem">Save</button>'

    ) +



    // Address row: edits route back to the one validated step-3 address form
    // (structured street/city/ZIP + service-area check). A free-text inline edit
    // here could not re-validate the ZIP or keep pricing/tax correct.

    editRow('addr', SVGPIN, 'Address',

      esc(BOOK.address),

      '',

      'editAddressOnStep3()'

    ) +



    // Contact row: inline fields

    editRow('contact', SVGUSER, 'Contact',

      renderSummaryContact(first, last, email, BOOK.phone),

      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem">'

      + '<input type="text" class="summary-addr-input" id="s5-c-first" placeholder="First name" value="' + escAttr(first) + '" />'

      + '<input type="text" class="summary-addr-input" id="s5-c-last" placeholder="Last name" value="' + escAttr(last) + '" />'

      + '</div>'

      + '<input type="email" class="summary-addr-input" id="s5-c-email" placeholder="Email" value="' + escAttr(email) + '" style="margin-top:0.4rem" />'

      + '<input type="tel" class="summary-addr-input" id="s5-c-phone" placeholder="512-555-0123" value="' + escAttr(BOOK.phone) + '" inputmode="tel" maxlength="18" style="margin-top:0.4rem" />'

      + '<button onclick="saveContactEdit()" class="summary-addr-save" style="margin-top:0.5rem">Save</button>'

    );



  renderS5TimeButtons(BOOK.date);

  if (BOOK.promoCode) {
    var promoField = document.getElementById('s5-promo-code');
    if (promoField) promoField.value = BOOK.promoCode;
  }
  renderStep5OrderTotal();



  goToStep(5);

  syncPaymentSubmitState();

  if (BOOK.isEmergingMarket) {

    BOOK._isQuoteFlow = false;
    BOOK._promoPreview = null;

    document.getElementById('s5-banner').textContent = 'Emerging market request';

    document.getElementById('s5-heading').textContent = 'Submit a service request';

    document.getElementById('s5-sub').innerHTML = '<strong>No payment collected.</strong> We are collecting demand in your area and will reach out if coverage becomes available.';

    document.getElementById('s5-payment-section').style.display = 'none';

    document.getElementById('s5-quote-section').style.display = 'block';

    document.getElementById('s5-quote-section').innerHTML = '<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:var(--radius-md);padding:1rem 1.1rem;font-size:0.86rem;color:#075985;line-height:1.65"><strong>We will contact you first.</strong> ' + ACTIVE_MARKET_LABEL + ' is still limited. For ' + esc(BOOK.city) + ', ' + esc(BOOK.state) + ', we will save your request, check local coverage, and contact you before any scheduling or payment happens.</div>';

    document.getElementById('s5-charge-note').style.display = 'none';

    document.getElementById('s5-stripe-note').style.display = 'none';

    document.getElementById('s5-cancel-note').style.display = 'none';
    document.getElementById('s5-confidence').innerHTML =
      '<span>No payment</span><span>Demand tracked by market</span><span>We contact you before scheduling</span>';

    document.getElementById('s5-submit').innerHTML = 'Submit Service Request <span>&#8594;</span>';
    document.getElementById('s5-submit').disabled = false;
    setPromoStatus('This offer applies to instant-price online bookings in active service areas.', 'warning');

    var emergingProg4Label = document.querySelector('#prog-4 .progress-label');
    if (emergingProg4Label) emergingProg4Label.textContent = 'Request';

    return;

  }

  document.getElementById('s5-banner').innerHTML = 'You&rsquo;re almost done &mdash; just 1 step left';

  document.getElementById('s5-heading').textContent = 'Secure your booking';

  document.getElementById('s5-sub').textContent = 'Review the total, add your card, and confirm. Payment is only processed after the job is complete.';

  document.getElementById('s5-payment-section').style.display = 'block';

  document.getElementById('s5-quote-section').style.display = 'none';

  document.getElementById('s5-charge-note').style.display = 'none';

  document.getElementById('s5-stripe-note').style.display = '';
  document.getElementById('s5-cancel-note').style.display = '';

  document.getElementById('s5-confidence').innerHTML =
    '';

  document.getElementById('s5-submit').innerHTML = 'Complete Booking <span>&#8594;</span>';

  var resetProg4Label = document.querySelector('#prog-4 .progress-label');
  if (resetProg4Label) resetProg4Label.textContent = 'Payment';



  // Detect quote-only flow: all items are custom quotes OR user checked the quote checkbox

  var isQuoteFlow = (BOOK._grandTotalCents === 0) || BOOK.wantsQuote || BOOK._hasCustomQuoteItems;
  var isScheduledAuthorization = !isQuoteFlow
    && BOOK.date > addIsoDays(getChicagoTodayIso(), IMMEDIATE_AUTHORIZATION_DAYS);

  BOOK._isQuoteFlow = isQuoteFlow;
  BOOK._scheduledAuthorization = isScheduledAuthorization;
  if (isQuoteFlow || isScheduledAuthorization) BOOK.paymentMethod = 'card';
  if (isQuoteFlow || isScheduledAuthorization) BOOK._setupIntentSecret = null;
  renderBookingPaymentMethods();
  syncPaymentSubmitState();
  await refreshPromoPreview({ silentFailure: true });

  // Custom quote (owner, 2026-10-21): no card on this step. 12 of 15 people
  // left at a card form shown before any price. The card is taken on the
  // approval page, after the customer sees the quoted price.
  if (isQuoteFlow) {
    document.getElementById('s5-banner').textContent = 'Almost done - send your quote request';
    document.getElementById('s5-heading').textContent = 'Send your quote request';
    document.getElementById('s5-sub').textContent = 'No card needed. We email you a price, and nothing is booked or charged until you approve it.';
    document.getElementById('s5-payment-section').style.display = 'none';
    document.getElementById('s5-quote-section').style.display = 'block';
    document.getElementById('s5-quote-section').innerHTML = '<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:var(--radius-md);padding:1rem 1.25rem;font-size:0.875rem;color:#075985;line-height:1.6"><strong>What happens next.</strong> We review your project and email you a price. You approve it and add a card at that point. Nothing is charged until the work is done.</div>';
    document.getElementById('s5-charge-note').style.display = 'none';
    document.getElementById('s5-stripe-note').style.display = 'none';
    document.getElementById('s5-cancel-note').style.display = 'none';
    document.getElementById('s5-confidence').innerHTML = '<span>No card needed</span><span>Price before booking</span><span>Reply by email</span>';
    document.getElementById('s5-confidence').style.display = '';
    document.getElementById('s5-submit').innerHTML = 'Send Quote Request <span>&#8594;</span>';
    var quoteProgLabel = document.querySelector('#prog-4 .progress-label');
    if (quoteProgLabel) quoteProgLabel.textContent = 'Request';
    syncPaymentSubmitState();
    captureQuoteLead();
    return;
  }



  if (isQuoteFlow || isScheduledAuthorization) {

    document.getElementById('s5-banner').textContent = isQuoteFlow
      ? 'Almost done - request your quote'
      : 'Almost done - reserve your appointment';

    document.getElementById('s5-heading').textContent = isQuoteFlow
      ? 'Request custom quote'
      : 'Reserve your appointment';

    document.getElementById('s5-sub').textContent = isQuoteFlow
      ? 'Save your card securely so we can finalize the quote faster if you approve it. No appointment is confirmed yet.'
      : 'Save your card securely without a charge or temporary hold. We will verify it two days before your visit and process payment only after the job is complete.';

    document.getElementById('s5-payment-section').style.display = 'block';

    document.getElementById('s5-quote-section').style.display = 'none';

    document.getElementById('s5-charge-note').style.display = 'none';

    document.getElementById('s5-stripe-note').style.display = '';

    document.getElementById('s5-confidence').innerHTML =

      '';

    document.getElementById('s5-submit').innerHTML = isQuoteFlow
      ? 'Request Custom Quote <span>&#8594;</span>'
      : 'Reserve Appointment <span>&#8594;</span>';

    var prog4Label = document.querySelector('#prog-4 .progress-label');
    if (prog4Label) prog4Label.textContent = isQuoteFlow ? 'Review' : 'Card';

    if (!await initStripe()) return;

    try {
      var siResp = await fetch('/api/booking/setup-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: BOOK.firstName + ' ' + BOOK.lastName,
          email: BOOK.email,
          purpose: isScheduledAuthorization ? 'future_booking' : 'quote_booking',
          date: BOOK.date
        })
      });
      var siData = await siResp.json();
      if (!siResp.ok) throw new Error(siData.error || 'Could not initialize payment form');
      BOOK._setupIntentSecret = siData.clientSecret;
      syncPaymentSubmitState();
    } catch(siErr) {
      var errElSetup = document.getElementById('s5-err');
      if (errElSetup) { errElSetup.textContent = siErr.message; errElSetup.classList.add('show'); }
    }

  } else {

    if (await initStripe()) syncPaymentSubmitState();

  }

}



function toggleS5Edit(id) {

  var valEl  = document.getElementById('s5-' + id + '-val');

  var formEl = document.getElementById('s5-' + id + '-form');

  if (!valEl || !formEl) return;

  var opening = formEl.style.display === 'none';

  formEl.style.display = opening ? '' : 'none';

  valEl.style.display  = opening ? 'none' : '';

  if (opening) {

    var first = formEl.querySelector('input');

    if (first) first.focus();

  }

}



var _s5SelTime = BOOK.time;

function renderS5TimeButtons(dateValue) {
  var times = document.getElementById('s5-dt-times');
  if (!times) return;
  if (_s5SelTime && !isPublishedSlotAvailable(dateValue, _s5SelTime)) _s5SelTime = '';
  times.innerHTML = TIME_SLOTS.map(function(slot) {
    var disabled = !isPublishedSlotAvailable(dateValue, slot);
    return '<button type="button" class="s5-time-btn' + (_s5SelTime === slot ? ' selected' : '') + '"'
      + (disabled ? ' disabled aria-disabled="true"' : '')
      + ' data-time="' + escAttr(slot) + '" onclick="s5SelectTime(this.dataset.time)">' + esc(slot) + '</button>';
  }).join('');
}

function s5SelectTime(t) {

  var dateInput = document.getElementById('s5-dt-date');

  if (!dateInput || !isPublishedSlotAvailable(dateInput.value, t)) return;

  _s5SelTime = t;

  document.querySelectorAll('.s5-time-btn').forEach(function(b){ b.classList.toggle('selected', b.textContent===t); });

}



async function saveDtEdit() {

  var dateInp = document.getElementById('s5-dt-date');

  if (!dateInp || !dateInp.value) return;

  if (!_s5SelTime) return;

  if (!isPublishedSlotAvailable(dateInp.value, _s5SelTime)) {
    var scheduleErr = document.getElementById('s5-err');
    if (scheduleErr) {
      scheduleErr.textContent = 'Choose an available time within the next 30 days. We book every day, 8 AM–8 PM.';
      scheduleErr.classList.add('show');
    }
    return;
  }

  var scheduleErr = document.getElementById('s5-err');
  if (scheduleErr) scheduleErr.classList.remove('show');

  var previousDate = BOOK.date;
  BOOK.date = dateInp.value;

  BOOK.time = _s5SelTime;

  var summaryDate = new Date(BOOK.date + 'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});

  var valEl = document.getElementById('s5-dt-val');

  if (valEl) valEl.innerHTML = renderSummaryDateTime(summaryDate, BOOK.time);

  // sync back to step 3 fields

  var s3date = document.getElementById('s3-date-input');

  if (s3date) s3date.value = BOOK.date;

  toggleS5Edit('dt');

  // SetupIntents are purpose- and appointment-bound. Rebuild checkout when
  // the date changes so a near-term authorization can never be mistaken for a
  // future saved-card booking (or vice versa).
  if (previousDate !== BOOK.date) await goToStep5Payment();

}



// Editing the address returns to the single validated step-3 form (structured
// street/city/ZIP + service-area check + autocomplete), pre-filled with the
// customer's current values. Continuing from there rebuilds BOOK.address and
// re-checks the ZIP, so an edit always sticks and can never book an out-of-area
// or mispriced address.
function editAddressOnStep3() {
  goToStep(3);
  setTimeout(function() {
    var card = document.querySelector('#step-3 .address-card');
    var st = document.getElementById('s3-street');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (st) { try { st.focus({ preventScroll: true }); } catch (e) {} }
  }, 140);
}



function saveContactEdit() {

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var first = (document.getElementById('s5-c-first').value || '').trim();

  var last  = (document.getElementById('s5-c-last').value  || '').trim();

  var email = (document.getElementById('s5-c-email').value || '').trim();

  var phone = (document.getElementById('s5-c-phone').value || '').trim();

  if (!first || !last || !EMAIL_RE.test(email) || !isValidUsPhone(phone)) {
    var contactErr = document.getElementById('s5-err');
    if (contactErr) {
      contactErr.textContent = !isValidUsPhone(phone)
        ? 'Enter a valid 10-digit US phone number.'
        : 'Complete each contact field and enter a valid email.';
      contactErr.classList.add('show');
    }
    return;
  }

  var contactErr = document.getElementById('s5-err');
  if (contactErr) contactErr.classList.remove('show');

  phone = formatUsPhoneForDisplay(phone);

  BOOK.firstName = first; BOOK.lastName = last; BOOK.email = email; BOOK.phone = phone;

  var valEl = document.getElementById('s5-contact-val');

  if (valEl) valEl.innerHTML = renderSummaryContact(first, last, email, phone);

  // sync step 4 fields

  ['s4-first','s4-last','s4-email','s4-phone'].forEach(function(id, i){

    var el = document.getElementById(id);

    if (el) el.value = [first,last,email,phone][i];

  });

  toggleS5Edit('contact');
  refreshPromoPreview({ silentFailure: true });

}



// ----------------------------------------------------------------------------

// PRE-SELECT FROM URL PARAM

// ----------------------------------------------------------------------------

// -- ADDRESS AUTOCOMPLETE (OpenStreetMap/Nominatim) ---------------------------

(function initAddressAutocomplete() {

  var input = document.getElementById('s3-street');

  var dropdown = document.getElementById('s3-addr-dropdown');

  if (!input || !dropdown) return;

  var debounce;
  var cache = {};
  var lastLookupAt = 0;
  var lookupToken = 0;

  function hideDropdown() { dropdown.style.display = 'none'; }

  function txState(value) {
    var v = String(value || '').trim();
    return v.toLowerCase() === 'texas' ? 'TX' : (v || 'TX');
  }

  function normalizedNominatimResults(results) {
    return (results || []).map(function(r) {
      var a = r.address || {};
      var street = [a.house_number, a.road].filter(Boolean).join(' ').trim();
      if (!street) return null;
      var city = a.city || a.town || a.village || a.suburb || '';
      var state = txState(a.state_code || a.state);
      var zip = String(a.postcode || '').slice(0, 5);
      var label = [street, city, state + (zip ? ' ' + zip : '')].filter(Boolean).join(', ');
      return { street: street, city: city, state: state, zip: zip, label: label };
    }).filter(Boolean).slice(0, 5);
  }

  function normalizedSuggestionResults(results) {
    return (results || []).map(function(r) {
      var street = String(r.street || '').trim();
      if (!street) return null;
      var city = r.city || '';
      var state = txState(r.state || 'TX');
      var zip = String(r.zip || '').slice(0, 5);
      var label = r.label || [street, city, state + (zip ? ' ' + zip : '')].filter(Boolean).join(', ');
      return { street: street, city: city, state: state, zip: zip, label: label };
    }).filter(Boolean).slice(0, 5);
  }

  function renderSuggestions(items) {
    if (!items.length) { hideDropdown(); return; }

    dropdown.innerHTML = items.map(function(item) {
      return '<div role="option" data-street="' + escAttr(item.street) + '" data-city="' + escAttr(item.city) + '" data-state="' + escAttr(item.state) + '" data-zip="' + escAttr(item.zip) + '" style="padding:0.6rem 1rem;cursor:pointer;font-size:0.875rem;border-bottom:1px solid #f3f4f6;transition:background 0.1s" onmouseenter="this.style.background=\'#e0f7fa\'" onmouseleave="this.style.background=\'#fff\'">' + esc(item.label) + '</div>';
    }).join('');

    dropdown.querySelectorAll('[role="option"]').forEach(function(opt) {
      opt.addEventListener('mousedown', function(ev) {
        ev.preventDefault();
        input.value = opt.dataset.street || input.value;

        var cityEl = document.getElementById('s3-city');
        var stateEl = document.getElementById('s3-state');
        var zipEl = document.getElementById('s3-zip');

        if (opt.dataset.city && cityEl) cityEl.value = opt.dataset.city;
        if (opt.dataset.state && stateEl) stateEl.value = opt.dataset.state;
        if (opt.dataset.zip && zipEl) {
          zipEl.value = opt.dataset.zip;
          checkServiceZip(opt.dataset.zip);
        }

        hideDropdown();
      });
    });

    dropdown.style.display = 'block';
  }

  function lookupAddress(q) {
    var key = q.toLowerCase();
    var token = ++lookupToken;

    if (cache[key]) { renderSuggestions(cache[key]); return; }

    lastLookupAt = Date.now();

    fetch('/api/address/autocomplete?q=' + encodeURIComponent(q))
      .then(function(r) {
        if (!r.ok) throw new Error('Geoapify unavailable');
        return r.json();
      })
      .then(function(data) {
        if (token !== lookupToken) return;
        cache[key] = normalizedSuggestionResults(data.suggestions);
        if (!cache[key].length) throw new Error('No Geoapify suggestions');
        renderSuggestions(cache[key]);
      })
      .catch(function() { lookupOpenStreetMapAddress(q, key, token); });
  }

  function lookupOpenStreetMapAddress(q, key, token) {
    var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=us&addressdetails=1&limit=5&viewbox=-106.65,36.50,-93.51,25.84&bounded=1&q=' + encodeURIComponent(q + ', TX');

    fetch(url)
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(results) {
        if (token !== lookupToken) return;
        cache[key] = normalizedNominatimResults(results);
        renderSuggestions(cache[key]);
      })
      .catch(hideDropdown);
  }

  input.addEventListener('input', function() {
    clearTimeout(debounce);

    var q = input.value.trim();

    if (q.length < 5) { hideDropdown(); return; }

    debounce = setTimeout(function() {
      var wait = Math.max(0, 1200 - (Date.now() - lastLookupAt));
      debounce = setTimeout(function() { lookupAddress(q); }, wait);
    }, 700);
  });

  input.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape') hideDropdown();
  });

  input.addEventListener('blur', function() { setTimeout(hideDropdown, 200); });

})();



// -- PHONE AUTO-FORMAT + WRAPPER FOCUS STATE -----------------------------------

(function initPhoneFormat() {

  var ph = document.getElementById('s4-phone');

  var wrap = document.getElementById('s4-phone-wrap');

  if (!ph) return;

  ph.addEventListener('focus', function() { if (wrap) wrap.style.borderColor = 'var(--teal)'; });

  ph.addEventListener('blur',  function() { if (wrap) wrap.style.borderColor = ''; });

  ph.addEventListener('input', function() {

    var pos = this.selectionStart;

    var old = this.value.length;

    var d = this.value.replace(/\D/g, '');

    if (d.length > 10 && d.charAt(0) === '1') d = d.slice(1);

    d = d.substring(0, 10);

    if (d.length > 6)      this.value = d.slice(0,3) + '-' + d.slice(3,6) + '-' + d.slice(6);

    else if (d.length > 3) this.value = d.slice(0,3) + '-' + d.slice(3);

    else                   this.value = d;

    var diff = this.value.length - old;

    this.setSelectionRange(pos + diff, pos + diff);

  });

})();



(function preSelect() {

  var params = new URLSearchParams(window.location.search);

  var svc = params.get('service') || params.get('s') || '';
  var itemParam = String(params.get('item') || '').trim();
  BOOK.promoCode = String(params.get('promo') || '').trim().toUpperCase();

  // Room-Ready bundle deep-link (/book?bundle=<slug>): pre-add the bundle's
  // catalog items across services. Prices/flags come straight from the catalog,
  // so the existing engine totals it exactly like hand-picked items.
  var bundleSlug = String(params.get('bundle') || '').trim().toLowerCase();
  if (bundleSlug) {
    var bundleList = AAE_BOOKING_SOURCE.bundles || [];
    var bundle = bundleList.find(function(b) { return b.slug === bundleSlug && b.active !== false; });
    if (bundle) {
      BOOK.bundleSlug = bundle.slug;
      if (!BOOK.selectedServices) BOOK.selectedServices = [];
      var bundleAdded = false;
      (bundle.included || []).forEach(function(ref) {
        var item = findCatalogItem(ref.service, ref.name);
        if (!item) return;
        if (BOOK.selectedServices.indexOf(ref.service) === -1) BOOK.selectedServices.push(ref.service);
        if (!BOOK.selectedItems[ref.service]) BOOK.selectedItems[ref.service] = [];
        var exists = BOOK.selectedItems[ref.service].some(function(i) { return i.name === ref.name; });
        if (!exists) {
          BOOK.selectedItems[ref.service].push({ name: item.name, price: item.price, priceMax: item.priceMax, addon: !!item.addon, customQuote: !!item.customQuote, qty: 1 });
          bundleAdded = true;
        }
      });
      if (bundleAdded) {
        var leadService = getBundleLeadService(bundle) || BOOK.selectedServices[0];
        if (leadService) {
          showItemScreen(leadService, 'items');
          return;
        }
        showSvcScreen();
        return;
      }
    }
  }

  if (!svc) return;

  var resolvedSvc = resolveServiceSelection(svc);

  if (resolvedSvc === 'Other') {
    startCustomQuoteFlow();
    return;
  }

  if (!resolvedSvc) return;

  if (itemParam) {
    openQuickPick(resolvedSvc, itemParam);
    return;
  }

  showItemScreen(resolvedSvc);

})();

(function initPromoField() {
  var promoInput = document.getElementById('s5-promo-code');
  applyPromoUiState();
  if (!promoInput) {
    loadPromoConfig();
    return;
  }

  if (BOOK.promoCode) promoInput.value = BOOK.promoCode;

  promoInput.addEventListener('input', function() {
    this.value = this.value.toUpperCase().replace(/\s+/g, '');
    BOOK.promoCode = this.value;
    BOOK._promoPreview = null;
    renderStep5OrderTotal();
    setPromoStatus(getPromoStatusMessage('', BOOK.promoCode), '');
  });

  promoInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyPromoCode();
    }
  });

  loadPromoConfig();
})();



// ----------------------------------------------------------------------------

// DATE/TIME PICKER

// ----------------------------------------------------------------------------

(function initCal() {

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  var DAYS_SHORT = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  var todayIso = getChicagoTodayIso();

  var maxIso = addIsoDays(todayIso, BOOKING_WINDOW_DAYS);

  var todayParts = chicagoDateParts(new Date());

  var curMonth = parseInt(todayParts.month, 10) - 1, curYear = parseInt(todayParts.year, 10);

  var firstMonthKey = curYear * 12 + curMonth;

  var maxParts = maxIso.split('-');

  var lastMonthKey = parseInt(maxParts[0], 10) * 12 + parseInt(maxParts[1], 10) - 1;

  function pad(n) { return n < 10 ? '0'+n : n; }



  function renderCal() {

    var titleEl = document.getElementById('dt-cal-title');

    var gridEl  = document.getElementById('dt-cal-grid');

    if (!titleEl || !gridEl) return;

    titleEl.textContent = MONTHS[curMonth] + ' ' + curYear;

    var visibleMonthKey = curYear * 12 + curMonth;

    var prevButton = document.getElementById('dt-prev');

    var nextButton = document.getElementById('dt-next');

    if (prevButton) prevButton.disabled = visibleMonthKey <= firstMonthKey;

    if (nextButton) nextButton.disabled = visibleMonthKey >= lastMonthKey;

    var firstDay = new Date(Date.UTC(curYear, curMonth, 1, 12)).getUTCDay();

    var daysInMonth = new Date(Date.UTC(curYear, curMonth+1, 0, 12)).getUTCDate();

    var html = DAYS_SHORT.map(function(d){ return '<div class="dt-dow">'+d+'</div>'; }).join('');

    for (var i=0;i<firstDay;i++) html+='<div class="dt-day empty"></div>';

    for (var d=1;d<=daysInMonth;d++) {

      var dateStr = curYear+'-'+pad(curMonth+1)+'-'+pad(d);

      var disabled = dateStr < todayIso || dateStr > maxIso;

      var cls = 'dt-day' + (dateStr === todayIso ? ' today' : '') + (BOOK.date === dateStr ? ' selected' : '');

      html += '<button type="button" class="'+cls+'"'+(disabled ? ' disabled' : '')+' data-date="'+dateStr+'">'+d+'</button>';

    }

    gridEl.innerHTML = html;

    gridEl.querySelectorAll('.dt-day:not([disabled]):not(.empty)').forEach(function(btn) {

      btn.addEventListener('click', function() {

        BOOK.date = this.dataset.date; BOOK.time = '';

        renderCal(); renderTimes(); hideErr('s3-date-err'); var tw=document.getElementById('dt-times-wrap'); if(tw) setTimeout(function(){ tw.scrollIntoView({behavior:'smooth',block:'center'}); }, 100);

      });

    });

  }



  function renderTimes() {

    var wrap = document.getElementById('dt-times-wrap');

    var timesEl = document.getElementById('dt-times');

    if (!BOOK.date) { wrap.style.display='none'; return; }

    wrap.style.display='block';

    // Match the server's America/Chicago booking window and published hours.

    timesEl.innerHTML = TIME_SLOTS.map(function(slot) {

      var disabled = !isPublishedSlotAvailable(BOOK.date, slot);

      if (disabled) {

        if (BOOK.time === slot) BOOK.time = '';

        return '<button type="button" class="dt-time-btn" data-time="'+slot+'" disabled style="opacity:0.35;cursor:not-allowed;text-decoration:line-through">'+slot+'</button>';

      }

      return '<button type="button" class="dt-time-btn'+(BOOK.time===slot ? ' selected' : '')+'" data-time="'+slot+'">'+slot+'</button>';

    }).join('');

    timesEl.querySelectorAll('.dt-time-btn:not([disabled])').forEach(function(btn) {

      btn.addEventListener('click', function() { BOOK.time=this.dataset.time; renderTimes(); hideErr('s3-time-err'); setTimeout(function(){ var st=document.getElementById('s3-street'); var city=document.getElementById('s3-city'); var zip=document.getElementById('s3-zip'); var addressDone=st&&st.value.trim()&&city&&city.value.trim()&&zip&&zip.value.trim(); if(addressDone){ var act=document.querySelector('#step-3 .step-actions'); if(act) act.scrollIntoView({behavior:'smooth',block:'center'}); } else if(st){ var card=st.closest('.address-card')||st; card.scrollIntoView({behavior:'smooth',block:'start'}); } }, 120); });

    });

    // Auto-select first available if none chosen yet

    if (!BOOK.time) {

      var firstAvail = timesEl.querySelector('.dt-time-btn:not([disabled])');

      if (firstAvail) { BOOK.time = firstAvail.dataset.time; firstAvail.classList.add('selected'); }

    }

    // Mark first available slot with "Recommended" badge

    var firstRec = timesEl.querySelector('.dt-time-btn:not([disabled])');

    if (firstRec) { firstRec.innerHTML += '<span class="slot-rec">Earliest available</span>'; }

  }



  document.getElementById('dt-prev').addEventListener('click', function() { curMonth--; if(curMonth<0){curMonth=11;curYear--;} renderCal(); });

  document.getElementById('dt-next').addEventListener('click', function() { curMonth++; if(curMonth>11){curMonth=0;curYear++;} renderCal(); });

  renderCal(); renderTimes();

})();



// ----------------------------------------------------------------------------

// STRIPE

// ----------------------------------------------------------------------------

var stripeJsPromise = null;

function loadStripeJs() {

  if (typeof Stripe !== 'undefined') return Promise.resolve();

  if (stripeJsPromise) return stripeJsPromise;

  stripeJsPromise = new Promise(function(resolve, reject) {

    var existing = document.querySelector('script[src="https://js.stripe.com/v3/"]');
    var script = existing;

    function handleLoad() {
      if (typeof Stripe !== 'undefined') resolve();
      else handleError();
    }

    function handleError() {
      if (script && script.parentNode) script.parentNode.removeChild(script);
      reject(new Error('Stripe.js could not be loaded'));
    }

    if (existing) {
      existing.addEventListener('load', handleLoad, { once: true });
      existing.addEventListener('error', handleError, { once: true });
      return;
    }

    script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });
    document.head.appendChild(script);

  }).catch(function(error) {
    stripeJsPromise = null;
    throw error;
  });

  return stripeJsPromise;

}

function showStripeLoadError() {

  var wrap = document.getElementById('stripe-card-wrap');
  if (!wrap) return;

  wrap.setAttribute('aria-busy', 'false');
  wrap.innerHTML = '<div role="alert" style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;font-size:0.82rem;color:var(--red)"><span>Secure card entry could not load.</span><button type="button" class="summary-addr-save" onclick="retryStripeCheckout()">Try again</button></div>';

}

function syncPaymentSubmitState() {

  var submitBtn = document.getElementById('s5-submit');
  if (!submitBtn || BOOK.isEmergingMarket) return;
  if (BOOK._isQuoteFlow) {
    submitBtn.disabled = false;
    submitBtn.innerHTML = 'Send Quote Request <span>&#8594;</span>';
    return;
  }

  var paymentFormReady = !!BOOK._stripe && !!BOOK._cardEl;
  var usesSetupIntent = !!BOOK._isQuoteFlow || !!BOOK._scheduledAuthorization;
  var usesKlarna = !usesSetupIntent && BOOK.paymentMethod === 'klarna';
  var setupReady = !usesSetupIntent || !!BOOK._setupIntentSecret;
  var canSubmit = paymentFormReady && setupReady && (usesKlarna || !!BOOK._cardComplete);

  submitBtn.disabled = !canSubmit;

  if (!paymentFormReady || !setupReady) {
    submitBtn.textContent = 'Preparing secure checkout...';
  } else if (!usesKlarna && !BOOK._cardComplete) {
    submitBtn.textContent = 'Enter card details to continue';
  } else if (usesKlarna) {
    submitBtn.innerHTML = 'Continue with Klarna <span>&#8594;</span>';
  } else {
    submitBtn.innerHTML = BOOK._isQuoteFlow
      ? 'Request Custom Quote <span>&#8594;</span>'
      : (BOOK._scheduledAuthorization
        ? 'Reserve Appointment <span>&#8594;</span>'
        : 'Complete Booking <span>&#8594;</span>');
  }

}

function klarnaAvailableForCurrentBooking() {
  var config = (window.AAE_BOOKING_SOURCE && window.AAE_BOOKING_SOURCE.klarna) || {};
  return !!config.enabled
    && !BOOK._isQuoteFlow
    && !BOOK._scheduledAuthorization
    && BOOK.accountMode !== 'business'
    && Number(BOOK._grandTotalCents || 0) > 0;
}

function renderBookingPaymentMethods() {
  var picker = document.getElementById('payment-method-picker');
  var bookingNotice = document.getElementById('klarna-booking-availability');
  var eligibilityNote = document.getElementById('klarna-eligibility-note');
  var cardWrap = document.getElementById('stripe-card-wrap');
  var cardLabel = document.getElementById('card-details-label');
  var klarnaNote = document.getElementById('klarna-payment-note');
  var klarnaEnabled = !!((window.AAE_BOOKING_SOURCE && window.AAE_BOOKING_SOURCE.klarna) || {}).enabled;
  var available = klarnaAvailableForCurrentBooking();
  if (!available) BOOK.paymentMethod = 'card';
  if (bookingNotice) bookingNotice.style.display = klarnaEnabled ? 'flex' : 'none';
  if (picker) picker.style.display = available ? 'grid' : 'none';
  if (eligibilityNote) {
    var reason = '';
    if (klarnaEnabled && BOOK._isQuoteFlow) reason = 'Klarna is not available for custom quote requests.';
    else if (klarnaEnabled && BOOK._scheduledAuthorization) reason = 'Klarna is currently available for appointments within six days. Card is available for this appointment.';
    else if (klarnaEnabled && BOOK.accountMode === 'business') reason = 'Klarna is not available for business bookings. Card is available.';
    eligibilityNote.textContent = reason;
    eligibilityNote.style.display = reason ? 'block' : 'none';
  }
  var usesKlarna = available && BOOK.paymentMethod === 'klarna';
  if (cardWrap) cardWrap.style.display = usesKlarna ? 'none' : '';
  if (cardLabel) cardLabel.style.display = usesKlarna ? 'none' : '';
  if (klarnaNote) klarnaNote.style.display = usesKlarna ? 'block' : 'none';
  document.querySelectorAll('[data-payment-method]').forEach(function(button) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-payment-method') === BOOK.paymentMethod));
  });
  if (available && BOOK._elements && !BOOK._klarnaMessageEl) mountKlarnaMessaging(BOOK._elements);
  syncPaymentSubmitState();
}

function selectBookingPaymentMethod(method) {
  if (method !== 'card' && method !== 'klarna') return;
  if (method === 'klarna' && !klarnaAvailableForCurrentBooking()) return;
  BOOK.paymentMethod = method;
  BOOK._pendingPayment = null;
  renderBookingPaymentMethods();
}

function mountKlarnaMessaging(elements) {
  var target = document.getElementById('klarna-payment-message');
  if (!target || !klarnaAvailableForCurrentBooking() || !elements) return;
  if (BOOK._klarnaMessageEl) {
    try { BOOK._klarnaMessageEl.destroy(); } catch (e) {}
    BOOK._klarnaMessageEl = null;
  }
  target.innerHTML = '';
  try {
    BOOK._klarnaMessageEl = elements.create('paymentMethodMessaging', {
      amount: Number(BOOK._grandTotalCents || 0),
      currency: 'USD',
      paymentMethodTypes: ['klarna']
    });
    BOOK._klarnaMessageEl.mount('#klarna-payment-message');
  } catch (e) {
    target.textContent = 'Klarna payment options are shown after you continue. Eligibility is determined by Klarna.';
  }
}

async function retryStripeCheckout() {

  var wrap = document.getElementById('stripe-card-wrap');
  var submitBtn = document.getElementById('s5-submit');

  if (BOOK._cardEl) { try { BOOK._cardEl.destroy(); } catch(e){} }
  BOOK._cardEl = null;
  BOOK._stripe = null;
  BOOK._cardComplete = false;

  if (submitBtn) syncPaymentSubmitState();
  if (wrap) {
    wrap.setAttribute('aria-busy', 'true');
    wrap.innerHTML = '<div class="payment-loader" id="payment-loader" role="status">Preparing secure card entry</div><div id="stripe-card-element"></div>';
  }

  await goToStep5Payment();

}

async function initStripe() {

  if (BOOK._stripe && BOOK._cardEl) return true;

  if (BOOK._stripeInitPromise) return BOOK._stripeInitPromise;

  BOOK._stripeInitPromise = initializeStripe();

  try {
    return await BOOK._stripeInitPromise;
  } finally {
    BOOK._stripeInitPromise = null;
  }

}

async function initializeStripe() {

  if (BOOK._stripe && BOOK._cardEl) return true;

  try {

    await loadStripeJs();

    var r = await fetch('/api/config/public-key');

    if (!r.ok) throw new Error('Could not load payment config');

    var d = await r.json();

    if (!d.publishableKey) throw new Error('No publishable key returned');

    BOOK._stripe = Stripe(d.publishableKey);

    var elements = BOOK._stripe.elements();
    BOOK._elements = elements;

    if (BOOK._cardEl) { try { BOOK._cardEl.destroy(); } catch(e){} }

    BOOK._cardEl = elements.create('card', {

      style: { base: { fontSize:'16px', color:'#0d1117', fontFamily:'"DM Sans", sans-serif', '::placeholder':{ color:'#9ca3af' } }, invalid: { color:'#ef4444' } },

      hidePostalCode: false

    });

    BOOK._cardEl.mount('#stripe-card-element');

    mountKlarnaMessaging(elements);

    var paymentLoader = document.getElementById('payment-loader');
    if (paymentLoader) paymentLoader.remove();
    document.getElementById('stripe-card-wrap').setAttribute('aria-busy', 'false');
    syncPaymentSubmitState();
    renderBookingPaymentMethods();

    BOOK._cardEl.on('focus', function() {
      document.getElementById('stripe-card-wrap').classList.add('focused');
      setMobileStepActionsHidden(true);
    });

    BOOK._cardEl.on('blur',  function() {
      document.getElementById('stripe-card-wrap').classList.remove('focused');
      window.setTimeout(syncMobileStepActionsForKeyboard, 60);
    });

    BOOK._cardEl.on('change', function(evt) {

      BOOK._cardComplete = !!evt.complete;

      document.getElementById('stripe-card-wrap').classList.toggle('invalid', !!evt.error);

      document.getElementById('card-errors').textContent = evt.error ? evt.error.message : '';

      syncPaymentSubmitState();

    });

    return true;

  } catch(e) {

    console.error('Stripe init error:', e);

    showStripeLoadError();

    document.getElementById('s5-submit').disabled = true;

    return false;

  }

}



// ----------------------------------------------------------------------------

// SUBMIT

// ----------------------------------------------------------------------------

function buildItemsPayload() {

  var itemsPayload = {};

  BOOK.selectedServices.forEach(function(svc) {

    itemsPayload[svc] = (BOOK.selectedItems[svc]||[]).map(function(i){
      return {
        name: i.name,
        price: i.price,
        priceMax: i.priceMax || 0,
        qty: i.qty,
        addon: !!i.addon,
        customQuote: !!i.customQuote,
        group: findItemGroup(svc, i.name)
      };
    });

  });

  return itemsPayload;

}

async function submitBooking() {

  var submitBtn = document.getElementById('s5-submit');

  var backBtn   = document.getElementById('s5-back');

  var errEl     = document.getElementById('s5-err');

  errEl.classList.remove('show'); errEl.textContent = '';

  if (BOOK.isEmergingMarket) {
    await submitMarketDemand();
    return;
  }

  var legalConfig;
  try {
    var legalResp = await fetch('/api/legal-config', { headers: { 'Accept': 'application/json' } });
    legalConfig = await legalResp.json();
    if (!legalResp.ok || !legalConfig.customerTermsVersion || !legalConfig.privacyNoticeVersion) throw new Error();
  } catch (e) {
    errEl.textContent = 'The current Terms could not be verified. Please refresh and try again.';
    errEl.classList.add('show');
    return;
  }

  var policyMessage = getOnlineBookingPolicyMessage();
  if (policyMessage) {
    errEl.textContent = policyMessage;
    errEl.classList.add('show');
    return;
  }



  if (!BOOK._isQuoteFlow && (!BOOK._stripe || !BOOK._cardEl)) {

    errEl.textContent = 'Payment form not ready. Please refresh and try again.';

    errEl.classList.add('show'); return;

  }

  var usesKlarna = !BOOK._isQuoteFlow && !BOOK._scheduledAuthorization && BOOK.paymentMethod === 'klarna';

  if (!BOOK._isQuoteFlow && !usesKlarna && !BOOK._cardComplete) {

    errEl.textContent = 'Complete your card details before continuing.';

    errEl.classList.add('show'); return;

  }

  if (BOOK._scheduledAuthorization && !BOOK._setupIntentSecret) {

    errEl.textContent = 'Payment setup failed. Please refresh and try again.';

    errEl.classList.add('show'); return;

  }



  submitBtn.disabled = true; backBtn.disabled = true;

  submitBtn.innerHTML = 'Sending&hellip;';



  // Use tax-inclusive total calculated when Step 5 was rendered

  var totalCents = BOOK._grandTotalCents || 0;



  var itemsPayload = buildItemsPayload();



  var savedSetupIntentId = null;

  if (BOOK._scheduledAuthorization && BOOK._setupIntentSecret) {

    submitBtn.innerHTML = 'Saving card&hellip;';

    var setupResult = await BOOK._stripe.confirmCardSetup(BOOK._setupIntentSecret, {
      payment_method: {
        card: BOOK._cardEl,
        billing_details: {
          name: BOOK.firstName + ' ' + BOOK.lastName,
          email: BOOK.email,
          phone: BOOK.phone || undefined
        }
      }
    });

    if (setupResult.error) {
      errEl.textContent = setupResult.error.message;
      errEl.classList.add('show');
      submitBtn.disabled=false; backBtn.disabled=false;
      submitBtn.innerHTML = BOOK._isQuoteFlow
        ? 'Request Custom Quote <span>&#8594;</span>'
        : 'Reserve Appointment <span>&#8594;</span>';
      return;
    }

    savedSetupIntentId = setupResult.setupIntent.id;

    submitBtn.innerHTML = 'Submitting request&hellip;';

  }

  // A declined card does not undo the booking /api/booking already created. It
  // stays on the server as pending+unpaid, so re-POSTing on the retry mints a
  // second one — three declines used to leave three pending bookings, three
  // references, and three cancellation emails when the owner cleaned them up.
  // Stripe puts a declined PaymentIntent back into requires_payment_method and
  // its client secret stays valid, so as long as the order has not changed we
  // reuse the booking and intent we already hold instead of making new ones.
  var orderFingerprint = JSON.stringify({
    services: BOOK.selectedServices,
    items: itemsPayload,
    email: BOOK.email,
    address: BOOK.address,
    zip: BOOK.zip,
    date: BOOK.date,
    time: BOOK.time,
    totalCents: totalCents,
    promoCode: BOOK.promoCode || '',
    assemblecashToken: BOOK.assemblecashToken || '',
    bundleSlug: BOOK.bundleSlug || '',
    paymentMethod: BOOK.paymentMethod,
    smsConsent: !!(document.getElementById('s4-sms-consent') || {}).checked
  });

  var reusablePayment = (BOOK._pendingPayment && BOOK._pendingPayment.fingerprint === orderFingerprint)
    ? BOOK._pendingPayment.data
    : null;

  var data;

  if (reusablePayment) {

    data = reusablePayment;

  } else try {

    var resp = await fetch('/api/booking', {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({

        services: BOOK.selectedServices,

        items: itemsPayload,

        name: BOOK.firstName + ' ' + BOOK.lastName,

        phone: BOOK.phone, email: BOOK.email, address: BOOK.address,
        city: BOOK.city, state: BOOK.state, zip: BOOK.zip,

        date: BOOK.date, time: BOOK.time, details: BOOK.details,

        totalCents: totalCents, accountMode: BOOK.accountMode,

        paymentMethod: BOOK.paymentMethod,

        discountPct: BOOK._discountPct || 0,

        discountAmount: BOOK._discountAmount || 0,

        promoCode: BOOK.promoCode || '',

        promoPreviewApplied: !!BOOK._promoApplied,

        promoPreviewTotalCents: BOOK._grandTotalCents || 0,

        assemblecashToken: BOOK.assemblecashToken || '',

        bundleSlug: BOOK.bundleSlug || '',

        isQuoteRequest: BOOK._isQuoteFlow || false,

        // Submitting is the agreement; the notice beside the button says so.
        termsAccepted: true,
        termsConsentMethod: 'web_book_button_notice',

        termsVersion: legalConfig.customerTermsVersion,

        privacyNoticeVersion: legalConfig.privacyNoticeVersion,

        smsConsent: !!(document.getElementById('s4-sms-consent') || {}).checked,

        setupIntentId: BOOK._scheduledAuthorization ? savedSetupIntentId : null,
        formStartedAt: BOOK._formStartedAt || null,
        attribution: captureBookingAttribution()

      })

    });

    data = await resp.json();

    if (!resp.ok) {
      if (resp.status === 409 && data.code === 'PROMO_CHANGED' && data.promo && data.pricing) {
        BOOK._promoPreview = {
          promo: data.promo,
          pricing: {
            itemSubtotalCents: data.pricing.itemSubtotalCents || getLocalPricingPreview(getPricingSnapshot(BOOK.zip)).itemSubtotalCents,
            bundleDiscountCents: data.pricing.bundleDiscountCents || 0,
            serviceCallFeeCents: data.pricing.serviceCallFeeCents || 0,
            taxCents: data.pricing.taxCents || 0,
            totalCents: data.pricing.totalCents || 0
          }
        };
        renderStep5OrderTotal();
        setPromoStatus(getPromoStatusMessage(data.promo.reason, BOOK.promoCode || data.promo.enteredCode || ''), 'warning');
      }
      if (resp.status === 409 && data.code === 'ASSEMBLECASH_CHANGED' && data.pricing) {
        BOOK._promoPreview = {
          promo: data.promo || null,
          assemblecash: data.assemblecash || null,
          pricing: {
            itemSubtotalCents: data.pricing.itemSubtotalCents || getLocalPricingPreview(getPricingSnapshot(BOOK.zip)).itemSubtotalCents,
            bundleDiscountCents: data.pricing.bundleDiscountCents || 0,
            promoDiscountCents: data.pricing.promoDiscountCents || 0,
            serviceCallFeeCents: data.pricing.serviceCallFeeCents || 0,
            taxCents: data.pricing.taxCents || 0,
            totalCents: data.pricing.totalCents || 0
          }
        };
        renderStep5OrderTotal();
        var acMsg = document.getElementById('s5-ac-status');
        if (acMsg) {
          var applied = Math.max(0, Number((data.assemblecash && data.assemblecash.appliedCents) || 0));
          acMsg.style.color = applied > 0 ? '#92400e' : '#b91c1c';
          acMsg.textContent = applied > 0
            ? 'Your available AssembleCash changed. We refreshed the total with up to ' + dollars(applied / 100) + ' applied.'
            : 'Your AssembleCash balance changed and is no longer available for this booking.';
        }
      }
      throw new Error(data.error || 'Server error. Please try again.');
    }

    BOOK._analytics = data.analytics || {};
    // Hold the created booking so a card retry reuses it instead of creating another.
    BOOK._pendingPayment = { fingerprint: orderFingerprint, data: data };

  } catch(e) {

    errEl.textContent = e.message; errEl.classList.add('show');

    submitBtn.disabled=false; backBtn.disabled=false;

    submitBtn.innerHTML = 'Complete Booking <span>&#8594;</span>'; return;

  }



  if (data.clientSecret) {

    submitBtn.innerHTML = 'Processing payment&hellip;';

    BOOK._guestMutationToken = data.guestMutationToken || '';
    sessionStorage.setItem('aaePaymentRecovery', JSON.stringify({
      bookingId: data.bookingId,
      ref: data.ref,
      guestMutationToken: data.guestMutationToken || '',
      email: BOOK.email,
      date: BOOK.date,
      time: BOOK.time,
      address: BOOK.address,
      selectedServices: BOOK.selectedServices,
      analytics: BOOK._analytics || {},
      isQuote: false
    }));

    var result = data.paymentMethodType === 'klarna'
      ? await BOOK._stripe.confirmKlarnaPayment(data.clientSecret, {

        payment_method: {

          billing_details: {

            name: BOOK.firstName + ' ' + BOOK.lastName,

            email: BOOK.email,

            phone: BOOK.phone || undefined,

            address: {

              line1: BOOK.address,

              city: BOOK.city,

              state: 'TX',

              postal_code: BOOK.zip,

              country: 'US'

            }

          }

        },

        return_url: window.location.origin + '/book?payment_return=1&payment_method=klarna'

      })
      : await BOOK._stripe.confirmCardPayment(data.clientSecret, {

      payment_method: {

        card: BOOK._cardEl,

        billing_details: {

          name: BOOK.firstName + ' ' + BOOK.lastName,

          email: BOOK.email,

          phone: BOOK.phone || undefined

        }

      },

      return_url: window.location.origin + '/book?payment_return=1'

    });

    if (result.error) {

      errEl.textContent = result.error.message; errEl.classList.add('show');

      submitBtn.disabled=false; backBtn.disabled=false;

      submitBtn.innerHTML = 'Complete Booking <span>&#8594;</span>'; return;

    }

    try {
      var confirmResp = await fetch('/api/booking-confirmed', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({bookingId:data.bookingId,guestMutationToken:data.guestMutationToken}) });
      var confirmData = await confirmResp.json();
      if (!confirmResp.ok) throw new Error(confirmData.error || 'Payment was authorized, but the booking is still being confirmed.');
      sessionStorage.removeItem('aaePaymentRecovery');
      BOOK._pendingPayment = null;
    } catch(e) {
      console.error('booking-confirmed error:', e);
      showConfirmationPending(data.ref, e.message);
      return;
    }

  }

  BOOK._guestMutationToken = data.guestMutationToken || BOOK._guestMutationToken || '';
  showConfirmation(data.ref, BOOK._isQuoteFlow, !!data.scheduledAuthorization);

}

async function submitMarketDemand() {

  var submitBtn = document.getElementById('s5-submit');
  var backBtn   = document.getElementById('s5-back');
  var errEl     = document.getElementById('s5-err');

  submitBtn.disabled = true;
  backBtn.disabled = true;
  submitBtn.innerHTML = 'Saving request&hellip;';

  try {
    var resp = await fetch('/api/market-demand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        services: BOOK.selectedServices,
        items: buildItemsPayload(),
        requestedService: formatSelectedServices(', '),
        name: BOOK.firstName + ' ' + BOOK.lastName,
        phone: BOOK.phone,
        email: BOOK.email,
        address: BOOK.address,
        city: BOOK.city,
        state: BOOK.state,
        zip: BOOK.zip,
        date: BOOK.date,
        time: BOOK.time,
        details: BOOK.details,
        totalCents: BOOK._grandTotalCents || 0,
        source: 'booking_out_of_market',
        company: (document.getElementById('bk-company') || {}).value || ''
      })
    });

    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not save your request. Please try again.');

    showMarketDemandConfirmation(data.requestRef);

  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.add('show');
    submitBtn.disabled = false;
    backBtn.disabled = false;
    submitBtn.innerHTML = 'Submit Service Request <span>&#8594;</span>';
  }

}

function showMarketDemandConfirmation(ref) {

  for (var i=1;i<=TOTAL_STEPS;i++) { var p=document.getElementById('step-'+i); if(p) p.classList.add('hidden'); }

  document.getElementById('step-confirm').classList.remove('hidden');
  syncBookingChrome(true);

  var title = document.querySelector('#step-confirm .confirm-title');
  if (title) title.textContent = 'Request received';

  var refEl = document.getElementById('confirm-ref');
  if (ref) refEl.textContent = 'Request: ' + ref; else refEl.style.display = 'none';

  var svcEl = document.getElementById('confirm-services');
  if (svcEl) {
    svcEl.textContent = BOOK.selectedServices.indexOf('Other') !== -1
      ? 'Custom Quote'
      : (formatSelectedServices(' / ') || 'Your services');
  }

  var dtEl = document.getElementById('confirm-datetime');
  if (dtEl) {
    var summaryDate = BOOK.date ? new Date(BOOK.date + 'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) : 'Date requested';
    dtEl.textContent = summaryDate + (BOOK.time ? ' at ' + BOOK.time : '');
  }

  var addrEl = document.getElementById('confirm-address');
  if (addrEl) addrEl.textContent = BOOK.city + ', ' + BOOK.state + ' ' + BOOK.zip;

  var stepsEl = document.getElementById('confirm-next-steps');
  if (stepsEl) {
    stepsEl.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">1</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">Demand recorded</strong> - your request is now counted for this market.</div></div>'
      + '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">2</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">No payment collected</strong> - this is not a confirmed booking or guaranteed appointment.</div></div>'
      + '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">3</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">We will reach out</strong> - if coverage becomes available, we will contact you before scheduling or charging anything.</div></div>';
  }

  var portal = document.getElementById('confirm-portal-link');
  if (portal) portal.style.display = 'none';

  var cal = document.getElementById('confirm-calendar-link');
  if (cal) cal.style.display = 'none';

  var emailEl = document.getElementById('confirm-email');
  if (emailEl) emailEl.textContent = BOOK.email || 'your email';

  window.scrollTo({ top: 0, behavior: 'smooth' });

}



function trackBookingConfirmation(ref, isQuote, isScheduledAuthorization) {
  if (!ref) return;
  var outcome = {
    booking_type: isQuote ? 'quote' : (isScheduledAuthorization ? 'future' : 'near_term'),
    outcome_stage: 'form_confirmation'
  };
  trackBookingFunnelOnce(isQuote ? 'quote_requested' : 'booking_confirmed', outcome, ref);
  trackBookingFunnelOnce('generate_lead', Object.assign({
    lead_source: 'website_booking',
    lead_type: isQuote ? 'quote_request' : 'service_booking',
    outcome_stage: 'lead_received'
  }, outcome), ref);
  // Compatibility only. This historical event never meant finished work or captured revenue.
  // New key-event reporting must select the distinct outcome above, not both aliases.
  trackBookingFunnelOnce('booking_completed', Object.assign({ deprecated_event: true }, outcome), ref);

  // Existing Ads actions remain separate. Their value is the reservation estimate,
  // not captured revenue; quote leads have no monetary value.
  var ADS_BOOKING_CONVERSION = 'AW-16551666395/7KS0CIjz1aMcENvFudQ9';
  var ADS_QUOTE_CONVERSION = 'AW-16551666395/YSgLCNCQie8cENvFudQ9';

  var adsKey = 'aaeAdsConfirmation:' + ref + ':' + (isQuote ? 'quote' : 'booking');
  var adsSent = false;
  try { adsSent = sessionStorage.getItem(adsKey) === '1'; } catch (e) {}
  if (!adsSent && window.gtag && window.AAEAnalytics && window.AAEAnalytics.canMeasure()) {
    if (!isQuote) {
      window.gtag('event', 'conversion', {
        send_to: ADS_BOOKING_CONVERSION,
        transaction_id: ref,
        value: Number(BOOK._grandTotalCents || 0) / 100,
        currency: 'USD'
      });
    } else if (ADS_QUOTE_CONVERSION) {
      // Deliberately no value or currency. The price is unknown at this moment.
      window.gtag('event', 'conversion', {
        send_to: ADS_QUOTE_CONVERSION,
        transaction_id: ref
      });
    }
    try { sessionStorage.setItem(adsKey, '1'); } catch (e) {}
  }
}

function showConfirmation(ref, isQuote, isScheduledAuthorization) {
  try { trackBookingConfirmation(ref, isQuote, isScheduledAuthorization); } catch (e) { /* Confirmation UI does not depend on analytics. */ }

  for (var i=1;i<=TOTAL_STEPS;i++) { var p=document.getElementById('step-'+i); if(p) p.classList.add('hidden'); }

  document.getElementById('step-confirm').classList.remove('hidden');
  syncBookingChrome(true);



  // Adjust confirmation messaging for quote requests

  if (isQuote) {

    var h = document.querySelector('#step-confirm .confirm-title');
    var steps = document.getElementById('confirm-next-steps');
    var portal = document.getElementById('confirm-portal-link');
    var cal = document.getElementById('confirm-calendar-link');

    if (h) h.textContent = 'Quote request received';

    if (steps) {
      steps.innerHTML =
        '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">1</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">We review your notes</strong> - a real person checks the scope before scheduling.</div></div>'
        + '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">2</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">We send the final price</strong> - no appointment is confirmed until the quote is approved.</div></div>'
        + '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">3</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">You approve and add a card</strong> - nothing is charged until the work is done.</div></div>';
    }

    if (portal) portal.textContent = 'Track Your Request \u2192';
    if (cal) cal.style.display = 'none';

  }

  if (isScheduledAuthorization && !isQuote) {
    var scheduledTitle = document.querySelector('#step-confirm .confirm-title');
    var scheduledSteps = document.getElementById('confirm-next-steps');
    if (scheduledTitle) scheduledTitle.textContent = 'Appointment reserved';
    if (scheduledSteps) {
      scheduledSteps.innerHTML =
        '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">1</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">Appointment reserved</strong> - your requested date and time are on our schedule.</div></div>'
        + '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">2</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">Card saved securely</strong> - no charge or temporary hold was placed today.</div></div>'
        + '<div style="display:flex;align-items:flex-start;gap:0.75rem"><div style="width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:0.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">3</div><div style="font-size:0.875rem;color:var(--ink-soft);line-height:1.5"><strong style="color:var(--ink)">Payment verified closer to the visit</strong> - we will contact you only if your bank needs another confirmation.</div></div>';
    }
  }



  // Reference

  var refEl = document.getElementById('confirm-ref');

  if (ref) refEl.textContent = 'Ref: ' + ref; else refEl.style.display='none';



  // Services summary

  var svcEl = document.getElementById('confirm-services');

  if (svcEl) svcEl.textContent = formatSelectedServices(' / ') || 'Your services';



  // Date & time

  var dtEl = document.getElementById('confirm-datetime');

  if (dtEl && BOOK.date) {

    var dateStr = new Date(BOOK.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});

    dtEl.textContent = dateStr + (BOOK.time ? ' / ' + BOOK.time : '');

  }



  // Address

  var addrEl = document.getElementById('confirm-address');

  if (addrEl && BOOK.address) addrEl.textContent = BOOK.address;



  // Confirmation email

  var emailEl = document.getElementById('confirm-email');

  if (emailEl) emailEl.textContent = BOOK.email || 'your email';



  // Google Calendar link

  var calEl = document.getElementById('confirm-calendar-link');

  if (calEl && isQuote) {
    calEl.style.display = 'none';
  } else if (calEl && BOOK.date && BOOK.time) {

    try {

      var dt = BOOK.date.replace(/-/g,'');

      var hrMatch = BOOK.time.match(/(\d+):/);

      var hr = hrMatch ? parseInt(hrMatch[1]) : 9;

      if (BOOK.time.indexOf('PM') !== -1 && hr !== 12) hr += 12;

      if (BOOK.time.indexOf('AM') !== -1 && hr === 12) hr = 0;

      var s = dt + 'T' + String(hr).padStart(2,'0') + '0000';

      var e = dt + 'T' + String(hr+2).padStart(2,'0') + '0000';

      calEl.href = 'https://calendar.google.com/calendar/renderaction=TEMPLATE'

        + '&text=' + encodeURIComponent('AssembleAtEase - ' + formatSelectedServices(', '))

        + '&dates=' + s + '/' + e

        + '&details=' + encodeURIComponent('Booking ref: ' + (ref||'') + '\nAssembleAtEase\n(979) 232-5139')

        + '&location=' + encodeURIComponent(BOOK.address||'Service address to be confirmed');

      calEl.style.display = 'inline';

    } catch(e) {}

  }



  setProgress(TOTAL_STEPS+1);

  var trackUrl = '/track';

  if (ref && BOOK.email) trackUrl += '?ref=' + encodeURIComponent(ref) + '&email=' + encodeURIComponent(BOOK.email) + (BOOK._guestMutationToken ? '&token=' + encodeURIComponent(BOOK._guestMutationToken) : '');

  else if (ref) trackUrl += '?ref=' + encodeURIComponent(ref);

  document.getElementById('confirm-portal-link').href = trackUrl;

  window.scrollTo({ top: 0, behavior: 'smooth' });

}

function showConfirmationPending(ref, message) {
  for (var i=1;i<=TOTAL_STEPS;i++) { var p=document.getElementById('step-'+i); if(p) p.classList.add('hidden'); }
  document.getElementById('step-confirm').classList.remove('hidden');
  syncBookingChrome(true);
  var title=document.querySelector('#step-confirm .confirm-title');
  if(title) title.textContent='Payment authorized — confirmation pending';
  var refEl=document.getElementById('confirm-ref');
  if(refEl) refEl.textContent=ref ? 'Ref: '+ref : '';
  var steps=document.getElementById('confirm-next-steps');
  if(steps) steps.innerHTML='<div style="font-size:0.9rem;color:var(--ink-soft);line-height:1.6"><strong style="color:var(--ink)">Do not submit another booking.</strong> Your card authorization exists, but we could not finish confirming the booking. Retry this page or contact (979) 232-5139 with your reference.<br><br>'+esc(message||'Confirmation is still pending.')+'</div>';
  var portal=document.getElementById('confirm-portal-link'); if(portal) portal.style.display='none';
  var cal=document.getElementById('confirm-calendar-link'); if(cal) cal.style.display='none';
  window.scrollTo({top:0,behavior:'smooth'});
}

async function recoverRedirectedPayment() {
  var params=new URLSearchParams(window.location.search);
  if(!params.get('payment_intent_client_secret')) return;
  var raw=sessionStorage.getItem('aaePaymentRecovery');
  if(!raw){ showConfirmationPending('', 'This browser no longer has the booking recovery details. Contact support with the Stripe payment reference shown by your bank.'); return; }
  var recovery;
  try{ recovery=JSON.parse(raw); }catch(e){ showConfirmationPending('', 'Stored booking recovery details could not be read.'); return; }
  try{
    await loadStripeJs();
    var cfgResp=await fetch('/api/config/public-key');
    var cfg=await cfgResp.json();
    if(!cfgResp.ok||!cfg.publishableKey) throw new Error('Could not load secure payment.');
    var stripe=Stripe(cfg.publishableKey);
    var retrieved=await stripe.retrievePaymentIntent(params.get('payment_intent_client_secret'));
    if(retrieved.error) throw new Error(retrieved.error.message);
    if(!retrieved.paymentIntent||retrieved.paymentIntent.status!=='requires_capture') throw new Error('The payment authorization is not ready for booking confirmation.');
    var confirmResp=await fetch('/api/booking-confirmed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingId:recovery.bookingId,guestMutationToken:recovery.guestMutationToken})});
    var confirmData=await confirmResp.json();
    if(!confirmResp.ok) throw new Error(confirmData.error||'Booking confirmation is still pending.');
    BOOK.email=recovery.email||''; BOOK.date=recovery.date||''; BOOK.time=recovery.time||''; BOOK.address=recovery.address||'';
    BOOK.selectedServices=Array.isArray(recovery.selectedServices)?recovery.selectedServices:[];
    BOOK._analytics=recovery.analytics||{};
    BOOK._guestMutationToken=recovery.guestMutationToken||'';
    sessionStorage.removeItem('aaePaymentRecovery');
    history.replaceState({},document.title,'/book');
    showConfirmation(recovery.ref,false);
  }catch(e){ showConfirmationPending(recovery.ref,e.message); }
}

window.setTimeout(recoverRedirectedPayment, 0);
