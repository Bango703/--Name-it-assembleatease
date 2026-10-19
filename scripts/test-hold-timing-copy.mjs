#!/usr/bin/env node
// When the card hold is placed is decided by two numbers in _booking-window.js.
// The Terms, the booking page and the chatbot all state it to customers; on
// 2026-10-18 all three still said "five days" while the code used two. This
// test reads the numbers and fails if any sentence disagrees with them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMMEDIATE_AUTHORIZATION_DAYS, SCHEDULED_AUTHORIZATION_LEAD_DAYS, BOOKING_WINDOW_DAYS } from '../api/booking/_booking-window.js';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = n => WORDS[n] || String(n);
const read = p => readFileSync(p, 'utf8');

const lead = word(SCHEDULED_AUTHORIZATION_LEAD_DAYS);
// terms.html still says five days: changing it bumps CUSTOMER_TERMS_VERSION,
// which refuses any checkout open at deploy. It moves with the next Terms
// version (backlog LEGAL-TERMS-DURATION), and this line is added then.
assert.ok(read('book.html').includes(`We will verify it ${lead} days before your visit`), 'the booking page states the hold lead time the code uses');

const chat = read('api/chat.js');
assert.ok(chat.includes(`usually today through ${word(IMMEDIATE_AUTHORIZATION_DAYS)} days ahead`), 'the chatbot states the immediate-hold window');
assert.ok(chat.includes(`${word(IMMEDIATE_AUTHORIZATION_DAYS + 1)} to ${BOOKING_WINDOW_DAYS} days ahead`), 'the chatbot states when a card is saved instead');
assert.ok(chat.includes(`typically about ${lead} days before`), 'the chatbot states the hold lead time');

console.log(`PASS hold timing copy: booking page and chatbot say ${lead} days, as the code does`);
