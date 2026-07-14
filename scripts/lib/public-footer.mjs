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
  ['/blog/', 'Guides'],
  ['/business', 'Business Services'],
];

const SUPPORT_LINKS = [
  ['/#faq', 'FAQ'],
  ['/track', 'Track My Booking'],
  ['/contact', 'Contact'],
  ['/assembler/apply', 'Become an Easer'],
];

// Each Resources link points to a distinct, real guide (no repeated /blog/
// placeholders), with a single "All guides" entry to the index.
const RESOURCES_LINKS = [
  ['/blog/new-home-setup-checklist-austin', 'New home setup checklist'],
  ['/blog/ikea-assembly-cost-austin', 'IKEA assembly cost guide'],
  ['/blog/tv-mounting-costs-austin', 'TV mounting cost guide'],
  ['/blog/smart-home-installation-austin', 'Smart home setup guide'],
  ['/blog/best-furniture-assembly-austin', 'Choosing an assembly pro'],
  ['/blog/', 'All guides &rarr;'],
];

const BLOG_RESOURCES_LINKS = [
  ['/blog/ikea-assembly-cost-austin', 'IKEA Assembly Cost Austin'],
  ['/blog/tv-mounting-costs-austin', 'TV Mounting Costs Austin'],
  ['/blog/best-furniture-assembly-austin', 'Best Assembly Service Austin'],
  ['/blog/new-home-setup-checklist-austin', 'New Home Setup Checklist'],
  ['/blog/smart-home-installation-austin', 'Smart Home Install Austin'],
  ['/blog/', 'View all guides &rarr;'],
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

function renderContact(mode) {
  if (mode === 'email_only') {
    return `      <div class="footer-contact">
        <a href="${businessIdentity.mailtoHref}">${businessIdentity.email}</a>
        <a href="${businessIdentity.facebookUrl}" target="_blank" rel="noopener">Follow us on Facebook</a>
      </div>`;
  }

  return `      <div class="footer-contact">
        <a href="${businessIdentity.telHref}">${businessIdentity.phoneDisplay}</a>
        <a href="${businessIdentity.mailtoHref}">${businessIdentity.email}</a>
        <a href="${businessIdentity.facebookUrl}" target="_blank" rel="noopener">Follow us on Facebook</a>
      </div>`;
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
