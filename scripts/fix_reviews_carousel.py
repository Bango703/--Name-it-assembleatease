#!/usr/bin/env python3
# Fix reviews carousel: CSS animation instead of JS scrollLeft (avoids scroll-snap conflict)
import re, os

os.chdir(r"c:/Users/tgbiz/Handyman-marketplace")

MAPS = "https://www.google.com/maps?cid=7847022131459448801"
G = ('<svg width="16" height="16" viewBox="0 0 24 24">'
     '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>'
     '<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>'
     '<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>'
     '<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>'
     '</svg>')

NEW_SECTION = f"""<section class="section section-alt" id="reviews">
  <div class="section-inner" style="max-width:1040px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.25rem">
      <div>
        <div class="section-label">What customers say</div>
        <h2 class="section-title" style="margin:0">Real Reviews</h2>
      </div>
      <a href="{MAPS}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:7px;background:#fff;border:1.5px solid #e5e7eb;border-radius:999px;padding:7px 14px;text-decoration:none;box-shadow:0 1px 4px rgba(0,0,0,0.07);white-space:nowrap;margin-top:4px">
        {G}
        <span style="font-size:0.84rem;font-weight:700;color:#1a1a1a">5.0</span>
        <span style="color:#f59e0b;font-size:0.8rem">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
        <span style="font-size:0.73rem;color:#6b7280;border-left:1px solid #e5e7eb;padding-left:7px">11 Google reviews</span>
      </a>
    </div>
    <div style="overflow:hidden">
      <div id="rv-track" style="display:flex;gap:0.85rem;width:max-content"></div>
    </div>
    <style>
      @keyframes rv-scroll {{to{{transform:translateX(-50%);}}}}
      #rv-track{{animation:rv-scroll 38s linear infinite;}}
      #rv-track.rv-paused{{animation-play-state:paused;}}
    </style>
    <div style="text-align:center;margin-top:0.9rem">
      <a href="{MAPS}" target="_blank" rel="noopener" style="font-size:0.78rem;color:var(--muted);text-decoration:none" onmouseover="this.style.color='var(--cyan-dark)'" onmouseout="this.style.color='var(--muted)'">View all reviews on Google &rarr;</a>
    </div>
  </div>
</section>

<script>
(function(){{
  var MAPS="{MAPS}";
  var G='{G}';
  var COLORS=["#00BFFF","#0099CC","#006a7e","#4dd0e1","#0077a8","#003b47"];
  var DATA=[
    {{b:"Excellent",n:"Krispercs Focus",d:"Verified review"}},
    {{b:"Had my bed and dressers assembled. Very professional, fast and the price was right. Will definitely use this company again. I highly recommend AssembleAtEase.",n:"Brenda Mitchell",d:"Verified review"}},
    {{b:"AssembleAtEase was prompt and on point. Mounted a 75-inch TV and assembled a bed. Great job, very efficient!",n:"Erin B.",d:"Jun 2024"}},
    {{b:"He put together 9 beds and 9 dressers at amazing speed and they all look great! Five stars hands down.",n:"Omotola A.",d:"May 2024"}},
    {{b:"Travis has come out to our place several times and each time the job was WELL DONE. Thanks Travis!",n:"Mika H.",d:"Jun 2024"}},
    {{b:"Mounted TV, great experience. I would recommend.",n:"Austin P.",d:"Jun 2024"}},
    {{b:"Fast and friendly service. Will definitely use again when needed.",n:"Rochelle L.",d:"Jun 2024"}},
    {{b:"Very flexible, professional, and can put together anything for a reasonable price. Would recommend to anyone.",n:"Shelby M.",d:"Jun 2024"}},
    {{b:"Super handy and gets the job done fast!",n:"Emmanuel",d:"Jun 2024"}},
    {{b:"Fantastic customer service! I highly recommend!",n:"Sue S.",d:"Jun 2024"}},
    {{b:"This company does an amazing job. If you want a well done job, this is the guy!",n:"Lashantae H.",d:"May 2024"}}
  ];
  function esc(s){{return(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;");}}
  function ini(n){{return(n||"?").split(" ").map(function(w){{return w[0]||"";}}).join("").slice(0,2).toUpperCase();}}
  function clr(n){{return COLORS[(n||"A").charCodeAt(0)%COLORS.length];}}
  function card(r){{
    var s='style="';
    return '<div style="flex:0 0 268px;background:#fff;border:1px solid #e8ecef;border-radius:14px;padding:1rem 1.1rem;display:flex;flex-direction:column;gap:0.45rem;box-shadow:0 1px 4px rgba(0,0,0,0.04)">'
      +'<div style="display:flex;justify-content:space-between;align-items:center">'
      +'<span style="color:#f59e0b;font-size:0.82rem;letter-spacing:1px">&#9733;&#9733;&#9733;&#9733;&#9733;</span>'
      +'<span style="opacity:0.4">'+G+'</span></div>'
      +'<p style="font-size:0.83rem;color:#374151;line-height:1.6;margin:0;flex:1">&ldquo;'+esc(r.b)+'&rdquo;</p>'
      +'<div style="display:flex;align-items:center;gap:0.45rem;padding-top:0.55rem;border-top:1px solid #f3f4f6">'
      +'<div style="width:26px;height:26px;border-radius:50%;background:'+clr(r.n)+';display:flex;align-items:center;justify-content:center;font-size:0.6rem;font-weight:700;color:#fff;flex-shrink:0">'+ini(r.n)+'</div>'
      +'<div><div style="font-size:0.75rem;font-weight:700;color:#111">'+esc(r.n)+'</div>'
      +'<div style="font-size:0.65rem;color:#9ca3af">'+esc(r.d)+'</div></div></div>'
      +'</div>';
  }}
  var t=document.getElementById("rv-track");
  if(!t) return;
  var inner=DATA.map(card).join("");
  t.innerHTML=inner+inner; // doubled for seamless loop

  var wrap=t.parentElement;
  var resume;
  wrap.addEventListener("mouseenter",function(){{t.classList.add("rv-paused");}});
  wrap.addEventListener("mouseleave",function(){{t.classList.remove("rv-paused");}});
  wrap.addEventListener("touchstart",function(){{t.classList.add("rv-paused");clearTimeout(resume);}},{{passive:true}});
  wrap.addEventListener("touchend",function(){{resume=setTimeout(function(){{t.classList.remove("rv-paused");}},2000);}},{{passive:true}});
}})();
</script>"""

html = open("index.html", "r", encoding="utf-8").read()

# Find section start
s = html.find('<section class="section section-alt" id="reviews">')
if s == -1:
    print("ERROR: reviews section not found")
    exit(1)

# Find script end — look for closing script after DATA or PALETTE or COLORS
for marker in ["var DATA", "var PALETTE", "var COLORS"]:
    mi = html.find(marker, s)
    if mi > 0:
        e = html.find("</script>", mi) + 9
        break

html = html[:s] + NEW_SECTION + html[e:]
open("index.html", "w", encoding="utf-8").write(html)

ok = "rv-scroll" in html and "@keyframes" in html and "rv-paused" in html
print("OK — CSS animation carousel" if ok else "FAIL")
