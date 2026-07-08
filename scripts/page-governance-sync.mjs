import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { governanceConfig, replacementRules, ROOT, escapeRegExp } from './lib/site-governance.mjs';
import { listHtmlPages, writeReportFile } from './lib/page-governance.mjs';

const SCRIPT_DIR = join(ROOT, 'scripts');
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.py']);

function toPosixPath(path) {
  return String(path).replace(/\\/g, '/');
}

function listScriptFiles(dir = SCRIPT_DIR) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listScriptFiles(fullPath));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.'));
    if (!SCRIPT_EXTENSIONS.has(extension)) continue;
    files.push(toPosixPath(relative(ROOT, fullPath)));
  }
  return files;
}

function applyRule(text, currentValue, aliases) {
  let next = text;
  let count = 0;
  const sortedAliases = [...aliases]
    .filter((alias) => alias && alias !== currentValue)
    .sort((left, right) => String(right).length - String(left).length);

  for (const alias of sortedAliases) {
    if (!alias || alias === currentValue) continue;
    const pattern = currentValue.startsWith(alias)
      ? new RegExp(`${escapeRegExp(alias)}(?!/)`, 'g')
      : new RegExp(escapeRegExp(alias), 'g');
    const matches = next.match(pattern);
    if (!matches?.length) continue;
    next = next.replace(pattern, currentValue);
    count += matches.length;
  }
  return { next, count };
}

const targetFiles = [...new Set([...listHtmlPages(), ...listScriptFiles()])].sort((a, b) => a.localeCompare(b));
const fileReports = [];
const replacementSummary = Object.fromEntries(replacementRules.map((rule) => [rule.label, 0]));

for (const relativePath of targetFiles) {
  const absolutePath = join(ROOT, relativePath);
  const original = readFileSync(absolutePath, 'utf8');
  let next = original;
  const appliedRules = [];

  for (const rule of replacementRules) {
    const result = applyRule(next, rule.current, rule.aliases);
    if (!result.count) continue;
    next = result.next;
    replacementSummary[rule.label] += result.count;
    appliedRules.push({ rule: rule.label, count: result.count, current: rule.current });
  }

  if (next === original) continue;

  writeFileSync(absolutePath, next);
  fileReports.push({
    path: relativePath,
    replacements: appliedRules,
  });
}

const changedFileCount = fileReports.length;
const totalReplacementCount = Object.values(replacementSummary).reduce((sum, count) => sum + count, 0);
const report = {
  generatedAt: new Date().toISOString(),
  sourceOfTruth: governanceConfig.business.domain,
  filesScanned: targetFiles.length,
  changedFileCount,
  totalReplacementCount,
  replacementSummary,
  changedFiles: fileReports,
};

const markdownLines = [
  '# Page Governance Sync Report',
  '',
  `Scanned ${report.filesScanned} files.`,
  `Changed ${report.changedFileCount} files.`,
  `Applied ${report.totalReplacementCount} replacement(s).`,
  '',
  '## Replacement Summary',
  '',
  ...Object.entries(replacementSummary).map(([label, count]) => `- ${label}: ${count}`),
  '',
  '## Changed Files',
  '',
];

if (!fileReports.length) {
  markdownLines.push('- No files required sync updates.');
} else {
  for (const file of fileReports) {
    markdownLines.push(`- ${file.path}`);
    for (const replacement of file.replacements) {
      markdownLines.push(`  - ${replacement.rule}: ${replacement.count}`);
    }
  }
}

writeReportFile('page-governance-sync-report.json', `${JSON.stringify(report, null, 2)}\n`);
writeReportFile('page-governance-sync-report.md', `${markdownLines.join('\n')}\n`);

console.log(`Scanned ${report.filesScanned} files for governance sync.`);
console.log(`Changed ${report.changedFileCount} files with ${report.totalReplacementCount} replacement(s).`);
