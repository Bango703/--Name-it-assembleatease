// What a customer is told about booking with AssembleAtEase, written once.
//
// Two places hand these sentences to AI assistants, so they must not drift:
//   scripts/generate-llms.mjs   llms.txt and llms-full.txt (assistants that read the site)
//   api/_mcp-tools.js           the AI assistant connector at /api/mcp (assistants that call it)
// Both read this module. Every sentence is built from the place that owns the fact:
//   contact, hours        the Organization JSON-LD in index.html
//   cancellation terms    CANCELLATION_POLICY in api/_source-of-truth.js
//   service names         the booking catalog (passed in by the caller)
// The sentences are the ones llms.txt carried before this module existed
// (2026-10-21); generate-llms --check proves they did not change in the move.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANCELLATION_POLICY } from './_source-of-truth.js';

let cachedOrganization = null;

/** The Organization node of index.html's JSON-LD: name, phone, email, hours, profiles. */
export function organization(root = process.cwd()) {
  if (cachedOrganization && cachedOrganization.root === root) return cachedOrganization.org;
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of [].concat(data['@graph'] || data)) {
      if (node && node['@type'] === 'Organization') {
        cachedOrganization = { root, org: node };
        return node;
      }
    }
  }
  throw new Error('index.html has no Organization JSON-LD to read contact details from');
}

/** +19792325139 -> (979) 232-5139 */
export function phone(e164) {
  const d = String(e164 || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(e164 || '');
}

/** 08:00 -> 8 AM, 20:30 -> 8:30 PM */
export function clock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

/** Customer-service hours: contactPoint.hoursAvailable on the Organization. */
export function hours(org) {
  const specs = [].concat(org.contactPoint || []).flatMap((c) => [].concat(c.hoursAvailable || []));
  if (!specs.length) throw new Error('index.html Organization JSON-LD has no contactPoint.hoursAvailable');
  return specs.map((s) => {
    const days = [].concat(s.dayOfWeek || []).map((d) => String(d).replace(/^https?:\/\/schema\.org\//, ''));
    const span = days.length > 2 ? `${days[0]} to ${days[days.length - 1]}` : days.join(' and ');
    return `${span}, ${clock(s.opens)} to ${clock(s.closes)}`;
  });
}

/**
 * The booking facts, one sentence each. `services` is the list of service
 * names the caller offers (llms.txt lists the six with pages).
 */
export function bookingFacts({ org, services }) {
  const p = CANCELLATION_POLICY;
  return {
    services: `${services.join(', ')}, and custom quotes for anything else.`,
    where: 'Texas. Core areas are the Austin metro and the San Antonio metro, where a local pro is matched automatically. Other Texas ZIP codes can book and are confirmed by our team.',
    prices: 'fixed and itemized per piece, shown before booking. Texas sales tax is added at checkout.',
    payment: 'you pay after the work is done. A hold for the total is placed on your card before the appointment.',
    cancellation: `free up to ${p.freeWindowHours} hours before the appointment. Inside ${p.freeWindowHours} hours, once a pro has accepted the job, a ${p.lateFeePct}% fee on the service price applies, or ${p.imminentFeePct}% when the pro is already on the way or it is under ${p.imminentWindowHours} hours. No fee applies if no pro has accepted. A booking that was rescheduled no longer has the free window.`,
    customQuotes: 'no card is needed to ask. We email a price; you approve it and add a card to book.',
    pros: 'The pros (called Easers) are independent contractors who bring their own tools.',
    contact: `${phone(org.telephone)}, ${org.email}. Phone and email hours: ${hours(org).join('; ')}. Booking online is open any time.`,
  };
}

// llms.txt labels, in the order the file lists them. `pros` is a full sentence
// with no label.
const FACT_LABELS = [
  ['services', 'Services'],
  ['where', 'Where'],
  ['prices', 'Prices'],
  ['payment', 'Payment'],
  ['cancellation', 'Cancellation'],
  ['customQuotes', 'Custom quotes'],
  ['pros', null],
  ['contact', 'Contact'],
];

/** The facts as llms.txt bullet lines. */
export function factLines(facts) {
  return FACT_LABELS.map(([key, label]) => (label ? `- ${label}: ${facts[key]}` : `- ${facts[key]}`));
}

/** A fact as a sentence of its own: "payment" -> "You pay after the work is done. ..." */
export function factSentence(facts, key) {
  const text = String(facts[key] || '');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}
