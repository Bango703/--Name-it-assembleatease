import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';

/**
 * The catalog search rule and word list, read from the one file the booking
 * page also loads (assets/js/catalog-search.js), the same way api/_pricing.js
 * reads the booking catalog. api/booking/catalog.js ships each item's words and
 * the stop words to the customer app, so app and website cannot disagree.
 */
let loaded = null;

export function catalogSearch() {
  if (loaded) return loaded;
  const sourcePath = join(process.cwd(), 'assets', 'js', 'catalog-search.js');
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(sourcePath, 'utf8'), sandbox, { filename: sourcePath, timeout: 1000 });
  const search = sandbox.window.AAE_CATALOG_SEARCH;
  if (!search || typeof search.searchText !== 'function') throw new Error('assets/js/catalog-search.js did not define AAE_CATALOG_SEARCH');
  loaded = search;
  return loaded;
}
