import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bookingPage = await readFile(new URL('../book.html', import.meta.url), 'utf8');

// The extras step must offer the complete catalog without steering customers
// toward one unrelated service.
assert.match(bookingPage, /function renderAddServiceChoice\(\)/);
assert.match(bookingPage, /<div class=\\"reco-shelf-head\\">Optional<\/div>/);
assert.match(bookingPage, /Browse all available services and choose only what you need for this visit/);
assert.match(bookingPage, /Browse all services/);
assert.match(bookingPage, /onclick=\\"openAddServicePicker\(\)\\"/);
assert.doesNotMatch(bookingPage, /Add smart home setup/);
assert.doesNotMatch(bookingPage, /Bundle another service/);
assert.doesNotMatch(bookingPage, /Same-visit bundles/);
assert.doesNotMatch(bookingPage, /BUNDLE_SERVICE_RULES/);

// The catalog is reused in contextual add mode, keeps prior work visible, and
// always provides an explicit way out without adding another service.
assert.match(bookingPage, /servicePickerMode: 'initial'/);
assert.match(bookingPage, /servicePickerReturnSvc: ''/);
assert.match(bookingPage, /id="svc-screen-title"/);
assert.match(bookingPage, /id="svc-screen-subtitle"/);
assert.match(bookingPage, /id="service-picker-complete" hidden/);
assert.match(bookingPage, /onclick="finishAddingServices\(\)"/);
assert.match(bookingPage, /Done adding services/);
assert.match(bookingPage, /function openAddServicePicker\(\)[\s\S]*?BOOK\.servicePickerMode = 'add';[\s\S]*?showSvcScreen\(\);/);
assert.match(bookingPage, /function finishAddingServices\(\)[\s\S]*?showItemScreen\(returnSvc, 'notes'\);/);
assert.match(bookingPage, /customQuote\.hidden = adding/);
assert.match(bookingPage, /BOOK\.selectedServices\.length === 1 && BOOK\.servicePickerMode !== 'add'/);
assert.match(bookingPage, /Selected - /);

// The new flow remains a navigation-only change. Existing pricing and booking
// submission sources of truth must still be present.
assert.match(bookingPage, /function getPricingSnapshot\(zip\)/);
assert.match(bookingPage, /\/api\/booking\/promo-preview/);
assert.match(bookingPage, /\/api\/booking\/setup-intent/);
assert.match(bookingPage, /\/api\/booking['"]/);

// Execute the real picker-state functions with a minimal DOM. This verifies
// that entering add mode preserves the existing service, exposes a safe exit,
// returns to notes, and removes a browsed service when no item was selected.
const flowStart = bookingPage.indexOf('function getFirstSelectedServiceWithItems()');
const flowEnd = bookingPage.indexOf('function updateSvcRows()', flowStart);
assert.ok(flowStart >= 0 && flowEnd > flowStart, 'Service-picker state functions must be present');

const elements = {
  's1-details': { value: 'Keep the existing customer note.' },
  's1-quote': { checked: false },
  'svc-screen-kicker': { textContent: '' },
  'svc-screen-title': { textContent: '' },
  'svc-screen-subtitle': { textContent: '' },
  'service-picker-complete': { hidden: true },
  'item-screen': { style: {} },
  'svc-screen': { style: {} },
  'step-1': { scrollIntoView() {} },
};
const customQuoteRow = { hidden: false };
const itemCounts = {
  'Furniture Assembly': 1,
  'Smart Home': 0,
};
let shownItemScreen = null;

const context = {
  BOOK: {
    selectedServices: ['Furniture Assembly'],
    selectedItems: { 'Furniture Assembly': [{ name: 'Bed Frame', qty: 1 }] },
    currentSvc: 'Furniture Assembly',
    currentGroup: 'Bedroom',
    itemStage: 'extras',
    itemSearchOpen: false,
    itemHelpOpen: false,
    servicePickerMode: 'initial',
    servicePickerReturnSvc: '',
    details: '',
    wantsQuote: false,
  },
  document: {
    getElementById(id) { return elements[id] || null; },
    querySelector(selector) {
      return selector === '.svc-row[data-service="Other"]' ? customQuoteRow : null;
    },
  },
  getSelectedItemCountForService(service) { return itemCounts[service] || 0; },
  updateSvcRows() {},
  updateOrderSummary() {},
  showItemScreen(service, stage) { shownItemScreen = { service, stage }; },
};

vm.runInNewContext(bookingPage.slice(flowStart, flowEnd), context);
context.openAddServicePicker();
assert.equal(context.BOOK.servicePickerMode, 'add');
assert.equal(context.BOOK.servicePickerReturnSvc, 'Furniture Assembly');
assert.deepEqual(context.BOOK.selectedServices, ['Furniture Assembly']);
assert.equal(elements['svc-screen-title'].textContent, 'Add another service');
assert.equal(elements['service-picker-complete'].hidden, false);
assert.equal(customQuoteRow.hidden, true);
assert.equal(context.BOOK.details, 'Keep the existing customer note.');

context.finishAddingServices();
assert.deepEqual(shownItemScreen, { service: 'Furniture Assembly', stage: 'notes' });
assert.equal(context.BOOK.servicePickerMode, 'initial');

context.BOOK.servicePickerMode = 'add';
context.BOOK.currentSvc = 'Smart Home';
context.BOOK.selectedServices = ['Furniture Assembly', 'Smart Home'];
context.BOOK.selectedItems['Smart Home'] = [];
context.showSvcScreen();
assert.deepEqual(context.BOOK.selectedServices, ['Furniture Assembly']);
assert.equal(context.BOOK.selectedItems['Smart Home'], undefined);

console.log('Booking add-another-service flow checks: PASS');
