/**
 * How long a job actually took.
 *
 * WHY THIS EXISTS
 * Every booking already carries the stamps: job_started_at is written when the
 * Easer taps Start Job, completed_at when they tap Mark Complete. Nothing ever
 * turned the pair into a number. The Easer saw a live "Time on site" ticker on
 * their own phone and it was thrown away the moment the job closed, so the one
 * question that tells you whether a flat rate matches the actual work had no
 * answer anywhere in the platform.
 *
 * This is the ONE place that math lives. The owner dashboard reads it for the
 * per-job field and for the by-service rollup, and scripts/test-job-duration.mjs
 * exercises this exact file, so the tested code and the shipped code are the
 * same code.
 *
 * WHAT IT REFUSES TO DO
 * A missing stamp returns null, never zero. An owner-recorded offline job is
 * written straight to completed with no start time (api/owner/create-booking.js),
 * and counting those as instant work would drag every average toward zero and
 * quietly lie about the crew. Article 16: a number we cannot stand behind is
 * not shown as a number.
 */
(function (global) {
  'use strict';

  function stamp(row, snake, camel) {
    var raw = row && (row[snake] != null ? row[snake] : row[camel]);
    if (raw == null || raw === '') return null;
    var ms = raw instanceof Date ? raw.getTime() : Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Milliseconds from Start Job to Mark Complete, or null when it cannot be known.
   * Accepts a raw booking row (snake_case) or a finance ledger row (camelCase).
   */
  function jobDurationMs(booking) {
    var started = stamp(booking, 'job_started_at', 'jobStartedAt');
    var finished = stamp(booking, 'completed_at', 'completedAt');
    if (started == null || finished == null) return null;
    var span = finished - started;
    // A job cannot finish before it starts. A non-positive span means a clock
    // skew or a mis-tap, not a fast job, so it is unknown rather than zero.
    return span > 0 ? span : null;
  }

  /** "1h 45m", "45m", "2h". Null in, null out, so callers must say "Not recorded". */
  function formatJobDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
    var minutes = Math.round(ms / 60000);
    if (minutes < 60) return minutes + 'm';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return rest ? hours + 'h ' + rest + 'm' : hours + 'h';
  }

  function median(sorted) {
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  /**
   * Roll a set of bookings up.
   * `missing` is reported, never hidden: it is how the owner knows the average
   * describes 12 jobs and not the 19 they are looking at.
   */
  function summarize(bookings) {
    var spans = [];
    var missing = 0;
    (bookings || []).forEach(function (booking) {
      var ms = jobDurationMs(booking);
      if (ms == null) { missing += 1; return; }
      spans.push(ms);
    });
    if (!spans.length) return { count: 0, missing: missing, averageMs: null, medianMs: null, longestMs: null };
    spans.sort(function (a, b) { return a - b; });
    var total = spans.reduce(function (sum, ms) { return sum + ms; }, 0);
    return {
      count: spans.length,
      missing: missing,
      averageMs: Math.round(total / spans.length),
      // The median is the planning number. One job left running overnight before
      // someone remembered to close it would otherwise set the expectation.
      medianMs: median(spans),
      longestMs: spans[spans.length - 1],
    };
  }

  /** Same rollup, grouped by service, longest typical job first. */
  function byService(bookings) {
    var groups = {};
    var order = [];
    (bookings || []).forEach(function (booking) {
      var service = (booking && booking.service) || 'Other';
      if (!groups[service]) { groups[service] = []; order.push(service); }
      groups[service].push(booking);
    });
    return order.map(function (service) {
      var stats = summarize(groups[service]);
      stats.service = service;
      return stats;
    }).filter(function (stats) {
      return stats.count > 0;
    }).sort(function (a, b) {
      return b.medianMs - a.medianMs;
    });
  }

  global.AAE_JOB_DURATION = {
    jobDurationMs: jobDurationMs,
    formatJobDuration: formatJobDuration,
    summarize: summarize,
    byService: byService,
  };
})(typeof window !== 'undefined' ? window : globalThis);
