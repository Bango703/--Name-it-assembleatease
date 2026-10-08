import { CITIES, STATEWIDE_MARKETS } from '../scripts/lib/texas-cities.mjs';
import { marketForZip } from './_source-of-truth.js';

const CITY_NAMES = new Map([...CITIES, ...STATEWIDE_MARKETS].map(city => [city.name.toLowerCase(), city.name]));
const CITY_SLUGS = new Set([...CITIES, ...STATEWIDE_MARKETS].map(city => city.slug));
const PUBLIC_PATHS = new Set(['/', '/book', '/pricing', '/services', '/contact', '/about', '/bundles', '/business', '/locations', '/blog', '/resources', '/become-an-easer', '/assembler/apply', '/track', '/assemblecash', '/setup-club', '/furniture-stores-texas']);
const NON_ACQUISITION_HOSTS = new Set(['assembleatease.com', 'stripe.com', 'checkout.stripe.com', 'payments.klarna.com', 'klarna.com', 'resend.com']);
function nonAcquisitionHost(value) {
  return Array.from(NON_ACQUISITION_HOSTS).some(domain => value === domain || value.endsWith('.' + domain));
}

function host(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^www\./, '');
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(text) && text.length <= 120 ? text : '';
}

function campaignLabel(value, max = 80) {
  const text = String(value || '').trim().toLowerCase();
  // Only deliberate campaign identifiers; omit free-text search terms entirely.
  return /^[a-z][a-z0-9_-]*$/.test(text) && text.length <= max
    && text.replace(/\D/g, '').length < 7 && !/[a-f0-9]{24,}/.test(text) ? text : '';
}

const UTM_SOURCES = new Set(['google', 'bing', 'duckduckgo', 'ecosia', 'ecosia.org', 'yahoo', 'google_jobs_apply', 'facebook', 'instagram', 'linkedin', 'nextdoor', 'buffer', 'partner', 'owner', 'sora', 'newsletter']);
const UTM_MEDIA = new Set(['organic', 'social', 'organic_social', 'referral', 'email', 'voice', 'cpc', 'ppc', 'paidsearch', 'paid_search']);
const CAMPAIGN_PREFIX = /^(?:gbp|rebook|partner|organic|social|newsletter|sora|business|referral|austin|san_antonio|houston|dallas|tyler|texas)(?:[_-][a-z0-9]+)*$/;

export function safeAcquisitionPath(value) {
  const path = String(value || '').replace(/\.html$/, '').replace(/\/$/, '') || '/';
  if (PUBLIC_PATHS.has(path)) return path;
  const match = path.match(/^\/(furniture-assembly|tv-mounting|fitness-equipment-assembly|smart-home-installation|office-furniture-assembly|playset-assembly|gazebo-assembly|easer-jobs)-([a-z-]+)-tx$/);
  if (match && CITY_SLUGS.has(match[2])) return path;
  // Preserve the content channel without retaining arbitrary slug/free-text data.
  if (/^\/blog\/[a-z0-9-]+$/.test(path)) return '/blog';
  return '';
}

export function cleanBookingAttribution(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const referrer = host(input.referrerHost);
  const referrerHost = nonAcquisitionHost(referrer) ? '' : referrer;
  const candidateSource = String(input.utmSource || '').trim().toLowerCase();
  const utmSource = UTM_SOURCES.has(candidateSource) ? candidateSource : '';
  const candidateMedium = String(input.utmMedium || '').trim().toLowerCase();
  const utmMedium = UTM_MEDIA.has(candidateMedium) ? candidateMedium : '';
  const clickId = /^[a-z0-9_-]{1,180}$/i.test(String(input.clickId || '')) ? input.clickId : '';
  const clickIdType = clickId && ['gclid', 'msclkid', 'gbraid', 'wbraid'].includes(input.clickIdType) ? input.clickIdType : '';
  const searchHost = /^(?:google\.[a-z.]+|bing\.com|duckduckgo\.com|ecosia\.org|search\.yahoo\.com)$/;
  const paid = clickIdType || (utmSource && /^(cpc|ppc|paidsearch|paid_search)$/.test(utmMedium));
  const organic = utmMedium === 'organic' && /^(google|bing|duckduckgo|ecosia(?:\.org)?|yahoo|google_jobs_apply)$/.test(utmSource)
    || (!utmSource && !utmMedium && searchHost.test(referrerHost));
  const source = utmSource || (clickIdType === 'msclkid' ? 'bing' : clickIdType ? 'google' : referrerHost) || 'direct';
  const channel = paid ? 'paid_search' : clickId ? 'paid_unclassified'
    : organic ? 'organic_search'
      : (/^(social|organic_social)$/.test(utmMedium) && /^(facebook|instagram|linkedin|nextdoor|buffer)$/.test(utmSource)) || (!utmSource && !utmMedium && /(^|\.)(facebook|instagram|linkedin|nextdoor)\.com$/.test(referrerHost)) ? 'organic_social'
        : utmMedium === 'email' && utmSource ? 'email' : utmMedium === 'referral' && utmSource ? 'referral' : utmSource ? 'campaign' : referrerHost ? 'referral' : 'unattributed';
  const landingPath = safeAcquisitionPath(input.landingPath);
  const result = { source, channel, capturedAt: new Date().toISOString(), attributionVersion: 2 };
  if (utmSource) result.utmSource = utmSource;
  if (utmMedium) result.utmMedium = utmMedium;
  const campaign = campaignLabel(input.utmCampaign);
  const partnerCode = utmSource === 'partner' && /^[a-z][a-z0-9]{5}$/.test(campaign) && /\d/.test(campaign);
  if (utmSource && (CAMPAIGN_PREFIX.test(campaign) || partnerCode)) result.utmCampaign = campaign;
  const content = campaignLabel(input.utmContent, 64);
  if (utmSource && (/^(website|book)$/.test(content) || (utmSource === 'partner' && result.utmCampaign && content))) result.utmContent = content;
  if (clickId) result.clickId = clickId;
  if (clickIdType) result.clickIdType = clickIdType;
  if (referrerHost) result.referrerHost = referrerHost;
  if (landingPath) result.landingPath = landingPath;
  result.entryAudience = /(?:^\/assembler\/apply$|^\/become-an-easer$|^\/easer-jobs-)/.test(landingPath) ? 'easer'
    : landingPath === '/track' ? 'customer_support' : 'customer';
  return result;
}

// Reporting labels only: never used for dispatch, eligibility, prices or payment state.
export function bookingAnalyticsContext(location = {}) {
  return {
    service_market: marketForZip(location.zip) || 'unknown',
    service_city: CITY_NAMES.get(String(location.city || '').trim().toLowerCase()) || 'unknown',
  };
}
