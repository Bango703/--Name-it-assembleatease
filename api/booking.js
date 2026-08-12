import Stripe from 'stripe';
import { getSupabase } from './_supabase.js';
import { upsertContact, createDeal } from './_hubspot.js';
import { rateLimit } from './_ratelimit.js';
import { sendEmail, ownerEmail, esc } from './_email.js';
import { guardCustomerFacing } from './_customer-error-alert.js';
import { calculateBookingPricing, TX_TAX_RATE } from './_pricing.js';
import { getMinimumPretaxBookingCents, isActiveInstantBookingZip, isAutomaticDispatchZip, sameDayFeeForAppointment, SAME_DAY_EASER_BONUS_CENTS, SAME_DAY_MIN_LEAD_MINUTES } from './_source-of-truth.js';
import {
  applyPromotionToPricing,
  isMissingColumnError,
  resolveBookingPromotion,
} from './_promotions.js';
import { logActivity } from './booking/_activity.js';
import { appointmentTimestampMs } from './booking/_appt-date.js';
import { BOOKING_WINDOW_DAYS, needsScheduledAuthorization, validateBookingWindowDate } from './booking/_booking-window.js';
import { formatUsPhone, normalizeUsPhone } from './_phone.js';
import { assertGuestTokenConfiguration, deriveGuestMutationToken, guestMutationTokenHash, randomToken } from './_payment-security.js';
import { parseServiceLocation } from './_booking-location.js';
import {
  verifyRedemptionToken,
  getAvailableBalanceCents,
  maxRedeemableCents,
  reserveRedemption,
  attachRedemptionToBooking,
  releasePendingRedemption,
} from './_assemblecash.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Alert the owner in real time if a customer hits a server/config error here —
  // a blocked booking is a missed job, and it must never fail silently again.
  guardCustomerFacing(req, res, 'online booking');
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });

  const {
    services,
    items,
    service: serviceLegacy,
    name,
    phone: rawPhone,
    email,
    address,
    city,
    state,
    zip,
    date,
    time,
    details,
    isQuoteRequest,
    setupIntentId,
    promoCode,
    promoPreviewApplied,
    promoPreviewTotalCents,
    assemblecashToken,
    bundleSlug,
    attribution,
  } = req.body;

  const phone = normalizeUsPhone(rawPhone);
  const quoteRequested = isQuoteRequest === true;

  // Support both new multi-service payload (services=[]) and legacy single-service (service='')
  const serviceList = Array.isArray(services) && services.length > 0
    ? services
    : (serviceLegacy ? [serviceLegacy] : []);
  const service = serviceList.join(', ');

  if (!service || !name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !address || !zip || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!phone) {
    return res.status(400).json({ error: 'Enter a valid 10-digit US phone number.', code: 'INVALID_PHONE' });
  }
  if (!/^\d{5}$/.test(String(zip).trim())) {
    return res.status(400).json({ error: 'Enter a valid 5-digit ZIP code.', code: 'INVALID_ZIP' });
  }
  if (String(state || 'TX').trim().toUpperCase() !== 'TX') {
    return res.status(409).json({ error: 'Online booking is currently available for Texas addresses only.', code: 'STATE_NOT_ACTIVE' });
  }
  if (!isActiveInstantBookingZip(zip)) {
    return res.status(409).json({
      error: 'Online booking is currently available for Texas addresses only.',
      code: 'MARKET_NOT_ACTIVE',
    });
  }

  const bookingCity = String(city || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const serviceLocation = parseServiceLocation({ address, city: bookingCity, state: 'TX', zip });

  const dateCheck = validateBookingWindowDate(date);
  const requestedDate = dateCheck.requestedDate;
  if (!requestedDate) {
    return res.status(400).json({ error: 'Invalid appointment date.' });
  }
  if (!dateCheck.ok) {
    return res.status(400).json({
      error: `Online appointments can be booked up to ${BOOKING_WINDOW_DAYS} days ahead.`,
      code: 'BOOKING_WINDOW_RESTRICTED',
      latestBookableDate: dateCheck.lastDate,
    });
  }
  const scheduledAuthorization = !quoteRequested && needsScheduledAuthorization(date);
  // Same-day service fee — server-authoritative, decided from the appointment date
  // (never the browser). Non-zero only when the feature is enabled AND the date is
  // today in America/Chicago. It is additive and never enters the 30/70 split.
  const sameDayFeeCentsForDate = sameDayFeeForAppointment(date);

  const weekday = requestedDate.getUTCDay();
  const weekdaySlots = [
    '7:00 AM – 9:00 AM', '9:00 AM – 11:00 AM', '11:00 AM – 1:00 PM',
    '1:00 PM – 3:00 PM', '3:00 PM – 5:00 PM',
  ];
  const saturdaySlots = weekdaySlots.slice(0, 3);
  const allowedSlots = weekday === 0 ? [] : (weekday === 6 ? saturdaySlots : weekdaySlots);
  if (!allowedSlots.includes(time)) {
    return res.status(400).json({
      error: weekday === 0
        ? 'Online appointments are closed on Sunday. Please choose Monday through Saturday.'
        : 'Please choose a time within published service hours (Monday–Friday 7 AM–5 PM; Saturday 7 AM–1 PM).',
      code: 'INVALID_SERVICE_HOURS',
    });
  }
  const appointmentMs = appointmentTimestampMs(date, time);
  if (appointmentMs == null || appointmentMs <= Date.now()) {
    return res.status(400).json({ error: 'That appointment time has already passed. Please choose a later time.' });
  }
  // Same-day bookings need real lead time so the job can actually be staffed —
  // closes the "book a slot starting in 30 minutes" gap. Quote requests are exempt
  // (owner-reviewed, not instantly dispatched).
  if (sameDayFeeCentsForDate > 0 && !quoteRequested
      && (appointmentMs - Date.now()) < SAME_DAY_MIN_LEAD_MINUTES * 60000) {
    return res.status(400).json({
      error: `Same-day appointments need at least ${Math.round(SAME_DAY_MIN_LEAD_MINUTES / 60)} hours' notice. Please pick a later time today or the next available day.`,
      code: 'SAME_DAY_LEAD_TIME',
    });
  }

  const KEY = process.env.RESEND_API_KEY;
  const TO  = ownerEmail();
  const ref = 'AAE-' + randomToken(8).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase();
  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const SITE = 'https://www.assembleatease.com';

  try { assertGuestTokenConfiguration(); }
  catch (tokenConfigErr) {
    console.error('Guest token configuration unavailable:', tokenConfigErr.message);
    return res.status(503).json({
      error: 'Secure booking access is not configured. No booking was created.',
      code: 'GUEST_TOKEN_CONFIGURATION_REQUIRED',
    });
  }

  // ── Supabase: save booking ──────────────────────────────────
  const sb = getSupabase();
  const pricing = calculateBookingPricing({ services: serviceList, itemsByService: items, zip, sameDayFeeCents: sameDayFeeCentsForDate });
  if (pricing.invalidItems.length) {
    return res.status(400).json({
      error: 'Some selected services are no longer available. Please refresh and try again.',
      invalidItems: pricing.invalidItems,
    });
  }

  const promo = await resolveBookingPromotion({
    promoCode,
    email,
    pricing,
    isQuoteRequest: quoteRequested,
    sb,
  });
  const pricingWithPromo = applyPromotionToPricing(pricing, promo);
  let amount = pricingWithPromo.totalCents;
  const subtotalCents = pricingWithPromo.itemSubtotalCents;
  const discountCents = pricingWithPromo.discountCents;
  const promoDiscountCents = pricingWithPromo.promoDiscountCents;
  let taxableSubtotalCents = pricingWithPromo.taxableSubtotalCents;
  let taxCents = pricingWithPromo.taxCents;
  const serviceCallFeeCents = pricingWithPromo.serviceCallFeeCents;
  // Applied same-day fee (0 on a custom-quote-only cart) and the fixed rush bonus
  // the fulfiller earns from it. The business keeps the remainder.
  const appliedSameDayFeeCents = Math.max(0, Number(pricingWithPromo.sameDayFeeCents || 0));
  const sameDayEaserBonusCents = appliedSameDayFeeCents > 0 ? SAME_DAY_EASER_BONUS_CENTS : 0;
  const pricedBooking = amount > 0 && !quoteRequested;
  const shouldAuthorizeNow = pricedBooking && !scheduledAuthorization;
  let verifiedQuotePaymentMethodId = null;
  let verifiedQuoteCustomerId = null;

  if (quoteRequested || scheduledAuthorization) {
    if (!setupIntentId || !process.env.STRIPE_SECRET_KEY) {
      return res.status(409).json({
        error: scheduledAuthorization
          ? 'Secure card setup must be completed before confirming this future appointment.'
          : 'Secure card setup must be completed before submitting a custom quote request.',
        code: scheduledAuthorization ? 'FUTURE_BOOKING_CARD_SETUP_REQUIRED' : 'QUOTE_CARD_SETUP_REQUIRED',
      });
    }
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const setupIntent = await stripe.setupIntents.retrieve(String(setupIntentId));
      const setupEmail = String(setupIntent.metadata?.email || '').trim().toLowerCase();
      const expectedSetupSource = scheduledAuthorization ? 'future_booking' : 'quote_booking';
      if (setupIntent.status !== 'succeeded'
          || setupIntent.metadata?.source !== expectedSetupSource
          || setupEmail !== String(email).trim().toLowerCase()
          || (scheduledAuthorization && setupIntent.metadata?.appointmentDate !== date)
          || typeof setupIntent.customer !== 'string'
          || typeof setupIntent.payment_method !== 'string') {
        return res.status(409).json({
          error: 'Secure card setup does not match this booking request.',
          code: scheduledAuthorization ? 'FUTURE_BOOKING_CARD_SETUP_MISMATCH' : 'QUOTE_CARD_SETUP_MISMATCH',
        });
      }
      verifiedQuoteCustomerId = setupIntent.customer;
      verifiedQuotePaymentMethodId = setupIntent.payment_method;
    } catch (setupErr) {
      console.error('Booking SetupIntent verification failed:', setupErr);
      return res.status(502).json({ error: 'Could not verify secure card setup. Please retry the booking.' });
    }
  }

  const previewApplied = promoPreviewApplied === true;
  const previewTotal = Number.isFinite(Number(promoPreviewTotalCents)) ? Math.round(Number(promoPreviewTotalCents)) : null;
  if (String(promoCode || '').trim()) {
    const promoStateChanged = previewApplied !== !!promo.applied
      || (previewTotal != null && previewTotal !== amount);
    if (promoStateChanged) {
      return res.status(409).json({
        error: 'This offer changed while you were booking. Review the updated total and confirm again.',
        code: 'PROMO_CHANGED',
        promo: {
          enteredCode: promo.enteredCode,
          applied: promo.applied,
          appliedCode: promo.appliedCode,
          discountCents: promoDiscountCents,
          reason: promo.reason,
        },
        pricing: {
          totalCents: amount,
          taxCents,
          serviceCallFeeCents,
          bundleDiscountCents: discountCents,
          promoDiscountCents,
        },
      });
    }
  }

  if (amount > 0 && !pricingWithPromo.callZone) {
    return res.status(400).json({
      error: 'This ZIP is outside the active online booking area. Please submit a service request or email service@assembleatease.com.',
      code: 'OUTSIDE_ACTIVE_BOOKING_AREA',
      callZone: pricingWithPromo.callZone,
    });
  }

  if (amount > 0 && !quoteRequested && pricingWithPromo.isAddonOnly) {
    return res.status(400).json({
      error: 'Add-ons can only be booked with a base service item. Please add a main service item or request a custom quote.',
      code: 'ADDON_ONLY_NOT_ALLOWED',
      callZone: pricingWithPromo.callZone,
    });
  }

  // No hard minimum BLOCK. The per-ZIP service-call fee already covers travel and
  // overhead on small jobs, so we take the booking instead of turning the customer
  // away over a few dollars. (minBookingCents kept as informational context only.)
  const minBookingCents = getMinimumPretaxBookingCents(pricingWithPromo.callZone);

  // ── AssembleCash redemption (server-authoritative; never trust a client amount) ──
  // Applied AFTER promo, like a discount on the pre-tax service base. Capped at $20,
  // bounded by the live balance, and never pushes the base below the margin floor.
  // Requires a valid redemption token (proves the customer verified this email).
  // We atomically reserve the credit before saving the booking / creating Stripe
  // state so two overlapping checkouts cannot spend the same reward balance.
  let assemblecashRedeemedCents = 0;
  if (assemblecashToken && pricedBooking && verifyRedemptionToken(assemblecashToken, email)) {
    try {
      const acBalance = await getAvailableBalanceCents(sb, email);
      const requestedRedeem = maxRedeemableCents({
        balanceCents: acBalance,
        pretaxBaseCents: pricingWithPromo.promoAdjustedItemSubtotalCents,
        marginFloorCents: minBookingCents || 0,
      });
      if (requestedRedeem > 0) {
        const reservedRedeem = await reserveRedemption(sb, {
          customerEmail: email,
          requestedAmountCents: requestedRedeem,
          bookingRef: ref,
        });
        if (reservedRedeem !== requestedRedeem) {
          const refreshedBalance = await getAvailableBalanceCents(sb, email);
          const refreshedRedeem = maxRedeemableCents({
            balanceCents: refreshedBalance,
            pretaxBaseCents: pricingWithPromo.promoAdjustedItemSubtotalCents,
            marginFloorCents: minBookingCents || 0,
          });
          const refreshedAdjustedSubtotal = Math.max(0, pricingWithPromo.promoAdjustedItemSubtotalCents - refreshedRedeem);
          const refreshedTaxableSubtotal = refreshedAdjustedSubtotal + serviceCallFeeCents + appliedSameDayFeeCents;
          const refreshedTax = Math.round(refreshedTaxableSubtotal * TX_TAX_RATE);
          const refreshedTotal = refreshedTaxableSubtotal + refreshedTax;
          return res.status(409).json({
            error: 'Your AssembleCash balance changed while this booking was being prepared. We refreshed the total.',
            code: 'ASSEMBLECASH_CHANGED',
            promo: {
              applied: promo.applied,
              appliedCode: promo.appliedCode || '',
              label: promo.label || 'Promo',
              discountCents: promoDiscountCents,
              reason: 'assemblecash_changed',
              enteredCode: promoCode || '',
            },
            assemblecash: {
              requestedCents: requestedRedeem,
              appliedCents: refreshedRedeem,
              remainingBalanceCents: refreshedBalance,
            },
            pricing: {
              itemSubtotalCents: pricingWithPromo.itemSubtotalCents,
              bundleDiscountCents: pricingWithPromo.discountCents,
              promoDiscountCents,
              serviceCallFeeCents,
              taxCents: refreshedTax,
              totalCents: refreshedTotal,
            },
          });
        }
        const acAdjustedSubtotal = Math.max(0, pricingWithPromo.promoAdjustedItemSubtotalCents - reservedRedeem);
        taxableSubtotalCents = acAdjustedSubtotal + serviceCallFeeCents + appliedSameDayFeeCents;
        taxCents = Math.round(taxableSubtotalCents * TX_TAX_RATE);
        amount = taxableSubtotalCents + taxCents;
        assemblecashRedeemedCents = reservedRedeem;
      }
    } catch (e) {
      if (e?.code === 'AC_REDEMPTION_RPC_MISSING') {
        return res.status(503).json({
          error: 'AssembleCash is temporarily unavailable while rewards are being updated. Please book without it or finish the rewards migration first.',
          code: 'ASSEMBLECASH_UNAVAILABLE',
        });
      }
      console.warn('AssembleCash redemption skipped:', e && (e.message || e));
    }
  }

  const isDeposit = false;
  const depositAmountCents = null;
  const requiresOwnerAssignment = !isAutomaticDispatchZip(zip);

  const bookingInsertPayload = {
    ref,
    service,
    customer_name: name,
    customer_phone: phone,
    customer_email: email,
    address,
    service_city: serviceLocation.city,
    service_state: serviceLocation.state,
    service_zip: serviceLocation.zip,
    date,
    time,
    details,
    status: scheduledAuthorization ? 'confirmed' : 'pending',
    payment_status: scheduledAuthorization ? 'card_saved' : (shouldAuthorizeNow ? 'pending' : 'not_required'),
    total_price: amount,
    tax_amount: taxCents,
    service_call_fee: serviceCallFeeCents,
    same_day_fee_cents: appliedSameDayFeeCents,
    same_day_easer_bonus_cents: sameDayEaserBonusCents,
    call_zone: pricingWithPromo.callZone,
    dispatch_paused: scheduledAuthorization,
    needs_manual_dispatch: requiresOwnerAssignment,
    ...(scheduledAuthorization ? {
      confirmed_at: new Date().toISOString(),
      confirmed_by: 'scheduled_card_setup',
      stripe_customer_id: verifiedQuoteCustomerId,
      stripe_payment_method_id: verifiedQuotePaymentMethodId,
    } : {}),
    is_deposit: isDeposit,
    deposit_amount: depositAmountCents,
    promo_code: promo.applied ? promo.appliedCode : null,
    promo_discount_cents: promoDiscountCents,
    assemblecash_redeemed_cents: assemblecashRedeemedCents,
    bundle_slug: (typeof bundleSlug === 'string' && bundleSlug) ? bundleSlug.slice(0, 64) : null,
    booking_attribution: cleanBookingAttribution(attribution),
  };

  let activeBookingInsertPayload = bookingInsertPayload;
  let { data: savedBooking, error: insertErr } = await sb.from('bookings').insert(activeBookingInsertPayload).select('id').single();

  if (insertErr && isMissingColumnError(insertErr) && /service_(?:city|state|zip)/i.test(String(insertErr.message || ''))) {
    const { service_city, service_state, service_zip, ...withoutLocationColumns } = activeBookingInsertPayload;
    activeBookingInsertPayload = withoutLocationColumns;
    ({ data: savedBooking, error: insertErr } = await sb.from('bookings').insert(activeBookingInsertPayload).select('id').single());
  }

  if (insertErr && isMissingColumnError(insertErr) && /promo_|assemblecash|bundle_slug/i.test(String(insertErr.message || ''))) {
    const { promo_code, promo_discount_cents, assemblecash_redeemed_cents, bundle_slug, ...legacyBookingInsertPayload } = activeBookingInsertPayload;
    activeBookingInsertPayload = legacyBookingInsertPayload;
    ({ data: savedBooking, error: insertErr } = await sb.from('bookings').insert(activeBookingInsertPayload).select('id').single());
  }

  if (insertErr && isMissingColumnError(insertErr) && /same_day_/i.test(String(insertErr.message || ''))) {
    const { same_day_fee_cents, same_day_easer_bonus_cents, ...withoutSameDay } = activeBookingInsertPayload;
    activeBookingInsertPayload = withoutSameDay;
    ({ data: savedBooking, error: insertErr } = await sb.from('bookings').insert(activeBookingInsertPayload).select('id').single());
  }

  if (insertErr && isMissingColumnError(insertErr) && /booking_attribution/i.test(String(insertErr.message || ''))) {
    const { booking_attribution, ...withoutAttribution } = activeBookingInsertPayload;
    activeBookingInsertPayload = withoutAttribution;
    ({ data: savedBooking, error: insertErr } = await sb.from('bookings').insert(activeBookingInsertPayload).select('id').single());
  }

  if (insertErr) {
    if (assemblecashRedeemedCents > 0) {
      await releasePendingRedemption(sb, { bookingRef: ref, customerEmail: email, reason: 'reverse:booking_insert_failed' });
    }
    console.error('Booking insert error:', insertErr);
    return res.status(500).json({ error: 'Failed to save booking. Please try again.' });
  }

  const bookingId = savedBooking.id;
  const guestMutationToken = deriveGuestMutationToken({ bookingId, ref, email });
  const { error: guestTokenErr } = await sb.from('bookings').update({
    guest_mutation_token_hash: guestMutationTokenHash({ id: bookingId, ref, customer_email: email }),
  }).eq('id', bookingId);
  if (guestTokenErr) {
    if (assemblecashRedeemedCents > 0) {
      await releasePendingRedemption(sb, { bookingId, bookingRef: ref, customerEmail: email, reason: 'reverse:guest_token_setup_failed' });
    }
    await sb.from('bookings').delete().eq('id', bookingId);
    console.error('Booking guest-token setup failed:', guestTokenErr);
    return res.status(503).json({
      error: 'Secure booking access is temporarily unavailable. Please try again shortly.',
      code: 'BOOKING_SECURITY_UNAVAILABLE',
    });
  }
  if (assemblecashRedeemedCents > 0) {
    await attachRedemptionToBooking(sb, { bookingId, bookingRef: ref, customerEmail: email });
  }

  if (promo.applied && promoDiscountCents > 0) {
    logActivity(sb, {
      bookingId,
      eventType: 'booking_created',
      actorType: 'customer',
      actorName: name,
      description: `Promo applied — ${promo.appliedCode} (-$${(promoDiscountCents / 100).toFixed(2)}).`,
      metadata: {
        promoCode: promo.appliedCode,
        promoDiscountCents,
      },
    });
  }

  const bookingItemRows = buildBookingItemRows({ bookingId, itemsByService: pricingWithPromo.normalizedItems });
  if (bookingItemRows.length) {
    const { error: itemInsertErr } = await sb.from('booking_items').insert(bookingItemRows);
    if (itemInsertErr) {
      console.warn('Booking items insert skipped:', itemInsertErr.message || itemInsertErr);
    }
  }

  // Quote booking with saved card: store the customer + payment method from SetupIntent
  if (quoteRequested && verifiedQuotePaymentMethodId && verifiedQuoteCustomerId) {
    const { error: quoteCardLinkErr } = await sb.from('bookings').update({
      stripe_customer_id: verifiedQuoteCustomerId,
      stripe_payment_method_id: verifiedQuotePaymentMethodId,
      payment_status: 'card_saved',
    }).eq('id', bookingId);
    if (quoteCardLinkErr) {
      await sb.from('bookings').delete().eq('id', bookingId);
      return res.status(500).json({ error: 'Could not save secure quote payment setup. Please try again.' });
    }
  }

  // ── Stripe: create customer + PaymentIntent (skip if no price) ──
  let clientSecret = null;
  let paymentIntentCreationAttempted = false;

  if (shouldAuthorizeNow && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      // Find or create Stripe customer
      const existing = await stripe.customers.list({ email, limit: 1 });
      const customer = existing.data[0] || await stripe.customers.create({
        email,
        name,
        metadata: { bookingRef: ref },
      });

      // Create PaymentIntent — authorize card now, capture manually after job completion
      paymentIntentCreationAttempted = true;
      const pi = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: customer.id,
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        payment_method_types: ['card'],
        payment_method_options: {
          card: {
            request_three_d_secure: 'automatic',
          },
        },
        receipt_email: email,
        statement_descriptor_suffix: 'ASSEMBLEATEASE',
        description: `${service} — ${name}`,
        shipping: {
          name,
          address: {
            line1: address,
            ...(bookingCity ? { city: bookingCity } : {}),
            state: 'TX',
            postal_code: String(zip).trim(),
            country: 'US',
          },
        },
        metadata: {
          bookingRef: ref,
          bookingId,
          type: 'customer_booking',
          isDeposit: 'false',
          depositAmountCents: '0',
          bundleSlug: String(bundleSlug || ''),
          promoCode: promo.applied ? promo.appliedCode : '',
          promoDiscountCents: String(promoDiscountCents || 0),
          assemblecashRedeemedCents: String(assemblecashRedeemedCents || 0),
        },
      }, { idempotencyKey: `booking-create-${bookingId}-${amount}` });

      // Save Stripe IDs to booking record
      const { data: stripeLinkRows, error: stripeLinkErr } = await sb.from('bookings').update({
        stripe_customer_id: customer.id,
        stripe_payment_intent_id: pi.id,
      })
        .eq('id', bookingId)
        .eq('status', 'pending')
        .eq('payment_status', 'pending')
        .is('stripe_payment_intent_id', null)
        .select('id');

      if (stripeLinkErr || !stripeLinkRows?.length) {
        let cancellationConfirmed = false;
        try {
          const cancelledIntent = await stripe.paymentIntents.cancel(pi.id);
          cancellationConfirmed = cancelledIntent?.status === 'canceled';
        } catch (cancelErr) {
          console.error('Failed to cancel unlinked PaymentIntent:', cancelErr);
        }

        if (!cancellationConfirmed) {
          // Preserve a durable booking record whenever Stripe cancellation is
          // unknown. A best-effort second link makes the existing intent
          // recoverable from the owner dashboard; the row is never deleted in
          // this state even if the database is temporarily unavailable.
          const { data: recoveryRows, error: recoveryLinkError } = await sb.from('bookings').update({
            stripe_customer_id: customer.id,
            stripe_payment_intent_id: pi.id,
            payment_status: 'failed',
          })
            .eq('id', bookingId)
            .eq('status', 'pending')
            .in('payment_status', ['pending', 'failed'])
            .is('stripe_payment_intent_id', null)
            .select('id');
          if (recoveryLinkError || !recoveryRows?.length) {
            console.error('Uncancelled PaymentIntent could not be linked for recovery:', recoveryLinkError || pi.id);
          }
          const reconciliationError = new Error(`Stripe payment link requires reconciliation for ${pi.id}`);
          reconciliationError.preserveBooking = true;
          reconciliationError.paymentIntentId = pi.id;
          throw reconciliationError;
        }

        const safeLinkError = new Error(`Failed to persist Stripe payment link: ${stripeLinkErr?.message || 'booking state changed'}`);
        safeLinkError.safeToDeleteBooking = true;
        throw safeLinkError;
      }

      clientSecret = pi.client_secret;
    } catch (stripeErr) {
      console.error('Stripe setup error:', stripeErr);
      const preserveForReconciliation = stripeErr?.preserveBooking
        || (paymentIntentCreationAttempted && stripeErr?.safeToDeleteBooking !== true);
      if (preserveForReconciliation) {
        await logActivity(sb, {
          bookingId,
          eventType: 'payment_reconciliation_required',
          actorType: 'system',
          actorName: 'booking-create',
          description: 'Stripe payment setup could not be safely cancelled or linked. The booking was preserved for owner reconciliation.',
          metadata: { paymentIntentId: stripeErr.paymentIntentId || null },
        }).catch(activityError => console.error('Payment reconciliation activity log failed:', activityError?.message || activityError));
        return res.status(503).json({
          error: `Payment setup needs review. Do not submit another booking. Contact 737-290-6129 with reference ${ref}.`,
          code: 'PAYMENT_RECONCILIATION_REQUIRED',
          bookingRef: ref,
        });
      }

      if (assemblecashRedeemedCents > 0) {
        await releasePendingRedemption(sb, { bookingId, bookingRef: ref, customerEmail: email, reason: 'reverse:stripe_setup_failed' });
      }
      // Deletion is safe only when no PaymentIntent exists or Stripe confirmed
      // cancellation of the unlinked intent.
      await sb.from('bookings').delete().eq('id', bookingId).catch(delErr =>
        console.error('Failed to clean up booking after Stripe setup error:', delErr)
      );
      return res.status(502).json({
        error: 'Payment setup failed. Please try again in a moment. Your card was not charged.',
        code: 'STRIPE_SETUP_FAILED',
      });
    }
  }

  const sService = esc(quoteRequested && service === 'Other' ? 'Custom Quote' : service);
  const sName = esc(name);
  const sPhone = esc(formatUsPhone(phone));
  const sEmail = esc(email);
  const sAddress = esc(address);
  const sDate = esc(date);
  const sTime = esc(time);
  const sDetails = esc(details);
  const guestTrackUrl = `${SITE}/track?ref=${encodeURIComponent(ref)}&email=${encodeURIComponent(email)}&token=${encodeURIComponent(guestMutationToken)}`;

  const ownerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Notification</td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">New Booking Request</p>
    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1a1a1a">Ref: ${ref}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Services</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a1a;line-height:1.5">${sService}</p>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:110px;vertical-align:top">Customer</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sName}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Phone</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="tel:${sPhone}" style="color:#00BFFF;text-decoration:none;font-weight:600">${sPhone}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Email</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0"><a href="mailto:${sEmail}" style="color:#00BFFF;text-decoration:none">${sEmail}</a></td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sAddress}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sDate}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sTime}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Details</td><td style="padding:10px 0;line-height:1.6">${sDetails || 'None provided'}</td></tr>
      ${amount > 0 ? `<tr><td style="padding:10px 0;border-top:1px solid #f0f0f0;color:#71717a;vertical-align:top">Subtotal</td><td style="padding:10px 0;border-top:1px solid #f0f0f0;font-weight:600">$${(subtotalCents/100).toFixed(2)}</td></tr>
      ${discountCents > 0 ? `<tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Bundle Discount</td><td style="padding:10px 0;font-weight:600;color:#0d9488">-$${(discountCents/100).toFixed(2)}</td></tr>` : ''}
      ${promoDiscountCents > 0 ? `<tr><td style="padding:10px 0;color:#71717a;vertical-align:top">${esc(promo.label)}</td><td style="padding:10px 0;font-weight:600;color:#0369a1">-$${(promoDiscountCents/100).toFixed(2)}</td></tr>` : ''}
      ${assemblecashRedeemedCents > 0 ? `<tr><td style="padding:10px 0;color:#71717a;vertical-align:top">AssembleCash applied</td><td style="padding:10px 0;font-weight:600;color:#0369a1">-$${(assemblecashRedeemedCents/100).toFixed(2)}</td></tr>` : ''}
      ${serviceCallFeeCents > 0 ? `<tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Service Call</td><td style="padding:10px 0;font-weight:600">$${(serviceCallFeeCents/100).toFixed(2)}</td></tr>` : ''}
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Tax</td><td style="padding:10px 0;font-weight:600">$${(taxCents/100).toFixed(2)}</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #f0f0f0;color:#71717a;vertical-align:top">Est. Total</td><td style="padding:10px 0;border-top:1px solid #f0f0f0;font-weight:700;color:#065f46">$${(amount/100).toFixed(2)}</td></tr>` : ''}
      ${clientSecret ? '<tr><td style="padding:10px 0;border-top:1px solid #f0f0f0;color:#71717a">Payment</td><td style="padding:10px 0;border-top:1px solid #f0f0f0"><span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">CARD PENDING AUTHORIZATION</span></td></tr>' : ''}
      ${scheduledAuthorization ? '<tr><td style="padding:10px 0;border-top:1px solid #f0f0f0;color:#71717a">Payment</td><td style="padding:10px 0;border-top:1px solid #f0f0f0"><span style="display:inline-block;background:#e0f2fe;color:#075985;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">CARD SAVED — AUTHORIZATION SCHEDULED</span></td></tr>' : ''}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af">Action Required</p>
    <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">${quoteRequested ? `Review the project notes, prepare a final quote, and contact <strong>${sName}</strong> before scheduling or authorizing any amount.` : (scheduledAuthorization ? `Plan coverage for this appointment. The customer card is saved, but dispatch stays paused until payment is authorized five days before the visit.` : `Contact <strong>${sName}</strong> at <a href="tel:${sPhone}" style="color:#1e40af">${sPhone}</a> or <a href="mailto:${sEmail}" style="color:#1e40af">${sEmail}</a> to confirm this appointment.`)}</p>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa;line-height:1.6">
    AssembleAtEase &bull; Serving customers across Texas &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a><br/>Reviewed pros &bull; Clear pricing
  </td></tr></table>
</div></body></html>`;

  const customerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">${quoteRequested ? `We received your quote request,&nbsp;${sName}.` : `We received your booking,&nbsp;${sName}.`}</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">${quoteRequested ? `We will review your project notes and follow up with the next step before anything is scheduled.` : (scheduledAuthorization ? `Your appointment is reserved. Your card is saved securely, and we will verify it closer to your visit. No payment has been taken.` : `Thank you for choosing AssembleAtEase. A member of our team will follow up to confirm your appointment details.`)}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Booking Reference</td><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px;text-align:right">Status</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#1a1a1a">${ref}</td><td style="text-align:right"><span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">${quoteRequested ? 'QUOTE REQUEST' : (scheduledAuthorization ? 'SCHEDULED' : 'PENDING CONFIRMATION')}</span></td></tr>
      </table>
    </td></tr></table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Appointment Details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Services</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${sService}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sDate}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${sTime}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${sAddress}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:10px 0;line-height:1.6">${sDetails || 'None'}</td></tr>
    </table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">
      ${quoteRequested ? `
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We review the scope</strong> — A real person checks your notes before confirming availability.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We send the final price</strong> — No appointment is confirmed until the quote is approved.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Then we schedule</strong> — Your card is saved securely, but no payment has been taken.</td></tr>
      ` : `
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Email confirmation</strong> — We'll follow up to confirm date, time, and scope.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Your technician arrives</strong> — On the scheduled date, a reviewed local pro arrives with the tools needed for the job.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">${scheduledAuthorization ? 'Payment method saved' : (clientSecret ? 'Secure checkout' : 'Payment reviewed after confirmation')}</strong> &mdash; ${scheduledAuthorization ? 'We will verify your card five days before the appointment. If your bank needs anything else, we will send a secure link.' : (clientSecret ? 'Your payment method is verified securely by Stripe. Payment is processed after the job is complete.' : 'If payment is needed, we will send secure payment steps before the work is scheduled.')}</td></tr>
      `}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:13px;color:#92400e;line-height:1.6">
      <strong>Need to change plans?</strong> Reply to this email. Cancel at least 24 hours before your appointment for a full release of any hold. Inside 24 hours, a late-cancel fee may apply because a pro has already reserved the time.
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="${esc(guestTrackUrl)}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Track or manage this request</a>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Serving customers across Texas &bull; Reviewed pros &bull; Clear pricing</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">You received this email because a booking was submitted at assembleatease.com. If you did not make this request, please disregard this email.</p>
  </td></tr></table>
</div></body></html>`;

  try {
    // ── Owner notification email ──────────────────────────────
    // When payment is required (clientSecret present), the card hasn't been held yet.
    // Sending an owner email now would be premature — the customer might abandon the
    // card form or the auth might fail. Owner email is sent by /api/booking-confirmed
    // AFTER the frontend successfully calls stripe.confirmCardPayment().
    // When no payment is required (custom quote / free booking), send immediately.
    // Route through sendEmail so the owner alert is logged to notification_log and
    // its failures are visible — a raw fire-and-forget send previously let quote
    // requests vanish silently when the owner email never landed or hit spam.
    if (!clientSecret) {
      const ownerAlert = await sendEmail({
        to: TO,
        from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
        subject: (quoteRequested ? 'New Quote Request - ' : 'New Booking - ') + (quoteRequested && service === 'Other' ? 'Custom Quote' : service) + ' from ' + name,
        html: ownerHtml,
        replyTo: email,
        meta: { bookingId, notificationType: quoteRequested ? 'quote_request_owner' : 'new_booking_owner', recipientType: 'owner' },
      }).catch(e => ({ ok: false, error: e?.message || String(e) }));
      if (!ownerAlert?.ok) console.error('Owner quote/booking email failed:', ownerAlert?.error || ownerAlert?.reason || 'unknown');

      // Send customer email immediately too (no payment to wait for)
      await sendEmail({
        to: email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: quoteRequested ? 'Quote request received - ' + ref : 'Booking Confirmed - We received your request!',
        html: customerHtml,
        replyTo: TO,
        meta: { bookingId, notificationType: quoteRequested ? 'quote_request_customer' : 'booking_received_customer', recipientType: 'customer' },
      }).catch(e => console.error('Customer quote/booking email failed:', e?.message || e));
    }
    // When clientSecret is present: both owner and customer emails are sent by
    // /api/booking-confirmed after the card authorization succeeds.
    // HubSpot CRM — non-blocking
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        const contactId = await upsertContact({ email, name, phone, address, lifecycleStage: 'opportunity' });
        if (contactId) {
          await createDeal({ contactId, dealName: service + ' — ' + name, service, date, time, details });
        }
      } catch (err) { console.error('HubSpot booking error:', err); }
    }

    return res.status(200).json({
      success: true,
      ref,
      bookingId,
      guestMutationToken,
      clientSecret,
      scheduledAuthorization,
      isDeposit,
      depositAmountCents,
      pricing: {
        itemSubtotalCents: subtotalCents,
        discountCents,
        discountPct: pricing.discountPct,
        serviceCallFeeCents,
        taxableSubtotalCents,
        taxCents,
        totalCents: amount,
        minimumPretaxCents: minBookingCents,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed' });
  }
}

function buildBookingItemRows({ bookingId, itemsByService }) {
  if (!bookingId || !itemsByService || typeof itemsByService !== 'object') return [];

  const rows = [];
  for (const [serviceCategoryRaw, rawItems] of Object.entries(itemsByService)) {
    const serviceCategory = cleanText(serviceCategoryRaw, 120) || 'Other';
    const items = Array.isArray(rawItems) ? rawItems : [];

    for (const item of items) {
      const itemName = cleanText(item?.name, 180);
      if (!itemName) continue;

      const qty = clampInt(item?.qty, 1, 99, 1);
      const isAddOn = item?.addon === true || item?.isAddOn === true;
      const unitPriceCents = item?.customQuote ? 0 : dollarsToCents(item?.price);
      const lineTotal = unitPriceCents * qty;
      const addOnRevenue = isAddOn ? lineTotal : 0;
      const baseServiceRevenue = isAddOn ? 0 : lineTotal;
      const serviceName = cleanText(item?.group, 120) || serviceCategory;

      rows.push({
        booking_id: bookingId,
        service_category: serviceCategory,
        service_name: serviceName,
        item_name: itemName,
        item_price: unitPriceCents,
        quantity: qty,
        is_add_on: isAddOn,
        add_on_name: isAddOn ? itemName : null,
        add_on_price: isAddOn ? unitPriceCents : 0,
        line_total: lineTotal,
        add_on_revenue: addOnRevenue,
        base_service_revenue: baseServiceRevenue,
      });
    }
  }

  return rows;
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function dollarsToCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanBookingAttribution(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clean = (field, max) => String(input[field] || '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, max);
  const landingPath = clean('landingPath', 240);
  const referrerHost = clean('referrerHost', 120).toLowerCase();
  const utmSource = clean('utmSource', 100);
  const result = {
    source: utmSource || referrerHost || 'direct',
    capturedAt: new Date().toISOString(),
  };
  if (utmSource) result.utmSource = utmSource;
  const utmMedium = clean('utmMedium', 100);
  const utmCampaign = clean('utmCampaign', 140);
  const utmContent = clean('utmContent', 140);
  const utmTerm = clean('utmTerm', 140);
  const clickId = clean('clickId', 180);
  if (utmMedium) result.utmMedium = utmMedium;
  if (utmCampaign) result.utmCampaign = utmCampaign;
  if (utmContent) result.utmContent = utmContent;
  if (utmTerm) result.utmTerm = utmTerm;
  if (clickId) result.clickId = clickId;
  if (landingPath.startsWith('/')) result.landingPath = landingPath;
  if (referrerHost) result.referrerHost = referrerHost;
  return result;
}
