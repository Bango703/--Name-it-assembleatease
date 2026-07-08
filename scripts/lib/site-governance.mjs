import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const REPORT_DIR = join(ROOT, 'business-artifacts', 'page-governance');
export const GOVERNANCE_CONFIG_PATH = join(REPORT_DIR, 'site-governance.json');

export const governanceConfig = JSON.parse(readFileSync(GOVERNANCE_CONFIG_PATH, 'utf8'));

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

export const businessIdentity = {
  email: governanceConfig.business.email,
  phoneE164: governanceConfig.business.phoneE164,
  phoneDisplay: governanceConfig.business.phoneDisplay,
  mailtoHref: `mailto:${governanceConfig.business.email}`,
  telHref: `tel:${governanceConfig.business.phoneE164}`,
  facebookUrl: governanceConfig.social.facebook,
  googleMapsUrl: governanceConfig.social.googleMaps,
  linkedinPageUrl: governanceConfig.social.linkedinPage,
};

export const identityAliases = {
  email: unique([...(governanceConfig.business.emailAliases || []), governanceConfig.business.email]),
  phoneHref: unique([...(governanceConfig.business.phoneHrefAliases || []), governanceConfig.business.phoneE164]),
  phoneDisplay: unique([...(governanceConfig.business.phoneDisplayAliases || []), governanceConfig.business.phoneDisplay]),
  facebook: unique([
    ...(governanceConfig.social.facebookAliases || []),
    governanceConfig.social.facebookLegacy,
    governanceConfig.social.facebook,
    governanceConfig.social.facebook.replace(/\/$/, '//'),
    governanceConfig.social.facebook.replace(/\/$/, ''),
  ]),
  googleMaps: unique([...(governanceConfig.social.googleMapsAliases || []), governanceConfig.social.googleMaps]),
  linkedin: unique([...(governanceConfig.social.linkedinAliases || []), governanceConfig.social.linkedinPage]),
};

export const replacementRules = [
  {
    label: 'business_email',
    current: governanceConfig.business.email,
    aliases: identityAliases.email.filter((value) => value !== governanceConfig.business.email),
  },
  {
    label: 'business_phone_href',
    current: governanceConfig.business.phoneE164,
    aliases: identityAliases.phoneHref.filter((value) => value !== governanceConfig.business.phoneE164),
  },
  {
    label: 'business_phone_display',
    current: governanceConfig.business.phoneDisplay,
    aliases: identityAliases.phoneDisplay.filter((value) => value !== governanceConfig.business.phoneDisplay),
  },
  {
    label: 'facebook_page',
    current: governanceConfig.social.facebook,
    aliases: identityAliases.facebook.filter((value) => value !== governanceConfig.social.facebook),
  },
  {
    label: 'google_maps',
    current: governanceConfig.social.googleMaps,
    aliases: identityAliases.googleMaps.filter((value) => value !== governanceConfig.social.googleMaps),
  },
  {
    label: 'linkedin_page',
    current: governanceConfig.social.linkedinPage,
    aliases: identityAliases.linkedin.filter((value) => value !== governanceConfig.social.linkedinPage),
  },
];
