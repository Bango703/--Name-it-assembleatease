import { getSupabase } from './_supabase.js';
import { rateLimit } from './_ratelimit.js';
import { WEBSITE_PHOTO_BUCKET, WEBSITE_PHOTO_LIMIT, isWebsiteService } from './_website-photos.js';

/**
 * GET /api/job-photos?service=tv-mounting&city=plano
 *
 * Public. Returns published job photos for a service page: that city's jobs
 * first, then the newest from elsewhere, up to six. Only photos the owner
 * published (with the customer's permission) are ever returned, and only the
 * public copy's URL and its description: no booking, customer, or address.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const allowed = await rateLimit(ip, 'default').catch(() => true);
  if (!allowed) return res.status(429).json({ photos: [] });

  const service = String(req.query?.service || '');
  const city = String(req.query?.city || '').toLowerCase();
  if (!isWebsiteService(service)) return res.status(400).json({ photos: [] });
  const citySlug = /^[a-z0-9-]{2,40}$/.test(city) ? city : null;

  const sb = getSupabase();
  const { data, error } = await sb
    .from('booking_evidence')
    .select('id, website_public_path, website_alt, website_city_slug, website_published_at')
    .eq('website_service', service)
    .not('website_published_at', 'is', null)
    .order('website_published_at', { ascending: false })
    .limit(60);
  if (error) {
    // Before migration 118, or a database hiccup: the page keeps its own photos.
    return res.status(200).json({ photos: [] });
  }

  const rows = (data || []).filter(r => r.website_public_path);
  const local = citySlug ? rows.filter(r => r.website_city_slug === citySlug) : [];
  const rest = rows.filter(r => !local.includes(r));
  const chosen = [...local, ...rest].slice(0, WEBSITE_PHOTO_LIMIT);

  const photos = chosen.map(r => ({
    url: sb.storage.from(WEBSITE_PHOTO_BUCKET).getPublicUrl(r.website_public_path).data.publicUrl,
    alt: r.website_alt,
    local: Boolean(citySlug && r.website_city_slug === citySlug),
  }));

  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
  return res.status(200).json({ photos, localCount: local.length });
}
