// The two iPhone apps, in one place: the website footer and banners
// (scripts/lib/public-footer.mjs, scripts/app-banner-sync.mjs), the booking
// confirmation page, the Easer recruiting page and the emails all read these.
//
// Badge artwork is Apple's own, unmodified (images/badges/, from Apple's
// marketing guidelines): black, at least 40px tall, clear space of a quarter of
// its height, one badge per layout, and Apple credited where legal notices sit.

export const APP_STORE = Object.freeze({
  customer: Object.freeze({
    id: '6822339934',
    name: 'AssembleAtEase',
    url: 'https://apps.apple.com/us/app/assembleatease-assembly-pros/id6822339934',
  }),
  easer: Object.freeze({
    id: '6820654960',
    name: 'Easer by AssembleAtEase',
    url: 'https://apps.apple.com/us/app/easer-by-assembleatease/id6820654960',
  }),
});

export const APP_STORE_BADGE_SVG = '/images/badges/download-on-the-app-store.svg';
// Email clients do not show SVG.
export const APP_STORE_BADGE_PNG = 'https://www.assembleatease.com/images/badges/download-on-the-app-store.png';

// Apple asks for this credit wherever the badge is used.
export const APPLE_TRADEMARK_CREDIT = 'Apple and the Apple logo are trademarks of Apple Inc., registered in the U.S. and other countries. App Store is a service mark of Apple Inc.';

/** The badge for an email, with one line above it. */
export function appStoreBadgeEmailHtml(app, line) {
  const target = APP_STORE[app];
  if (!target) return '';
  return `<div style="text-align:center;margin:24px 0 8px">
      <p style="margin:0 0 10px;font-size:0.85rem;color:#52525b">${line}</p>
      <a href="${target.url}" style="display:inline-block"><img src="${APP_STORE_BADGE_PNG}" alt="Download on the App Store" width="120" height="40" style="display:block;border:0;width:120px;height:40px"></a>
    </div>`;
}
