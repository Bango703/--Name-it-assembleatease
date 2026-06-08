import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = [
  'api/booking.js',
  'api/booking-confirmed.js',
  'api/booking/complete.js',
  'api/booking/assembler-complete.js',
  'api/booking/payout.js',
  'api/booking/refund.js',
  'api/assembler/apply.js',
  'api/assembler/stripe-webhook.js',
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

const staleCopyChecks = [
  {
    file: 'api/booking/payout.js',
    blocked: ['Payout Sent', 'we sent a payout', "you've been paid"],
  },
  {
    file: 'terms.html',
    blocked: ['always uses Stripe Connect', 'non-refundable $30 application fee'],
  },
];

for (const check of staleCopyChecks) {
  const text = readFileSync(check.file, 'utf8').toLowerCase();
  for (const phrase of check.blocked) {
    if (text.includes(phrase.toLowerCase())) {
      throw new Error(`Stale launch-risk copy found in ${check.file}: ${phrase}`);
    }
  }
}

console.log('Smoke checks passed');
