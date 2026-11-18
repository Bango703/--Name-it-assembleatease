#!/usr/bin/env node
// Phone hours are one fact (owner, 2026-11-17: "Mon-Fri 7-5, Sat 7-1").
//
// Before this guard the homepage's Organization schema said 8 AM to 8 PM every
// day, the About page said Mon-Fri 7-5 and Sat 7-1, and Sora's overflow
// (supportHours in api/ai/support.js) rang the owner only Mon-Fri 7-5 and
// Sat 7-1. llms.txt and the AI assistant connector read the homepage, so they
// told customers 8 PM while a call at 6 PM would reach Sora, not a person.
//
// The hours a customer is told (contactPoint.hoursAvailable on every page that
// carries the Organization) must equal the hours the phone line rings a person.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportHours } from '../api/ai/support.js';
import { bookingFacts, organization } from '../api/_public-facts.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function orgFrom(file) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of [].concat(data['@graph'] || data)) {
      if (node && node['@type'] === 'Organization' && node.contactPoint) return node;
    }
  }
  return null;
}

// Is a person reachable at this Central-time weekday and minute, per the schema?
function schemaOpen(org, day, minute) {
  for (const spec of [].concat(org.contactPoint || []).flatMap((c) => [].concat(c.hoursAvailable || []))) {
    const days = [].concat(spec.dayOfWeek || []).map((d) => String(d).replace(/^https?:\/\/schema\.org\//, ''));
    if (!days.includes(day)) continue;
    const [oh, om] = String(spec.opens).split(':').map(Number);
    const [ch, cm] = String(spec.closes).split(':').map(Number);
    if (minute >= oh * 60 + om && minute < ch * 60 + cm) return true;
  }
  return false;
}

const pages = ['index.html', 'about.html'];
const orgs = pages.map((file) => [file, orgFrom(file)]).filter(([, org]) => org);
assert.ok(orgs.some(([file]) => file === 'index.html'), 'index.html carries the Organization contact hours');

// A Wednesday and a Saturday and a Sunday in November (CST, UTC-6), every 30 minutes.
const samples = [];
for (const [date, day] of [['2026-11-18', 'Wednesday'], ['2026-11-21', 'Saturday'], ['2026-11-22', 'Sunday']]) {
  for (let minute = 0; minute < 24 * 60; minute += 30) {
    const utc = new Date(`${date}T00:00:00Z`);
    utc.setUTCMinutes(minute + 6 * 60);
    samples.push({ day, minute, at: utc });
  }
}

let checked = 0;
for (const [file, org] of orgs) {
  for (const { day, minute, at } of samples) {
    const phone = supportHours(at).humanSupportOpen;
    const told = schemaOpen(org, day, minute);
    assert.equal(told, phone, `${file} says ${told ? 'open' : 'closed'} on ${day} at ${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}, the phone line rings a person: ${phone}`);
    checked += 1;
  }
}

// What assistants are told comes from the same schema.
const facts = bookingFacts({ org: organization(), services: ['Furniture Assembly'] });
assert.match(facts.contact, /Monday to Friday, 7 AM to 5 PM; Saturday, 7 AM to 1 PM/, 'llms.txt and the connector state the phone hours');
assert.match(readFileSync('llms.txt', 'utf8'), /Phone and email hours: Monday to Friday, 7 AM to 5 PM; Saturday, 7 AM to 1 PM\./, 'llms.txt is regenerated');
assert.match(supportHours(new Date()).humanSupportHours, /Monday-Friday 7 AM-5 PM; Saturday 7 AM-1 PM; closed Sunday/);

console.log(`PASS phone hours: ${orgs.map(([f]) => f).join(' and ')} match the hours the phone line rings a person (${checked} checks); llms.txt and the AI connector say the same.`);
