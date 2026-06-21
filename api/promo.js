import { getSupabase } from './_supabase.js';
import { getPublicPromotion, loadMarketingSettings } from './_promotions.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  try {
    const sb = getSupabase();
    const settings = await loadMarketingSettings(sb);
    const promo = getPublicPromotion(settings);
    return res.status(200).json({
      promo: promo
        ? {
            ...promo,
            enabled: true,
            setupNeeded: settings.setupNeeded === true,
            source: settings.source || 'database',
          }
        : null,
    });
  } catch (error) {
    console.error('Public promo load error:', error);
    return res.status(500).json({ error: 'Failed to load promo' });
  }
}
