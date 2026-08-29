import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

const originalEnv = Object.fromEntries([
  'BUFFER_API_KEY',
  'BUFFER_FACEBOOK_CHANNEL_ID',
  'BUFFER_GOOGLE_BUSINESS_CHANNEL_ID',
].map((key) => [key, process.env[key]]));

process.env.BUFFER_API_KEY = 'test-key';
process.env.BUFFER_FACEBOOK_CHANNEL_ID = 'facebook-test';
process.env.BUFFER_GOOGLE_BUSINESS_CHANNEL_ID = 'google-test';

const { publishContentKit } = await import('../api/_social-publisher.js');
const { addArticleToIndexSchema, sanitizeArticleHtml } = await import('../api/cron/auto-blog.js');

const dryRun = await publishContentKit({
  title: 'TV Mounting Checklist',
  url: 'https://www.assembleatease.com/blog/tv-mounting-checklist',
  imageUrl: 'https://www.assembleatease.com/images/service-tv-mounting.jpg',
  kit: { facebook: 'Read the guide.', googleBusiness: 'Read the guide.' },
  channels: ['facebook', 'googleBusiness'],
  dryRun: true,
});

assert.equal(dryRun.googleBusiness.payload.metadata.google.detailsWhatsNew.button, 'learn_more');
assert.equal(
  dryRun.googleBusiness.payload.assets[0].image.metadata.altText,
  'AssembleAtEase guide: TV Mounting Checklist',
);
assert.equal(
  dryRun.facebook.payload.assets[0].image.metadata.altText,
  'AssembleAtEase guide: TV Mounting Checklist',
);

const usefulParagraph = 'Confirm the product model, room access, measurements, installation surface, manufacturer instructions, required hardware, final placement, and any property restrictions before the appointment. Share photos and complete job notes so the requested scope can be reviewed accurately before a professional is assigned. ';
const generatedHtml = [
  '<h2>Check the product and room</h2>',
  `<p>${usefulParagraph.repeat(3)}</p>`,
  '<h2>List the complete scope</h2>',
  `<p>${usefulParagraph.repeat(3)}</p>`,
  '<ul><li>Product model</li><li>Room photos</li><li>Access instructions</li></ul>',
  '<h2>Wait for assignment confirmation</h2>',
  `<p>${usefulParagraph.repeat(3)}</p>`,
  `<p>${usefulParagraph.repeat(3)}</p>`,
  '<script>throw new Error("unsafe")</script>',
].join('');
const accepted = sanitizeArticleHtml(generatedHtml, 'test topic', 'Austin, Texas');
assert.equal(accepted.ok, true);
assert.ok(accepted.wordCount >= 350);
assert.ok(!accepted.html.includes('<script'));
assert.ok(accepted.html.includes('Check Texas Availability'));

const rejected = sanitizeArticleHtml(
  generatedHtml.replace('Confirm the product model', 'We recently helped hundreds of homes. Confirm the product model'),
  'test topic',
  'Austin, Texas',
);
assert.equal(rejected.ok, false);
assert.match(rejected.reason, /unsupported/i);

const indexHtml = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","mainEntity":{"@type":"ItemList","itemListElement":[]}}</script>';
const updatedIndex = addArticleToIndexSchema(indexHtml, {
  title: 'Test Guide',
  canonicalUrl: 'https://www.assembleatease.com/blog/test-guide',
});
assert.ok(updatedIndex.includes('https://www.assembleatease.com/blog/test-guide'));
assert.ok(updatedIndex.includes('"position":1'));

const contentKitSource = readFileSync(join(ROOT, 'api', '_content-kit.js'), 'utf8');
assert.ok(contentKitSource.includes('Never invent a meeting'));
assert.ok(contentKitSource.includes('Do not claim service outside Texas'));

for (const [key, value] of Object.entries(originalEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

console.log('Social content safety checks passed.');
