import {
  buildManifestRows,
  buildReportMarkdown,
  collectGovernanceData,
  summarizeGovernanceResults,
  toCsv,
  writeReportFile,
} from './lib/page-governance.mjs';

const results = collectGovernanceData();
const summary = summarizeGovernanceResults(results);
const manifestRows = buildManifestRows(results);

writeReportFile('page-manifest.json', `${JSON.stringify(manifestRows, null, 2)}\n`);
writeReportFile('page-manifest.csv', `${toCsv(manifestRows)}\n`);
writeReportFile('page-governance-report.md', buildReportMarkdown(results, summary));

console.log(`Page governance report generated for ${summary.totalPages} pages.`);
console.log(`PASS=${summary.statusCounts.PASS} WARNING=${summary.statusCounts.WARNING} FAIL=${summary.statusCounts.FAIL}`);
