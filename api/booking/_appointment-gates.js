import { appointmentTimestampMs } from './_appt-date.js';

// Austin launch operations permit modest early arrival when the customer agrees,
// but block impossible status changes hours or days before the appointment.
export const EASER_STAGE_EARLY_WINDOW_MINUTES = Object.freeze({
  en_route: 120,
  arrived: 60,
  in_progress: 30,
  completed: 30,
});

const STAGE_LABELS = Object.freeze({
  en_route: 'On the Way',
  arrived: 'Arrived',
  in_progress: 'Start Job',
  completed: 'Complete Job',
});

function friendlyWindow(mins) {
  if (mins % 60 === 0) { const h = mins / 60; return `${h} hour${h > 1 ? 's' : ''}`; }
  return `${mins} minutes`;
}

function friendlyDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return String(dateStr || '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function evaluateEaserAppointmentGate({ date, time, stage, nowMs = Date.now() } = {}) {
  const earlyMinutes = EASER_STAGE_EARLY_WINDOW_MINUTES[stage];
  if (!Number.isFinite(earlyMinutes)) {
    return { allowed: false, code: 'APPOINTMENT_STAGE_INVALID', error: 'Unsupported appointment stage.' };
  }

  const appointmentMs = appointmentTimestampMs(date, time);
  if (!Number.isFinite(appointmentMs)) {
    return {
      allowed: false,
      code: 'APPOINTMENT_TIME_INVALID',
      error: 'The appointment date or time could not be verified. Contact support before updating this job.',
    };
  }

  const earliestMs = appointmentMs - earlyMinutes * 60 * 1000;
  if (Number(nowMs) < earliestMs) {
    return {
      allowed: false,
      code: 'APPOINTMENT_STAGE_TOO_EARLY',
      error: `You can mark "${STAGE_LABELS[stage]}" starting ${friendlyWindow(earlyMinutes)} before the appointment — ${friendlyDate(date)}${time ? ' at ' + time : ''}. Check back then.`,
      appointmentAt: new Date(appointmentMs).toISOString(),
      earliestAt: new Date(earliestMs).toISOString(),
      earlyWindowMinutes: earlyMinutes,
    };
  }

  return {
    allowed: true,
    code: null,
    appointmentAt: new Date(appointmentMs).toISOString(),
    earliestAt: new Date(earliestMs).toISOString(),
    earlyWindowMinutes: earlyMinutes,
  };
}
