// Transforms the 6 footer-linked Austin service pages to the flagship layout.
// Keeps each page's <head> (title/meta/canonical/base CSS), nav, mobile nav,
// footer, mobile sticky bar, cookie banner and scripts INTACT. Only:
//   1. injects the flagship .fa-* CSS before </head> (idempotent)
//   2. swaps the visible body (between <!-- HERO --> and <footer class="footer">)
//   3. points og:image / twitter:image at the service's real hero photo
//   4. normalizes the page entity to a Service supplied by one Organization
// Copy is location-NEUTRAL except the SEO spots (eyebrow, service-area, FAQ, links).
import { readFileSync, writeFileSync } from 'node:fs';

const CITY = 'Austin';
const MAX_COMMON_JOBS = 4;

function decodeHtmlText(value) {
  return String(value || '')
    .replaceAll('&ndash;', '–')
    .replaceAll('&mdash;', '—')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&rsquo;', '’')
    .replaceAll('&#39;', "'");
}

function buildServiceSchema(cfg) {
  const url = `https://www.assembleatease.com/${cfg.slug}`;
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${url}#service`,
    name: `AssembleAtEase — ${cfg.eyebrow} in ${CITY}`,
    serviceType: cfg.eyebrow,
    image: `https://www.assembleatease.com/images/${cfg.heroPhoto}`,
    url,
    provider: {
      '@type': 'Organization',
      '@id': 'https://www.assembleatease.com/#organization',
      name: 'AssembleAtEase',
      url: 'https://www.assembleatease.com',
      telephone: '+17372906129',
      email: 'service@assembleatease.com',
    },
    areaServed: {
      '@type': 'City',
      name: CITY,
      containedInPlace: { '@type': 'State', name: 'Texas' },
    },
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: cfg.eyebrow,
      itemListElement: cfg.offers.map((offer, index) => ({
        '@type': 'Offer',
        position: index + 1,
        name: decodeHtmlText(offer.n),
        description: decodeHtmlText(offer.p),
      })),
    },
  }).replace(/<\//g, '<\\/')}</script>`;
}

function parseStartingPrice(label) {
  const match = String(label || '').match(/\$(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function assertVisibleStartPrice(service) {
  const expectedStart = parseStartingPrice(service.fromPrice);
  const visibleStarts = (service.offers || [])
    .slice(0, MAX_COMMON_JOBS)
    .map((offer) => parseStartingPrice(offer.p))
    .filter(Number.isFinite);
  const lowestVisible = visibleStarts.length ? Math.min(...visibleStarts) : NaN;

  if (!Number.isFinite(expectedStart) || !Number.isFinite(lowestVisible)) {
    throw new Error(`Unable to validate visible start price for ${service.slug}.`);
  }
  if (lowestVisible > expectedStart) {
    throw new Error(
      `${service.slug} starts at ${service.fromPrice}, but visible offers begin at $${lowestVisible}. Update the visible offers before generating pages.`,
    );
  }
}

const FA_STYLE = `<style>
/* ===== Flagship service page ===== */
.fa-hero{position:relative;background:linear-gradient(180deg,#edf6fe 0%,#f6fbff 55%,#ffffff 100%);overflow:hidden;border-bottom:1px solid var(--border)}
.fa-hero::before{content:"";position:absolute;top:-28%;right:-8%;width:52%;height:130%;background:radial-gradient(circle at center,rgba(0,191,255,0.16),transparent 60%);pointer-events:none}
.fa-hero-grid{position:relative;z-index:1;max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1.02fr 0.98fr;gap:3.5rem;align-items:center;padding:4.25rem 2rem 4.5rem}
.fa-eyebrow{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap;max-width:100%;font-size:0.72rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:var(--cyan-dark);margin-bottom:1.25rem}
.fa-eyebrow::before{content:"";width:24px;height:2px;background:var(--cyan)}
.fa-title{font-family:var(--font-display);font-size:clamp(2.3rem,4.6vw,3.6rem);line-height:1.04;letter-spacing:-0.5px;color:var(--ink);margin-bottom:1.1rem;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
.fa-title em{font-style:italic;color:var(--cyan-dark)}
.fa-sub{font-size:1.08rem;line-height:1.7;color:var(--ink-soft);max-width:31rem;margin-bottom:1.85rem}
.fa-cta-row{display:flex;flex-wrap:wrap;gap:0.9rem;margin-bottom:1.7rem}
.fa-btn-primary{display:inline-flex;align-items:center;gap:8px;background:var(--cyan);color:#03303f;font-weight:700;font-size:1rem;padding:0.95rem 1.95rem;border-radius:999px;text-decoration:none;transition:all .18s;box-shadow:0 12px 30px rgba(0,191,255,0.3)}
.fa-btn-primary:hover{background:var(--cyan-dark);color:#fff;transform:translateY(-2px)}
.fa-btn-ghost{display:inline-flex;align-items:center;gap:8px;color:var(--ink);font-weight:600;font-size:1rem;padding:0.95rem 1.5rem;border-radius:999px;text-decoration:none;border:1.5px solid var(--border);transition:all .18s}
.fa-btn-ghost:hover{border-color:var(--cyan);color:var(--cyan-dark)}
.fa-hero-media{position:relative}
.fa-hero-media img{width:100%;height:auto;display:block;border-radius:20px;box-shadow:0 26px 55px rgba(2,32,43,0.22)}
.fa-media-chip{position:absolute;left:0.9rem;bottom:0.9rem;background:rgba(8,18,30,0.84);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.14);color:#fff;font-size:0.78rem;font-weight:600;padding:0.5rem 0.9rem;border-radius:999px;display:flex;align-items:center;gap:8px}
.fa-media-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:#28d17c;box-shadow:0 0 0 4px rgba(40,209,124,0.25)}
.fa-section{padding:4.75rem 2rem}
.fa-wrap{max-width:1100px;margin:0 auto}
.fa-head{max-width:42rem;margin-bottom:0.5rem}
.fa-head--center{margin-left:auto;margin-right:auto;text-align:center}
.fa-kicker{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.13em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.55rem}
.fa-h2{font-family:var(--font-display);font-size:clamp(1.7rem,3.1vw,2.45rem);color:var(--ink);line-height:1.1}
.fa-lead{font-size:1rem;color:var(--muted);line-height:1.7;max-width:40rem;margin-top:0.7rem}
.fa-gallery{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem;margin-top:2.5rem}
.fa-shot{border-radius:16px;overflow:hidden;background:var(--white);border:1px solid var(--border);box-shadow:var(--shadow)}
.fa-shot .frame{width:100%;aspect-ratio:7/5;overflow:hidden;background:#e9eef2}
.fa-shot .frame img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s}
.fa-shot:hover .frame img{transform:scale(1.04)}
.fa-shot .cap{padding:0.95rem 1.1rem;font-size:0.92rem;font-weight:700;color:var(--ink)}
.fa-shot .cap small{display:block;font-weight:500;color:var(--muted);font-size:0.77rem;margin-top:3px}
.fa-note{background:var(--off-white);border:1px solid var(--border);border-radius:16px;padding:1.7rem 1.5rem;color:var(--ink);display:flex;flex-direction:column;justify-content:center;min-height:200px}
.fa-note strong{font-family:var(--font-display);font-size:1.25rem;line-height:1.18;display:block;margin-bottom:0.55rem}
.fa-note p{font-size:0.92rem;line-height:1.6;color:var(--muted)}
.fa-price-shell{display:grid;grid-template-columns:minmax(240px,0.78fr) minmax(0,1.22fr);gap:1rem;align-items:stretch}
.fa-price-side{background:linear-gradient(180deg,#ffffff 0%,#f5fbfe 100%);border:1px solid rgba(15,23,42,0.08);border-radius:28px;padding:1.6rem 1.5rem;box-shadow:0 20px 48px rgba(15,23,42,0.08);display:flex;flex-direction:column;justify-content:space-between}
.fa-price-anchor{text-align:left;margin-bottom:1rem}
.fa-price-anchor .big{font-family:var(--font-display);font-size:clamp(2.4rem,5vw,3.1rem);color:var(--cyan-dark);line-height:1}
.fa-price-anchor .lbl{display:block;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--muted);font-weight:700;margin-top:0.45rem}
.fa-price-note{font-size:0.92rem;line-height:1.72;color:var(--muted);margin:0}
.fa-menu{background:var(--white);border:1px solid rgba(15,23,42,0.08);border-radius:28px;padding:1rem;box-shadow:0 20px 48px rgba(15,23,42,0.08);display:grid;gap:0.75rem}
.fa-menu-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.05rem;border:1px solid rgba(15,23,42,0.08);border-radius:18px;background:linear-gradient(180deg,#ffffff 0%,#fbfdff 100%)}
.fa-menu-row .nm{font-size:0.96rem;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:0.55rem;flex-wrap:wrap}
.fa-menu-row .tag{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--cyan-dark);background:var(--cyan-light);border:1px solid var(--cyan-mid);border-radius:999px;padding:0.12rem 0.5rem}
.fa-menu-row .pr{font-family:var(--font-display);font-size:1.2rem;color:var(--cyan-dark);white-space:nowrap}
.fa-price-foot{margin-top:1rem;padding:1.2rem 1.35rem;border-radius:24px;background:linear-gradient(135deg,#0f3558 0%,#1a6a87 100%);display:flex;align-items:center;justify-content:space-between;gap:1rem}
.fa-price-copy{display:flex;flex-direction:column;gap:0.35rem;max-width:33rem}
.fa-price-copy strong{font-size:1.05rem;color:#fff}
.fa-price-copy span{font-size:0.88rem;line-height:1.7;color:rgba(255,255,255,0.82)}
.fa-price-actions{display:flex;flex-direction:column;align-items:flex-end;gap:0.8rem}
.fa-price-support{max-width:21rem;font-size:0.8rem;line-height:1.6;color:rgba(255,255,255,0.8);margin:0;text-align:right}
.fa-process{max-width:900px;margin:0 auto}
.fa-process-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.75rem}
.fa-process-tab{appearance:none;border:1.5px solid var(--border);background:var(--white);border-radius:16px;padding:0.95rem 1rem;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s,background .15s}
.fa-process-tab:hover{border-color:var(--cyan-mid)}
.fa-process-tab.is-active{border-color:var(--cyan);background:#f7fcfe;box-shadow:0 10px 28px rgba(0,191,255,0.08)}
.fa-process-num{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.05rem;margin-bottom:0.7rem}
.fa-process-tab.is-active .fa-process-num{background:var(--cyan-dark)}
.fa-process-label{display:block;font-size:0.94rem;font-weight:700;color:var(--ink)}
.fa-process-panel{margin-top:0.9rem;background:var(--off-white);border:1px solid var(--border);border-radius:18px;padding:1.15rem 1.25rem}
.fa-process-panel h3{font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.4rem}
.fa-process-panel p{font-size:0.9rem;line-height:1.65;color:var(--muted)}
.fa-mini-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.8rem}
.fa-mini-fact{background:var(--white);border:1.5px solid var(--border);border-radius:16px;padding:1rem 1.05rem}
.fa-mini-fact strong{display:block;font-size:0.88rem;color:var(--ink);margin-bottom:0.3rem}
.fa-mini-fact span{display:block;font-size:0.82rem;line-height:1.55;color:var(--muted)}
.fa-faq-item{background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:0.75rem}
.fa-faq-q{width:100%;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.05rem 1.3rem;background:none;border:none;cursor:pointer;font-family:var(--font-body);font-size:0.94rem;font-weight:600;color:var(--ink);text-align:left}
.fa-faq-a{display:none;padding:0 1.3rem 1.1rem;font-size:0.88rem;color:var(--muted);line-height:1.75}
.fa-chev{transition:transform .2s;flex-shrink:0;color:var(--cyan-dark);font-size:1.1rem}
.fa-citylinks{display:flex;flex-wrap:wrap;gap:0.6rem;justify-content:center}
.fa-citylinks a{display:inline-flex;align-items:center;background:var(--white);border:1px solid var(--cyan-mid);border-radius:999px;padding:0.55rem 1.15rem;font-size:0.875rem;font-weight:600;color:var(--cyan-dark);text-decoration:none;transition:all .15s}
.fa-citylinks a:hover{background:var(--cyan-light);border-color:var(--cyan)}
.fa-share-kit{max-width:860px;margin:0 auto}
.fa-share-inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.15rem 1.25rem;background:var(--white);border:1px solid var(--border);border-radius:18px}
.fa-share-copy strong{display:block;font-size:1rem;color:var(--ink);margin-bottom:0.2rem}
.fa-share-copy span{display:block;font-size:0.88rem;line-height:1.6;color:var(--muted);max-width:34rem}
.fa-share-actions{display:flex;align-items:center;justify-content:flex-end;gap:0.6rem;flex-wrap:wrap}
.fa-share-btn{display:inline-flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:999px;border:1px solid var(--cyan-mid);background:var(--white);color:var(--cyan-dark);text-decoration:none;transition:background .15s,border-color .15s,color .15s,transform .15s}
.fa-share-btn:hover{background:var(--cyan-light);border-color:var(--cyan);transform:translateY(-1px)}
.fa-share-btn svg{width:18px;height:18px;display:block}
.fa-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){
  .fa-hero-grid{grid-template-columns:1fr;gap:2.2rem;padding:3rem 1.5rem 3.25rem}
  .fa-hero-media{order:-1;max-width:540px;margin:0 auto;width:100%}
  .fa-mini-facts{grid-template-columns:1fr}
  .fa-price-shell{grid-template-columns:1fr}
  .fa-price-foot{flex-direction:column;align-items:flex-start}
  .fa-price-actions{align-items:flex-start}
  .fa-price-support{text-align:left}
}
@media(max-width:560px){
  .fa-section{padding:3.4rem 1.4rem}
  .fa-title{font-size:clamp(2rem,10.5vw,2.6rem)}
  .fa-gallery{grid-template-columns:1fr}
  .fa-cta-row{flex-direction:column;align-items:stretch}
  .fa-btn-primary,.fa-btn-ghost{justify-content:center}
  .fa-menu{padding:0.8rem}
  .fa-process-tabs{gap:0.5rem}
  .fa-process-tab{padding:0.8rem 0.75rem}
  .fa-process-label{font-size:0.82rem}
  .fa-share-inner{display:block;padding:1.05rem 1rem}
  .fa-share-actions{justify-content:flex-start;margin-top:0.8rem}
}
</style>`;

const ALL_SERVICES = [
  { label: 'Furniture Assembly', austin: '/furniture-assembly-austin-tx' },
  { label: 'TV Mounting', austin: '/tv-mounting-austin-tx' },
  { label: 'Smart Home Installation', austin: '/smart-home-installation-austin-tx' },
  { label: 'Fitness Equipment Assembly', austin: '/fitness-equipment-assembly-austin-tx' },
  { label: 'Office Furniture Assembly', austin: '/office-furniture-assembly-austin-tx' },
  { label: 'Playset Assembly', austin: '/playset-assembly-austin-tx' },
];
const NEAR_CITIES = [
  { slug: 'round-rock', name: 'Round Rock' },
  { slug: 'cedar-park', name: 'Cedar Park' },
  { slug: 'pflugerville', name: 'Pflugerville' },
  { slug: 'lakeway', name: 'Lakeway' },
];
const FLAGSHIP_STYLE_RE = /<style>\s*\/\* ===== Flagship[\s\S]*?<\/style>\s*/g;
const CITY_TEMPLATE_STYLE_RE = /<style>\s*\.pricing-shell\{[\s\S]*?#m-svc-bar\{display:none\}[\s\S]*?<\/style>\s*/g;

function gallerySection(cfg) {
  const header = `    <div class="fa-head">
      <div class="fa-kicker">Recent work</div>
      <h2 class="fa-h2">${cfg.workHeadline}</h2>
      <p class="fa-lead">Recent job photos for this service.</p>
    </div>`;
  const shot = (g) => `      <figure class="fa-shot"><div class="frame"><img src="/images/${g.src}" alt="${g.alt}" loading="lazy"${g.pos ? ` style="object-position:${g.pos}"` : ''}/></div><figcaption class="cap">${g.cap}<small>${g.sub}</small></figcaption></figure>`;
  const noteCell = `      <div class="fa-note"><strong>${cfg.noteStrong}</strong><p>${cfg.noteSpan}</p></div>`;
  let inner;
  if (cfg.gallery.length >= 2) {
    inner = `    <div class="fa-gallery">\n${cfg.gallery.slice(0, 2).map(shot).join('\n')}\n    </div>`;
  } else if (cfg.gallery.length === 1) {
    inner = `    <div class="fa-gallery">\n${shot(cfg.gallery[0])}\n${noteCell}\n    </div>`;
  } else {
    inner = `    <div class="fa-note"><strong>${cfg.noteStrong}</strong><p>${cfg.noteSpan}</p></div>`;
  }
  return `<section class="fa-section" style="background:var(--white)">
  <div class="fa-wrap">
${header}
${inner}
  </div>
</section>`;
}

function buildBody(cfg) {
  const bk = `/book?service=${cfg.bookingParam}`;
  const pageUrl = `https://www.assembleatease.com/${cfg.slug}`;
  const facebookShare = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`;
  const linkedinShare = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`;
  const menu = cfg.offers
    .slice(0, MAX_COMMON_JOBS)
    .map((o) => `      <div class="fa-menu-row"><span class="nm">${o.n}${o.popular ? ' <span class="tag">Popular</span>' : ''}</span><span class="pr">${o.p}</span></div>`)
    .join('\n');
  const faqs = cfg.faqs.map((f) => `    <div class="fa-faq-item">
      <button class="fa-faq-q" onclick="var a=this.nextElementSibling;a.style.display=a.style.display==='block'?'none':'block';this.querySelector('.fa-chev').style.transform=a.style.display==='block'?'rotate(180deg)':'rotate(0)'">${f.q} <span class="fa-chev">&#8964;</span></button>
      <div class="fa-faq-a">${f.a}</div>
    </div>`).join('\n');
  const nearby = NEAR_CITIES.map((c) => `      <a href="/${cfg.prefix}-${c.slug}-tx">${c.name}</a>`).join('\n');
  const processId = `process-${cfg.slug}`;

  return `<!-- HERO -->
<section class="fa-hero">
  <div class="fa-hero-grid">
    <div class="fa-hero-copy">
      <span class="fa-eyebrow">${CITY}, TX &middot; ${cfg.eyebrow}</span>
      <h1 class="fa-title">${cfg.heroTitle}</h1>
      <p class="fa-sub">${cfg.heroSub}</p>
      <div class="fa-cta-row">
        <a class="fa-btn-primary" href="${bk}">${cfg.ctaVerb} &rarr;</a>
        <a class="fa-btn-ghost" href="#fa-pricing">See pricing</a>
      </div>
    </div>
    <div class="fa-hero-media">
      <img src="/images/${cfg.heroPhoto}" alt="${cfg.heroAlt}" loading="eager" fetchpriority="high"/>
      <div class="fa-media-chip">Done in ${CITY}</div>
    </div>
  </div>
</section>

<!-- OUR WORK -->
${gallerySection(cfg)}

<!-- PRICING -->
<section class="fa-section" id="fa-pricing" style="background:var(--off-white);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
  <div class="fa-wrap">
    <div class="fa-head fa-head--center">
      <div class="fa-kicker">Pricing</div>
      <h2 class="fa-h2">Simple, flat pricing</h2>
    </div>
    <div class="fa-price-shell">
      <div class="fa-price-side">
        <div class="fa-price-anchor"><span class="big">From ${cfg.fromPrice}</span><span class="lbl">${cfg.fromLabel}</span></div>
        <p class="fa-price-note">Common jobs and starting points for this service. Choose the matching service type, then add the exact setup details in booking so we can confirm the scope before the visit.</p>
      </div>
      <div class="fa-menu">
${menu}
      </div>
    </div>
    <div class="fa-price-foot">
      <div class="fa-price-copy">
        <strong>Need a different setup?</strong>
        <span>Tell us the exact items, wall conditions, or room layout and we will line up the right visit for the job.</span>
      </div>
      <div class="fa-price-actions">
        <a href="${bk}" class="fa-btn-primary">Check availability &amp; book &rarr;</a>
        <p class="fa-price-support">Add item count, wall details, or room notes in booking and we will confirm the setup before the visit.</p>
      </div>
    </div>
  </div>
</section>

<!-- HOW IT WORKS -->
<section class="fa-section" style="background:var(--white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:900px">
    <div class="fa-head fa-head--center" style="margin-bottom:1.4rem">
      <div class="fa-kicker">Simple process</div>
      <h2 class="fa-h2">Three quick steps.</h2>
    </div>
    <div class="fa-process" id="${processId}">
      <div class="fa-process-tabs" role="tablist" aria-label="Simple process">
        <button type="button" class="fa-process-tab is-active" role="tab" aria-selected="true" onclick="aaeSetProcessStep('${processId}', this, 'Tell us what you need', 'Choose the items or options for this job and pick a time that works for you.')"><span class="fa-process-num">1</span><span class="fa-process-label">Pick</span></button>
        <button type="button" class="fa-process-tab" role="tab" aria-selected="false" onclick="aaeSetProcessStep('${processId}', this, 'We confirm the details', 'We review availability, confirm the visit, and reach out if anything needs clarification before the appointment.')"><span class="fa-process-num">2</span><span class="fa-process-label">Confirm</span></button>
        <button type="button" class="fa-process-tab" role="tab" aria-selected="false" onclick="aaeSetProcessStep('${processId}', this, 'We complete the setup', 'Your pro arrives ready for the job, finishes the setup carefully, and leaves the space ready to use.')"><span class="fa-process-num">3</span><span class="fa-process-label">Done</span></button>
      </div>
      <div class="fa-process-panel">
        <h3>Tell us what you need</h3>
        <p>Choose the items or options for this job and pick a time that works for you.</p>
      </div>
    </div>
  </div>
</section>

<!-- WHAT TO EXPECT -->
<section class="fa-section" style="background:var(--off-white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:900px">
    <div class="fa-head fa-head--center" style="margin-bottom:1.5rem">
      <div class="fa-kicker">Booking notes</div>
      <h2 class="fa-h2">Before you book.</h2>
    </div>
    <div class="fa-mini-facts">
      <div class="fa-mini-fact"><strong class="fa-mini-fact-title">Reviewed local pro</strong><span>Assigned and confirmed before the visit.</span></div>
      <div class="fa-mini-fact"><strong class="fa-mini-fact-title">Careful setup</strong><span>Built, mounted, or installed with the finish details checked.</span></div>
      <div class="fa-mini-fact"><strong class="fa-mini-fact-title">Ready to use</strong><span>We leave the space clean and the job ready for the next step.</span></div>
    </div>
  </div>
</section>

<!-- FAQ -->
<section class="fa-section" style="background:var(--white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:700px">
    <div class="fa-head fa-head--center" style="margin-bottom:2.4rem">
      <div class="fa-kicker">FAQ</div>
      <h2 class="fa-h2">Common questions about ${cfg.faqNoun} in ${CITY}</h2>
    </div>
${faqs}
  </div>
</section>

<!-- NEARBY CITIES -->
<section class="fa-section" style="background:var(--off-white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:760px;text-align:center">
    <div class="fa-head fa-head--center" style="margin-bottom:1.6rem">
      <div class="fa-kicker">Nearby cities</div>
      <h2 class="fa-h2">${cfg.linkLabel} outside Austin</h2>
    </div>
    <div class="fa-citylinks">
${nearby}
    </div>
  </div>
</section>

<!-- SHARE -->
<section class="fa-section" style="background:var(--white)">
  <div class="fa-share-kit" aria-label="Share this service page">
    <div class="fa-share-inner">
      <div class="fa-share-copy">
        <strong>Share this service page.</strong>
        <span>Send it to someone planning this kind of job.</span>
      </div>
      <div class="fa-share-actions">
        <a class="fa-share-btn" href="${facebookShare}" target="_blank" rel="noopener" aria-label="Share on Facebook">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-7.3H16l.4-3h-2.9V8.8c0-.9.2-1.5 1.5-1.5h1.6V4.6c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 4v2.2H8v3h2.5V21h3z"/></svg>
          <span class="fa-sr-only">Facebook</span>
        </a>
        <a class="fa-share-btn" href="${linkedinShare}" target="_blank" rel="noopener" aria-label="Share on LinkedIn">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.94 8.5a1.72 1.72 0 1 1 0-3.44 1.72 1.72 0 0 1 0 3.44ZM8.5 19H5.38V9.86H8.5V19Zm10.12 0h-3.1v-4.45c0-1.06-.02-2.42-1.48-2.42-1.49 0-1.72 1.16-1.72 2.34V19H9.2V9.86h3v1.25h.04c.42-.8 1.44-1.65 2.96-1.65 3.16 0 3.74 2.08 3.74 4.78V19Z"/></svg>
          <span class="fa-sr-only">LinkedIn</span>
        </a>
        <a class="fa-share-btn" href="#" data-copy-url="${pageUrl}" onclick="return aaeCopyShareLink(this)" aria-label="Copy page link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.2 4.72"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.8 19.28"/></svg>
          <span class="fa-sr-only">Copy link</span>
        </a>
      </div>
    </div>
  </div>
</section>

<script>
function aaeSetProcessStep(groupId, btn, title, copy){
  var group=document.getElementById(groupId);
  if(!group) return;
  var tabs=group.querySelectorAll('.fa-process-tab');
  tabs.forEach(function(tab){
    tab.classList.remove('is-active');
    tab.setAttribute('aria-selected','false');
  });
  btn.classList.add('is-active');
  btn.setAttribute('aria-selected','true');
  var panel=group.querySelector('.fa-process-panel');
  if(!panel) return;
  panel.innerHTML='<h3>'+title+'</h3><p>'+copy+'</p>';
}
function aaeCopyShareLink(link){
  var url=link.getAttribute('data-copy-url');
  if(!url) return false;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(function(){
      link.setAttribute('aria-label','Link copied');
      link.title='Link copied';
    });
  }
  return false;
}
</script>

`;
}

const SERVICES = [
  {
    slug: 'furniture-assembly-austin-tx', prefix: 'furniture-assembly', linkLabel: 'Furniture assembly',
    eyebrow: 'Furniture Assembly', faqNoun: 'furniture assembly', bookingParam: 'Furniture+Assembly',
    fromPrice: '$69', fromLabel: 'per item', ctaVerb: 'Book furniture assembly',
    heroTitle: 'Furniture Assembly in Austin,<br><em>built right the first time.</em>',
    heroSub: 'Beds, dressers, desks, sectionals and storage pieces assembled cleanly and left ready to use. Tools and cleanup are included.',
    heroPhoto: 'real-furniture-dresser-wood.jpg', heroAlt: 'Two-tone six-drawer dresser assembled in an Austin bedroom',
    workHeadline: 'Built right. Left clean.',
    noteStrong: 'Recent builds around Austin.', noteSpan: 'Beds, dressers, desks and storage pieces assembled, leveled and cleaned up before we leave.',
    gallery: [
      { src: 'real-furniture-dresser-white.png', alt: 'Nine-drawer white dresser assembled and leveled in an Austin bedroom', cap: '9-drawer modern dresser', sub: 'Drawers aligned, frame leveled, packaging removed' },
      { src: 'real-furniture-bed-paneled.png', alt: 'Upholstered paneled platform bed assembled in a bedroom', cap: 'Upholstered platform bed', sub: 'Headboard, rails and slats torqued to spec', pos: 'center 26%' },
    ],
    offers: [
      { n: 'Side / end table', p: '$69' },
      { n: 'Nightstand (single)', p: '$79' },
      { n: 'Bed frame (queen)', p: '$119', popular: true },
      { n: 'Dresser / chest of drawers', p: '$109&ndash;$129' },
      { n: 'IKEA PAX wardrobe (single unit)', p: '$169' },
    ],
    faqs: [
      { q: 'How long does furniture assembly take?', a: 'Most single items take 30&ndash;90 minutes. A full bedroom set or several pieces can take longer. We&rsquo;ll give you a time estimate when confirming your booking.' },
      { q: 'Do you bring your own tools?', a: 'Yes. Our Easers arrive with the tools needed for standard flat-pack furniture assembly.' },
      { q: 'Can you assemble any brand?', a: 'Yes &mdash; IKEA, Wayfair, Amazon, Ashley, Target, Costco, CB2, Pottery Barn, West Elm and more.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; in addition to Austin, we cover Round Rock, Cedar Park, Pflugerville, Lakeway, and the surrounding metro. Book online and we&rsquo;ll confirm the details.' },
    ],
  },
  {
    slug: 'tv-mounting-austin-tx', prefix: 'tv-mounting', linkLabel: 'TV Mounting',
    eyebrow: 'TV Mounting', faqNoun: 'TV mounting', bookingParam: 'Mounting+%26+Hanging',
    fromPrice: '$99', fromLabel: 'standard TV &mdash; pictures &amp; mirrors from $79', ctaVerb: 'Book TV mounting',
    heroTitle: 'TV Mounting in Austin,<br><em>level and clean.</em>',
    heroSub: 'TVs, soundbars, mirrors and art &mdash; mounted level, anchored to studs, cables hidden. You supply the mount and hardware; we bring the tools and the steady hands for a clean, level wall.',
    heroPhoto: 'real-tv-mount-console.jpg', heroAlt: 'Large flat-screen TV wall-mounted above a media console',
    workHeadline: 'Mounted level. Wires gone.',
    noteStrong: 'Hundreds of TVs on the wall and counting.', noteSpan: 'Bedrooms, great rooms, offices and patios &mdash; mounts, soundbars and cable concealment, cleaned up and leveled.',
    gallery: [
      { src: 'real-tv-dawg-days.jpg', alt: 'Large TV mounted on a great-room wall above a soundbar', cap: 'Great-room TV + soundbar', sub: 'Leveled, soundbar mounted, cables out of sight' },
      { src: 'real-tv-setup-console.jpg', alt: 'Flat TV flush-mounted over a black media console', cap: 'Flush mount over a console', sub: 'Tilt set, cords concealed, ready to watch' },
    ],
    offers: [
      { n: 'Single framed picture / mirror', p: '$79' },
      { n: 'TV up to 40" (standard wall)', p: '$99' },
      { n: 'TV 41"&ndash;55" (standard wall)', p: '$119', popular: true },
      { n: 'In-wall cord concealment', p: '$189' },
    ],
    faqs: [
      { q: 'How long does TV mounting take?', a: 'Most standard wall mounts take 60&ndash;90 minutes. Cord concealment, brick or stone, and above-fireplace jobs take a little longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you provide the TV mount?', a: 'No &mdash; please have your wall mount and any hardware ready before the visit. Our pros bring the tools and do the install. Not sure which mount fits your TV and wall? Message your pro after booking and they&rsquo;ll point you to the right one.' },
      { q: 'Can you hide the cables in the wall?', a: 'Yes &mdash; in-wall cord concealment runs the cables behind the drywall for a clean look on standard walls. On brick, stone or surfaces where in-wall isn&rsquo;t possible, we use a paintable cable raceway.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'smart-home-installation-austin-tx', prefix: 'smart-home-installation', linkLabel: 'Smart Home Installation',
    eyebrow: 'Smart Home Setup', faqNoun: 'smart home setup', bookingParam: 'Smart+Home',
    fromPrice: '$69', fromLabel: 'per device &mdash; installed &amp; tested', ctaVerb: 'Book smart home setup',
    heroTitle: 'Smart Home Installation in Austin,<br><em>installed and tested.</em>',
    heroSub: 'Thermostats, video doorbells, cameras, locks and plugs &mdash; installed, connected to your Wi-Fi, and tested before we leave. No app headaches, no half-finished setup.',
    heroPhoto: 'real-smarthome-doorbell-vivint.png', heroAlt: 'Smart video doorbell installed beside a front door',
    workHeadline: 'Installed, connected, tested.',
    noteStrong: 'Set up and working before we leave.', noteSpan: 'Doorbells, thermostats, cameras, locks and plugs &mdash; wired where needed, connected to your app, and tested with you.',
    gallery: [
      { src: 'real-smarthome-doorbell-adt.jpg', alt: 'Smart video doorbell mounted on exterior siding', cap: 'Video doorbell install', sub: 'Mounted, wired, connected and tested' },
    ],
    offers: [
      { n: 'Smart plug install + setup (per 2 plugs)', p: '$69' },
      { n: 'Smart Thermostat (Nest, Ecobee)', p: '$99', popular: true },
      { n: 'Smart Doorbell &mdash; wireless', p: '$89' },
      { n: 'Camera System (4 cameras)', p: '$249' },
    ],
    faqs: [
      { q: 'What can you install?', a: 'Thermostats, video doorbells, cameras, smart locks, plugs, switches and hubs. If it connects to an app, we can usually mount it, wire it, and set it up.' },
      { q: 'Do I need to buy the device first?', a: 'Yes &mdash; have your device and any subscription ready. We handle mounting, wiring where needed, app setup and testing on your Wi-Fi.' },
      { q: 'Will it work with my existing setup?', a: 'We connect new devices to your Wi-Fi and your existing app or ecosystem (Google, Alexa, Apple Home where supported) and test everything before we leave.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'fitness-equipment-assembly-austin-tx', prefix: 'fitness-equipment-assembly', linkLabel: 'Fitness Equipment Assembly',
    eyebrow: 'Fitness Equipment Assembly', faqNoun: 'fitness equipment assembly', bookingParam: 'Fitness+Equipment',
    fromPrice: '$119', fromLabel: 'per machine &mdash; assembled &amp; leveled', ctaVerb: 'Book fitness assembly',
    heroTitle: 'Fitness Equipment Assembly in Austin,<br><em>ready to train.</em>',
    heroSub: 'Treadmills, ellipticals, racks and full home gyms &mdash; assembled solid, leveled, and wiped down. We bring the tools and break down the boxes so you can start day one.',
    heroPhoto: 'real-fitness-home-gym.jpg', heroAlt: 'Home gym with assembled cardio machines and a power rack',
    workHeadline: 'Heavy gear, assembled right.',
    noteStrong: 'From a single treadmill to a full home gym.', noteSpan: 'Cardio machines, racks, benches and cable systems &mdash; built to spec, leveled, stable, and wiped down before we go.',
    gallery: [],
    offers: [
      { n: 'Inversion Table', p: '$119' },
      { n: 'Treadmill Assembly', p: '$189', popular: true },
      { n: 'Elliptical Machine', p: '$209' },
      { n: 'Squat Rack / Power Cage', p: '$219' },
    ],
    faqs: [
      { q: 'How long does equipment assembly take?', a: 'Most treadmills and ellipticals take 1&ndash;2 hours; racks, cages and full home gyms can take longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you bring tools?', a: 'Yes &mdash; our Easers arrive fully equipped. You don&rsquo;t need to provide any tools or equipment.' },
      { q: 'Can you assemble any brand?', a: 'Yes &mdash; Peloton, NordicTrack, Bowflex, Sole, Rogue, Titan and more. If it shipped in a box with instructions, we can build it.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'office-furniture-assembly-austin-tx', prefix: 'office-furniture-assembly', linkLabel: 'Office Furniture Assembly',
    eyebrow: 'Office Furniture Assembly', faqNoun: 'office furniture assembly', bookingParam: 'Office+Assembly',
    fromPrice: '$89', fromLabel: 'per piece &mdash; built square &amp; leveled', ctaVerb: 'Book office assembly',
    heroTitle: 'Office Furniture Assembly in Austin,<br><em>back to work.</em>',
    heroSub: 'Desks, chairs, cabinets and full workstations &mdash; built square, leveled, and ready to use. Tools and cleanup included, whether it&rsquo;s one desk or a whole floor.',
    heroPhoto: 'real-office-home-ldesk.jpg', heroAlt: 'Assembled wooden L-shaped desk and storage in a home office',
    workHeadline: 'Built square. Ready to work.',
    noteStrong: 'Home offices to full floors.', noteSpan: 'Desks, standing desks, chairs, cabinets, bookcases and multi-seat workstations &mdash; built square, leveled and cleaned up.',
    gallery: [
      { src: 'real-office-workstations.jpg', alt: 'Row of assembled office workstations with dividers', cap: 'Multi-seat workstations', sub: 'Desks, dividers and pedestals, aligned and leveled' },
      { src: 'real-office-cabinets.jpg', alt: 'Pair of assembled glass-door storage cabinets', cap: 'Storage cabinets', sub: 'Built, leveled and anchored where needed' },
    ],
    offers: [
      { n: 'Office Chair / File Cabinet', p: '$89' },
      { n: 'Simple Flat-Pack Desk', p: '$99' },
      { n: 'L-Shape / Executive Desk', p: '$179', popular: true },
      { n: 'Electric Standing Desk', p: '$199' },
    ],
    faqs: [
      { q: 'How long does office assembly take?', a: 'A single desk or chair is usually 45&ndash;90 minutes; a full workstation or several pieces takes longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you bring tools?', a: 'Yes &mdash; fully equipped, including for electric standing desks. You don&rsquo;t need to provide any tools or equipment.' },
      { q: 'Can you do a whole office?', a: 'Yes &mdash; desks, chairs, cabinets, bookcases and full workstation sets. Bundle the pieces into one visit and we&rsquo;ll knock it out in a single trip.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'playset-assembly-austin-tx', prefix: 'playset-assembly', linkLabel: 'Playset Assembly',
    eyebrow: 'Outdoor & Playset Assembly', faqNoun: 'playset & outdoor assembly', bookingParam: 'Outdoor+%26+Playsets',
    fromPrice: '$299', fromLabel: 'playsets &mdash; smaller outdoor items from $89', ctaVerb: 'Book outdoor assembly',
    heroTitle: 'Playset Assembly in Austin,<br><em>ready for the backyard.</em>',
    heroSub: 'Playsets, swing sets, trampolines, gazebos and patio sets &mdash; built to spec, anchored safe, and checked over before anyone climbs on. Tools and cleanup included.',
    heroPhoto: 'service-outdoor-playsets.jpg', heroAlt: 'Assembler building a backyard playset frame with the completed set behind him',
    workHeadline: 'Built safe. Ready to play.',
    noteStrong: 'Backyards built and counting.', noteSpan: 'Swing sets, trampolines, playhouses and gazebos &mdash; built to spec, anchored, and safety-checked before play.',
    gallery: [
      { src: 'work-outdoor-playset.jpg', alt: 'Assembler working on a backyard playset frame', cap: 'Playset build in progress', sub: 'Frame squared up, hardware staged, setup underway' },
      { src: 'real-outdoor-gazebo.png', alt: 'Assembled backyard gazebo structure', cap: 'Completed gazebo kit', sub: 'Leveled, tightened, and ready for the backyard' },
    ],
    offers: [
      { n: 'Deck box / outdoor storage bench', p: '$89' },
      { n: 'Patio umbrella + base', p: '$89' },
      { n: 'Trampoline Assembly', p: '$199', popular: true },
      { n: 'Swing Set / Backyard Playset', p: '$299&ndash;$379' },
      { n: 'Pergola / Gazebo Kit', p: '$399&ndash;$599' },
    ],
    faqs: [
      { q: 'How long does a playset take?', a: 'A trampoline or sandbox is often 1&ndash;2 hours; a large swing set or playset can take 3&ndash;5 hours or more. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you anchor it safely?', a: 'Yes &mdash; we build to the manufacturer&rsquo;s spec, anchor per the instructions, and check stability before anyone gets on.' },
      { q: 'Can you assemble any brand?', a: 'Yes &mdash; Backyard Discovery, Gorilla, Lifetime, Rainbow, Springfree and more, plus pergola and gazebo kits and patio furniture.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
];

let count = 0;
for (const cfg of SERVICES) {
  assertVisibleStartPrice(cfg);
}
for (const cfg of SERVICES) {
  const file = `${cfg.slug}.html`;
  let html = readFileSync(file, 'utf8');

  // 1. replace any previous flagship CSS block so regenerated pages stay clean.
  html = html.replace(FLAGSHIP_STYLE_RE, '');
  html = html.replace(CITY_TEMPLATE_STYLE_RE, '');
  html = html.replace('</head>', `${FA_STYLE}\n</head>`);

  // 2. swap visible body
  const start = html.indexOf('<!-- HERO -->');
  const end = html.indexOf('<footer class="footer">');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Body markers not found in ${file}`);
  }
  html = html.slice(0, start) + buildBody(cfg) + html.slice(end);

  // 3. point social image at the real hero photo
  const heroUrl = `https://www.assembleatease.com/images/${cfg.heroPhoto}`;
  html = html.replace('<meta property="og:image" content="https://www.assembleatease.com/images/logo.jpg"/>', `<meta property="og:image" content="${heroUrl}"/>`);
  html = html.replace('<meta name="twitter:card" content="summary"/>', '<meta name="twitter:card" content="summary_large_image"/>');
  html = html.replace('<meta name="twitter:image" content="https://www.assembleatease.com/images/logo.jpg"/>', `<meta name="twitter:image" content="${heroUrl}"/>`);

  // One Organization is the business identity; each location landing page
  // describes the specific service supplied in that verified market.
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    buildServiceSchema(cfg),
  );

  writeFileSync(file, html);
  count += 1;
  console.log(`built ${file}`);
}
console.log(`Done: ${count} pages.`);
