// Which committed city pages are offered to search engines. The rule itself
// lives in texas-cities.mjs; this maps a page file to it so the applier
// (scripts/apply-search-index-policy.mjs) and the SEO audit read one answer.
import { isIndexedLocationPage, isIndexedEaserJobsPage } from './texas-cities.mjs';
import { governanceConfig } from './site-governance.mjs';

const SERVICE_PREFIXES = governanceConfig.services.locationServicePrefixes;
const LOCATION_RE = new RegExp(`^(${SERVICE_PREFIXES.join('|')})-([a-z-]+)-tx\\.html$`);
const EASER_RE = /^easer-jobs-([a-z-]+)-tx\.html$/;

export const BRAND_SUFFIX = ' | AssembleAtEase';
export const EASER_SUFFIX = ' | Become an Easer';

// null for pages the policy does not govern.
export function searchIndexPolicyFor(page) {
  const location = page.match(LOCATION_RE);
  if (location) {
    return { kind: 'location', indexed: isIndexedLocationPage(location[2], location[1]), suffix: BRAND_SUFFIX };
  }
  const easer = page.match(EASER_RE);
  if (easer) return { kind: 'easer_jobs', indexed: isIndexedEaserJobsPage(easer[1]), suffix: EASER_SUFFIX };
  return null;
}
