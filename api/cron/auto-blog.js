import Anthropic from '@anthropic-ai/sdk';

const REPO_OWNER = 'Bango703';
const REPO_NAME  = '--Name-it-assembleatease';
const SITE       = 'https://www.assembleatease.com';

// Topics pool — AI picks the best untouched one each run
const TOPIC_POOL = [
  'how to hang a tv on a brick wall in austin',
  'wayfair furniture assembly tips austin tx',
  'best handyman services north austin',
  'home office setup assembly austin',
  'nursery furniture assembly checklist',
  'murphy bed assembly and installation austin',
  'how long does furniture assembly take',
  'west elm furniture assembly austin',
  'costco furniture assembly austin tx',
  'garage shelving installation austin',
  'amazon furniture assembly service austin',
  'bookshelf and shelving unit assembly austin',
  'outdoor patio furniture assembly austin',
  'desk assembly service austin tx',
  'how to mount a tv without studs',
  'moving into new home setup checklist austin',
  'dining table and chair assembly austin',
  'wardrobe and closet assembly austin tx',
  'baby crib and changing table assembly austin',
  'home gym equipment assembly austin',
  'floating shelves installation austin tx',
  'how much does it cost to hire a handyman in austin',
  'same day handyman service austin texas',
  'smart doorbell installation austin',
  'ceiling fan installation cost austin tx',
];

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const githubToken   = process.env.GITHUB_TOKEN;
  const anthropicKey  = process.env.ANTHROPIC_API_KEY;

  if (!githubToken || !anthropicKey) {
    return res.status(500).json({ error: 'Missing GITHUB_TOKEN or ANTHROPIC_API_KEY' });
  }

  // ── 1. Get existing blog files to avoid duplicates ──────────────
  let existingSlugs = [];
  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/blog`,
      { headers: { Authorization: `token ${githubToken}`, Accept: 'application/vnd.github+json' } }
    );
    const files = await ghRes.json();
    if (Array.isArray(files)) {
      existingSlugs = files
        .filter(f => f.name.endsWith('.html') && f.name !== 'index.html')
        .map(f => f.name.replace('.html', ''));
    }
  } catch (e) {
    console.error('GitHub file list error:', e);
  }

  // Filter out already-covered topics
  const available = TOPIC_POOL.filter(t => {
    const slug = topicToSlug(t);
    return !existingSlugs.includes(slug);
  });

  if (!available.length) {
    return res.status(200).json({ message: 'All topics already published' });
  }

  // Pick a random unused topic
  const topic = available[Math.floor(Math.random() * available.length)];
  const slug  = topicToSlug(topic);
  const today = new Date().toISOString().slice(0, 10);

  // ── 2. Generate blog post HTML with Claude ───────────────────────
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const systemPrompt = `You are an SEO content writer for AssembleAtEase, a professional furniture assembly and handyman service in Austin, TX.

Write a detailed, helpful blog post as complete HTML content (article body only — no <html>, <head>, or <body> tags).

Rules:
- Target audience: Austin homeowners
- Tone: helpful, expert, conversational
- Length: 600–900 words of actual content
- Include 3–5 <h2> headings
- Include at least one <table class="price-table"> with realistic Austin prices if relevant
- Include <ul> or <ol> lists where appropriate
- End with a <div class="article-cta"> section
- Reference AssembleAtEase naturally 2–3 times
- Mention Austin TX specifically throughout
- Use <strong> for key phrases
- Do NOT include CSS, scripts, or outer HTML structure
- The CTA div must end with: <a href="/book" class="btn btn-cyan btn-lg">Book a Service in Austin &rarr;</a>

Output ONLY the HTML article content — nothing else.`;

  const userPrompt = `Write a blog post about: "${topic}"

The article title should be an SEO-friendly question or statement about this topic in Austin TX.
Make it genuinely useful — real prices, real tips, real comparisons.`;

  let articleHtml;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2000,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });
    articleHtml = message.content[0]?.text?.trim();
  } catch (e) {
    console.error('Anthropic error:', e);
    return res.status(500).json({ error: 'Failed to generate blog content' });
  }

  if (!articleHtml) {
    return res.status(500).json({ error: 'Empty response from AI' });
  }

  // Extract title from first <h1> or first <h2>
  const h1Match = articleHtml.match(/<h1[^>]*>(.*?)<\/h1>/i);
  const h2Match = articleHtml.match(/<h2[^>]*>(.*?)<\/h2>/i);
  const rawTitle = (h1Match?.[1] || h2Match?.[1] || topic)
    .replace(/<[^>]+>/g, '').trim();
  const title = rawTitle.length > 10 ? rawTitle : `${capitalize(topic)} — Austin TX`;

  // Remove any accidental h1 from body (we put it in the hero)
  const cleanBody = articleHtml.replace(/<h1[^>]*>.*?<\/h1>/gi, '');

  // ── 3. Build the full HTML page ──────────────────────────────────
  const canonicalUrl = `${SITE}/blog/${slug}`;
  const readTime = Math.max(3, Math.round(cleanBody.replace(/<[^>]+>/g, '').split(/\s+/).length / 200));

  const fullHtml = buildBlogPage({ title, slug, canonicalUrl, today, readTime, body: cleanBody });

  // ── 4. Commit to GitHub ──────────────────────────────────────────
  const filePath = `blog/${slug}.html`;
  const content  = Buffer.from(fullHtml).toString('base64');

  try {
    const ghPut = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Auto-blog: ${title}`,
          content,
          branch: 'main',
        }),
      }
    );

    if (!ghPut.ok) {
      const err = await ghPut.text();
      console.error('GitHub commit error:', err);
      return res.status(500).json({ error: 'Failed to commit blog post to GitHub' });
    }
  } catch (e) {
    console.error('GitHub API error:', e);
    return res.status(500).json({ error: 'GitHub API request failed' });
  }

  console.log(`Auto-blog published: ${filePath}`);
  return res.status(200).json({ success: true, slug, title, url: canonicalUrl });
}

// ── Helpers ──────────────────────────────────────────────────────────

function topicToSlug(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function buildBlogPage({ title, slug, canonicalUrl, today, readTime, body }) {
  const escaped = title.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const displayDate = new Date(today).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<script>(function(){if(localStorage.getItem('cookie-consent')==='accepted'){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=G-ZN45GP8D25';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','G-ZN45GP8D25');gtag('config','AW-16551666395');}})();</script>
<meta charset="UTF-8"/>
<title>${escaped} &mdash; AssembleAtEase</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${escaped}. Expert advice from AssembleAtEase, Austin TX's trusted assembly and handyman service."/>
<link rel="stylesheet" href="/assets/css/marketing.css"/>
<link rel="canonical" href="${canonicalUrl}"/>
<meta property="og:type" content="article"/>
<meta property="og:title" content="${escaped}"/>
<meta property="og:description" content="${escaped}. Expert advice from AssembleAtEase, Austin TX."/>
<meta property="og:url" content="${canonicalUrl}"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="${SITE}/images/logo.jpg"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${escaped}"/>
<meta name="twitter:image" content="${SITE}/images/logo.jpg"/>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/><link rel="icon" type="image/jpeg" href="/images/logo.jpg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--cyan:#0097a7;--cyan-dark:#0097a7;--cyan-light:#e0f7fa;--ink:#0d1117;--ink-soft:#374151;--muted:#6b7280;--border:#e5e7eb;--off-white:#f9fafb;--white:#ffffff;--radius:12px;--radius-xl:24px;--font-display:'DM Serif Display',serif;--font-body:'DM Sans',sans-serif;--shadow:0 4px 20px rgba(0,0,0,0.08)}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--white);color:var(--ink);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.nav{position:sticky;top:0;z-index:200;background:rgba(255,255,255,0.97);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.nav-inner{max-width:1100px;margin:0 auto;padding:0 2rem;height:68px;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.nav-logo img{width:42px;height:42px;border-radius:50%;object-fit:cover}
.nav-logo-text{font-family:var(--font-display);font-size:1.15rem;color:var(--ink)}
.nav-logo-text span{color:var(--cyan)}
.nav-links{display:flex;align-items:center;gap:2rem;list-style:none}
.nav-links a{font-size:0.875rem;font-weight:500;color:var(--ink-soft);text-decoration:none;transition:color 0.15s}
.nav-links a:hover{color:var(--cyan)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0.65rem 1.5rem;border-radius:999px;font-family:var(--font-body);font-size:0.875rem;font-weight:600;cursor:pointer;text-decoration:none;border:none;transition:all 0.18s}
.btn-cyan{background:var(--cyan);color:#fff}
.btn-cyan:hover{background:#00838f;box-shadow:0 4px 16px rgba(0,151,167,0.35);transform:translateY(-1px)}
.btn-lg{padding:1rem 2.5rem;font-size:1rem}
.page-hero{background:linear-gradient(135deg,#00bcd4,#00838f);padding:3.5rem 2rem;text-align:center}
.page-hero-inner{max-width:700px;margin:0 auto}
.page-back{display:inline-flex;align-items:center;gap:6px;color:rgba(255,255,255,0.75);text-decoration:none;font-size:0.82rem;font-weight:500;margin-bottom:1.25rem;transition:color 0.15s}
.page-back:hover{color:#fff}
.page-title{font-family:var(--font-display);font-size:clamp(1.75rem,3.5vw,2.5rem);color:#fff;margin-bottom:0.75rem;line-height:1.3}
.page-desc{font-size:0.9rem;color:rgba(255,255,255,0.7);line-height:1.75}
.article{padding:3rem 2rem 4rem;max-width:720px;margin:0 auto}
.article h2{font-family:var(--font-display);font-size:1.35rem;color:var(--ink);margin:2.25rem 0 0.75rem}
.article p{font-size:0.95rem;color:var(--ink-soft);line-height:1.85;margin-bottom:1rem}
.article ul,.article ol{margin:0 0 1rem 1.5rem;color:var(--ink-soft);font-size:0.95rem;line-height:1.85}
.article li{margin-bottom:0.35rem}
.article strong{color:var(--ink)}
.article a{color:var(--cyan);text-decoration:underline}
.price-table{width:100%;border-collapse:collapse;margin:1rem 0 1.5rem;font-size:0.9rem}
.price-table th{text-align:left;padding:0.6rem 1rem;background:var(--off-white);border-bottom:2px solid var(--border);font-weight:600;color:var(--ink)}
.price-table td{padding:0.6rem 1rem;border-bottom:1px solid var(--border);color:var(--ink-soft)}
.article-cta{text-align:center;margin-top:2.5rem;padding:2.5rem;background:var(--off-white);border-radius:var(--radius-xl)}
.article-cta p{font-size:1rem;color:var(--ink);margin-bottom:1rem}
.footer{background:#0a1628;padding:3rem 2rem 2rem}
.footer-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:3rem;margin-bottom:2rem}
.footer-logo{display:flex;align-items:center;gap:10px;margin-bottom:0.75rem}
.footer-logo img{width:38px;height:38px;border-radius:50%;object-fit:cover}
.footer-logo-text{font-family:var(--font-display);font-size:1.05rem;color:#fff}
.footer-logo-text span{color:var(--cyan)}
.footer-tagline{font-size:0.82rem;color:rgba(255,255,255,0.38);line-height:1.65;margin-bottom:1rem}
.footer-contact a{display:block;font-size:0.85rem;color:rgba(255,255,255,0.5);text-decoration:none;margin-bottom:3px}
.footer-col-title{font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:rgba(255,255,255,0.28);margin-bottom:0.85rem;font-weight:700}
.footer-links{list-style:none;display:flex;flex-direction:column;gap:0.55rem}
.footer-links a{font-size:0.85rem;color:rgba(255,255,255,0.45);text-decoration:none}
.footer-links a:hover{color:#fff}
.footer-bottom{max-width:1100px;margin:0 auto;padding-top:1.25rem;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem}
.footer-copy{font-size:0.72rem;color:rgba(255,255,255,0.2)}
.footer-legal{display:flex;gap:1.25rem}
.footer-legal a{font-size:0.72rem;color:rgba(255,255,255,0.25);text-decoration:none}
.footer-legal a:hover{color:rgba(255,255,255,0.6)}
@media(max-width:900px){.nav-links{display:none}.footer-inner{grid-template-columns:1fr;gap:2rem}}
</style>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BlogPosting","headline":"${escaped}","description":"${escaped}. Expert advice from AssembleAtEase, Austin TX.","url":"${canonicalUrl}","datePublished":"${today}","dateModified":"${today}","author":{"@type":"Organization","name":"AssembleAtEase","url":"${SITE}"},"publisher":{"@type":"Organization","name":"AssembleAtEase","url":"${SITE}","logo":{"@type":"ImageObject","url":"${SITE}/images/logo.jpg"}},"image":"${SITE}/images/logo.jpg","mainEntityOfPage":"${canonicalUrl}"}
</script>
</head>
<body>
<a href="#main-content" class="skip-nav" style="position:absolute;top:-40px;left:0;background:#0097a7;color:#fff;padding:8px 16px;z-index:9999;text-decoration:none;border-radius:0 0 8px 0;font-size:0.875rem;font-weight:600;transition:top 0.15s" onfocus="this.style.top='0'" onblur="this.style.top='-40px'">Skip to main content</a>
<nav class="nav"><div class="nav-inner"><a href="/" class="nav-logo"><picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo"/></picture><div class="nav-logo-text">Assemble<span>AtEase</span></div></a><ul class="nav-links"><li><a href="/#services">Services</a></li><li><a href="/blog/">Blog</a></li><li><a href="/about">About Us</a></li><li><a href="/contact">Contact</a></li></ul><a href="/book" class="btn btn-cyan">Book Now</a></div></nav>

<section class="page-hero" id="main-content"><div class="page-hero-inner"><a href="/blog/" class="page-back">&larr; Back to Blog</a><h1 class="page-title">${escaped}</h1><p class="page-desc">${displayDate} &bull; ${readTime} min read</p></div></section>

<article class="article">
${body}
</article>

<section style="background:linear-gradient(135deg,#003d47,#006070);padding:3rem 2rem;text-align:center;margin-top:3rem">
  <div style="max-width:560px;margin:0 auto">
    <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.12em;color:rgba(255,255,255,0.6);margin-bottom:0.75rem;font-weight:700">Austin TX &bull; Same-Day Available</div>
    <h2 style="font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.2rem);color:#fff;margin-bottom:0.85rem;line-height:1.2">Ready to book a pro in Austin?</h2>
    <p style="font-size:0.95rem;color:rgba(255,255,255,0.8);margin-bottom:1.75rem;line-height:1.7">Flat-rate pricing. Vetted professionals. No charge until the job is done.</p>
    <a href="/book" class="btn btn-cyan btn-lg" style="color:#fff;background:#fff;color:#0097a7;font-weight:700">Book a Service &rarr;</a>
  </div>
</section>

<footer class="footer">
  <div class="footer-inner">
    <div>
      <div class="footer-logo"><picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo"/></picture><div class="footer-logo-text">Assemble<span>AtEase</span></div></div>
      <p class="footer-tagline">Professional furniture assembly and handyman services in Austin, Texas.</p>
      <div class="footer-contact"><a href="mailto:service@assembleatease.com">service@assembleatease.com</a></div>
    </div>
    <div>
      <div class="footer-col-title">Services</div>
      <ul class="footer-links">
        <li><a href="/furniture">Furniture Assembly</a></li>
        <li><a href="/mounting">TV &amp; Mounting</a></li>
        <li><a href="/repairs">Home Repairs</a></li>
        <li><a href="/smarthome">Smart Home</a></li>
        <li><a href="/junk">Junk Removal</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Company</div>
      <ul class="footer-links">
        <li><a href="/about">About Us</a></li>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/blog/">Blog</a></li>
        <li><a href="/contact">Contact</a></li>
        <li><a href="/privacy">Privacy Policy</a></li>
        <li><a href="/terms">Terms</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <div class="footer-copy">&copy; ${new Date().getFullYear()} AssembleAtEase. All rights reserved. Austin, TX.</div>
    <div class="footer-legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a></div>
  </div>
</footer>
<script type="text/javascript" id="hs-script-loader" async defer src="//js-na2.hs-scripts.com/245917212.js"></script>
</body>
</html>`;
}
