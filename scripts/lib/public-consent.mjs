export const PUBLIC_COOKIE_SCRIPT_SRC = '/assets/js/cookie-consent.js';

export function buildPublicCookieBanner() {
  return `<div id="cookie-banner" class="hidden" data-cookie-banner>
  <span>Optional analytics, advertising measurement, and CRM cookies help us improve booking. You can accept or decline them. See our <a href="/privacy">Privacy Notice</a>.</span>
  <div class="cookie-btns">
    <button type="button" class="cookie-btn cookie-decline" data-cookie-decline>Decline</button>
    <button type="button" class="cookie-btn cookie-accept" data-cookie-accept>Accept</button>
  </div>
</div>`;
}

export function buildPublicCookieScriptTag() {
  return `<script src="${PUBLIC_COOKIE_SCRIPT_SRC}" defer></script>`;
}

export function buildPublicCookieConsentBlock() {
  return `${buildPublicCookieBanner()}
${buildPublicCookieScriptTag()}`;
}
