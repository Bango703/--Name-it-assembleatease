async function get(path) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    throw new Error('Request failed: ' + res.statusText);
  }
  return res.json();
}

window.initAssembler = async function (selector = '[data-assembler]') {
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
};
