import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const ownerSource = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
const reportStart = ownerSource.indexOf("document.getElementById('export-csv-btn').addEventListener");
const reportEnd = ownerSource.indexOf('// ─── Render list with search + status filter ───', reportStart);
assert.ok(reportStart >= 0 && reportEnd > reportStart, 'Financial report generator must be present');

const reportSource = ownerSource.slice(reportStart, reportEnd);
assert.match(reportSource, /var rows = completed\.map/);
assert.doesNotMatch(reportSource, /var rows = allBookings\.map/);
assert.doesNotMatch(reportSource, /esc\(b\.customer_name\)/);
assert.doesNotMatch(reportSource, /esc\(b\.assembler_name/);
assert.match(reportSource, /totProfit\+=Number\(fs\.platformGrossCents\)/);
assert.doesNotMatch(reportSource, /totProfit = totNet - totPayout/);
assert.match(reportSource, /Financial Performance Summary/);
assert.match(reportSource, /Management-prepared and unaudited/);
assert.match(reportSource, /Customer Payments Collected/);
assert.match(reportSource, /Sales Tax Liability/);
assert.match(reportSource, /Known Contractor Costs/);
assert.match(reportSource, /Reconciled Platform Gross/);
assert.match(reportSource, /Operating profit:<\/strong> not shown/);
assert.match(reportSource, /customer names are intentionally omitted/);
assert.match(reportSource, /9169 W State St #3847, Garden City, ID 83714/);
assert.match(reportSource, /@page\{size:letter landscape/);
assert.match(reportSource, /break-inside:avoid/);
assert.match(reportSource, /Reporting period/);
assert.match(reportSource, /white-space:nowrap/);
assert.doesNotMatch(reportSource, /Net Customer Revenue/);
assert.doesNotMatch(reportSource, /Known Easer Cost/);
assert.doesNotMatch(reportSource, /Their platform gross is shown as Review/);
assert.doesNotMatch(reportSource, /Austin, TX/);
assert.doesNotMatch(reportSource, /#7c3aed|#ef4444|#f59e0b/i);

let exportHandler = null;
let renderedHtml = '';
const bookings = [
  {
    status: 'completed',
    ref: 'AAE-RECONCILED',
    service: 'Furniture Assembly',
    customer_name: 'Private Customer One',
    date: '2026-08-10',
    time: '10:00 AM - 12:00 PM',
    assembler_name: 'Professional One',
    netCharged: 37_400,
    financeReady: true,
    financial_summary: {
      taxCollectedCents: 2_850,
      processingFeeCents: 1_020,
      easerCostCents: 24_550,
      platformGrossCents: 8_980,
    },
  },
  {
    status: 'completed',
    ref: 'AAE-PENDING',
    service: 'TV Mounting',
    customer_name: 'Private Customer Two',
    date: '2026-08-11',
    time: '1:00 PM - 3:00 PM',
    assembler_name: 'Professional Two',
    netCharged: 15_300,
    financeReady: false,
    financial_summary: {
      taxCollectedCents: 1_166,
      processingFeeCents: 474,
      easerCostCents: 0,
      platformGrossCents: 0,
    },
  },
  {
    status: 'cancelled',
    ref: 'AAE-CANCELLED',
    service: 'Cancelled Service',
    customer_name: 'Private Cancelled Customer',
    date: '2026-08-12',
    netCharged: 0,
    financeReady: false,
    financial_summary: {},
  },
];

const context = {
  allBookings: bookings,
  actualNetPaymentsCents: booking => booking.netCharged,
  completedFinanceReady: booking => booking.financeReady,
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
      return {
        addEventListener(event, handler) {
          assert.equal(event, 'click');
          exportHandler = handler;
        },
      };
    },
  },
  window: {
    open() {
      return {
        document: {
          write(html) { renderedHtml = html; },
          close() {},
        },
      };
    },
  },
};

vm.runInNewContext(reportSource, context);
assert.equal(typeof exportHandler, 'function');
exportHandler();

assert.match(renderedHtml, /\$527\.00/);
assert.match(renderedHtml, /\$40\.16/);
assert.match(renderedHtml, /\$14\.94/);
assert.match(renderedHtml, /\$245\.50/);
assert.match(renderedHtml, /\$89\.80/);
assert.match(renderedHtml, /\$374\.00 - \(\$28\.50\) - \(\$10\.20\) - \(\$245\.50\) = \$89\.80/);
assert.match(renderedHtml, /AAE-RECONCILED/);
assert.match(renderedHtml, /AAE-PENDING/);
assert.match(renderedHtml, /Sales Tax/);
assert.match(renderedHtml, /Action required/);
assert.match(renderedHtml, /Aug 10, 2026 - Aug 11, 2026/);
assert.match(renderedHtml, /1 completed booking is excluded/);
assert.doesNotMatch(renderedHtml, /AAE-CANCELLED|Cancelled Service/);
assert.doesNotMatch(renderedHtml, /Private Customer/);

if (process.argv.includes('--preview')) {
  const previewDir = new URL('../tmp/pdfs/financial-report-preview/', import.meta.url);
  await mkdir(previewDir, { recursive: true });
  await writeFile(new URL('index.html', previewDir), renderedHtml.replace('window.onload=function(){window.print();}', ''), 'utf8');
  console.log(`Preview written to ${new URL('index.html', previewDir).pathname}`);
}

console.log('Owner financial report layout, privacy, and truth checks: PASS');
