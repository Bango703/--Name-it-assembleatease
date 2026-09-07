// A selection is not a booking, credential, price quote, or consent record.
// Shared by the voice tool and browser; pricing is always recalculated at checkout.
const MAX_LINES = 25;
const MAX_FRAGMENT = 16000;

export function validateVoiceSelection(value, catalog) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['version', 'items', 'requestQuote'].includes(key))
      || value.version !== 1 || typeof value.requestQuote !== 'boolean'
      || !Array.isArray(value.items) || !value.items.length || value.items.length > MAX_LINES) {
    return { error: 'Please select your services again. This selection could not be loaded.' };
  }
  const items = [];
  const seen = new Set();
  let hasCustomQuote = false;
  for (const line of value.items) {
    if (!line || typeof line !== 'object' || Array.isArray(line)
        || Object.keys(line).some(key => !['service', 'name', 'qty'].includes(key))
        || typeof line.service !== 'string' || typeof line.name !== 'string'
        || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 99
        || !Object.hasOwn(catalog?.subcategories || {}, line.service)) {
      return { error: 'Please review the selected items and quantities.' };
    }
    const item = catalog.subcategories[line.service]
      .flatMap(group => group.items || []).find(candidate => candidate.name === line.name);
    const key = JSON.stringify([line.service, line.name]);
    if (!item || seen.has(key)) return { error: 'An item is unavailable or repeated. Please select your services again.' };
    seen.add(key);
    hasCustomQuote ||= item.customQuote === true;
    items.push({ service: line.service, name: item.name, qty: line.qty });
  }
  return { value: { version: 1, items, requestQuote: value.requestQuote || hasCustomQuote } };
}

export function voiceSelectionFragment(value, catalog) {
  const result = validateVoiceSelection(value, catalog);
  if (result.error) return result;
  const fragment = '#sora=' + encodeURIComponent(JSON.stringify(result.value));
  return fragment.length <= MAX_FRAGMENT ? { value: fragment }
    : { error: 'This selection is too large for a booking link. Please use the booking page.' };
}

export function readVoiceSelectionFragment(fragment, catalog) {
  if (typeof fragment !== 'string' || !fragment.startsWith('#sora=') || fragment.length > MAX_FRAGMENT) {
    return { error: 'This booking selection could not be loaded. Please select your services again.' };
  }
  try { return validateVoiceSelection(JSON.parse(decodeURIComponent(fragment.slice(6))), catalog); }
  catch { return { error: 'This booking selection could not be loaded. Please select your services again.' }; }
}

export function applyVoiceSelection(selection, catalog, booking) {
  const validated = validateVoiceSelection(selection, catalog);
  if (validated.error) return validated;
  // Never replace an existing cart, a restored session, or a payment recovery.
  if (booking.selectedServices?.length || Object.keys(booking.selectedItems || {}).length
      || booking._guestMutationToken || booking._clientSecret || booking.date || booking.email) {
    return { error: 'Your current booking was kept. Review it before starting a different selection.' };
  }
  const services = [];
  const selected = {};
  for (const line of validated.value.items) {
    const item = catalog.subcategories[line.service].flatMap(group => group.items || [])
      .find(candidate => candidate.name === line.name);
    if (!services.includes(line.service)) services.push(line.service);
    (selected[line.service] ||= []).push({ name: item.name, qty: line.qty, price: item.price,
      priceMax: item.priceMax || 0, addon: item.addon === true, customQuote: item.customQuote === true });
  }
  booking.selectedServices = services;
  booking.selectedItems = selected;
  booking.wantsQuote = validated.value.requestQuote;
  return { ok: true, service: services[0] };
}
