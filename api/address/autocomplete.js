/**
 * GET /api/address/autocomplete?q=...
 * Server-side proxy for Geoapify address autocomplete.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Geoapify not configured' });
  }

  const q = String(req.query?.q || '').trim().slice(0, 120);
  if (q.length < 4) {
    return res.status(400).json({ error: 'Enter at least 4 characters' });
  }

  const params = new URLSearchParams({
    text: q,
    apiKey,
    limit: '6',
    lang: 'en',
    filter: 'rect:-106.65,25.84,-93.51,36.50',
    bias: 'proximity:-99.9018,31.9686',
  });

  try {
    const upstream = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: 'Address provider error' });
    }

    const data = await upstream.json();
    const suggestions = (data.features || [])
      .map(feature => normalizeGeoapifyFeature(feature))
      .filter(Boolean)
      .slice(0, 5);

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ provider: 'geoapify', suggestions });
  } catch (err) {
    console.error('[address/autocomplete] Geoapify lookup failed:', err?.message || err);
    return res.status(502).json({ error: 'Address lookup failed' });
  }
}

function normalizeGeoapifyFeature(feature) {
  const p = feature?.properties || {};
  const street = p.address_line1 || [p.housenumber, p.street || p.name].filter(Boolean).join(' ').trim();
  if (!street) return null;

  const city = p.city || p.town || p.village || p.suburb || p.county || '';
  const state = stateCode(p.state_code || p.state);
  const zip = String(p.postcode || '').slice(0, 5);
  const label = p.formatted || [street, city, state + (zip ? ` ${zip}` : '')].filter(Boolean).join(', ');

  return {
    street,
    city,
    state,
    zip,
    label,
    lat: p.lat || null,
    lon: p.lon || null,
  };
}

function stateCode(value) {
  const v = String(value || '').trim();
  if (!v) return 'TX';
  return v.toLowerCase() === 'texas' ? 'TX' : v.toUpperCase();
}
