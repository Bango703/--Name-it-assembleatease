// The nightly consistency checks on the owner dashboard, shared by the live
// run (tests/e2e-live) and the fixed-data suite (tests/e2e), which proves they
// pass when the dashboard agrees with itself.
//
// The repository is public, so its Actions logs are public. Every check
// compares inside the browser and reports only true or false with the name of
// the check: no customer, amount or count ever reaches the log.
import { expect } from '@playwright/test';

// Polls a check that runs in the page and answers true or false.
const holds = (page, name, fn, arg) => expect.poll(() => page.evaluate(fn, arg).catch(() => false), { message: name, timeout: 20_000 }).toBe(true);

async function view(page, name) {
  await page.evaluate((n) => document.querySelector(`.sidebar [data-view="${n}"]`).click(), name);
}

export async function checkDashboardAgrees(page) {
  await holds(page, 'Live Ops loaded and verified current state', () => {
    const updated = document.getElementById('ops-last-updated')?.textContent || '';
    const bar = document.getElementById('ops-alerts-bar')?.textContent || '';
    return updated !== '—' && !/unavailable/i.test(updated) && !/could not verify/i.test(bar);
  });

  await page.waitForTimeout(5_000);
  await holds(page, 'no menu badge failed to load', () => ![...document.querySelectorAll('.sidebar .nav-count')]
    .some((b) => b.offsetParent && b.textContent.trim() === '!'));

  // Financials, fetched by the page with its own session.
  await page.evaluate(async () => {
    const r = await fetch('/api/owner/financial-dashboard?period=all&ledger=all', { headers: window._ownerHeaders(), cache: 'no-store' });
    window.__liveFin = r.ok ? await r.json() : null;
  });
  await holds(page, 'Financials loaded', () => !!(window.__liveFin && window.__liveFin.summary));

  await view(page, 'bookings');
  await holds(page, 'Bookings platform-gross tile equals Financials all-time platform gross', () => {
    const n = Number(window.__liveFin.summary.platformGrossProfit) || 0;
    const want = (n < 0 ? '-' : '') + '$' + (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return document.querySelector('#stat-revenue .stat-value')?.textContent.trim() === want;
  });

  await view(page, 'customers');
  await holds(page, 'Customers repeat count equals Financials customers with more than one completed job', () => {
    const want = (window.__liveFin.customerTotals || []).filter((t) => t.completedJobs > 1).length;
    return document.getElementById('cust-repeat')?.textContent.trim() === String(want);
  });

  await view(page, 'today');
  await holds(page, 'Today view loaded', () => document.getElementById('today-count')?.textContent.trim() !== '—');
  await holds(page, 'Today badge equals the Today view active jobs', () => {
    const active = Number(document.getElementById('today-pending').textContent) + Number(document.getElementById('today-confirmed').textContent);
    const badge = document.getElementById('nav-today');
    const shown = badge.style.display === 'none' ? 0 : Number(badge.textContent);
    return shown === active;
  });
  await holds(page, 'Today count equals the jobs listed', () => Number(document.getElementById('today-count').textContent)
    === document.querySelectorAll('#today-list .today-job-card').length);
}
