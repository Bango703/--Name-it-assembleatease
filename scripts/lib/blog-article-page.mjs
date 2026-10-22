// One renderer for every blog article: the hand-written posts in
// scripts/cleanup-blog-pages.mjs and the engine's posts (api/_blog-engine.js).
// Same governed header, footer, consent banner, structured data and layout.
import { buildPublicCookieConsentBlock } from './public-consent.mjs';
import { buildPublicFooterBlock } from './public-footer.mjs';
import { buildPublicNavBlock } from './public-nav.mjs';
import { fitTitle } from './seo-title.mjs';

export const SITE = 'https://www.assembleatease.com';

export function renderBlogArticle(post, content, { related = [], defaultModified } = {}) {
  // A published job photo is a full URL; site photos are paths.
  const imageUrl = /^https?:\/\//.test(post.image) ? post.image : `${SITE}${post.image}`;
  const canonical = `${SITE}/blog/${post.slug}`;
  if (!content) throw new Error(`Missing modern article content for ${post.slug}`);
  const metaDescription = post.metaDescription || post.description;
  const intro = post.paragraphs.map((paragraph) => `    <p>${esc(paragraph)}</p>`).join('\n');
  const sections = content.sections.map((section) => {
    const id = headingId(section.title);
    const paragraphs = (section.paragraphs || []).map((paragraph) => `      <p>${esc(paragraph)}</p>`).join('\n');
    const bullets = section.bullets?.length
      ? `\n      <ul>\n${section.bullets.map((item) => `        <li>${esc(item)}</li>`).join('\n')}\n      </ul>`
      : '';
    return `    <section aria-labelledby="${id}">\n      <h2 id="${id}">${esc(section.title)}</h2>\n${paragraphs}${bullets}\n    </section>`;
  }).join('\n');
  const toc = content.sections.map((section) => `<li><a href="#${headingId(section.title)}">${esc(section.title)}</a></li>`).join('');
  const relatedHtml = related.map((link) => `<li><a href="${link.href}">${esc(link.label)}</a></li>`).join('');
  const articleWords = [post.description, ...post.paragraphs, content.quickAnswer, ...content.sections.flatMap((section) => [...(section.paragraphs || []), ...(section.bullets || [])]), ...(content.faq || []).flatMap((item) => [item.q, item.a])].join(' ');
  const readTime = Math.max(3, Math.ceil(wordCount(articleWords) / 225));
  const publishedLabel = formatDate(content.published);
  const modifiedDate = content.modified || defaultModified;
  const modifiedLabel = formatDate(modifiedDate);
  const locationNote = post.slug.includes('austin')
    ? 'This guide focuses on Austin, Texas. The planning principles apply broadly, but local pricing, property rules, and service availability can differ. Enter the service address to confirm current availability.'
    : 'This planning guide can be used in any market. Service availability and pricing are confirmed for the service address before an appointment is assigned.';
  const json = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        '@id': `${canonical}#article`,
        headline: post.title,
        description: metaDescription,
        url: canonical,
        datePublished: content.published,
        dateModified: modifiedDate,
        author: { '@type': 'Organization', name: 'AssembleAtEase Editorial Team', url: `${SITE}/about` },
        publisher: {
          '@type': 'Organization',
          name: 'AssembleAtEase',
          url: SITE,
          logo: { '@type': 'ImageObject', url: `${SITE}/images/logo.jpg` },
        },
        image: { '@type': 'ImageObject', url: `${imageUrl}` },
        mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
        articleSection: post.tag,
        isAccessibleForFree: true,
      },
      ...(content.faq?.length ? [{
        '@type': 'FAQPage',
        mainEntity: content.faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })),
      }] : []),
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
          { '@type': 'ListItem', position: 2, name: 'Guides', item: `${SITE}/blog` },
          { '@type': 'ListItem', position: 3, name: post.title, item: canonical },
        ],
      },
    ],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(fitTitle(post.title))}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${esc(metaDescription)}"/>
<meta name="robots" content="index,follow,max-image-preview:large"/>
<link rel="stylesheet" href="/assets/css/marketing.css"/>
<link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:type" content="article"/>
<meta property="og:title" content="${esc(post.title)}"/>
<meta property="og:description" content="${esc(post.description)}"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="${imageUrl}"/>
<meta property="og:image:alt" content="${esc(post.alt)}"/>
<meta property="article:published_time" content="${content.published}"/>
<meta property="article:modified_time" content="${modifiedDate}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(post.title)}"/>
<meta name="twitter:description" content="${esc(metaDescription)}"/>
<meta name="twitter:image" content="${imageUrl}"/>
<meta name="twitter:image:alt" content="${esc(post.alt)}"/>
<link rel="icon" href="/favicon.ico" sizes="any"/>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/>
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
<script type="application/ld+json">${JSON.stringify(json)}</script>
</head>
<body>
${nav()}<main id="main-content">
  <section class="blog-hero">
    <div class="blog-hero-copy">
      <a href="/blog/" class="page-back">Back to Blogs</a>
      <span class="guide-meta">${esc(post.tag)}</span>
      <h1 class="page-title">${esc(post.title)}</h1>
      <p class="page-desc">${esc(post.description)}</p>
      <p class="blog-byline">By AssembleAtEase Editorial Team <span aria-hidden="true">&middot;</span> Updated <time datetime="${modifiedDate}">${modifiedLabel}</time> <span aria-hidden="true">&middot;</span> ${readTime} min read</p>
    </div>
    <img class="blog-hero-image" src="${post.image}" alt="${esc(post.alt)}" width="640" height="440" loading="eager"/>
  </section>
  <article class="article article-modern">
    <div class="article-summary">
      <span>Quick answer</span>
      <p>${esc(content.quickAnswer)}</p>
    </div>
${intro}
    <nav class="article-toc" aria-label="In this guide">
      <strong>In this guide</strong>
      <ol>${toc}</ol>
    </nav>
${sections}
${content.faq?.length ? `    <section class="article-faq" aria-labelledby="faq">
      <h2 id="faq">Frequently asked questions</h2>
${content.faq.map((item) => `      <h3>${esc(item.q)}</h3>\n      <p>${esc(item.a)}</p>`).join('\n')}
    </section>
` : ''}${content.disclosure ? `    <p class="article-disclosure">${esc(content.disclosure)}</p>\n` : ''}
    <aside class="article-market-note"><strong>Location note.</strong> ${esc(locationNote)}</aside>
    <section class="article-related" aria-labelledby="related-guides">
      <h2 id="related-guides">Related planning and pricing</h2>
      <ul>${relatedHtml}</ul>
    </section>
    <div class="article-cta">
      <div><strong>See your exact price before you book.</strong><span>Pick your items, choose a time, and pay once the work is done.</span></div>
      <a href="${post.serviceUrl}" class="btn btn-cyan btn-lg">${esc(post.cta)}</a>
    </div>
  </article>
</main>
${footer()}
${cookieBanner()}
${promoScript()}
</body>
</html>
`;
}

export function headingId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

export function formatDate(value) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function nav(activeHref = '') {
  return buildPublicNavBlock({
    variant: 'blog',
    includeSkipNav: true,
    activeHref,
  });
}

export function footer() {
  return buildPublicFooterBlock({
    variant: 'blog_resources',
    tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and home services with clear pricing and careful work.',
  });
}

// The live offer bar (assets/js/site-promo.js): shows the owner's current
// offer under the nav, adds its code to every /book link, and hides itself when
// the offer is switched off. Every other public page already loads it.
export function promoScript() {
  return '<script src="/assets/js/site-promo.js" defer></script>';
}

export function cookieBanner() {
  return buildPublicCookieConsentBlock();
}

export function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The blog index card for one article (blog/index.html). */
export function guideCard(post) {
  return `      <a href="/blog/${post.slug}" class="guide-card">
        <span class="guide-thumb"><img src="${post.image}" alt="${esc(post.alt)}" loading="lazy" width="300" height="300"></span>
        <span><span class="guide-meta">${esc(post.tag)}</span><span class="guide-title">${esc(post.title)}</span><span class="guide-copy">${esc(post.description)}</span><span class="guide-link">Read blog</span></span>
      </a>`;
}
