#!/usr/bin/env node

/**
 * A social post may carry an image OR a link attachment, never both.
 *
 * Buffer rejects the combination outright:
 *   "A link attachment cannot be combined with asset"
 *
 * The image remains attached and the URL moves into the post text. This keeps a
 * visible click path without sending a payload Buffer rejects.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const src = await fs.readFile(new URL('../api/_social-publisher.js', import.meta.url), 'utf8');

// Pull the two helpers out of the module and exercise them for real, rather
// than asserting on source text that could drift from behaviour.
const helperSrc = src.slice(src.indexOf('function withoutLinkAttachments'));
const { withoutLinkAttachments, ensureUrlInText } = new Function(
  helperSrc.split('\nasync function')[0].split('\nfunction textForChannel')[0]
  + '\nreturn { withoutLinkAttachments, ensureUrlInText };',
)();

const URL_ = 'https://www.assembleatease.com/blog/tv-mounting-guide';

// ── The conflict is actually resolved ──────────────────────────────────────
{
  assert.ok(src.includes('if (input.assets.length) {'),
    'the conflict must be resolved only when an asset is actually attached');
  assert.ok(src.includes('input.metadata = withoutLinkAttachments(input.metadata);'),
    'an image post must drop its link attachment, or Buffer refuses the whole post');
  assert.ok(src.includes('input.text = ensureUrlInText(input.text, url);'),
    'dropping the link must not drop the click path');
  console.log('PASS an image post never also carries a link attachment');
}

// ── Facebook and LinkedIn: the link attachment goes ────────────────────────
{
  for (const channel of ['facebook', 'linkedin']) {
    const stripped = withoutLinkAttachments({ [channel]: { type: 'post', linkAttachment: { url: URL_ } } });
    assert.equal(stripped[channel].linkAttachment, undefined,
      `${channel} must lose its linkAttachment when an image is attached`);
    assert.equal(stripped[channel].type, 'post',
      `${channel} must keep every other metadata field — only the attachment conflicts`);
  }
  console.log('PASS Facebook and LinkedIn keep their metadata and lose only the attachment');
}

// ── Google Business is a different field and must survive ──────────────────
// It carries its link in detailsWhatsNew.link, not linkAttachment, and Buffer
// accepts a photo alongside it. Stripping it would silently remove the CTA
// button from the one channel that was never broken.
{
  const gbp = withoutLinkAttachments({
    googleBusiness: { detailsWhatsNew: { button: 'learn_more', link: URL_ } },
  });
  assert.equal(gbp.googleBusiness.detailsWhatsNew.link, URL_,
    'Google Business must keep its link — it uses a different field and was never in conflict');
  console.log('PASS Google Business keeps its call-to-action link');
}

// ── The click path survives, and is not duplicated ─────────────────────────
{
  const added = ensureUrlInText('Mount it right the first time.', URL_);
  assert.ok(added.includes(URL_), 'a post whose copy omits the URL must have it appended');
  assert.ok(added.startsWith('Mount it right the first time.'), 'the original copy must be preserved');

  const already = ensureUrlInText(`Read more at ${URL_}`, URL_);
  assert.equal((already.match(new RegExp(URL_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1,
    'a URL already present in the copy must not be repeated');

  assert.equal(ensureUrlInText('Just text', ''), 'Just text', 'no URL means nothing to append');
  console.log('PASS the URL reaches the post text exactly once');
}

console.log('\nSocial link/asset conflict tests passed.');
