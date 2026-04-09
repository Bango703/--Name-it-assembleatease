/* Lightweight API helper
 * Exports: get, post, put, del
 */
const baseUrl = window.API_BASE_URL || '/';

async function request(path, options = {}) {
  const url = new URL(path, baseUrl).toString();
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    const body = contentType.includes('application/json') ? await res.json() : await res.text();
    const err = new Error(res.statusText || 'Request failed');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (contentType.includes('application/json')) return await res.json();
  return await res.text();
}

export const get = (path) => request(path, { method: 'GET' });
export const post = (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) });
export const put = (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data) });
export const del = (path) => request(path, { method: 'DELETE' });
