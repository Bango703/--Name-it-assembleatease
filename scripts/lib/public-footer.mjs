import { businessIdentity } from './site-governance.mjs';

// Consumer services only. Business/commercial + custom quotes live once, in the
// Company column ("Business Services" -> /business), so there is no duplicate
// /business link across the footer.
const BOOKING_SERVICE_LINKS = [
  ['/book?service=Furniture+Assembly', 'Furniture Assembly'],
  ['/book?service=Mounting+%26+Hanging', 'TV Mounting'],
  ['/book?service=Smart+Home', 'Smart Home Setup'],
  ['/book?service=Fitness+Equipment', 'Fitness Equipment'],
  ['/book?service=Office+Assembly', 'Office Furniture'],
  ['/book?service=Outdoor+%26+Playsets', 'Outdoor / Playsets'],
];

const SERVICE_PAGE_LINKS = [
  ['/furniture-assembly-austin-tx', 'Furniture Assembly'],
  ['/tv-mounting-austin-tx', 'TV Mounting'],
  ['/smart-home-installation-austin-tx', 'Smart Home Setup'],
  ['/fitness-equipment-assembly-austin-tx', 'Fitness Equipment'],
  ['/office-furniture-assembly-austin-tx', 'Office Furniture'],
  ['/playset-assembly-austin-tx', 'Outdoor / Playsets'],
];

const COMPANY_LINKS = [
  ['/about', 'About Us'],
  ['/locations', 'Locations'],
  ['/pricing', 'Pricing'],
  ['/blog', 'Guides'],
  ['/business', 'Business Services'],
];

const SUPPORT_LINKS = [
  ['/#faq', 'FAQ'],
  ['/track', 'Track My Booking'],
  ['/contact', 'Contact'],
  ['/assembler/apply', 'Become an Easer'],
];

// Each Resources link points to a distinct, real guide. The Company column
// already owns the single /blog/ index link ("Guides"), so this list never
// repeats that destination under a second label.
const RESOURCES_LINKS = [
  ['/blog/new-home-setup-checklist-austin', 'New home setup checklist'],
  ['/blog/ikea-assembly-cost-austin', 'IKEA assembly cost guide'],
  ['/blog/tv-mounting-costs-austin', 'TV mounting cost guide'],
  ['/blog/smart-home-installation-austin', 'Smart home setup guide'],
  ['/blog/best-furniture-assembly-austin', 'Choosing an assembly pro'],
];

const BLOG_RESOURCES_LINKS = [
  ['/blog/ikea-assembly-cost-austin', 'IKEA Assembly Cost Austin'],
  ['/blog/tv-mounting-costs-austin', 'TV Mounting Costs Austin'],
  ['/blog/best-furniture-assembly-austin', 'Best Assembly Service Austin'],
  ['/blog/new-home-setup-checklist-austin', 'New Home Setup Checklist'],
  ['/blog/smart-home-installation-austin', 'Smart Home Install Austin'],
];

function renderLinks(links) {
  return links.map(([href, label]) => `        <li><a href="${href}">${label}</a></li>`).join('\n');
}

function renderColumn(title, links) {
  return `    <div>
      <div class="footer-col-title">${title}</div>
      <ul class="footer-links">
${renderLinks(links)}
      </ul>
    </div>`;
}

function renderResourceColumn(title, links) {
  return `    <div style="grid-column:1 / -1">
      <div class="footer-col-title">${title}</div>
      <ul class="footer-links" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.5rem">
${renderLinks(links)}
      </ul>
    </div>`;
}

const FACEBOOK_ICON_PATH = 'M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.88v2.26h3.32l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z';
const LINKEDIN_ICON_PATH = 'M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z';

function renderSocial() {
  return `      <div class="footer-social">
        <a href="${businessIdentity.facebookUrl}" target="_blank" rel="noopener" aria-label="AssembleAtEase on Facebook"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${FACEBOOK_ICON_PATH}"/></svg></a>
        <a href="${businessIdentity.linkedinPageUrl}" target="_blank" rel="noopener" aria-label="AssembleAtEase on LinkedIn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${LINKEDIN_ICON_PATH}"/></svg></a>
      </div>`;
}

function renderContact(mode) {
  if (mode === 'email_only') {
    return `      <div class="footer-contact">
        <a href="${businessIdentity.mailtoHref}">${businessIdentity.email}</a>
      </div>
${renderSocial()}`;
  }

  return `      <div class="footer-contact">
        <a href="${businessIdentity.telHref}">${businessIdentity.phoneDisplay}</a>
        <a href="${businessIdentity.mailtoHref}">${businessIdentity.email}</a>
      </div>
${renderSocial()}`;
}

function renderFooterInner({ tagline, servicesLinks, companyLinks = COMPANY_LINKS, supportLinks = SUPPORT_LINKS, contactMode = 'full', resourcesTitle = '', resourcesLinks = [] }) {
  const columns = [
    `    <div>
      <div class="footer-logo"><picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" width="38" height="38"/></picture><div class="footer-logo-text">Assemble<span>AtEase</span></div></div>
      <p class="footer-tagline">${tagline}</p>
${renderContact(contactMode)}
    </div>`,
    renderColumn('Services', servicesLinks),
    renderColumn('Company', companyLinks),
  ];

  if (supportLinks?.length) {
    columns.push(renderColumn('Support', supportLinks));
  }

  if (resourcesTitle && resourcesLinks.length) {
    columns.push(renderResourceColumn(resourcesTitle, resourcesLinks));
  }

  return columns.join('\n');
}

export function buildPublicFooter({ variant, tagline, copyrightLabel = 'AssembleAtEase LLC' }) {
  if (variant === 'booking_resources') {
    return `<footer class="footer">
  <div class="footer-inner">
${renderFooterInner({
  tagline,
  servicesLinks: BOOKING_SERVICE_LINKS,
  resourcesTitle: 'Resources',
  resourcesLinks: RESOURCES_LINKS,
})}
  </div>
  <div class="footer-bottom">
    <div class="footer-copy">&copy; <span id="year"></span> ${copyrightLabel}. All rights reserved.</div>
    <div class="footer-legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a></div>
  </div>
</footer>`;
  }

  if (variant === 'service_support') {
    return `<footer class="footer">
  <div class="footer-inner">
${renderFooterInner({
  tagline,
  servicesLinks: SERVICE_PAGE_LINKS,
})}
  </div>
  <div class="footer-bottom">
    <div class="footer-copy">&copy; <span id="year"></span> ${copyrightLabel}. All rights reserved.</div>
    <div class="footer-legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a></div>
  </div>
</footer>`;
  }

  if (variant === 'business_compact') {
    return `<footer class="footer">
  <div class="footer-inner">
${renderFooterInner({
  tagline,
  servicesLinks: BOOKING_SERVICE_LINKS,
  contactMode: 'email_only',
})}
  </div>
  <div class="footer-bottom">
    <div class="footer-copy">&copy; <span id="year"></span> ${copyrightLabel}. All rights reserved.</div>
    <div class="footer-legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a></div>
  </div>
</footer>`;
  }

  if (variant === 'blog_resources') {
    return `<footer class="footer">
  <div class="footer-inner">
${renderFooterInner({
  tagline,
  servicesLinks: SERVICE_PAGE_LINKS,
  resourcesTitle: 'Helpful Guides',
  resourcesLinks: BLOG_RESOURCES_LINKS,
  copyrightLabel,
})}
  </div>
  <div class="footer-bottom">
    <div class="footer-copy">&copy; <span id="year"></span> ${copyrightLabel}. All rights reserved.</div>
    <div class="footer-legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a></div>
  </div>
</footer>`;
  }

  throw new Error(`Unknown public footer variant: ${variant}`);
}

export function buildPublicFooterBlock(options) {
  return `${buildPublicFooter(options)}\n<script>document.getElementById('year') && (document.getElementById('year').textContent = new Date().getFullYear());</script>`;
}
