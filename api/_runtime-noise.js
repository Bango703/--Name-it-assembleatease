/**
 * Browser errors that are not ours.
 *
 * The page error monitor (assets/js/mobile-nav.js) hears every error on the
 * page, including ones thrown by a visitor's browser extensions: password
 * managers, ad blockers, shopping add-ons. Those surfaced in Live Ops as
 * "Customer-side page error", e.g. 2026-10-01 "Invalid call to
 * runtime.sendMessage(). Tab not found." That is the browser extension
 * messaging API, which no page on this site calls. It told the owner the
 * site was broken when it was not.
 *
 * One rule, two readers: the intake endpoint drops these before storing, and
 * Live Ops hides any already stored.
 */
const EXTENSION_SOURCE = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//i;
const EXTENSION_MESSAGE = [
  /\bruntime\.sendMessage\b/i,
  /\bruntime\.connect\b/i,
  /Extension context invalidated/i,
  /Could not establish connection\. Receiving end does not exist/i,
  /message port closed before a response was received/i,
];

export function isBrowserExtensionNoise({ message = '', source = '', stack = '' } = {}) {
  if (EXTENSION_SOURCE.test(String(source)) || EXTENSION_SOURCE.test(String(stack))) return true;
  const text = String(message);
  return EXTENSION_MESSAGE.some(re => re.test(text));
}
