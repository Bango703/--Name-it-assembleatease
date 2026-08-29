import crypto from 'crypto';
import { CONTRACTOR_AGREEMENT_VERSION } from './_assembler-onboarding.js';

/**
 * _agreement-versions.js — the ONE answer to "which agreement is required, and
 * who has accepted what".
 *
 * WHY THIS EXISTS
 * The required version was a constant in code, so publishing an agreement meant
 * editing a line and shipping a deploy. Policy is explicit that publishing a
 * contract and releasing software are separate systems: software fixes must
 * flow continuously while agreement versions batch to a monthly review.
 *
 * Acceptance had no history at all. Re-accepting overwrote the profile columns,
 * destroying the record of what someone previously agreed to — the only thing
 * that matters in a dispute.
 *
 * DEPLOY ORDER IS SAFE BY DESIGN
 * Every read falls back to the constant when migration 090 has not run. An
 * agreement gate that fails closed would take every Easer offline the moment
 * this shipped early; one that falls back keeps today's behaviour exactly.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not decide whether an Easer may work. Accepting an agreement clears
 * ONE requirement; suspension, identity verification and every other gate are
 * unchanged and still evaluated by _easer-readiness.js. Acceptance must never
 * reactivate a suspended account.
 */

export const AGREEMENT_DOCUMENT = 'easer_agreement';

export const AGREEMENT_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  SUPERSEDED: 'superseded',
});

/** A missing table means migration 090 has not run yet — never a real failure. */
function isMissingAgreementTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST204') return true;
  return /agreement_versions|agreement_acceptances|does not exist|schema cache/i.test(String(error.message || ''));
}

export function hashAgreementContent(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

/**
 * The version an Easer is currently required to have accepted.
 *
 * Falls back to the compiled constant so behaviour before migration 090 is
 * identical to today. `source` says which answer you got, because a caller
 * showing this to a human should not imply a database record exists when it
 * does not.
 */
export async function getPublishedAgreement(sb, document = AGREEMENT_DOCUMENT) {
  try {
    const { data, error } = await sb
      .from('agreement_versions')
      .select('version, content, content_hash, published_at, effective_at, is_material, is_emergency, change_summary')
      .eq('document', document)
      .eq('status', AGREEMENT_STATUS.PUBLISHED)
      .maybeSingle();
    if (error) {
      if (isMissingAgreementTable(error)) {
        return { version: CONTRACTOR_AGREEMENT_VERSION, source: 'constant', row: null };
      }
      throw error;
    }
    if (!data?.version) {
      return { version: CONTRACTOR_AGREEMENT_VERSION, source: 'constant', row: null };
    }
    return { version: data.version, source: 'database', row: data };
  } catch (err) {
    if (isMissingAgreementTable(err)) {
      return { version: CONTRACTOR_AGREEMENT_VERSION, source: 'constant', row: null };
    }
    throw err;
  }
}

/** The draft being accumulated, if any. Never affects eligibility. */
export async function getDraftAgreement(sb, document = AGREEMENT_DOCUMENT) {
  try {
    const { data, error } = await sb
      .from('agreement_versions')
      .select('id, version, content, content_hash, change_summary, is_material, is_emergency, created_at, updated_at')
      .eq('document', document)
      .eq('status', AGREEMENT_STATUS.DRAFT)
      .maybeSingle();
    if (error) {
      if (isMissingAgreementTable(error)) return null;
      throw error;
    }
    return data || null;
  } catch (err) {
    if (isMissingAgreementTable(err)) return null;
    throw err;
  }
}

/**
 * Append an acceptance to the ledger.
 *
 * The ledger is the record; the profiles columns are a cache of the newest one
 * so existing readiness, apply and approval keep working untouched. Writing the
 * ledger first means a failure loses the cache update, never the evidence.
 *
 * Re-accepting the SAME version is not an error and does not write twice — the
 * unique constraint makes that idempotent, which matters when a phone retries.
 */
export async function recordAgreementAcceptance(sb, {
  profileId,
  version,
  contentHash = null,
  signedName = null,
  ip = null,
  userAgent = null,
  document = AGREEMENT_DOCUMENT,
}) {
  if (!profileId || !version) {
    throw new Error('An agreement acceptance needs both a profile and a version.');
  }
  const acceptedAt = new Date().toISOString();

  let ledgerWritten = false;
  try {
    const { error } = await sb.from('agreement_acceptances').insert({
      profile_id: profileId,
      document,
      version,
      content_hash: contentHash,
      accepted_at: acceptedAt,
      signed_name: signedName,
      ip,
      user_agent: userAgent,
      source: 'live',
    });
    // 23505 = already accepted this exact version. Idempotent, not a failure.
    if (error && error.code !== '23505' && !isMissingAgreementTable(error)) throw error;
    ledgerWritten = !error;
  } catch (err) {
    if (!isMissingAgreementTable(err)) throw err;
  }

  return { acceptedAt, ledgerWritten };
}

/** Everything a person has ever accepted, newest first. */
export async function getAcceptanceHistory(sb, profileId, document = AGREEMENT_DOCUMENT) {
  try {
    const { data, error } = await sb
      .from('agreement_acceptances')
      .select('version, accepted_at, signed_name, source, content_hash')
      .eq('profile_id', profileId)
      .eq('document', document)
      .order('accepted_at', { ascending: false });
    if (error) {
      if (isMissingAgreementTable(error)) return [];
      throw error;
    }
    return data || [];
  } catch (err) {
    if (isMissingAgreementTable(err)) return [];
    throw err;
  }
}

/**
 * Whether this profile has accepted the currently published version.
 *
 * ONE requirement among several. A true here does not mean the Easer may work —
 * suspension, identity verification and the rest are decided elsewhere and are
 * deliberately not consulted.
 */
export async function hasAcceptedCurrentAgreement(sb, profile, document = AGREEMENT_DOCUMENT) {
  const { version } = await getPublishedAgreement(sb, document);
  if (profile?.contractor_agreement_version === version) return { accepted: true, requiredVersion: version };

  try {
    const { data } = await sb
      .from('agreement_acceptances')
      .select('version')
      .eq('profile_id', profile?.id)
      .eq('document', document)
      .eq('version', version)
      .maybeSingle();
    return { accepted: Boolean(data), requiredVersion: version };
  } catch (err) {
    if (isMissingAgreementTable(err)) {
      return { accepted: profile?.contractor_agreement_version === version, requiredVersion: version };
    }
    throw err;
  }
}
