// Shares a customer's review on AssembleAtEase's own Facebook and Google Business
// pages, as a post by the business, only when the customer opted in.
//
// Reviews themselves cannot be posted to Google or Facebook for a customer: both
// require the customer's own account, and the FTC Consumer Reviews and
// Testimonials rule (16 CFR 465) prohibits reviews not written by the named
// person. So the customer posts their own review (review.html copies the text
// for them), and with consent the business shares it as a testimonial.
//
// Posts go into the Buffer queue (not published instantly), so the owner can
// edit or remove any post before it goes out. A failed share never affects the
// saved review.

import { publishContentKit } from './_social-publisher.js';

const ORIGIN = 'https://www.assembleatease.com';
const BOOK_URL = `${ORIGIN}/book`;
const SHARE_CHANNELS = ['facebook', 'googleBusiness'];
const MIN_TEXT = 20;
const MAX_TEXT = 600;

// Public service photos (never job completion photos, which stay private).
const SERVICE_IMAGES = [
  [/tv|mount/i, 'real-tv-mount-console-1200.webp'],
  [/smart|doorbell|camera|lock|thermostat/i, 'real-smarthome-doorbell-vivint-1024.webp'],
  [/fitness|gym|treadmill|bike/i, 'real-fitness-home-gym-1200.webp'],
  [/office|desk|workstation/i, 'real-office-home-ldesk-1200.webp'],
  [/outdoor|playset|swing|gazebo|trampoline/i, 'service-outdoor-playsets-1200.webp'],
  [/furniture|assembly|bed|dresser/i, 'real-furniture-dresser-wood-1000.webp'],
];

const PROFANITY = /\b(fuck|shit|bitch|damn|asshole|bastard|crap|dick|piss)\w*/i;
const CONTACT_OR_LINK = /(https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|\bAAE-[A-Z0-9]+\b)/i;

export function reviewerDisplayName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A verified customer';
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  const last = parts.length > 1 ? ` ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : '';
  return `${first}${last}`;
}

export function serviceImageUrl(service) {
  const hit = SERVICE_IMAGES.find(([re]) => re.test(String(service || '')));
  return `${ORIGIN}/images/${hit ? hit[1] : SERVICE_IMAGES[SERVICE_IMAGES.length - 1][1]}`;
}

// Decide whether a review may be shared, and build the post. Pure: no I/O.
export function buildReviewShare({ consent, rating, body, customerName, service }) {
  if (consent !== true) return { share: false, reason: 'no_consent' };
  if (rating !== 5) return { share: false, reason: 'not_five_star' };
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (text.length < MIN_TEXT) return { share: false, reason: 'too_short' };
  if (text.length > MAX_TEXT) return { share: false, reason: 'too_long' };
  if (CONTACT_OR_LINK.test(text)) return { share: false, reason: 'contains_contact_or_link' };
  if (PROFANITY.test(text)) return { share: false, reason: 'language' };

  const who = reviewerDisplayName(customerName);
  const serviceLabel = String(service || '').trim();
  const attribution = serviceLabel ? `${who}, ${serviceLabel} customer` : who;
  const quote = `"${text}"`;
  const facebook = `5-star review from a recent customer:\n\n${quote}\n${attribution}\n\nBook your own setup: ${BOOK_URL}`;
  const googleBusiness = `5-star review from a recent customer:\n\n${quote}\n${attribution}`;
  return {
    share: true,
    title: `Customer review: ${who}`,
    url: BOOK_URL,
    imageUrl: serviceImageUrl(serviceLabel),
    altText: serviceLabel ? `${serviceLabel} completed by AssembleAtEase` : 'Home setup completed by AssembleAtEase',
    kit: { facebook, googleBusiness },
  };
}

export async function shareReviewToSocials(review, { publish = publishContentKit, timeoutMs = 5000 } = {}) {
  const post = buildReviewShare(review);
  if (!post.share) return { shared: false, reason: post.reason, channels: {} };
  try {
    const channels = await Promise.race([
      publish({
        title: post.title,
        url: post.url,
        kit: post.kit,
        imageUrl: post.imageUrl,
        channels: SHARE_CHANNELS,
        aiAssisted: false,
        altText: post.altText,
        source: 'assembleatease-customer-review',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Buffer did not answer in time')), timeoutMs)),
    ]);
    const queued = Object.values(channels || {}).some((c) => c?.status === 'queued');
    return { shared: queued, reason: queued ? 'queued' : 'not_queued', channels };
  } catch (err) {
    return { shared: false, reason: 'error', error: err?.message || String(err), channels: {} };
  }
}
