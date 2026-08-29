#!/usr/bin/env node

/**
 * An Easer's photo is INTERNAL until a human says otherwise.
 *
 * booking_evidence.visibility has always defaulted to 'owner'. Nothing read it.
 * Every photo an Easer uploaded was emailed to the customer, embedded on the
 * tracking page, shown on the review page, and attached to the review request —
 * behind signed URLs valid for up to thirty days. A selfie, an ID, a photo of
 * the wrong room, anything the camera produced went straight to the customer.
 *
 * The root cause was one query answering two different questions:
 *
 *   "Did the Easer provide completion evidence?"  gates COMPLETION
 *   "May the customer be shown this image?"       gates PUBLICATION
 *
 * They are now separate functions. Completion still requires a photo — that
 * gate is deliberately untouched. Publishing one now requires a decision.
 *
 * This guard exists because the failure is silent and one-way: nobody notices
 * a photo that should not have been sent until the customer has already seen it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = p => fs.readFile(new URL('../' + p, import.meta.url), 'utf8');

const loader = await read('api/booking/_completion-evidence.js');
const easerComplete = await read('api/booking/assembler-complete.js');
const ownerComplete = await read('api/booking/complete.js');
const track = await read('api/booking/track.js');
const reviewEmail = await read('api/_review-email.js');
const evidenceApi = await read('api/booking/evidence.js');
const easerUi = await read('assembler/my-assignments.html');
const ownerUi = await read('owner/index.html');

// ── The gate itself ────────────────────────────────────────────────────────
{
  assert.ok(loader.includes("export const CUSTOMER_FACING_VISIBILITY = 'all';"),
    'the value that means "approved for the customer" must be named in one place');
  assert.ok(loader.includes('export async function loadCustomerFacingCompletionPhoto'),
    'there must be a distinct loader for the photo a customer may see');
  assert.ok(loader.includes("query = query.eq('visibility', CUSTOMER_FACING_VISIBILITY)"),
    'the customer-facing query must filter on visibility');

  // Defence in depth: even if the filter above were removed, a row that was
  // never promoted must not be returned on the customer path.
  assert.ok(loader.includes("const visibilityOk = !customerFacingOnly || data?.visibility === CUSTOMER_FACING_VISIBILITY;"),
    'the result must be re-checked, not trusted from the query alone');
  assert.ok(loader.includes("reason: 'not_approved_for_customer'"),
    'the refusal must state its real reason rather than look like a missing photo');

  // The customer-facing loader must actually SELECT visibility, or the check
  // above silently compares against undefined.
  assert.ok(/loadCustomerFacingCompletionPhoto[\s\S]{0,400}created_at, visibility/.test(loader),
    'the customer-facing select must include visibility or the check is vacuous');
  console.log('PASS only a promoted photo can be loaded for a customer');
}

// ── Every customer-facing surface uses it ──────────────────────────────────
{
  const surfaces = [
    ['api/booking/assembler-complete.js', easerComplete, 'the Easer completion receipt'],
    ['api/booking/complete.js', ownerComplete, 'the owner completion receipt'],
    ['api/booking/track.js', track, 'the customer tracking page (and the review page, which reads it)'],
    ['api/_review-email.js', reviewEmail, 'the review request email'],
  ];
  for (const [file, src, what] of surfaces) {
    assert.ok(src.includes('loadCustomerFacingCompletionPhoto'),
      `${what} (${file}) must load only an approved photo`);
  }

  // The two completion handlers legitimately use BOTH: the raw loader for the
  // completion gate, the customer-facing one for the email. Everywhere else,
  // reaching for the raw loader on a customer surface is the original bug.
  for (const [file, src] of [['api/booking/track.js', track], ['api/_review-email.js', reviewEmail]]) {
    assert.ok(!src.includes('loadCurrentCompletionEvidence'),
      `${file} shows a customer — it must not reach for the ungated loader`);
  }
  console.log('PASS every customer surface reads the approved photo, not the raw upload');
}

// ── Completion still requires a photo — that gate is untouched ─────────────
{
  assert.ok(easerComplete.includes('const completionEvidenceResult = await loadCurrentCompletionEvidence(sb, booking);'),
    'the Easer completion gate must keep using the raw loader — a photo is still required to complete');
  assert.ok(easerComplete.includes('A completion photo is required.'),
    'the completion requirement must not have been weakened by the privacy fix');
  // The owner path now also accepts a photo the OWNER supplied for the Easer.
  // That is a deadlock fix, not a weakening: without it an Easer who cannot
  // upload makes the job unfinishable by anyone. A photo is still mandatory —
  // it simply no longer has to come from a person who has stopped responding.
  assert.ok(ownerComplete.includes('loadCurrentCompletionEvidence(sb, booking, {'),
    'the owner completion gate must still demand evidence');
  assert.ok(ownerComplete.includes('acceptSuppliedOnBehalf: true'),
    'the owner may rely on evidence they supplied, or an unresponsive Easer strands the job');
  assert.ok(!/acceptSuppliedOnBehalf/.test(easerComplete),
    'an Easer completing their own job must never be able to lean on someone else\'s photo');
  console.log('PASS completion still requires a photo; only publication and who may supply it changed');
}

// ── No approved photo must not break the email ────────────────────────────
{
  // The receipt builds photoBlock as '' and interpolates it. An absent photo
  // has to mean an absent SECTION, never a failed send (Rule 7).
  for (const [file, src] of [['assembler-complete', easerComplete], ['complete', ownerComplete]]) {
    assert.ok(src.includes("let photoBlock = '';"),
      `${file} must default to no photo section`);
    assert.ok(/const \{ evidence: shareable \} = await loadCustomerFacingCompletionPhoto/.test(src),
      `${file} must look up the shareable photo separately from the completion gate`);
    assert.ok(/shareable\?\.storage_path/.test(src),
      `${file} must tolerate there being no approved photo at all`);
  }
  console.log('PASS with nothing approved the receipt still sends, just without the section');
}

// ── Promotion is deliberate, typed, and singular ───────────────────────────
{
  assert.ok(evidenceApi.includes("if (req.method === 'POST')"), 'there must be a way to designate a photo');
  assert.ok(evidenceApi.includes('if (!verifyOwner(req)) return res.status(401)'),
    'designating a customer-facing photo must be owner-only');
  assert.ok(evidenceApi.includes("row.evidence_type !== 'completion_photo'"),
    'damage claims and before-photos must never be promotable to customer-facing');
  assert.ok(evidenceApi.includes("code: 'NOT_SHAREABLE_TYPE'"),
    'the refusal must carry a reason the UI can show');

  // Every customer surface takes the most recent approved row, so more than one
  // approved photo would make the choice a timestamp accident.
  assert.ok(evidenceApi.includes(".update({ visibility: 'owner' })") && evidenceApi.includes(".neq('id', evidenceId)"),
    'promoting one photo must demote the others, or which photo the customer sees is arbitrary');
  console.log('PASS only the owner can promote, only a completion photo, and only one');
}

// ── The people involved are told ───────────────────────────────────────────
{
  const instruction = 'Do not upload selfies, faces, IDs, personal documents, or unrelated images.';
  assert.ok(easerUi.includes(instruction),
    'the Easer must be told plainly what not to upload');
  assert.ok((easerUi.match(/Do not upload selfies/g) || []).length >= 2,
    'the instruction must appear at BOTH upload points, not just the main one');

  assert.ok(ownerUi.includes('window.setEvidenceCustomerFacing'),
    'the owner needs a control to designate the customer-facing photo');
  assert.ok(ownerUi.includes('SHOWN TO CUSTOMER'),
    'the owner must be able to see at a glance which photo the customer gets');
  assert.ok(ownerUi.includes('Share with customer') && ownerUi.includes('Stop sharing'),
    'sharing must be reversible from the same place it is granted');
  console.log('PASS the Easer is instructed and the owner can see and change what is shared');
}

console.log('\nCompletion photo privacy tests passed.');
