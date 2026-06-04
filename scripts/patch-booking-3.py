"""Restore escAttr and itemRowHtml that were accidentally removed."""
import sys

PATH = 'C:/Users/tgbiz/Handyman-marketplace/book.html'

with open(PATH, 'rb') as f:
    src = f.read()

def b(s):
    return s.encode('utf-8').replace(b'\n', b'\r\n')

# Insert escAttr + itemRowHtml right after CHECK_SVG definition
ANCHOR = b"var CHECK_SVG = '<svg viewBox=\"0 0 24 24\"><path d=\"M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z\"/></svg>';\r\n"

idx = src.find(ANCHOR)
if idx == -1:
    print('FAIL: CHECK_SVG anchor not found'); sys.exit(1)

INSERT = b("""
function escAttr(s) { return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;'); }

function itemRowHtml(svc, item) {

  var sel = isItemSelected(svc, item.name);

  var qty = getItemQty(svc, item.name);

  var priceStr = fmtPrice(item);

  var badge = item.popular ? '<span class="subcat-item-badge">Popular</span>' : '';

  return '<div class="subcat-item' + (sel ? ' selected' : '') + '"'

    + ' data-item-svc="' + escAttr(svc) + '"'

    + ' data-item-name="' + escAttr(item.name) + '"'

    + ' data-item-price="' + (item.price||0) + '"'

    + ' data-item-price-max="' + (item.priceMax||0) + '"'

    + ' data-item-addon="' + (!!item.addon) + '"'

    + ' data-item-custom="' + (!!item.customQuote) + '">'

    + '<div class="subcat-item-left">'

    + '<div class="subcat-item-cb">' + CHECK_SVG + '</div>'

    + '<span class="subcat-item-name">' + esc(item.name) + '</span>'

    + badge

    + '</div>'

    + '<span class="subcat-item-price' + (item.addon ? ' addon' : '') + '">' + priceStr + '</span>'

    + '<div class="subcat-qty">'

    + '<button class="qty-btn" data-qty-svc="' + escAttr(svc) + '" data-qty-name="' + escAttr(item.name) + '" data-qty-delta="-1">\\u2212</button>'

    + '<span class="qty-val">' + qty + '</span>'

    + '<button class="qty-btn" data-qty-svc="' + escAttr(svc) + '" data-qty-name="' + escAttr(item.name) + '" data-qty-delta="1">+</button>'

    + '</div>'

    + '</div>';

}

""")

insert_pos = idx + len(ANCHOR)
src = src[:insert_pos] + INSERT + src[insert_pos:]

with open(PATH, 'wb') as f:
    f.write(src)

print('OK: escAttr and itemRowHtml restored')
