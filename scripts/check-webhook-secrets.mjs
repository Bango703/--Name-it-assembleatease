import { readFileSync } from 'fs';
const env = readFileSync('.env.local', 'utf8');
const get = k => { const m = env.match(new RegExp(k + '="?([^"\\n]+)"?')); return m ? m[1].trim() : ''; };
const sk = get('STRIPE_SECRET_KEY');

// Roll the Identity endpoint secret to get a fresh readable copy
// (Stripe does not return secret in GET responses — must roll to see it)
const r = await fetch('https://api.stripe.com/v1/webhook_endpoints/we_1TNy9hCH3MybbJ1M5FW6Wy7f/secret', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: '',
});
const data = await r.json();
console.log('HTTP status:', r.status);
console.log('Response:', JSON.stringify(data, null, 2));
