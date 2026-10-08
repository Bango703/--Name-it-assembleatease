import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

const originalEnv = Object.fromEntries([
  'BUFFER_API_KEY',
  'BUFFER_FACEBOOK_CHANNEL_ID',
  'BUFFER_GOOGLE_BUSINESS_CHANNEL_ID',
  'BUFFER_LINKEDIN_CHANNEL_ID',
].map((key) => [key, process.env[key]]));

process.env.BUFFER_API_KEY = 'test-key';
process.env.BUFFER_FACEBOOK_CHANNEL_ID = 'facebook-test';
process.env.BUFFER_GOOGLE_BUSINESS_CHANNEL_ID = 'google-test';
process.env.BUFFER_LINKEDIN_CHANNEL_ID = 'linkedin-test';

const { publishContentKit } = await import('../api/_social-publisher.js');
const { addArticleToIndexSchema, sanitizeArticleHtml } = await import('../api/cron/auto-blog.js');
const { cleanBookingAttribution } = await import('../api/_booking-attribution.js');

// Exercise actual dry-run publication. No Buffer request or live queue write is allowed.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Social dry-run attempted a network request'); };
const articleUrl = 'https://www.assembleatease.com/blog/tv-mounting-checklist';
const articleImage = 'https://www.assembleatease.com/images/service-tv-mounting.jpg';
const socialKit = Object.fromEntries(['facebook', 'linkedin', 'googleBusiness'].map(key => [key, `Read the guide: ${articleUrl}`]));
const socialBefore = JSON.stringify(socialKit);
const taggedPosts = await publishContentKit({
  title: 'TV Mounting Checklist', url: articleUrl, imageUrl: articleImage,
  kit: socialKit, channels: ['facebook', 'linkedin', 'googleBusiness'], dryRun: true,
});
for (const [key, expectedSource, expectedMedium, expectedCampaign, expectedChannel] of [
  ['facebook', 'facebook', 'social', 'social_buffer', 'organic_social'],
  ['linkedin', 'linkedin', 'social', 'social_buffer', 'organic_social'],
  ['googleBusiness', 'google', 'organic', 'gbp_buffer', 'organic_search'],
]) {
  const input = taggedPosts[key].payload;
  const link = key === 'googleBusiness' ? input.metadata.google.detailsWhatsNew.link
    : key === 'linkedin' ? input.metadata.linkedin.linkAttachment.url
      : input.text.match(/https:\/\/\S+/)[0];
  const tagged = new URL(link);
  assert.equal(tagged.origin + tagged.pathname, articleUrl);
  assert.deepEqual(Object.fromEntries(tagged.searchParams), {
    utm_source: expectedSource, utm_medium: expectedMedium, utm_campaign: expectedCampaign,
  }, `${key} uses static, non-personal channel attribution`);
  assert.equal(input.text, `Read the guide: ${link}`, 'one tagged destination replaces the existing text link');
  assert.equal(input.mode, process.env.BUFFER_POST_MODE || 'addToQueue');
  assert.equal(input.schedulingType, process.env.BUFFER_SCHEDULING_TYPE || 'automatic');
  assert.equal(input.dueAt, undefined);
  assert.equal(input.channelId, `${key === 'googleBusiness' ? 'google' : key}-test`);
  assert.equal(input.assets.length, key === 'linkedin' ? 0 : 1);
  if (key !== 'linkedin') assert.equal(input.assets[0].image.url, articleImage);
  if (key === 'facebook') assert.equal(input.metadata.facebook.linkAttachment, undefined);
  const clean = cleanBookingAttribution({
    utmSource: tagged.searchParams.get('utm_source'), utmMedium: tagged.searchParams.get('utm_medium'),
    utmCampaign: tagged.searchParams.get('utm_campaign'), landingPath: tagged.pathname,
  });
  assert.equal(clean.channel, expectedChannel);
  assert.equal(clean.utmCampaign, expectedCampaign, 'capture sanitizer retains campaign evidence');
}
assert.equal(JSON.stringify(socialKit), socialBefore, 'caller content kit is not mutated');

const existingTagged = `${articleUrl}?utm_source=old&email=private%40example.com#private-token`;
const dueAt = '2026-10-08T13:50:00.000Z';
const rescheduled = await publishContentKit({
  title: 'TV guide', url: existingTagged, channels: ['facebook'], dryRun: true, dueAt,
  kit: { facebook: `First ${existingTagged}\nAlso https://assembleatease.com/blog/tv-mounting-checklist\nOther https://example.com/article` },
});
const custom = rescheduled.facebook.payload;
assert.equal(custom.mode, 'customScheduled');
assert.equal(custom.dueAt, dueAt);
assert.equal(custom.assets.length, 0);
assert.equal(custom.metadata.facebook.linkAttachment.url, taggedPosts.googleBusiness.payload.metadata.google.detailsWhatsNew.link.replace('utm_source=google&utm_medium=organic&utm_campaign=gbp_buffer', 'utm_source=facebook&utm_medium=social&utm_campaign=social_buffer'));
assert.ok(!custom.text.includes('private') && !custom.text.includes('utm_source=old'));
assert.equal((custom.text.match(/utm_source=facebook/g) || []).length, 2, 'equivalent article links receive consistent attribution');
assert.ok(custom.text.includes('Other https://example.com/article'), 'unrelated links are not rewritten');

for (const url of ['https://example.com/blog/test', 'https://assembleatease.com.evil.example/blog/test', 'https://www.assembleatease.com/book?bundle=room-ready', 'not-a-url']) {
  const result = await publishContentKit({ title: 'Other destination', url, channels: ['linkedin'], dryRun: true });
  assert.equal(result.linkedin.payload.metadata.linkedin.linkAttachment.url, url, 'only public first-party article URLs are tagged');
}
assert.deepEqual(await publishContentKit({ title: 'None selected', url: articleUrl, channels: [], dryRun: true }), {});

// Current main also publishes consented customer reviews through this shared
// boundary. Preserve their truthful provenance, image label and booking CTA.
const reviewPosts = await publishContentKit({
  title: 'Customer review', url: 'https://www.assembleatease.com/book',
  imageUrl: articleImage, kit: { facebook: 'Customer review', googleBusiness: 'Customer review' },
  channels: ['facebook', 'googleBusiness'], dryRun: true,
  aiAssisted: false, altText: 'Customer-reviewed furniture assembly', source: 'assembleatease-customer-review',
});
for (const key of ['facebook', 'googleBusiness']) {
  const payload = reviewPosts[key].payload;
  assert.equal(payload.aiAssisted, false);
  assert.equal(payload.source, 'assembleatease-customer-review');
  assert.equal(payload.assets[0].image.metadata.altText, 'Customer-reviewed furniture assembly');
  assert.equal(payload.text, 'Customer review\n\nhttps://www.assembleatease.com/book');
}
assert.equal(reviewPosts.facebook.payload.metadata.facebook.linkAttachment, undefined);
assert.equal(reviewPosts.googleBusiness.payload.metadata.google.detailsWhatsNew.link, 'https://www.assembleatease.com/book');

// Query attribution must not change the repeat-protection article identity.
const automationSource = readFileSync(join(ROOT, 'api', '_social-automation.js'), 'utf8');
const extractionSource = automationSource.slice(automationSource.indexOf('function extractBlogUrls(post)'));
const extractBlogUrls = new Function(`${extractionSource}\nreturn extractBlogUrls;`)();
assert.deepEqual(extractBlogUrls({ text: taggedPosts.facebook.payload.text }), [articleUrl]);
assert.deepEqual(extractBlogUrls({ externalLink: taggedPosts.linkedin.payload.metadata.linkedin.linkAttachment.url }), [articleUrl]);
globalThis.fetch = originalFetch;

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
