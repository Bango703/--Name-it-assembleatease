// Transforms the 5 non-furniture Austin service pages to the flagship layout.
// Keeps each page's <head> (title/meta/canonical/JSON-LD/base CSS), nav, mobile nav,
// footer, mobile sticky bar, cookie banner and scripts INTACT. Only:
//   1. injects the flagship .fa-* CSS before </head> (idempotent)
//   2. swaps the visible body (between <!-- HERO --> and <footer class="footer">)
//   3. points og:image / twitter:image at the service's real hero photo
// Copy is location-NEUTRAL except the SEO spots (eyebrow, service-area, FAQ, links).
import { readFileSync, writeFileSync } from 'node:fs';

const CITY = 'Austin';

const FA_STYLE = `<style>
/* ===== Flagship service page ===== */
.fa-hero{position:relative;background:linear-gradient(180deg,#edf6fe 0%,#f6fbff 55%,#ffffff 100%);overflow:hidden;border-bottom:1px solid var(--border)}
.fa-hero::before{content:"";position:absolute;top:-28%;right:-8%;width:52%;height:130%;background:radial-gradient(circle at center,rgba(0,191,255,0.16),transparent 60%);pointer-events:none}
.fa-hero-grid{position:relative;z-index:1;max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1.02fr 0.98fr;gap:3.5rem;align-items:center;padding:4.25rem 2rem 4.5rem}
.fa-eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:0.72rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:var(--cyan-dark);margin-bottom:1.25rem}
.fa-eyebrow::before{content:"";width:24px;height:2px;background:var(--cyan)}
.fa-title{font-family:var(--font-display);font-size:clamp(2.3rem,4.6vw,3.6rem);line-height:1.04;letter-spacing:-0.5px;color:var(--ink);margin-bottom:1.1rem}
.fa-title em{font-style:italic;color:var(--cyan-dark)}
.fa-sub{font-size:1.08rem;line-height:1.7;color:var(--ink-soft);max-width:31rem;margin-bottom:1.85rem}
.fa-cta-row{display:flex;flex-wrap:wrap;gap:0.9rem;margin-bottom:1.7rem}
.fa-btn-primary{display:inline-flex;align-items:center;gap:8px;background:var(--cyan);color:#03303f;font-weight:700;font-size:1rem;padding:0.95rem 1.95rem;border-radius:999px;text-decoration:none;transition:all .18s;box-shadow:0 12px 30px rgba(0,191,255,0.3)}
.fa-btn-primary:hover{background:var(--cyan-dark);color:#fff;transform:translateY(-2px)}
.fa-btn-ghost{display:inline-flex;align-items:center;gap:8px;color:var(--ink);font-weight:600;font-size:1rem;padding:0.95rem 1.5rem;border-radius:999px;text-decoration:none;border:1.5px solid var(--border);transition:all .18s}
.fa-btn-ghost:hover{border-color:var(--cyan);color:var(--cyan-dark)}
.fa-hero-proof{display:flex;align-items:center;flex-wrap:wrap;gap:0.4rem;font-size:0.9rem;color:var(--ink-soft)}
.fa-stars{color:#f5a623;letter-spacing:1px}
.fa-hero-proof strong{color:var(--ink)}
.fa-dot{width:4px;height:4px;border-radius:50%;background:#cbd5e1;margin:0 0.5rem}
.fa-hero-media{position:relative}
.fa-hero-media img{width:100%;height:auto;display:block;border-radius:20px;box-shadow:0 26px 55px rgba(2,32,43,0.22)}
.fa-media-chip{position:absolute;left:0.9rem;bottom:0.9rem;background:rgba(8,18,30,0.84);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.14);color:#fff;font-size:0.78rem;font-weight:600;padding:0.5rem 0.9rem;border-radius:999px;display:flex;align-items:center;gap:8px}
.fa-media-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:#28d17c;box-shadow:0 0 0 4px rgba(40,209,124,0.25)}
.fa-strip{background:#f3f8fc;border-bottom:1px solid var(--border);padding:1.1rem 2rem}
.fa-strip-inner{max-width:1080px;margin:0 auto;display:flex;flex-wrap:wrap;justify-content:center;gap:0.9rem 2.4rem}
.fa-strip span{display:inline-flex;align-items:center;gap:9px;font-size:0.86rem;color:var(--ink-soft);font-weight:600}
.fa-strip svg{color:var(--cyan-dark);flex-shrink:0}
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
.fa-note{background:linear-gradient(155deg,var(--cyan) 0%,#0079a8 100%);border-radius:16px;padding:1.9rem 1.6rem;color:#fff;display:flex;flex-direction:column;justify-content:center;min-height:200px}
.fa-note strong{font-family:var(--font-display);font-size:1.4rem;line-height:1.18;display:block;margin-bottom:0.6rem}
.fa-note p{font-size:0.92rem;line-height:1.6;color:rgba(255,255,255,0.92)}
.fa-band{margin-top:1.4rem;background:linear-gradient(135deg,var(--cyan) 0%,#0084bd 100%);border-radius:16px;padding:1.3rem 1.7rem;color:#fff;display:flex;align-items:center;gap:0.65rem;flex-wrap:wrap;justify-content:center;text-align:center}
.fa-band strong{font-family:var(--font-display);font-size:1.15rem}
.fa-band span{font-size:0.9rem;color:rgba(255,255,255,0.94)}
.fa-price-anchor{text-align:center;margin-bottom:1.8rem}
.fa-price-anchor .big{font-family:var(--font-display);font-size:clamp(2.4rem,5vw,3.1rem);color:var(--cyan-dark);line-height:1}
.fa-price-anchor .lbl{display:block;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--muted);font-weight:700;margin-top:0.45rem}
.fa-menu{max-width:600px;margin:0 auto;background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:0.4rem 1.7rem;box-shadow:var(--shadow)}
.fa-menu-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.05rem 0;border-bottom:1px solid var(--border)}
.fa-menu-row:last-child{border-bottom:none}
.fa-menu-row .nm{font-size:0.96rem;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:0.55rem;flex-wrap:wrap}
.fa-menu-row .tag{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--cyan-dark);background:var(--cyan-light);border:1px solid var(--cyan-mid);border-radius:999px;padding:0.12rem 0.5rem}
.fa-menu-row .pr{font-family:var(--font-display);font-size:1.2rem;color:var(--cyan-dark);white-space:nowrap}
.fa-price-foot{max-width:600px;margin:1.5rem auto 0;text-align:center}
.fa-price-foot p{font-size:0.88rem;color:var(--muted);line-height:1.65;margin-bottom:1.4rem}
.fa-why{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem;margin-top:2.6rem}
.fa-why-card{background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:1.75rem;transition:border-color .15s,box-shadow .15s}
.fa-why-card:hover{border-color:var(--cyan);box-shadow:var(--shadow)}
.fa-why-ico{width:36px;height:36px;border-radius:10px;background:var(--cyan-light);border:1px solid var(--cyan-mid);margin-bottom:0.85rem;display:flex;align-items:center;justify-content:center}
.fa-why-card h3{font-size:0.96rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem}
.fa-why-card p{font-size:0.875rem;color:var(--muted);line-height:1.65}
.fa-chips{display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center;margin-top:1.6rem}
.fa-chip{background:var(--white);border:1px solid var(--border);border-radius:999px;padding:0.35rem 0.95rem;font-size:0.8rem;font-weight:500;color:var(--ink-soft)}
.fa-faq-item{background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:0.75rem}
.fa-faq-q{width:100%;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.05rem 1.3rem;background:none;border:none;cursor:pointer;font-family:var(--font-body);font-size:0.94rem;font-weight:600;color:var(--ink);text-align:left}
.fa-faq-a{display:none;padding:0 1.3rem 1.1rem;font-size:0.88rem;color:var(--muted);line-height:1.75}
.fa-chev{transition:transform .2s;flex-shrink:0;color:var(--cyan-dark);font-size:1.1rem}
.fa-links{display:grid;grid-template-columns:1fr 1fr;gap:2.5rem;margin-top:0.5rem}
.fa-links-col-title{font-size:0.68rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem}
.fa-links a{color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500;display:block;margin-bottom:0.65rem}
.fa-links a:hover{text-decoration:underline}
@media(max-width:900px){
  .fa-hero-grid{grid-template-columns:1fr;gap:2.2rem;padding:3rem 1.5rem 3.25rem}
  .fa-hero-media{order:-1;max-width:540px;margin:0 auto;width:100%}
  .fa-why{grid-template-columns:1fr 1fr}
}
@media(max-width:560px){
  .fa-section{padding:3.4rem 1.4rem}
  .fa-gallery{grid-template-columns:1fr}
  .fa-why{grid-template-columns:1fr}
  .fa-links{grid-template-columns:1fr;gap:2rem}
  .fa-cta-row{flex-direction:column;align-items:stretch}
  .fa-btn-primary,.fa-btn-ghost{justify-content:center}
  .fa-menu{padding:0.25rem 1.2rem}
}
</style>`;

const WHY_CARDS = `
      <div class="fa-why-card"><div class="fa-why-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0099CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div><h3>Secure checkout</h3><p>Review your total before confirming. Payment is handled securely by Stripe after completion.</p></div>
      <div class="fa-why-card"><div class="fa-why-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0099CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div><h3>Same-day &amp; next-day available</h3><p>We keep open slots for last-minute bookings across the metro.</p></div>
      <div class="fa-why-card"><div class="fa-why-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0099CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg></div><h3>Flat-rate pricing &mdash; no surprises</h3><p>Every item price, service-call fee, and tax estimate is shown before checkout.</p></div>
      <div class="fa-why-card"><div class="fa-why-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0099CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></div><h3>Locally owned &amp; operated</h3><p>Not a national chain. We live and work in the same communities we serve.</p></div>
      <div class="fa-why-card"><div class="fa-why-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0099CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div><h3>Fast follow-up</h3><p>Book online and get a real confirmation fast &mdash; not a chatbot, not days later.</p></div>
      <div class="fa-why-card"><div class="fa-why-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0099CC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div><h3>Careful, clean, respectful</h3><p>We treat your home like it&rsquo;s ours. No rushing, no shortcuts. Every time.</p></div>`;

const ICONS = {
  wrench: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  clock: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  shield: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
};

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
const AREA_CHIPS = ['Austin, TX', 'Round Rock, TX', 'Cedar Park, TX', 'Pflugerville, TX', 'Lakeway, TX'];

function trustStrip(items) {
  return `<section class="fa-strip"><div class="fa-strip-inner">
    ${items.map((it) => `<span>${ICONS[it.icon]} ${it.text}</span>`).join('\n    ')}
  </div></section>`;
}

function gallerySection(cfg) {
  const header = `    <div class="fa-head">
      <div class="fa-kicker">Our work</div>
      <h2 class="fa-h2">${cfg.workHeadline}</h2>
      <p class="fa-lead">A few recent jobs we wrapped up &mdash; done solid, left clean, nothing for you to deal with afterward.</p>
    </div>`;
  const shot = (g) => `      <figure class="fa-shot"><div class="frame"><img src="/images/${g.src}" alt="${g.alt}" loading="lazy"${g.pos ? ` style="object-position:${g.pos}"` : ''}/></div><figcaption class="cap">${g.cap}<small>${g.sub}</small></figcaption></figure>`;
  const noteCell = `      <div class="fa-note"><strong>${cfg.noteStrong}</strong><p>${cfg.noteSpan}</p></div>`;
  const band = `    <div class="fa-band"><strong>${cfg.noteStrong}</strong> <span>${cfg.noteSpan}</span></div>`;
  let inner;
  if (cfg.gallery.length >= 2) {
    inner = `    <div class="fa-gallery">\n${cfg.gallery.slice(0, 2).map(shot).join('\n')}\n    </div>\n${band}`;
  } else if (cfg.gallery.length === 1) {
    inner = `    <div class="fa-gallery">\n${shot(cfg.gallery[0])}\n${noteCell}\n    </div>`;
  } else {
    inner = band;
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
  const menu = cfg.offers.map((o) => `      <div class="fa-menu-row"><span class="nm">${o.n}${o.popular ? ' <span class="tag">Popular</span>' : ''}</span><span class="pr">${o.p}</span></div>`).join('\n');
  const faqs = cfg.faqs.map((f) => `    <div class="fa-faq-item">
      <button class="fa-faq-q" onclick="var a=this.nextElementSibling;a.style.display=a.style.display==='block'?'none':'block';this.querySelector('.fa-chev').style.transform=a.style.display==='block'?'rotate(180deg)':'rotate(0)'">${f.q} <span class="fa-chev">&#8964;</span></button>
      <div class="fa-faq-a">${f.a}</div>
    </div>`).join('\n');
  const brands = cfg.brands.map((b) => `      <span class="fa-chip">${b}</span>`).join('\n');
  const areaChips = AREA_CHIPS.map((c) => `      <span class="fa-chip">${c}</span>`).join('\n');
  const nearby = NEAR_CITIES.map((c) => `        <a href="/${cfg.prefix}-${c.slug}-tx">${cfg.linkLabel} in ${c.name}</a>`).join('\n');
  const others = ALL_SERVICES.filter((s) => s.austin !== `/${cfg.slug}`).slice(0, 4)
    .map((s) => `        <a href="${s.austin}">${s.label} in ${CITY}</a>`).join('\n');

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
      <div class="fa-hero-proof"><span class="fa-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>&nbsp;<strong>5.0</strong>&nbsp;rated <span class="fa-dot"></span> From&nbsp;<strong>${cfg.fromPrice}</strong> <span class="fa-dot"></span> Payment after completion</div>
    </div>
    <div class="fa-hero-media">
      <img src="/images/${cfg.heroPhoto}" alt="${cfg.heroAlt}" loading="eager"/>
      <div class="fa-media-chip">Done in ${CITY}</div>
    </div>
  </div>
</section>

<!-- TRUST STRIP -->
${trustStrip(cfg.trust)}

<!-- OUR WORK -->
${gallerySection(cfg)}

<!-- PRICING -->
<section class="fa-section" id="fa-pricing" style="background:var(--off-white);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
  <div class="fa-wrap">
    <div class="fa-head fa-head--center">
      <div class="fa-kicker">Transparent pricing</div>
      <h2 class="fa-h2">Simple, flat pricing</h2>
    </div>
    <div class="fa-price-anchor"><span class="big">From ${cfg.fromPrice}</span><span class="lbl">${cfg.fromLabel}</span></div>
    <div class="fa-menu">
${menu}
    </div>
    <div class="fa-price-foot">
      <p>Plus a flat $25 service-call fee and tax &mdash; the full total is shown before you confirm. Add your exact items in the booking flow for a live total.</p>
      <a href="${bk}" class="fa-btn-primary">Build your quote &amp; book &rarr;</a>
    </div>
  </div>
</section>

<!-- HOW IT WORKS -->
<section class="fa-section" style="background:var(--white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:900px">
    <div class="fa-head fa-head--center" style="margin-bottom:2.5rem">
      <div class="fa-kicker">Simple process</div>
      <h2 class="fa-h2">Book in minutes. Done today.</h2>
    </div>
    <div class="how-grid">
      <div style="text-align:center;padding:1.5rem 1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.4rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem">1</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Book online</h3>
        <p style="font-size:0.875rem;color:var(--muted);line-height:1.65">Choose what you need, pick a date and time. Takes under 2 minutes.</p>
      </div>
      <div style="font-size:1.5rem;color:var(--border);padding-top:2.5rem">&#8594;</div>
      <div style="text-align:center;padding:1.5rem 1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.4rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem">2</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">We confirm</h3>
        <p style="font-size:0.875rem;color:var(--muted);line-height:1.65">We follow up quickly to confirm availability and assign a reviewed local pro.</p>
      </div>
      <div style="font-size:1.5rem;color:var(--border);padding-top:2.5rem">&#8594;</div>
      <div style="text-align:center;padding:1.5rem 1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.4rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem">3</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Payment after completion</h3>
        <p style="font-size:0.875rem;color:var(--muted);line-height:1.65">The total is shown before you confirm, and payment is processed after the job is complete.</p>
      </div>
    </div>
  </div>
</section>

<!-- WHY CHOOSE US -->
<section class="fa-section" style="background:var(--off-white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap">
    <div class="fa-head fa-head--center">
      <div class="fa-kicker">Why choose us</div>
      <h2 class="fa-h2">Trusted assembly, done right.</h2>
      <p class="fa-lead" style="margin-left:auto;margin-right:auto;text-align:center">Built on referrals &mdash; every job matters to us personally.</p>
    </div>
    <div class="fa-why">${WHY_CARDS}
    </div>
  </div>
</section>

<!-- BRANDS -->
<section style="background:var(--white);border-bottom:1px solid var(--border);padding:2.25rem 2rem">
  <div style="max-width:820px;margin:0 auto;text-align:center">
    <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem">${cfg.brandsLabel}</div>
    <div class="fa-chips">
${brands}
    </div>
  </div>
</section>

<!-- SERVICE AREA -->
<section class="fa-section" style="background:var(--off-white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:780px;text-align:center">
    <div class="fa-head fa-head--center">
      <div class="fa-kicker">Service area</div>
      <h2 class="fa-h2">${cfg.linkLabel} near ${CITY}</h2>
      <p class="fa-lead" style="margin-left:auto;margin-right:auto;text-align:center">We serve ${CITY} and the surrounding metro &mdash; your local assembly and installation team.</p>
    </div>
    <div class="fa-chips">
${areaChips}
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

<!-- INTERNAL LINKS -->
<section class="fa-section" style="background:var(--off-white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap">
    <div class="fa-head fa-head--center" style="margin-bottom:2rem">
      <div class="fa-kicker">Explore more</div>
      <h2 class="fa-h2">${cfg.linkLabel} &amp; more near ${CITY}</h2>
    </div>
    <div class="fa-links">
      <div>
        <div class="fa-links-col-title">${cfg.linkLabel} in nearby cities</div>
${nearby}
      </div>
      <div>
        <div class="fa-links-col-title">Other services in ${CITY}</div>
${others}
      </div>
    </div>
    <div style="margin-top:1.75rem;padding-top:1.5rem;border-top:1px solid var(--border);text-align:center">
      <a href="/book" style="color:var(--cyan-dark);font-size:0.875rem;font-weight:600;text-decoration:none">View all services &rarr;</a>
    </div>
  </div>
</section>

<!-- FINAL CTA -->
<section style="background:linear-gradient(135deg,#07101d 0%,#0a3a52 52%,#0099CC 100%);padding:5rem 2rem;text-align:center">
  <div style="max-width:620px;margin:0 auto">
    <h2 style="font-family:var(--font-display);font-size:clamp(2rem,4vw,2.8rem);color:#fff;margin-bottom:1rem">Ready to get it done?</h2>
    <p style="font-size:1rem;color:rgba(255,255,255,0.85);margin-bottom:2rem;line-height:1.75">Flat-rate pricing and same-day availability across the metro. Book in minutes with secure checkout.</p>
    <a href="${bk}" style="display:inline-flex;align-items:center;gap:8px;background:#fff;color:#04475e;font-family:var(--font-body);font-size:1rem;font-weight:700;padding:1rem 2.5rem;border-radius:999px;text-decoration:none;margin-bottom:1rem">${cfg.ctaVerb} &rarr;</a>
    <p style="font-size:0.82rem;color:rgba(255,255,255,0.6)"><a href="tel:+17372906129" style="color:rgba(255,255,255,0.78);text-decoration:none">(737) 290-6129</a> &nbsp;&bull;&nbsp; <a href="mailto:service@assembleatease.com" style="color:rgba(255,255,255,0.78);text-decoration:none">service@assembleatease.com</a></p>
  </div>
</section>

`;
}

const SERVICES = [
  {
    slug: 'tv-mounting-austin-tx', prefix: 'tv-mounting', linkLabel: 'TV Mounting',
    eyebrow: 'TV Mounting & Hanging', faqNoun: 'TV mounting', bookingParam: 'Mounting+%26+Hanging',
    fromPrice: '$79', fromLabel: 'pictures &amp; mirrors &mdash; TVs from $99', ctaVerb: 'Book TV mounting',
    heroTitle: 'On the wall.<br><em>Wires gone.</em>',
    heroSub: 'TVs, soundbars, mirrors and art &mdash; mounted level, anchored to studs, cables hidden. You supply the mount and hardware; we bring the tools and the steady hands for a clean, level wall.',
    heroPhoto: 'real-tv-mount-console.jpg', heroAlt: 'Large flat-screen TV wall-mounted above a media console',
    workHeadline: 'Mounted level. Wires gone.',
    noteStrong: 'Hundreds of TVs on the wall and counting.', noteSpan: 'Bedrooms, great rooms, offices and patios &mdash; mounts, soundbars and cable concealment, cleaned up and leveled.',
    gallery: [
      { src: 'real-tv-dawg-days.jpg', alt: 'Large TV mounted on a great-room wall above a soundbar', cap: 'Great-room TV + soundbar', sub: 'Leveled, soundbar mounted, cables out of sight' },
      { src: 'real-tv-setup-console.jpg', alt: 'Flat TV flush-mounted over a black media console', cap: 'Flush mount over a console', sub: 'Tilt set, cords concealed, ready to watch' },
    ],
    trust: [
      { icon: 'wrench', text: 'Pro brings the tools' },
      { icon: 'clock', text: 'Most mounts 60&ndash;90 min' },
      { icon: 'shield', text: 'Pay after it&rsquo;s done' },
      { icon: 'check', text: 'Cables hidden, wall clean' },
    ],
    offers: [
      { n: 'Single framed picture / mirror', p: '$79' },
      { n: 'TV up to 40" (standard wall)', p: '$99' },
      { n: 'TV 41"&ndash;55" (standard wall)', p: '$119', popular: true },
      { n: 'In-wall cord concealment', p: '$189' },
    ],
    brandsLabel: 'TVs &amp; mounts we work with every day',
    brands: ['Samsung', 'LG', 'Sony', 'TCL', 'Vizio', 'Sonos', 'Sanus', 'Echogear'],
    faqs: [
      { q: 'How long does TV mounting take?', a: 'Most standard wall mounts take 60&ndash;90 minutes. Cord concealment, brick or stone, and above-fireplace jobs take a little longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you provide the TV mount?', a: 'No &mdash; please have your wall mount and any hardware ready before the visit. Our pros bring the tools and do the install. Not sure which mount fits your TV and wall? Message your pro after booking and they&rsquo;ll point you to the right one.' },
      { q: 'Can you hide the cables in the wall?', a: 'Yes &mdash; in-wall cord concealment runs the cables behind the drywall for a clean look on standard walls. On brick, stone or surfaces where in-wall isn&rsquo;t possible, we use a paintable cable raceway.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; in addition to Austin, we cover Round Rock, Cedar Park, Pflugerville, Lakeway, and the entire Austin metro. Book online and we&rsquo;ll follow up quickly to confirm the details.' },
    ],
  },
  {
    slug: 'smart-home-installation-austin-tx', prefix: 'smart-home-installation', linkLabel: 'Smart Home Installation',
    eyebrow: 'Smart Home Setup', faqNoun: 'smart home setup', bookingParam: 'Smart+Home',
    fromPrice: '$69', fromLabel: 'per device &mdash; installed &amp; tested', ctaVerb: 'Book smart home setup',
    heroTitle: 'Smart home,<br><em>actually set up.</em>',
    heroSub: 'Thermostats, video doorbells, cameras, locks and plugs &mdash; installed, connected to your Wi-Fi, and tested before we leave. No app headaches, no half-finished setup.',
    heroPhoto: 'real-smarthome-doorbell-vivint.png', heroAlt: 'Smart video doorbell installed beside a front door',
    workHeadline: 'Installed, connected, tested.',
    noteStrong: 'Set up and working before we leave.', noteSpan: 'Doorbells, thermostats, cameras, locks and plugs &mdash; wired where needed, connected to your app, and tested with you.',
    gallery: [
      { src: 'real-smarthome-doorbell-adt.jpg', alt: 'Smart video doorbell mounted on exterior siding', cap: 'Video doorbell install', sub: 'Mounted, wired, connected and tested' },
    ],
    trust: [
      { icon: 'wrench', text: 'Connected &amp; tested before we go' },
      { icon: 'clock', text: 'Most installs 30&ndash;60 min' },
      { icon: 'shield', text: 'Pay after it&rsquo;s done' },
      { icon: 'check', text: 'Works with your Wi-Fi' },
    ],
    offers: [
      { n: 'Smart plug install + setup (per 2 plugs)', p: '$69' },
      { n: 'Smart Thermostat (Nest, Ecobee)', p: '$99', popular: true },
      { n: 'Smart Doorbell &mdash; wireless', p: '$89' },
      { n: 'Camera System (4 cameras)', p: '$249' },
    ],
    brandsLabel: 'Devices we set up every day',
    brands: ['Nest', 'Ring', 'Ecobee', 'Google', 'Philips Hue', 'Wyze', 'Vivint', 'Kasa'],
    faqs: [
      { q: 'What can you install?', a: 'Thermostats, video doorbells, cameras, smart locks, plugs, switches and hubs. If it connects to an app, we can usually mount it, wire it, and set it up.' },
      { q: 'Do I need to buy the device first?', a: 'Yes &mdash; have your device and any subscription ready. We handle mounting, wiring where needed, app setup and testing on your Wi-Fi.' },
      { q: 'Will it work with my existing setup?', a: 'We connect new devices to your Wi-Fi and your existing app or ecosystem (Google, Alexa, Apple Home where supported) and test everything before we leave.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; in addition to Austin, we cover Round Rock, Cedar Park, Pflugerville, Lakeway, and the entire Austin metro. Book online and we&rsquo;ll follow up quickly to confirm the details.' },
    ],
  },
  {
    slug: 'fitness-equipment-assembly-austin-tx', prefix: 'fitness-equipment-assembly', linkLabel: 'Fitness Equipment Assembly',
    eyebrow: 'Fitness Equipment Assembly', faqNoun: 'fitness equipment assembly', bookingParam: 'Fitness+Equipment',
    fromPrice: '$119', fromLabel: 'per machine &mdash; assembled &amp; leveled', ctaVerb: 'Book fitness assembly',
    heroTitle: 'Boxed up.<br><em>Ready to train.</em>',
    heroSub: 'Treadmills, ellipticals, racks and full home gyms &mdash; assembled solid, leveled, and wiped down. We bring the tools and break down the boxes so you can start day one.',
    heroPhoto: 'real-fitness-home-gym.jpg', heroAlt: 'Home gym with assembled cardio machines and a power rack',
    workHeadline: 'Heavy gear, assembled right.',
    noteStrong: 'From a single treadmill to a full home gym.', noteSpan: 'Cardio machines, racks, benches and cable systems &mdash; built to spec, leveled, stable, and wiped down before we go.',
    gallery: [],
    trust: [
      { icon: 'wrench', text: 'Tools included, boxes hauled' },
      { icon: 'clock', text: 'Most machines 1&ndash;2 hrs' },
      { icon: 'shield', text: 'Pay after it&rsquo;s done' },
      { icon: 'check', text: 'Leveled &amp; wiped down' },
    ],
    offers: [
      { n: 'Inversion Table', p: '$119' },
      { n: 'Treadmill Assembly', p: '$189', popular: true },
      { n: 'Elliptical Machine', p: '$209' },
      { n: 'Squat Rack / Power Cage', p: '$219+' },
    ],
    brandsLabel: 'Brands we assemble every day',
    brands: ['Peloton', 'NordicTrack', 'Bowflex', 'Sole', 'Schwinn', 'Rogue', 'Titan', 'Hydrow'],
    faqs: [
      { q: 'How long does equipment assembly take?', a: 'Most treadmills and ellipticals take 1&ndash;2 hours; racks, cages and full home gyms can take longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you bring tools?', a: 'Yes &mdash; our Easers arrive fully equipped. You don&rsquo;t need to provide any tools or equipment.' },
      { q: 'Can you assemble any brand?', a: 'Yes &mdash; Peloton, NordicTrack, Bowflex, Sole, Rogue, Titan and more. If it shipped in a box with instructions, we can build it.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; in addition to Austin, we cover Round Rock, Cedar Park, Pflugerville, Lakeway, and the entire Austin metro. Book online and we&rsquo;ll follow up quickly to confirm the details.' },
    ],
  },
  {
    slug: 'office-furniture-assembly-austin-tx', prefix: 'office-furniture-assembly', linkLabel: 'Office Furniture Assembly',
    eyebrow: 'Office Furniture Assembly', faqNoun: 'office furniture assembly', bookingParam: 'Office+Assembly',
    fromPrice: '$89', fromLabel: 'per piece &mdash; built square &amp; leveled', ctaVerb: 'Book office assembly',
    heroTitle: 'Desks built.<br><em>Back to work.</em>',
    heroSub: 'Desks, chairs, cabinets and full workstations &mdash; built square, leveled, and ready to use. Tools and cleanup included, whether it&rsquo;s one desk or a whole floor.',
    heroPhoto: 'real-office-home-ldesk.jpg', heroAlt: 'Assembled wooden L-shaped desk and storage in a home office',
    workHeadline: 'Built square. Ready to work.',
    noteStrong: 'Home offices to full floors.', noteSpan: 'Desks, standing desks, chairs, cabinets, bookcases and multi-seat workstations &mdash; built square, leveled and cleaned up.',
    gallery: [
      { src: 'real-office-workstations.jpg', alt: 'Row of assembled office workstations with dividers', cap: 'Multi-seat workstations', sub: 'Desks, dividers and pedestals, aligned and leveled' },
      { src: 'real-office-cabinets.jpg', alt: 'Pair of assembled glass-door storage cabinets', cap: 'Storage cabinets', sub: 'Built, leveled and anchored where needed' },
    ],
    trust: [
      { icon: 'wrench', text: 'Pro brings the tools' },
      { icon: 'clock', text: 'Most desks 45&ndash;90 min' },
      { icon: 'shield', text: 'Pay after it&rsquo;s done' },
      { icon: 'check', text: 'Built square &amp; leveled' },
    ],
    offers: [
      { n: 'Office Chair / File Cabinet', p: '$89' },
      { n: 'Simple Flat-Pack Desk', p: '$99' },
      { n: 'L-Shape / Executive Desk', p: '$179', popular: true },
      { n: 'Electric Standing Desk', p: '$199' },
    ],
    brandsLabel: 'Brands we assemble every day',
    brands: ['IKEA', 'Uplift', 'Autonomous', 'Steelcase', 'FlexiSpot', 'Branch', 'Fully', 'Wayfair'],
    faqs: [
      { q: 'How long does office assembly take?', a: 'A single desk or chair is usually 45&ndash;90 minutes; a full workstation or several pieces takes longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you bring tools?', a: 'Yes &mdash; fully equipped, including for electric standing desks. You don&rsquo;t need to provide any tools or equipment.' },
      { q: 'Can you do a whole office?', a: 'Yes &mdash; desks, chairs, cabinets, bookcases and full workstation sets. Bundle the pieces into one visit and we&rsquo;ll knock it out in a single trip.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; in addition to Austin, we cover Round Rock, Cedar Park, Pflugerville, Lakeway, and the entire Austin metro. Book online and we&rsquo;ll follow up quickly to confirm the details.' },
    ],
  },
  {
    slug: 'playset-assembly-austin-tx', prefix: 'playset-assembly', linkLabel: 'Playset Assembly',
    eyebrow: 'Outdoor & Playset Assembly', faqNoun: 'playset & outdoor assembly', bookingParam: 'Outdoor+%26+Playsets',
    fromPrice: '$169', fromLabel: 'sandboxes &amp; playhouses &mdash; playsets from $299', ctaVerb: 'Book outdoor assembly',
    heroTitle: 'Out of the box.<br><em>Into the backyard.</em>',
    heroSub: 'Playsets, swing sets, trampolines, gazebos and patio sets &mdash; built to spec, anchored safe, and checked over before anyone climbs on. Tools and cleanup included.',
    heroPhoto: 'real-outdoor-gazebo.png', heroAlt: 'Assembled cedar gazebo with a swing in a backyard',
    workHeadline: 'Built safe. Ready to play.',
    noteStrong: 'Backyards built and counting.', noteSpan: 'Swing sets, trampolines, playhouses, gazebos and patio furniture &mdash; built to spec, anchored, and safety-checked before play.',
    gallery: [
      { src: 'real-outdoor-patio-gray.jpg', alt: 'Assembled wicker patio furniture set on a covered patio', cap: 'Patio furniture set', sub: 'Sofa, chairs and table, built and placed' },
      { src: 'real-outdoor-sectional.png', alt: 'Assembled outdoor wicker sectional in a backyard', cap: 'Outdoor sectional', sub: 'Modular sectional, squared up and leveled' },
    ],
    trust: [
      { icon: 'wrench', text: 'Pro brings the tools' },
      { icon: 'clock', text: 'Most builds 2&ndash;5 hrs' },
      { icon: 'shield', text: 'Pay after it&rsquo;s done' },
      { icon: 'check', text: 'Safety-checked before play' },
    ],
    offers: [
      { n: 'Sandbox / Outdoor Playhouse', p: '$169' },
      { n: 'Trampoline Assembly', p: '$199', popular: true },
      { n: 'Swing Set / Backyard Playset', p: '$299&ndash;$379' },
      { n: 'Pergola / Gazebo Kit', p: '$399&ndash;$599' },
    ],
    brandsLabel: 'Brands we assemble every day',
    brands: ['Backyard Discovery', 'Gorilla Playsets', 'Lifetime', 'Rainbow', 'Springfree', 'Skywalker', 'Yardistry'],
    faqs: [
      { q: 'How long does a playset take?', a: 'A trampoline or sandbox is often 1&ndash;2 hours; a large swing set or playset can take 3&ndash;5 hours or more. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you anchor it safely?', a: 'Yes &mdash; we build to the manufacturer&rsquo;s spec, anchor per the instructions, and check stability before anyone gets on.' },
      { q: 'Can you assemble any brand?', a: 'Yes &mdash; Backyard Discovery, Gorilla, Lifetime, Rainbow, Springfree and more, plus pergola and gazebo kits and patio furniture.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes &mdash; in addition to Austin, we cover Round Rock, Cedar Park, Pflugerville, Lakeway, and the entire Austin metro. Book online and we&rsquo;ll follow up quickly to confirm the details.' },
    ],
  },
];

let count = 0;
for (const cfg of SERVICES) {
  const file = `${cfg.slug}.html`;
  let html = readFileSync(file, 'utf8');

  // 1. inject flagship CSS (idempotent)
  if (!html.includes('/* ===== Flagship service page')) {
    html = html.replace('</head>', `${FA_STYLE}\n</head>`);
  }

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

  writeFileSync(file, html);
  count += 1;
  console.log(`built ${file}`);
}
console.log(`Done: ${count} pages.`);
