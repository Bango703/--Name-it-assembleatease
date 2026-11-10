import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const ownerSource = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
const reportStart = ownerSource.indexOf("document.getElementById('export-csv-btn').addEventListener");
const reportEnd = ownerSource.indexOf('// ─── Render list with search + status filter ───', reportStart);
assert.ok(reportStart >= 0 && reportEnd > reportStart, 'Financial report generator must be present');

const reportSource = ownerSource.slice(reportStart, reportEnd);
// Owner, 2026-11-10: the printed report equals the Financials page, from its
// all-time ledger and totals; it never works money out for itself.
assert.match(reportSource, /var fin = await loadAllTimeFinance\(true\);/);
assert.match(reportSource, /var rows = ledgerRows\.map/);
assert.doesNotMatch(reportSource, /allBookings|actualNetPaymentsCents|completedFinanceReady/);
assert.doesNotMatch(reportSource, /esc\(b\.customer_name\)|esc\(r\.customerName\)/);
assert.doesNotMatch(reportSource, /esc\(b\.assembler_name/);
assert.match(reportSource, /var totProfit = Number\(sumy\.platformGrossProfit\) \|\| 0;/);
assert.match(reportSource, /Financial Performance Summary/);
assert.match(reportSource, /Management-prepared and unaudited/);
assert.match(reportSource, /Customer Payments Collected/);
assert.match(reportSource, /Sales Tax Liability/);
assert.match(reportSource, /Easer Earnings/);
assert.match(reportSource, /'Platform Gross'/);
assert.match(reportSource, /Operating profit:<\/strong> not shown/);
assert.match(reportSource, /customer names are intentionally omitted/);
assert.match(reportSource, /9169 W State St #3847, Garden City, ID 83714/);
assert.match(reportSource, /@page\{size:letter landscape/);
assert.match(reportSource, /break-inside:avoid/);
assert.match(reportSource, /Reporting period/);
assert.match(reportSource, /white-space:nowrap/);
assert.match(reportSource, /overflow-wrap:anywhere/);
assert.match(reportSource, /replace\(\/\\\/\/g, '\/<wbr>'\)/);
assert.match(reportSource, /Recorded completed-job payment activity/);
assert.doesNotMatch(reportSource, /Net Customer Revenue/);
assert.doesNotMatch(reportSource, /Known Easer Cost/);
assert.doesNotMatch(reportSource, /Their platform gross is shown as Review/);
assert.doesNotMatch(reportSource, /Austin, TX/);
assert.doesNotMatch(reportSource, /#7c3aed|#ef4444|#f59e0b/i);

let exportHandler = null;
let renderedHtml = '';
let bodyHtml = '';
const fin = {
  summary: {
    customerRevenue: 37_400 + 15_300 + 5_000,
    salesTaxCollected: 2_850 + 1_166,
    processingFees: 1_020 + 474 + 150,
    easerPayouts: 24_550 + 9_800 + 2_500,
    platformGrossProfit: 8_980 + 3_860 + 2_350,
  },
  ledger: [
    { ref: 'AAE-PAID', service: 'Trampoline/Disassembly/Moving/Reassembly', customerName: 'Private Customer One', date: '2026-08-10', eventType: 'completed_job', customerRevenue: 37_400, salesTax: 2_850, processingFee: 1_020, easerPayout: 24_550, platformGrossProfit: 8_980, payoutStatus: 'paid' },
    { ref: 'AAE-PENDING', service: 'TV Mounting', customerName: 'Private Customer Two', date: '2026-08-11', eventType: 'completed_job', customerRevenue: 15_300, salesTax: 1_166, processingFee: 474, easerPayout: 9_800, platformGrossProfit: 3_860, payoutStatus: 'pending' },
    { ref: 'AAE-CXL', service: 'Furniture Assembly', customerName: 'Private Customer Three', date: '2026-08-12', eventType: 'cancellation_earnings', customerRevenue: 5_000, salesTax: 0, processingFee: 150, easerPayout: 2_500, platformGrossProfit: 2_350, payoutStatus: 'paid' },
  ],
};
function makeContext(result) {
  return {
    loadAllTimeFinance: async () => result,
    fmt$: cents => `$${(Number(cents || 0) / 100).toFixed(2)}`,
    esc: value => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
    document: {
      getElementById(id) {
        assert.equal(id, 'export-csv-btn');
        return { addEventListener(event, handler) { assert.equal(event, 'click'); exportHandler = handler; } };
      },
    },
    window: {
      open() {
        return {
          document: {
            open() {},
            write(html) { renderedHtml = html; },
            close() {},
            body: { set innerHTML(value) { bodyHtml = value; } },
          },
        };
      },
    },
  };
}

vm.runInNewContext(reportSource, makeContext(fin));
assert.equal(typeof exportHandler, 'function');
await exportHandler();

assert.match(renderedHtml, /\$577\.00/, 'customer payments are the Financials total');
assert.match(renderedHtml, /\$151\.90/, 'platform gross is the Financials total');
assert.match(renderedHtml, /\$577\.00 - \(\$40\.16\) - \(\$16\.44\) - \(\$368\.50\) = \$151\.90/);
assert.match(renderedHtml, /AAE-PAID/);
assert.match(renderedHtml, /AAE-PENDING/);
assert.match(renderedHtml, /Cancellation fee/, 'cancellation fees are rows, as in Financials');
assert.match(renderedHtml, /Trampoline\/<wbr>Disassembly\/<wbr>Moving\/<wbr>Reassembly/);
assert.match(renderedHtml, /Easer paid/);
assert.match(renderedHtml, /Easer payout pending/);
assert.match(renderedHtml, /Aug 10, 2026 - Aug 12, 2026/);
assert.match(renderedHtml, /2 completed jobs &bull; 1 cancellation fees/);
assert.doesNotMatch(renderedHtml, /Private Customer/, 'no customer names');

renderedHtml = '';
vm.runInNewContext(reportSource, makeContext(null));
await exportHandler();
assert.equal(renderedHtml.includes('Financial Performance Summary'), false, 'no report from unknown numbers');
assert.match(bodyHtml, /Financials could not be loaded, so no report was made/);

if (process.argv.includes('--preview')) {
  const previewDir = new URL('../tmp/pdfs/financial-report-preview/', import.meta.url);
  await mkdir(previewDir, { recursive: true });
  await writeFile(new URL('index.html', previewDir), renderedHtml.replace('window.onload=function(){window.print();}', ''), 'utf8');
  console.log(`Preview written to ${new URL('index.html', previewDir).pathname}`);
}

console.log('Owner financial report layout, privacy, and truth checks: PASS');
