const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

export function normalizeServiceZip(value) {
  const match = String(value || '').trim().match(ZIP_RE);
  return match ? match[1] : null;
}

export function normalizeServiceState(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'TEXAS') return 'TX';
  return /^[A-Z]{2}$/.test(raw) ? raw : null;
}

export function normalizeServiceCity(value) {
  const city = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .slice(0, 80);
  return city || null;
}

export function parseServiceLocation(input = {}) {
  const address = String(input.address || '').trim();
  const parts = address.split(',').map(part => part.trim()).filter(Boolean);
  let zip = normalizeServiceZip(input.zip);
  let state = normalizeServiceState(input.state);
  let city = normalizeServiceCity(input.city);

  if (!zip) {
    const trailingZip = address.match(/(?:^|[,\s])(\d{5})(?:-\d{4})?\s*$/);
    zip = trailingZip ? trailingZip[1] : null;
  }

  if (!state) {
    const stateMatch = address.match(/(?:^|,)\s*(TX|Texas)\s*(?:,|\d{5}|$)/i)
      || address.match(/\b(TX|Texas)\b/i);
    state = stateMatch ? 'TX' : null;
  }

  if (!city && parts.length >= 2) {
    let statePartIndex = -1;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (/^(?:TX|Texas)(?:\s+\d{5}(?:-\d{4})?)?$/i.test(parts[index])) {
        statePartIndex = index;
        break;
      }
    }
    if (statePartIndex > 0) city = normalizeServiceCity(parts[statePartIndex - 1]);
    if (!city && parts.length >= 3 && /^\d{5}(?:-\d{4})?$/.test(parts.at(-1))) {
      const possibleState = parts.at(-2);
      if (/^(?:TX|Texas)$/i.test(possibleState)) city = normalizeServiceCity(parts.at(-3));
    }
  }

  if (!state && zip && isTexasZip(zip)) state = 'TX';

  return {
    city,
    state,
    zip,
  };
}

export function isTexasZip(value) {
  const zip = normalizeServiceZip(value);
  if (!zip) return false;
  const number = Number(zip);
  return zip === '73301'
    || zip === '73344'
    || (number >= 75001 && number <= 79999)
    || (number >= 88510 && number <= 88595);
}

export function isMissingServiceLocationColumn(error) {
  const message = String(error?.message || error || '');
  return ['42703', 'PGRST204'].includes(error?.code)
    || /service_(?:city|state|zip)/i.test(message);
}
