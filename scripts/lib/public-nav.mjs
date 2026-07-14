function renderDesktopLinks(links) {
  return links
    .map(({ href, label, active = false }) => `      <li><a href="${href}"${active ? ' style="color:var(--cyan)"' : ''}>${label}</a></li>`)
    .join('\n');
}

function renderMobileLinks(links) {
  return links
    .map(({ href, label, className = '' }) => `  <a href="${href}"${className ? ` class="${className}"` : ''}>${label}</a>`)
    .join('\n');
}

const CORE_DESKTOP_LINKS = [
  { href: '/#services-hdr', label: 'Services' },
  { href: '/locations', label: 'Locations' },
  { href: '/bundles', label: 'Bundles' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/track', label: 'Track My Booking' },
  { href: '/about', label: 'About Us' },
];

const CORE_MOBILE_LINKS = [
  { href: '/#services-hdr', label: 'Services' },
  { href: '/locations', label: 'Locations' },
  { href: '/bundles', label: 'Bundles' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/track', label: 'Track My Booking' },
  { href: '/about', label: 'About Us' },
  { href: '/contact', label: 'Contact' },
  { href: '/assembler/apply', label: 'Become an Easer' },
  { href: '/book', label: 'Book Now &rarr;', className: 'btn btn-cyan btn-full' },
];

const BLOG_DESKTOP_LINKS = [
  { href: '/#services-hdr', label: 'Services' },
  { href: '/locations', label: 'Locations' },
  { href: '/blog/', label: 'Guides' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About Us' },
];

const BLOG_MOBILE_LINKS = [
  { href: '/#services-hdr', label: 'Services' },
  { href: '/locations', label: 'Locations' },
  { href: '/blog/', label: 'Guides' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/track', label: 'Track My Booking' },
  { href: '/about', label: 'About Us' },
  { href: '/contact', label: 'Contact' },
  { href: '/assembler/apply', label: 'Become an Easer' },
  { href: '/book', label: 'Book Now &rarr;', className: 'btn btn-cyan btn-full' },
];

const SERVICE_DESKTOP_LINKS = [
  { href: '/#services-hdr', label: 'Services' },
  { href: '/locations', label: 'Locations' },
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
];

const SERVICE_MOBILE_LINKS = [
  { href: '/locations', label: 'Locations' },
  { href: '/book?service=Furniture+Assembly', label: 'Furniture Assembly' },
  { href: '/book?service=Mounting+%26+Hanging', label: 'TV Mounting' },
  { href: '/book?service=Fitness+Equipment', label: 'Fitness Equipment' },
  { href: '/book?service=Outdoor+%26+Playsets', label: 'Outdoor / Playsets' },
  { href: '/book?service=Office+Assembly', label: 'Office Furniture' },
  { href: '/book?service=Smart+Home', label: 'Smart Home Setup' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About Us' },
  { href: '/track', label: 'Track My Booking' },
  { href: '/assembler/apply', label: 'Become an Easer' },
  { href: '/book', label: 'Book Now &rarr;', className: 'btn btn-cyan btn-full' },
];

const VARIANT_LINKS = {
  home: { desktop: CORE_DESKTOP_LINKS, mobile: CORE_MOBILE_LINKS },
  core: { desktop: CORE_DESKTOP_LINKS, mobile: CORE_MOBILE_LINKS },
  support: { desktop: CORE_DESKTOP_LINKS, mobile: CORE_MOBILE_LINKS },
  blog: { desktop: BLOG_DESKTOP_LINKS, mobile: BLOG_MOBILE_LINKS },
  service: { desktop: SERVICE_DESKTOP_LINKS, mobile: SERVICE_MOBILE_LINKS },
};

export function buildSkipNavLink() {
  return '<a href="#main-content" class="skip-nav">Skip to main content</a>';
}

/**
 * One canonical public header shell for every variant: the premium logo (with
 * the "Furniture Assembly • TV Mounting" tagline), the centered desktop links,
 * and a single Book Now CTA. Only the contextual link set changes per variant;
 * the structure, brand mark, tagline, and CTA are identical everywhere so the
 * header reads the same on every page and large-screen spacing stays consistent.
 */
function buildNav(desktopLinks, mobileLinks, activeHref) {
  const links = desktopLinks.map((link) => ({ ...link, active: activeHref === link.href }));

  return `<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" width="42" height="42"/></picture>
      <div class="nav-logo-text">AssembleAtEase<div class="nav-logo-sub">Furniture Assembly &bull; TV Mounting</div></div>
    </a>
    <ul class="nav-links">
${renderDesktopLinks(links)}
    </ul>
    <a href="/book" class="nav-book-cta">Book Now &rarr;</a>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
${renderMobileLinks(mobileLinks)}
</div>
<script src="/assets/js/mobile-nav.js" defer></script>`;
}

export function buildPublicNavBlock({ variant = 'core', includeSkipNav = true, activeHref = '' } = {}) {
  const links = VARIANT_LINKS[variant] || VARIANT_LINKS.core;
  const block = buildNav(links.desktop, links.mobile, activeHref);
  return `${includeSkipNav ? `${buildSkipNavLink()}\n` : ''}${block}\n`;
}
