/**
 * Browser configuration for Google Maps JavaScript API.
 *
 * Google Maps browser keys are intentionally delivered to the browser. The
 * key must be restricted in Google Cloud to the Maps JavaScript API and the
 * exact production/preview HTTP referrers.
 */

export const config = { runtime: 'nodejs' };

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!key) {
    return res.status(503).json({
      configured: false,
      error: 'Google Maps is not configured; trying the next map provider.',
      missing: ['GOOGLE_MAPS_API_KEY'],
    });
  }

  return res.status(200).json({
    configured: true,
    key,
  });
}
