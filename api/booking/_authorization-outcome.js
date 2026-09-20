// ─── What did a scheduled authorization attempt actually mean? ───────────────
//
// On 2026-09-19 the scheduled hold for AAE-DVSNHXE4OO was created and never
// confirmed: the confirm call failed before it reached Stripe, so the
// PaymentIntent sat at `requires_confirmation` with `last_payment_error: null`
// and Stripe's event log held nothing but `payment_intent.created`. The cron
// treated that state as "the customer's bank wants another confirmation". It
// emailed the customer to re-confirm a card she had already given, told the
// assigned Easer not to travel, and moved the booking to a status its own retry
// query cannot see. Nothing outside the platform had gone wrong.
//
// Three states were being funnelled into one message, so they are separated
// here, once, and every caller reads the verdict from this module:
//
//   authorized       Stripe holds the money. Nobody needs to do anything.
//   customer_action  Stripe asked the cardholder to authenticate, or the issuer
//                    refused the card. ONLY this reaches the customer.
//   platform_retry   We never got a confirmation to Stripe. Nobody outside this
//                    system is told; the booking stays where the next run finds
//                    it, and the owner is told what actually failed.
//   unexpected       Anything else. The owner reconciles before dispatch.
//
// Article 16: the reason shown to a human is the reason Stripe gave, or an
// honest statement that the request never got there — never a guess about a
// bank that was never asked.

const CARD_ERROR_TYPES = new Set(['StripeCardError', 'card_error']);

function isIssuerError(error) {
  if (!error) return false;
  return CARD_ERROR_TYPES.has(error.type) || CARD_ERROR_TYPES.has(error.rawType);
}

// Stripe received the request and refused it: wrong parameters, not a wrong
// card. Always a fault on this side.
function isRequestRejection(error) {
  if (!error) return false;
  return error.type === 'StripeInvalidRequestError' || error.rawType === 'invalid_request_error';
}

function errorDetail(error) {
  if (!error) return null;
  // Both codes, because they answer different questions: `code` is the class of
  // failure and `decline_code` is the issuer's actual reason. Printing only the
  // first tells the owner "card_declined" and nothing about why.
  const code = [...new Set([error.code, error.decline_code].filter(Boolean))].join('/') || null;
  const message = error.message || null;
  if (code && message) return `${code}: ${message}`;
  return code || message || null;
}

/**
 * @param {object} input
 * @param {string} input.intentStatus     PaymentIntent.status after the attempt.
 * @param {object|null} input.lastPaymentError  PaymentIntent.last_payment_error.
 * @param {object|null} input.confirmError      The error the confirm call threw, if any.
 * @returns {{kind: string, notifyCustomer: boolean, notifyEaser: boolean, retryable: boolean,
 *            code: string, ownerReason: string, customerHeadline: string|null}}
 */
export function classifyAuthorizationOutcome({ intentStatus, lastPaymentError = null, confirmError = null } = {}) {
  const status = String(intentStatus || '');
  const issuerError = lastPaymentError || (isIssuerError(confirmError) ? confirmError : null);
  const detail = errorDetail(issuerError);

  if (status === 'requires_capture') {
    return {
      kind: 'authorized',
      notifyCustomer: false,
      notifyEaser: false,
      retryable: false,
      code: 'AUTHORIZED',
      ownerReason: 'The card hold was authorized.',
      customerHeadline: null,
    };
  }

  // The bank spoke: it wants the cardholder present.
  if (status === 'requires_action') {
    return {
      kind: 'customer_action',
      notifyCustomer: true,
      notifyEaser: true,
      retryable: false,
      code: issuerError?.code || 'authentication_required',
      ownerReason: `The customer's bank asked for authentication${detail ? ` (${detail})` : ''}.`,
      customerHeadline: 'Your bank needs one more confirmation',
    };
  }

  // The bank spoke: it refused the card.
  if (status === 'requires_payment_method' && issuerError) {
    return {
      kind: 'customer_action',
      notifyCustomer: true,
      notifyEaser: true,
      retryable: false,
      code: issuerError.decline_code || issuerError.code || 'card_declined',
      ownerReason: `The customer's bank declined the hold${detail ? ` (${detail})` : ''}.`,
      customerHeadline: 'Your bank declined the hold on your card',
    };
  }

  // We created the hold and never got a confirmation to Stripe: requires_confirmation
  // always means that, and requires_payment_method with no issuer error means the
  // attempt never became a charge either. Neither is the customer's problem.
  if (status === 'requires_confirmation' || status === 'requires_payment_method') {
    return {
      kind: 'platform_retry',
      notifyCustomer: false,
      notifyEaser: false,
      retryable: true,
      code: 'CONFIRMATION_NOT_SENT',
      // Two different failures live here and must not be described the same
      // way: Stripe never answered, or Stripe answered "no, not like that".
      // The second is our bug, and saying "did not reach Stripe" about it sent
      // the owner looking at the network instead of the code.
      ownerReason: isRequestRejection(confirmError)
        ? `Stripe rejected our confirmation request: ${errorDetail(confirmError)}. This is a platform fault, not the customer's card. The booking stays queued.`
        : confirmError
          ? `The hold was created but our confirmation did not reach Stripe (${errorDetail(confirmError) || confirmError.type || 'no response'}). The booking stays queued and retries automatically.`
          : 'The hold was created but never confirmed. The booking stays queued and retries automatically.',
      customerHeadline: null,
    };
  }

  return {
    kind: 'unexpected',
    notifyCustomer: false,
    notifyEaser: false,
    retryable: false,
    code: `UNEXPECTED_${status.toUpperCase() || 'UNKNOWN'}`,
    ownerReason: `Unexpected Stripe payment state (${status || 'unknown'})${detail ? `: ${detail}` : ''}. Reconcile before dispatch.`,
    customerHeadline: null,
  };
}
