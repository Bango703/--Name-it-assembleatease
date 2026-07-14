import { writeFinancialAudit } from '../_financial-audit.js';

function paymentError(message, code = 'PAYMENT_INTENT_MISMATCH') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function intentFeeCents(intent) {
  const balanceTransaction = intent?.latest_charge && intent.latest_charge.balance_transaction;
  return balanceTransaction && typeof balanceTransaction.fee === 'number'
    ? balanceTransaction.fee
    : null;
}

function validateSucceededIntent(intent, booking, { expectedAmount, allowedTypes }) {
  const allowedPaymentType = allowedTypes.includes(intent?.metadata?.type)
    || (intent?.metadata?.type === 'reauth' && intent?.id === booking?.stripe_payment_intent_id);
  if (!intent
      || intent.status !== 'succeeded'
      || intent.currency !== 'usd'
      || Number(intent.amount_received || 0) !== Number(expectedAmount || 0)
      || intent.metadata?.bookingId !== booking.id
      || !allowedPaymentType) {
    throw paymentError('Stripe captured payment does not match this booking.');
  }
}

async function retrieveExpanded(stripe, paymentIntentId) {
  return stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.balance_transaction'],
  });
}

async function findExistingBalanceIntent(stripe, booking) {
  const page = await stripe.paymentIntents.list({
    customer: booking.stripe_customer_id,
    limit: 100,
  });
  const matches = (page?.data || []).filter(intent => intent.metadata?.bookingId === booking.id
    && intent.metadata?.type === 'customer_booking_balance'
    && intent.status !== 'canceled');
  if (matches.length > 1) {
    throw paymentError(
      'Multiple Stripe balance payments exist for this booking. Owner reconciliation is required.',
      'DUPLICATE_BALANCE_PAYMENT_REVIEW_REQUIRED',
    );
  }
  return matches.length ? retrieveExpanded(stripe, matches[0].id) : null;
}

async function captureAuthorizedPayment({ stripe, sb, booking, eventSource }) {
  const intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  if (intent.status === 'succeeded') {
    const recovered = await retrieveExpanded(stripe, booking.stripe_payment_intent_id);
    validateSucceededIntent(recovered, booking, {
      expectedAmount: booking.total_price,
      allowedTypes: ['customer_booking', 'customer_quote'],
    });
    return {
      amountCharged: recovered.amount_received,
      actualStripeFee: intentFeeCents(recovered),
      balancePaymentIntentId: null,
      balanceAmountCaptured: null,
    };
  }
  const validIntent = intent.status === 'requires_capture'
    && intent.capture_method === 'manual'
    && intent.currency === 'usd'
    && Number(intent.amount) === Number(booking.total_price || 0)
    && intent.metadata?.bookingId === booking.id
    && (
      ['customer_booking', 'customer_quote'].includes(intent.metadata?.type)
      || (intent.metadata?.type === 'reauth' && intent.id === booking.stripe_payment_intent_id)
    );
  if (!validIntent) throw paymentError('Stripe authorization is not capturable or does not match this booking.');

  const idempotencyKey = `booking-complete-capture-${booking.id}`;
  await writeFinancialAudit(sb, {
    eventType: 'capture_attempt',
    eventSource,
    bookingId: booking.id,
    paymentIntentId: booking.stripe_payment_intent_id,
    idempotencyKey,
    status: 'processing',
    metadata: { ref: booking.ref },
  });

  const captured = await stripe.paymentIntents.capture(
    booking.stripe_payment_intent_id,
    { expand: ['latest_charge.balance_transaction'] },
    { idempotencyKey },
  );
  validateSucceededIntent(captured, booking, {
    expectedAmount: booking.total_price,
    allowedTypes: ['customer_booking', 'customer_quote'],
  });

  await writeFinancialAudit(sb, {
    eventType: 'capture_attempt',
    eventSource,
    bookingId: booking.id,
    paymentIntentId: captured.id,
    idempotencyKey,
    status: 'processed',
    metadata: { ref: booking.ref, amountCharged: captured.amount_received || 0 },
  });

  return {
    amountCharged: captured.amount_received,
    actualStripeFee: intentFeeCents(captured),
    balancePaymentIntentId: null,
    balanceAmountCaptured: null,
  };
}

async function captureOrRecoverDepositBalance({ stripe, sb, booking, eventSource }) {
  const totalCents = Number(booking.total_price || 0);
  const depositCents = Number(booking.deposit_amount || 0);
  const balanceCents = totalCents - depositCents;
  const depositIntentId = booking.stripe_deposit_intent_id || booking.stripe_payment_intent_id;

  if (!depositIntentId || depositCents <= 0 || balanceCents < 0) {
    throw paymentError('Deposit payment truth is incomplete. Owner reconciliation is required.', 'DEPOSIT_PAYMENT_TRUTH_INCOMPLETE');
  }

  const depositIntent = await retrieveExpanded(stripe, depositIntentId);
  validateSucceededIntent(depositIntent, booking, {
    expectedAmount: depositCents,
    allowedTypes: ['customer_booking', 'customer_quote', 'customer_booking_deposit'],
  });

  let balanceIntent = null;
  if (balanceCents > 0) {
    if (!booking.stripe_customer_id || !booking.stripe_payment_method_id) {
      throw paymentError('The saved customer or payment method for the balance is missing.', 'DEPOSIT_BALANCE_SOURCE_MISSING');
    }

    const idempotencyKey = `booking-complete-balance-${booking.id}`;
    await writeFinancialAudit(sb, {
      eventType: 'capture_recovery_attempt',
      eventSource,
      bookingId: booking.id,
      paymentIntentId: booking.stripe_balance_payment_intent_id || null,
      idempotencyKey,
      status: 'processing',
      metadata: { ref: booking.ref, depositCents, balanceCents },
    });

    // Once the balance PaymentIntent ID is durable, retrieve it directly. Stripe
    // idempotency keys have a finite retention window, so replaying create days
    // later is not a sufficient duplicate-charge guard by itself.
    balanceIntent = booking.stripe_balance_payment_intent_id
      ? await retrieveExpanded(stripe, booking.stripe_balance_payment_intent_id)
      : await findExistingBalanceIntent(stripe, booking);
    if (!balanceIntent) {
      balanceIntent = await stripe.paymentIntents.create({
          amount: balanceCents,
          currency: 'usd',
          customer: booking.stripe_customer_id,
          payment_method: booking.stripe_payment_method_id,
          confirm: true,
          off_session: true,
          expand: ['latest_charge.balance_transaction'],
          metadata: { bookingRef: booking.ref, bookingId: booking.id, type: 'customer_booking_balance' },
          description: `Balance - ${booking.service} - ${booking.customer_name}`,
        }, { idempotencyKey });
    }

    validateSucceededIntent(balanceIntent, booking, {
      expectedAmount: balanceCents,
      allowedTypes: ['customer_booking_balance'],
    });

    await writeFinancialAudit(sb, {
      eventType: 'capture_recovery_attempt',
      eventSource,
      bookingId: booking.id,
      paymentIntentId: balanceIntent.id,
      idempotencyKey,
      status: 'processed',
      metadata: {
        ref: booking.ref,
        depositCents,
        balanceCents,
        amountCharged: depositCents + Number(balanceIntent.amount_received || 0),
      },
    });
  }

  const depositFee = intentFeeCents(depositIntent);
  const balanceFee = intentFeeCents(balanceIntent);
  const actualStripeFee = depositFee != null && (balanceCents === 0 || balanceFee != null)
    ? depositFee + (balanceFee || 0)
    : null;

  return {
    amountCharged: depositCents + Number(balanceIntent?.amount_received || 0),
    actualStripeFee,
    balancePaymentIntentId: balanceIntent?.id || null,
    balanceAmountCaptured: balanceIntent ? Number(balanceIntent.amount_received || 0) : 0,
  };
}

async function recoverCapturedPayment({ stripe, booking }) {
  const depositFlow = booking.payment_status === 'deposit_paid'
    || booking.is_deposit === true
    || Number(booking.deposit_amount || 0) > 0
    || !!booking.stripe_balance_payment_intent_id;
  if (depositFlow) return null;

  const intent = await retrieveExpanded(stripe, booking.stripe_payment_intent_id);
  validateSucceededIntent(intent, booking, {
    expectedAmount: booking.amount_charged,
    allowedTypes: ['customer_booking', 'customer_quote'],
  });
  return {
    amountCharged: intent.amount_received,
    actualStripeFee: intentFeeCents(intent),
    balancePaymentIntentId: null,
    balanceAmountCaptured: null,
  };
}

export async function captureOrRecoverBookingPayment({ stripe, sb, booking, eventSource }) {
  if (booking.payment_status === 'authorized') {
    return captureAuthorizedPayment({ stripe, sb, booking, eventSource });
  }

  const depositFlow = booking.payment_status === 'deposit_paid'
    || booking.is_deposit === true
    || Number(booking.deposit_amount || 0) > 0
    || !!booking.stripe_balance_payment_intent_id;
  if (depositFlow) {
    return captureOrRecoverDepositBalance({ stripe, sb, booking, eventSource });
  }

  if (booking.payment_status === 'captured') {
    const recovered = await recoverCapturedPayment({ stripe, booking });
    if (recovered) return recovered;
  }

  throw paymentError(`Unsupported booking payment state for completion: ${booking.payment_status || 'missing'}.`, 'PAYMENT_NOT_CAPTURABLE');
}
