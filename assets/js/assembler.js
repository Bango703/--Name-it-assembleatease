import { get } from './api.js';

// Small helper module for assembling UI pieces
export async function initAssembler(selector = '[data-assembler]') {
  const el = document.querySelector(selector);
  if (!el) return null;
  try {
    const payload = await get('/api/assembler');
    el.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return payload;
  } catch (err) {
    el.textContent = 'Failed to load content';
    throw err;
  }
}

export default initAssembler;
