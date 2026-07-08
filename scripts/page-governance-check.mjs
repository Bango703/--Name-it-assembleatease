import {
  buildReportMarkdown,
  collectGovernanceData,
  summarizeGovernanceResults,
  writeReportFile,
} from './lib/page-governance.mjs';

const strict = process.argv.includes('--strict');
const results = collectGovernanceData();
const summary = summarizeGovernanceResults(results);
const failingResults = results.filter((result) => result.status !== 'PASS');

writeReportFile('page-governance-findings.json', `${JSON.stringify(results, null, 2)}\n`);
writeReportFile('page-governance-findings.md', buildReportMarkdown(results, summary));

console.log(`Audited ${summary.totalPages} pages.`);
console.log(`PASS=${summary.statusCounts.PASS} WARNING=${summary.statusCounts.WARNING} FAIL=${summary.statusCounts.FAIL}`);

if (strict && summary.statusCounts.FAIL > 0) {
  process.exitCode = 1;
}

if (!strict && failingResults.length) {
  console.log('Governance findings were written without failing the command. Run with --strict to enforce FAIL results.');
}
