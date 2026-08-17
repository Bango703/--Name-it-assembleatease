import { CUSTOMER_TERMS_VERSION, PRIVACY_NOTICE_VERSION } from './_legal-consent.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    customerTermsVersion: CUSTOMER_TERMS_VERSION,
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
  });
}
