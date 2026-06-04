"""One-shot patch: rewrites book.html step-1 to two-screen flow."""
import sys

PATH = 'C:/Users/tgbiz/Handyman-marketplace/book.html'

with open(PATH, 'rb') as f:
    src = f.read()

def rpl(content, old, new, label):
    idx = content.find(old)
    if idx == -1:
        print(f'FAIL: could not find marker for {label}')
        print(f'  First 80 bytes of old: {old[:80]}')
        sys.exit(1)
    print(f'OK:   {label}')
    return content[:idx] + new + content[idx + len(old):]

NL = b'\r\n'

def b(s):
    """Convert LF-only string literal to CRLF bytes."""
    return s.encode('utf-8').replace(b'\n', b'\r\n')

# ─── HTML PATCH 1 ────────────────────────────────────────────────────────────
# Replace everything from service-section-head through subcats-wrap
# with the compact service list + Screen B opening.

OLD_H1_START = b'        <div class="service-section-head">'
OLD_H1_END   = b'        <div class="subcats-wrap" id="subcats-wrap"></div>'

idx_start = src.find(OLD_H1_START)
idx_end   = src.find(OLD_H1_END) + len(OLD_H1_END)
if idx_start == -1 or src.find(OLD_H1_END) == -1:
    print('FAIL: HTML marker 1 not found'); sys.exit(1)

NEW_H1 = b("""\
        <div class="svc-list">

          <button class="svc-row" data-service="Furniture Assembly" onclick="showItemScreen(this.dataset.service)">
            <div class="svc-row-icon"><svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><path d="M21 9V7c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v2c-1.1 0-2 .9-2 2v5h2v2h2v-2h10v2h2v-2h2v-5c0-1.1-.9-2-2-2zm-8 0H5V7h8v2zm6 0h-4V7h4v2z"/></svg></div>
            <div class="svc-row-info">
              <div class="svc-row-name">Furniture Assembly</div>
              <div class="svc-row-meta">From $99 &bull; 1&ndash;3 hrs</div>
              <div class="svc-row-badge"></div>
            </div>
            <svg class="svc-row-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>

          <button class="svc-row" data-service="TV Mounting" onclick="showItemScreen(this.dataset.service)">
            <div class="svc-row-icon"><svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg></div>
            <div class="svc-row-info">
              <div class="svc-row-name">TV Mounting</div>
              <div class="svc-row-meta">From $99 &bull; about 1 hr</div>
              <div class="svc-row-badge"></div>
            </div>
            <svg class="svc-row-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>

          <button class="svc-row" data-service="Smart Home" onclick="showItemScreen(this.dataset.service)">
            <div class="svc-row-icon"><svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg></div>
            <div class="svc-row-info">
              <div class="svc-row-name">Smart Home</div>
              <div class="svc-row-meta">From $99 &bull; about 1 hr</div>
              <div class="svc-row-badge"></div>
            </div>
            <svg class="svc-row-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>

          <button class="svc-row" data-service="Fitness Equipment" onclick="showItemScreen(this.dataset.service)">
            <div class="svc-row-icon"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 4v16m12-16v16M3 8h4m10 0h4M3 16h4m10 0h4"/></svg></div>
            <div class="svc-row-info">
              <div class="svc-row-name">Fitness Equipment</div>
              <div class="svc-row-meta">From $129 &bull; 1&ndash;3 hrs</div>
              <div class="svc-row-badge"></div>
            </div>
            <svg class="svc-row-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>

          <button class="svc-row" data-service="Outdoor &amp; Playsets" onclick="showItemScreen(this.dataset.service)">
            <div class="svc-row-icon"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 22V12.5L12 2l9 10.5V22"/><path d="M9 22v-7h6v7"/></svg></div>
            <div class="svc-row-info">
              <div class="svc-row-name">Outdoor &amp; Playsets</div>
              <div class="svc-row-meta">From $149 &bull; 2&ndash;4 hrs</div>
              <div class="svc-row-badge"></div>
            </div>
            <svg class="svc-row-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>

          <button class="svc-row" data-service="Office Assembly" onclick="showItemScreen(this.dataset.service)">
            <div class="svc-row-icon"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
            <div class="svc-row-info">
              <div class="svc-row-name">Office Assembly</div>
              <div class="svc-row-meta">From $99 &bull; 1&ndash;3 hrs</div>
              <div class="svc-row-badge"></div>
            </div>
            <svg class="svc-row-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
          </button>

        </div>

        </div><!-- /svc-screen -->



        <!-- ── SCREEN B: Item Selection ──────────────────────────────────────── -->

        <div id="item-screen" style="display:none">

          <div class="item-screen-nav">
            <button class="item-back-btn" onclick="showSvcScreen()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
              Back to services
            </button>
          </div>

          <div class="item-screen-heading" id="item-screen-heading"></div>
          <div class="item-screen-from" id="item-screen-from"></div>

          <div class="subcat-search-wrap">
            <svg class="subcat-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" id="item-search" class="subcat-search" placeholder="Search items… e.g. queen bed, treadmill" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            <button type="button" class="subcat-search-clear" id="item-search-clear" aria-label="Clear search">&times;</button>
          </div>
          <div id="item-no-results" class="subcat-no-results" style="display:none">No items match “<span></span>”</div>

          <div id="item-list-wrap"></div>\
""")

src = src[:idx_start] + NEW_H1 + src[idx_end:]
print('OK:   HTML patch 1 (service list + Screen B open)')

# ─── HTML PATCH 2 ────────────────────────────────────────────────────────────
# Replace the notes/step-err/step-actions block with the same content
# wrapped inside Screen B, then close Screen B.

OLD_H2 = b("""\
        <div class="form-fields" style="margin-top:0.5rem">

          <div class="form-group">

            <label class="form-label" for="s1-details">Additional notes <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>

            <textarea class="form-textarea" id="s1-details" rows="2"

              placeholder="Any extra details: brand, model, floor, access info..."></textarea>

          </div>

          <div class="form-group">

            <label class="form-label"><input type="checkbox" id="s1-quote" style="accent-color:var(--teal);width:16px;height:16px;vertical-align:middle;margin-right:6px"> This is a large or complex job &mdash; I'd prefer a custom quote</label>

          </div>

        </div>



        <div class="step-err" id="s1-err">Please select at least one service.</div>

        <div class="step-actions">

          <button class="btn-next" id="s1-next" onclick="goToStep2Account()">Continue <span>&#8594;</span></button>

        </div>

      </div>\
""")

NEW_H2 = b("""\
          <div class="form-fields" style="margin-top:1.5rem">

            <div class="form-group">

              <label class="form-label" for="s1-details">Additional notes <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>

              <textarea class="form-textarea" id="s1-details" rows="2"

                placeholder="Any extra details: brand, model, floor, access info..."></textarea>

            </div>

            <div class="form-group">

              <label class="form-label"><input type="checkbox" id="s1-quote" style="accent-color:var(--teal);width:16px;height:16px;vertical-align:middle;margin-right:6px"> This is a large or complex job &mdash; I'd prefer a custom quote</label>

            </div>

          </div>



          <div class="step-err" id="s1-err">Please select at least one service.</div>

          <div class="step-actions">

            <button class="btn-next" id="s1-next" onclick="goToStep2Account()">Continue <span>&#8594;</span></button>

          </div>

        </div><!-- /item-screen -->

      </div><!-- /step-1 -->\
""")

src = rpl(src, OLD_H2, NEW_H2, 'HTML patch 2 (notes + step-actions in Screen B)')

# ─── JS PATCH 1 ──────────────────────────────────────────────────────────────
# Replace tileClick + keyboard listener + renderSelectedServices + strip listener
# with showItemScreen / showSvcScreen / updateSvcRows.

OLD_JS1 = b("""\
// ----------------------------------------------------------------------------

// SERVICE TILE TOGGLE (multi-select), called via onclick attribute

// ----------------------------------------------------------------------------

function tileClick(el) {

  var svc = el.dataset.service;

  var idx = BOOK.selectedServices.indexOf(svc);

  if (idx === -1) {

    BOOK.selectedServices.push(svc);

    if (!BOOK.selectedItems[svc]) BOOK.selectedItems[svc] = [];

    el.classList.add('selected');
    el.setAttribute('aria-pressed', 'true');

    var fb = document.getElementById('tile-feedback');

    if (fb) { fb.style.display='flex'; clearTimeout(window._fbTimer); window._fbTimer=setTimeout(function(){fb.style.display='none';},3000); }

  } else {

    BOOK.selectedServices.splice(idx, 1);

    delete BOOK.selectedItems[svc];

    el.classList.remove('selected');
    el.setAttribute('aria-pressed', 'false');

  }

  hideErr('s1-err');

  renderSubcats();
  renderSelectedServices();

  updateOrderSummary();

}

document.querySelectorAll('.service-tile').forEach(function(tile) {
  tile.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      tileClick(tile);
    }
  });
});

function renderSelectedServices() {
  var strip = document.getElementById('selected-service-strip');
  if (!strip) return;

  if (BOOK.selectedServices.length === 0) {
    strip.classList.remove('show');
    strip.innerHTML = '';
    return;
  }

  var serviceWord = BOOK.selectedServices.length === 1 ? 'service' : 'services';
  var chips = BOOK.selectedServices.map(function(svc) {
    return '<span class="selected-service-chip">' + esc(svc)
      + '<button type="button" data-remove-svc="' + escAttr(svc) + '" aria-label="Remove ' + escAttr(svc) + '">&times;</button>'
      + '</span>';
  }).join('');

  strip.classList.add('show');
  strip.innerHTML = '<div class="selected-service-copy"><strong>' + BOOK.selectedServices.length + ' ' + serviceWord + ' selected.</strong> Pick items below.</div>'
    + '<div class="selected-service-chips">' + chips + '</div>';
}

document.getElementById('selected-service-strip').addEventListener('click', function(e) {
  var btn = e.target.closest('[data-remove-svc]');
  if (!btn) return;
  deselectService(btn.dataset.removeSvc);
});\
""")

NEW_JS1 = b("""\
// ----------------------------------------------------------------------------

// SCREEN NAVIGATION

// ----------------------------------------------------------------------------

var SVC_FROM = {
  'Furniture Assembly':  'From $99 · 1–3 hrs',
  'TV Mounting':         'From $99 · about 1 hr',
  'Smart Home':          'From $99 · about 1 hr',
  'Fitness Equipment':   'From $129 · 1–3 hrs',
  'Outdoor & Playsets':  'From $149 · 2–4 hrs',
  'Office Assembly':     'From $99 · 1–3 hrs'
};

function showItemScreen(svc) {

  BOOK.currentSvc = svc;

  if (BOOK.selectedServices.indexOf(svc) === -1) {
    BOOK.selectedServices.push(svc);
    if (!BOOK.selectedItems[svc]) BOOK.selectedItems[svc] = [];
  }

  document.getElementById('item-screen-heading').textContent = svc;
  document.getElementById('item-screen-from').textContent = SVC_FROM[svc] || '';

  renderItemScreen(svc);

  document.getElementById('svc-screen').style.display = 'none';
  document.getElementById('item-screen').style.display = '';

  var panel = document.getElementById('step-1');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

}

function showSvcScreen() {

  if (BOOK.currentSvc) {
    var items = BOOK.selectedItems[BOOK.currentSvc] || [];
    if (items.length === 0) {
      var idx = BOOK.selectedServices.indexOf(BOOK.currentSvc);
      if (idx !== -1) BOOK.selectedServices.splice(idx, 1);
      delete BOOK.selectedItems[BOOK.currentSvc];
    }
  }

  BOOK.currentSvc = null;

  document.getElementById('item-screen').style.display = 'none';
  document.getElementById('svc-screen').style.display = '';

  updateSvcRows();
  updateOrderSummary();

  var panel = document.getElementById('step-1');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

}

function updateSvcRows() {
  document.querySelectorAll('.svc-row').forEach(function(row) {
    var svc = row.dataset.service;
    var items = BOOK.selectedItems[svc] || [];
    row.classList.toggle('has-items', items.length > 0);
    var badge = row.querySelector('.svc-row-badge');
    if (badge) {
      badge.textContent = items.length > 0
        ? (items.length === 1 ? '1 item selected' : items.length + ' items selected')
        : '';
    }
  });
}\
""")

src = rpl(src, OLD_JS1, NEW_JS1, 'JS patch 1 (tileClick to showItemScreen/showSvcScreen/updateSvcRows)')

# ─── JS PATCH 2 ──────────────────────────────────────────────────────────────
# Replace the RENDER SUB-CATEGORY PANELS block (SVC_ICONS through end of
# renderSubcats + filterSubcatItems + subcats-wrap event listeners)
# with renderItemScreen + filterItemList + item-list-wrap listeners.

OLD_JS2_START = b'// ----------------------------------------------------------------------------\r\n\r\n// RENDER SUB-CATEGORY PANELS'
OLD_JS2_END   = b"document.getElementById('subcats-wrap').addEventListener('input', function(e) {\r\n\r\n  var inp = e.target.closest('.subcat-search');\r\n\r\n  if (inp) filterSubcatItems(inp);\r\n\r\n});"

idx2_start = src.find(OLD_JS2_START)
idx2_end   = src.find(OLD_JS2_END)
if idx2_start == -1 or idx2_end == -1:
    print('FAIL: JS patch 2 markers not found')
    print(f'  START found: {idx2_start != -1}')
    print(f'  END found:   {idx2_end != -1}')
    sys.exit(1)

idx2_end += len(OLD_JS2_END)

NEW_JS2 = b("""\
// ----------------------------------------------------------------------------

// RENDER ITEM SCREEN (Screen B)

// ----------------------------------------------------------------------------

function renderItemScreen(svc) {

  var groups = SUBCATS[svc] || [];

  var wrap = document.getElementById('item-list-wrap');

  var html = '';

  groups.forEach(function(g) {

    html += '<div class="subcat-group"><div class="subcat-group-label">' + esc(g.group) + '</div>';

    g.items.forEach(function(item) { html += itemRowHtml(svc, item); });

    html += '</div>';

  });

  wrap.innerHTML = html;

  var inp = document.getElementById('item-search');
  if (inp) inp.value = '';

  var clearBtn = document.getElementById('item-search-clear');
  if (clearBtn) clearBtn.classList.remove('vis');

  var noRes = document.getElementById('item-no-results');
  if (noRes) noRes.style.display = 'none';

}



function filterItemList(q) {

  var wrap = document.getElementById('item-list-wrap');

  if (!wrap) return;

  var clearBtn = document.getElementById('item-search-clear');

  var noRes = document.getElementById('item-no-results');

  if (clearBtn) clearBtn.classList.toggle('vis', q.length > 0);

  var groups = wrap.querySelectorAll('.subcat-group');

  var totalVisible = 0;

  groups.forEach(function(group) {

    var items = group.querySelectorAll('.subcat-item');

    var groupVisible = 0;

    items.forEach(function(item) {

      var name = (item.dataset.itemName || '').toLowerCase();

      var show = !q || name.indexOf(q) !== -1;

      item.style.display = show ? '' : 'none';

      if (show) groupVisible++;

    });

    group.style.display = groupVisible > 0 ? '' : 'none';

    totalVisible += groupVisible;

  });

  if (noRes) {

    noRes.style.display = totalVisible === 0 && q ? 'block' : 'none';

    var sp = noRes.querySelector('span');

    if (sp) sp.textContent = q;

  }

}



// Event delegation for item list

document.getElementById('item-list-wrap').addEventListener('click', function(e) {

  var qBtn = e.target.closest('[data-qty-delta]');

  if (qBtn) {

    e.stopPropagation();

    changeQty(qBtn.dataset.qtySvc, qBtn.dataset.qtyName, parseInt(qBtn.dataset.qtyDelta, 10));

    return;

  }

  var itemRow = e.target.closest('[data-item-svc]');

  if (itemRow && !e.target.closest('.subcat-qty')) {

    toggleItem(

      itemRow.dataset.itemSvc,

      itemRow.dataset.itemName,

      parseFloat(itemRow.dataset.itemPrice),

      parseFloat(itemRow.dataset.itemPriceMax),

      itemRow.dataset.itemAddon === 'true',

      itemRow.dataset.itemCustom === 'true'

    );

  }

});



document.getElementById('item-search').addEventListener('input', function() {

  filterItemList(this.value.trim().toLowerCase());

});



document.getElementById('item-search-clear').addEventListener('click', function() {

  var inp = document.getElementById('item-search');

  if (inp) { inp.value = ''; filterItemList(''); inp.focus(); }

});\
""")

src = src[:idx2_start] + NEW_JS2 + src[idx2_end:]
print('OK:   JS patch 2 (renderSubcats -> renderItemScreen + new event listeners)')

# ─── JS PATCH 3 ──────────────────────────────────────────────────────────────
# Update toggleItem: replace renderSubcats() call with renderItemScreen(BOOK.currentSvc)

OLD_JS3 = b("""\
  renderSubcats();

  updateOrderSummary();

}



function changeQty(svc, name, delta) {

  var found = (BOOK.selectedItems[svc] || []).find(function(i) { return i.name === name; });

  if (found) { found.qty = Math.max(1, found.qty + delta); renderSubcats(); updateOrderSummary(); }\
""")

NEW_JS3 = b("""\
  renderItemScreen(BOOK.currentSvc);

  updateOrderSummary();

}



function changeQty(svc, name, delta) {

  var found = (BOOK.selectedItems[svc] || []).find(function(i) { return i.name === name; });

  if (found) { found.qty = Math.max(1, found.qty + delta); renderItemScreen(BOOK.currentSvc); updateOrderSummary(); }\
""")

src = rpl(src, OLD_JS3, NEW_JS3, 'JS patch 3 (toggleItem/changeQty -> renderItemScreen)')

# ─── JS PATCH 4 ──────────────────────────────────────────────────────────────
# Add BOOK.currentSvc to initial BOOK state

OLD_JS4 = b('  selectedItems: {},   // { ServiceName: [{name, price, priceMax, addon, customQuote, qty}] }')
NEW_JS4 = b('  selectedItems: {},   // { ServiceName: [{name, price, priceMax, addon, customQuote, qty}] }\r\n  currentSvc: null,')

src = rpl(src, OLD_JS4, NEW_JS4, 'JS patch 4 (add currentSvc to BOOK state)')

# ─── JS PATCH 5 ──────────────────────────────────────────────────────────────
# Fix deselectService: remove .service-tile querySelector and renderSubcats/renderSelectedServices calls

OLD_JS5 = b"function deselectService(svc) {\r\n\r\n  var idx = BOOK.selectedServices.indexOf(svc);\r\n\r\n  if (idx !== -1) BOOK.selectedServices.splice(idx, 1);\r\n\r\n  delete BOOK.selectedItems[svc];\r\n\r\n  document.querySelectorAll('.service-tile').forEach(function(t) {\r\n\r\n    if (t.dataset.service === svc) {\r\n      t.classList.remove('selected');\r\n      t.setAttribute('aria-pressed', 'false');\r\n    }\r\n\r\n  });\r\n\r\n  renderSubcats();\r\n  renderSelectedServices();\r\n\r\n  updateOrderSummary();\r\n\r\n}"

NEW_JS5 = b("""\
function deselectService(svc) {

  var idx = BOOK.selectedServices.indexOf(svc);

  if (idx !== -1) BOOK.selectedServices.splice(idx, 1);

  delete BOOK.selectedItems[svc];

  if (BOOK.currentSvc === svc) BOOK.currentSvc = null;

  updateSvcRows();

  updateOrderSummary();

}\
""")

src = rpl(src, OLD_JS5, NEW_JS5, 'JS patch 5 (deselectService cleanup)')

# ─── JS PATCH 6 ──────────────────────────────────────────────────────────────
# Fix URL param preSelect: use .svc-row + showItemScreen instead of .service-tile + tileClick

OLD_JS6 = b"  document.querySelectorAll('.service-tile').forEach(function(tile) {\r\n\r\n    var tileClean = tile.dataset.service.toLowerCase().replace(/[^a-z]/g,'');\r\n\r\n    if (tileClean.indexOf(svcClean) !== -1 || svcClean.indexOf(tileClean) !== -1) {\r\n\r\n      tileClick(tile);\r\n\r\n    }\r\n\r\n  });"

NEW_JS6 = b("""\
  document.querySelectorAll('.svc-row').forEach(function(row) {

    var rowClean = (row.dataset.service || '').toLowerCase().replace(/[^a-z]/g,'');

    if (rowClean.indexOf(svcClean) !== -1 || svcClean.indexOf(rowClean) !== -1) {

      showItemScreen(row.dataset.service);

    }

  });\
""")

src = rpl(src, OLD_JS6, NEW_JS6, 'JS patch 6 (preSelect URL param uses svc-row + showItemScreen)')

# ─── WRITE ───────────────────────────────────────────────────────────────────

with open(PATH, 'wb') as f:
    f.write(src)

print()
print('Done. book.html patched successfully.')
