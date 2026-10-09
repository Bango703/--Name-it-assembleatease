/**
 * Demo Easer accounts (App Store review and similar).
 *
 * Owner, 2026-10-09: Apple's reviewer needs an Easer login that can see every
 * screen and run a whole job, but a reviewer must never be sent to a real
 * customer's home. A profile with is_demo_account = true is a working Easer for
 * TEST bookings only:
 *   - dispatch never offers it a real booking (and never emails it a nudge)
 *   - the owner cannot assign it, or add it as crew, to a real booking
 *   - it cannot accept a real booking, even with a stale offer link
 * Test bookings (bookings.is_test_booking) work for it exactly as for anyone.
 *
 * SAFE BEFORE THE MIGRATION. The flag is read with its own query, never added to
 * an existing select. Until migration 106 adds the column, the lookup reports
 * that no demo accounts exist, so every path behaves exactly as it did before.
 */

const DEMO_REAL_BOOKING_MESSAGE =
  'This is a demo account. It can only be given test bookings, never a real customer job.';

function isMissingColumn(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /42703|PGRST204|is_demo_account/i.test(text);
}

/** Every demo Easer id. A missing column means none exist yet. */
export async function loadDemoEaserIds(sb) {
  try {
    const { data, error } = await sb.from('profiles').select('id').eq('is_demo_account', true);
    if (error) {
      if (!isMissingColumn(error)) console.error('[demo-accounts] lookup failed:', error.message || error);
      return new Set();
    }
    return new Set((data || []).map(row => row.id).filter(Boolean));
  } catch (error) {
    console.error('[demo-accounts] lookup failed:', error?.message || error);
    return new Set();
  }
}

export async function isDemoEaser(sb, easerId) {
  if (!easerId) return false;
  try {
    const { data, error } = await sb.from('profiles').select('is_demo_account').eq('id', easerId).maybeSingle();
    if (error) {
      if (!isMissingColumn(error)) console.error('[demo-accounts] lookup failed:', error.message || error);
      return false;
    }
    return data?.is_demo_account === true;
  } catch (error) {
    console.error('[demo-accounts] lookup failed:', error?.message || error);
    return false;
  }
}

/** The one rule: a demo account may only touch a test booking. */
export function demoBookingBlock(booking, easerIsDemo) {
  if (easerIsDemo !== true) return null;
  if (booking?.is_test_booking === true) return null;
  return { code: 'DEMO_ACCOUNT_REAL_BOOKING', message: DEMO_REAL_BOOKING_MESSAGE };
}

/** Drops demo Easers from a candidate list unless the booking is a test booking. */
export function withoutDemoEasers(easers, demoIds, booking) {
  if (booking?.is_test_booking === true || !demoIds?.size) return easers;
  return (easers || []).filter(easer => !demoIds.has(easer.id));
}
