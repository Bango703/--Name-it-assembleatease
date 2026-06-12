import { verifyOwner } from '../_email.js';

const MIN_SECRET_LENGTH = 24;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const target = normalizeTarget(req.query.target);
  const checks = [
    checkUrl('SUPABASE_URL', { required: true, startsWith: 'https://' }),
    checkSecret('SUPABASE_SERVICE_KEY', { required: true }),
    checkSecret('OWNER_PASSWORD', { required: true }),
    checkSecret('CRON_SECRET', { required: true }),
    checkSecret('RESEND_API_KEY', { required: true }),
    checkSecret('GEOAPIFY_API_KEY', { required: true }),

    checkStripeKey('STRIPE_SECRET_KEY', 'secret', target),
    checkStripeKey('STRIPE_PUBLISHABLE_KEY', 'publishable', target),
    checkWebhookSecret('STRIPE_WEBHOOK_SECRET', { required: true }),
    checkWebhookSecret('STRIPE_IDENTITY_WEBHOOK_SECRET', { required: true }),

    checkConnectMode(),
    checkOptionalSecret('AAE_EASER_MEMBERSHIP', 'Required only if Easer membership checkout is enabled.'),
    checkOptionalSecret('VAPID_PUBLIC_KEY', 'Required only if push notifications are enabled.'),
    checkOptionalSecret('VAPID_PRIVATE_KEY', 'Required only if push notifications are enabled.'),
  ];

  const stripeModeCheck = checkStripeModePair(target);
  if (stripeModeCheck) checks.push(stripeModeCheck);

  const failed = checks.filter(check => check.status === 'fail');
  const warnings = checks.filter(check => check.status === 'warning');
  const status = failed.length ? 'fail' : warnings.length ? 'warning' : 'pass';

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    status,
    target,
    generatedAt: new Date().toISOString(),
    checks,
    nextRequiredActions: failed.map(check => check.action).filter(Boolean),
  });
}

function normalizeTarget(raw) {
  const fromQuery = String(raw || '').toLowerCase();
  if (fromQuery === 'test' || fromQuery === 'live') return fromQuery;
  return process.env.VERCEL_ENV === 'production' ? 'live' : 'test';
}

function checkUrl(name, { required, startsWith }) {
  const value = cleanEnv(name);
  if (!value) return requiredCheck(name, required, `Set ${name}.`);
  if (startsWith && !value.startsWith(startsWith)) {
    return fail(name, `${name} should start with ${startsWith}.`, `Update ${name} in production env.`);
  }
  return pass(name, `${name} is set.`);
}

function checkSecret(name, { required }) {
  const value = cleanEnv(name);
  if (!value) return requiredCheck(name, required, `Set ${name}.`);
  if (looksPlaceholder(value) || value.length < MIN_SECRET_LENGTH) {
    return fail(name, `${name} looks empty, too short, or placeholder-like.`, `Paste a real ${name} value.`);
  }
  return pass(name, `${name} is set.`);
}

function checkOptionalSecret(name, note) {
  const value = cleanEnv(name);
  if (!value) return warning(name, `${name} is not set. ${note}`, `Set ${name} before enabling that feature.`);
  if (looksPlaceholder(value)) return warning(name, `${name} looks placeholder-like. ${note}`, `Replace ${name} before enabling that feature.`);
  return pass(name, `${name} is set.`);
}

function checkStripeKey(name, kind, target) {
  const value = cleanEnv(name);
  if (!value) return fail(name, `${name} is missing.`, `Set ${name} using a ${target} Stripe ${kind} key.`);
  if (looksPlaceholder(value)) return fail(name, `${name} looks placeholder-like.`, `Paste a real ${target} Stripe ${kind} key.`);

  const expectedPrefix = kind === 'secret'
    ? (target === 'live' ? 'sk_live_' : 'sk_test_')
    : (target === 'live' ? 'pk_live_' : 'pk_test_');

  if (!value.startsWith(expectedPrefix)) {
    return fail(
      name,
      `${name} is not a ${target} ${kind} key.`,
      `Replace ${name} with a ${target} Stripe ${kind} key from the same Stripe account.`,
    );
  }

  return pass(name, `${name} is a ${target} ${kind} key.`);
}

function checkWebhookSecret(name, { required }) {
  const value = cleanEnv(name);
  if (!value) return requiredCheck(name, required, `Set ${name} from the Stripe live webhook endpoint signing secret.`);
  if (looksPlaceholder(value) || !value.startsWith('whsec_')) {
    return fail(name, `${name} must be a Stripe webhook signing secret.`, `Paste the whsec_ value for ${name}.`);
  }
  return pass(name, `${name} is set.`);
}

function checkStripeModePair(target) {
  const secret = cleanEnv('STRIPE_SECRET_KEY');
  const publishable = cleanEnv('STRIPE_PUBLISHABLE_KEY');
  if (!secret || !publishable) return null;

  const secretMode = secret.startsWith('sk_live_') ? 'live' : secret.startsWith('sk_test_') ? 'test' : 'unknown';
  const pubMode = publishable.startsWith('pk_live_') ? 'live' : publishable.startsWith('pk_test_') ? 'test' : 'unknown';

  if (secretMode !== pubMode) {
    return fail('STRIPE_KEY_MODE_MATCH', 'Stripe secret and publishable keys are from different modes.', 'Use matching live/live or test/test Stripe keys.');
  }
  if (secretMode !== target) {
    return fail('STRIPE_KEY_TARGET_MATCH', `Stripe keys are ${secretMode}, but readiness target is ${target}.`, `Use ${target} Stripe keys for this environment.`);
  }
  return pass('STRIPE_KEY_MODE_MATCH', `Stripe keys both use ${target} mode.`);
}

function checkConnectMode() {
  const enabled = String(process.env.STRIPE_CONNECT_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) {
    return warning('STRIPE_CONNECT_ENABLED', 'Stripe Connect payouts are disabled. Manual payouts remain required.', 'Keep false until live Connect onboarding and transfer testing passes.');
  }
  return warning('STRIPE_CONNECT_ENABLED', 'Stripe Connect payouts are enabled. Confirm live connected accounts and payout tests before launch.', 'Run a controlled live Connect payout test before relying on automated payouts.');
}

function cleanEnv(name) {
  return String(process.env[name] || '').trim().replace(/^['"]|['"]$/g, '');
}

function looksPlaceholder(value) {
  return !value
    || value.includes('...')
    || /your-|paste-|placeholder|example|changeme|todo/i.test(value);
}

function requiredCheck(name, required, action) {
  return required ? fail(name, `${name} is missing.`, action) : warning(name, `${name} is not set.`, action);
}

function pass(id, message) {
  return { id, status: 'pass', message };
}

function warning(id, message, action) {
  return { id, status: 'warning', message, action };
}

function fail(id, message, action) {
  return { id, status: 'fail', message, action };
}
