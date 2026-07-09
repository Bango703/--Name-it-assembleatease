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
  { href: '/bundles', label: 'Bundles' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/track', label: 'Track My Booking' },
  { href: '/about', label: 'About Us' },
];

const CORE_MOBILE_LINKS = [
  { href: '/#services-hdr', label: 'Services' },
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
  { href: '/blog/', label: 'Guides' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/about', label: 'About Us' },
];

const BLOG_MOBILE_LINKS = [
  { href: '/#services-hdr', label: 'Services' },
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
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
];

const SERVICE_MOBILE_LINKS = [
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

export function buildSkipNavLink() {
  return '<a href="#main-content" class="skip-nav">Skip to main content</a>';
}

function buildCoreNav(options) {
  const desktopLinks = CORE_DESKTOP_LINKS.map((link) => ({
    ...link,
    active: options.activeHref === link.href,
  }));

  return `<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" width="42" height="42"/></picture>
      <div class="nav-logo-text">Assemble<span>AtEase</span></div>
    </a>
    <ul class="nav-links">
${renderDesktopLinks(desktopLinks)}
    </ul>
    <a href="/book" class="nav-book-pill">Book Now &rarr;</a>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
${renderMobileLinks(CORE_MOBILE_LINKS)}
</div>
<script src="/assets/js/mobile-nav.js" defer></script>`;
}

function buildBlogNav(options) {
  const desktopLinks = BLOG_DESKTOP_LINKS.map((link) => ({
    ...link,
    active: options.activeHref === link.href,
  }));

  return `<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" width="42" height="42"/></picture>
      <div class="nav-logo-text">Assemble<span>AtEase</span></div>
    </a>
    <ul class="nav-links">
${renderDesktopLinks(desktopLinks)}
    </ul>
    <a href="/book" class="nav-book-pill">Book Now &rarr;</a>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
${renderMobileLinks(BLOG_MOBILE_LINKS)}
</div>
<script src="/assets/js/mobile-nav.js" defer></script>`;
}

function buildHomeNav() {
  return `<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" fetchpriority="high" width="36" height="36" style="border-radius:50%;object-fit:cover"/></picture>
      <div class="nav-logo-text">AssembleAtEase<div class="nav-logo-sub">Furniture Assembly &bull; TV Mounting</div></div>
    </a>
    <ul class="nav-links">
${renderDesktopLinks(CORE_DESKTOP_LINKS)}
    </ul>
    <div style="display:flex;align-items:center;gap:0.75rem"><a href="/book" class="nav-book-cta">Book Now &rarr;</a></div>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
${renderMobileLinks(CORE_MOBILE_LINKS)}
</div>
<script src="/assets/js/mobile-nav.js" defer></script>`;
}

function buildServiceNav(options) {
  const desktopLinks = SERVICE_DESKTOP_LINKS.map((link) => ({
    ...link,
    active: options.activeHref === link.href,
  }));

  return `<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo"/></picture>
      <div class="nav-logo-text">AssembleAtEase</div>
    </a>
    <ul class="nav-links">
${renderDesktopLinks(desktopLinks)}
    </ul>
    <a href="/book" class="btn btn-cyan" style="padding:0.5rem 1.25rem;font-size:0.875rem">Book Now &rarr;</a>
    <div class="nav-easer-link">
      <a href="/assembler/apply" style="font-size:0.875rem;font-weight:500;color:var(--ink-soft);text-decoration:none">Become an Easer</a>
    </div>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
${renderMobileLinks(SERVICE_MOBILE_LINKS)}
</div>
<script src="/assets/js/mobile-nav.js" defer></script>`;
}

function buildSupportNav(options) {
  const desktopLinks = CORE_DESKTOP_LINKS.map((link) => ({
    ...link,
    active: options.activeHref === link.href,
  }));

  return `<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" width="42" height="42"/></picture>
      <div class="nav-logo-text">Assemble<span>AtEase</span></div>
    </a>
    <ul class="nav-links">
${renderDesktopLinks(desktopLinks)}
    </ul>
    <a href="/book" class="btn btn-cyan" style="font-size:0.875rem;padding:0.5rem 1.25rem">Book Now &rarr;</a>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" aria-expanded="false" aria-controls="mobileNav">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
${renderMobileLinks(CORE_MOBILE_LINKS)}
</div>
<script src="/assets/js/mobile-nav.js" defer></script>`;
}

export function buildPublicNavBlock({ variant = 'core', includeSkipNav = true, activeHref = '' } = {}) {
  const options = { activeHref };
  let block = '';

  if (variant === 'home') block = buildHomeNav(options);
  else if (variant === 'blog') block = buildBlogNav(options);
  else if (variant === 'service') block = buildServiceNav(options);
  else if (variant === 'support') block = buildSupportNav(options);
  else block = buildCoreNav(options);

  return `${includeSkipNav ? `${buildSkipNavLink()}\n` : ''}${block}\n`;
}
