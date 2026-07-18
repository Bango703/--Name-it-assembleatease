import { verifyOwner } from '../_email.js';
import { getSupabase } from '../_supabase.js';

const MIN_SECRET_LENGTH = 24;
const REQUIRED_SCHEMA_MIGRATION = 41;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const target = normalizeTarget(req.query.target);
  const checks = [
    checkUrl('SUPABASE_URL', { required: true, startsWith: 'https://' }),
    checkSecret('SUPABASE_SERVICE_KEY', { required: true }),
    checkSecret('OWNER_PASSWORD', { required: true }),
    checkSecret('OWNER_SESSION_SECRET', { required: true, minLength: 32 }),
    checkSecret('GUEST_ACCESS_TOKEN_SECRET', { required: true, minLength: 32 }),
    checkSecret('UPSTASH_REDIS_REST_URL', { required: true }),
    checkSecret('UPSTASH_REDIS_REST_TOKEN', { required: true }),
    checkSecret('CRON_SECRET', { required: true }),
    checkSecret('RESEND_API_KEY', { required: true }),
    checkSecret('GEOAPIFY_API_KEY', { required: true }),

    checkStripeKey('STRIPE_SECRET_KEY', 'secret', target),
    checkStripeKey('STRIPE_PUBLISHABLE_KEY', 'publishable', target),
    checkWebhookSecret('STRIPE_WEBHOOK_SECRET', { required: true, target }),
    checkWebhookSecret('STRIPE_IDENTITY_WEBHOOK_SECRET', { required: true, target }),
    checkRequiredApproval(
      'TEXAS_TAX_CONFIGURATION_APPROVED',
      'A Texas tax professional must approve the launch service classifications and address-sourcing configuration before live charging.',
    ),

    checkConnectMode(),
    checkEaserMembershipMode(),
    checkContentPublishingMode(),
    checkPushMode(),
  ];

  const stripeModeCheck = checkStripeModePair(target);
  if (stripeModeCheck) checks.push(stripeModeCheck);

  checks.push(await checkSchemaState());

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

async function checkSchemaState() {
  try {
    const { data, error } = await getSupabase().from('platform_schema_state')
      .select('migration_number, migration_name, applied_at')
      .eq('migration_number', REQUIRED_SCHEMA_MIGRATION)
      .maybeSingle();
    if (error || !data) {
      return fail(
        'DATABASE_SCHEMA_041',
        `Launch migration ${REQUIRED_SCHEMA_MIGRATION} is not verified in this environment.`,
        'Apply migrations 038-041 in order and rerun readiness.',
      );
    }
    return pass('DATABASE_SCHEMA_041', `Launch schema ${data.migration_number} is applied.`);
  } catch (error) {
    return fail(
      'DATABASE_SCHEMA_041',
      'Could not verify the launch database schema.',
      'Confirm Supabase connectivity and apply migrations 038-041 in order.',
    );
  }
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

function checkSecret(name, { required, minLength = MIN_SECRET_LENGTH }) {
  const value = cleanEnv(name);
  if (!value) return requiredCheck(name, required, `Set ${name}.`);
  if (looksPlaceholder(value) || value.length < minLength) {
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

function checkPushMode() {
  const publicKey = cleanEnv('VAPID_PUBLIC_KEY');
  const privateKey = cleanEnv('VAPID_PRIVATE_KEY');
  if (!publicKey && !privateKey) {
    return pass('PUSH_NOTIFICATIONS', 'Push notifications are disabled; Easer email notifications remain active.');
  }
  if (!publicKey || !privateKey || looksPlaceholder(publicKey) || looksPlaceholder(privateKey)) {
    return fail('PUSH_NOTIFICATIONS', 'Push notification configuration is incomplete.', 'Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or remove both to keep push disabled.');
  }
  return pass('PUSH_NOTIFICATIONS', 'Push notifications are configured.');
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

function checkWebhookSecret(name, { required, target }) {
  const value = cleanEnv(name);
  if (!value) return requiredCheck(name, required, `Set ${name} from the Stripe ${target} webhook endpoint signing secret.`);
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
    return pass('STRIPE_CONNECT_ENABLED', 'Manual payout launch mode is active; Stripe Connect is disabled.');
  }
  if (cleanEnv('STRIPE_CONNECT_LIVE_VALIDATED').toLowerCase() !== 'true') {
    return fail('STRIPE_CONNECT_LIVE_VALIDATED', 'Stripe Connect is enabled without recorded live end-to-end validation.', 'Disable Stripe Connect or complete connected-account, transfer, and bank-payout reconciliation tests, then set STRIPE_CONNECT_LIVE_VALIDATED=true.');
  }
  return pass('STRIPE_CONNECT_LIVE_VALIDATED', 'Stripe Connect live validation is recorded for this environment.');
}

function checkEaserMembershipMode() {
  const enabled = cleanEnv('EASER_MEMBERSHIP_ENABLED').toLowerCase() === 'true';
  if (!enabled) {
    return pass('EASER_MEMBERSHIP_ENABLED', 'Easer membership enrollment, fee discounts, and dispatch priority are disabled for launch.');
  }
  const priceId = cleanEnv('AAE_EASER_MEMBERSHIP');
  if (!priceId || looksPlaceholder(priceId) || !priceId.startsWith('price_')) {
    return fail(
      'AAE_EASER_MEMBERSHIP',
      'Easer membership is enabled without a valid Stripe recurring price.',
      'Disable EASER_MEMBERSHIP_ENABLED or set a validated Stripe price and complete billing tests.',
    );
  }
  return warning(
    'EASER_MEMBERSHIP_ENABLED',
    'Easer membership is enabled. Confirm updated contractor terms and end-to-end billing before launch.',
    'Validate enrollment, webhook renewal/cancellation, dispatch priority, and fee snapshots.',
  );
}

function checkContentPublishingMode() {
  const blogEnabled = cleanEnv('AUTO_BLOG_PUBLISH_ENABLED').toLowerCase() === 'true';
  const socialEnabled = cleanEnv('SOCIAL_AUTO_PUBLISH').toLowerCase() === 'true';
  if (!blogEnabled && !socialEnabled) {
    return pass('AUTOMATIC_CONTENT_PUBLISHING', 'Automatic website and Buffer publishing are disabled for launch.');
  }
  return warning(
    'AUTOMATIC_CONTENT_PUBLISHING',
    'Automatic content publishing is enabled in this environment.',
    'Disable AUTO_BLOG_PUBLISH_ENABLED and SOCIAL_AUTO_PUBLISH until owner-reviewed blog and Buffer queue tests pass.',
  );
}

function checkRequiredApproval(name, note) {
  const approved = cleanEnv(name).toLowerCase() === 'true';
  if (!approved) {
    return fail(name, `${name} is not approved. ${note}`, `Complete the required review, then set ${name}=true in production.`);
  }
  return pass(name, `${name} is approved for this environment.`);
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
