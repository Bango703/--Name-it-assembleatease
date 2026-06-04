"""Finish patch: fix deselectService and preSelect URL handler."""
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

def b(s):
    return s.encode('utf-8').replace(b'\n', b'\r\n')

# Patch 5: deselectService
OLD5 = b"function deselectService(svc) {\r\n\r\n  var idx = BOOK.selectedServices.indexOf(svc);\r\n\r\n  if (idx !== -1) BOOK.selectedServices.splice(idx, 1);\r\n\r\n  delete BOOK.selectedItems[svc];\r\n\r\n  document.querySelectorAll('.service-tile').forEach(function(t) {\r\n\r\n    if (t.dataset.service === svc) {\r\n      t.classList.remove('selected');\r\n      t.setAttribute('aria-pressed', 'false');\r\n    }\r\n\r\n  });\r\n\r\n  renderSubcats();\r\n  renderSelectedServices();\r\n\r\n  updateOrderSummary();\r\n\r\n}"

NEW5 = b("""\
function deselectService(svc) {

  var idx = BOOK.selectedServices.indexOf(svc);

  if (idx !== -1) BOOK.selectedServices.splice(idx, 1);

  delete BOOK.selectedItems[svc];

  if (BOOK.currentSvc === svc) BOOK.currentSvc = null;

  updateSvcRows();

  updateOrderSummary();

}\
""")

src = rpl(src, OLD5, NEW5, 'deselectService cleanup')

# Patch 6: preSelect URL param
OLD6 = b"  document.querySelectorAll('.service-tile').forEach(function(tile) {\r\n\r\n    var tileClean = tile.dataset.service.toLowerCase().replace(/[^a-z]/g,'');\r\n\r\n    if (tileClean.indexOf(svcClean) !== -1 || svcClean.indexOf(tileClean) !== -1) {\r\n\r\n      tileClick(tile);\r\n\r\n    }\r\n\r\n  });"

NEW6 = b("""\
  document.querySelectorAll('.svc-row').forEach(function(row) {

    var rowClean = (row.dataset.service || '').toLowerCase().replace(/[^a-z]/g,'');

    if (rowClean.indexOf(svcClean) !== -1 || svcClean.indexOf(rowClean) !== -1) {

      showItemScreen(row.dataset.service);

    }

  });\
""")

src = rpl(src, OLD6, NEW6, 'preSelect uses svc-row + showItemScreen')

with open(PATH, 'wb') as f:
    f.write(src)

print('\nDone.')
