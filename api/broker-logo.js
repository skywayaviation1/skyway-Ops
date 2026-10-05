// /api/broker-logo.js
//
// Streams a broker logo. Two callers:
//   GET ?token=     public tracking page (trip token is checked again)
//   GET ?email=     ops preview (Firebase id token, ops or admin)
//
// Storage itself is not world-readable. This route is the only way out.

import { authorizeOps, brokerIdForTrip, loadTripForPublicToken, readLogoForBroker } from './_broker-brand-store.js';
import { brokerDocId } from '../src/broker-brand.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }

  try {
    const token = String(req.query?.token || '');
    const email = String(req.query?.email || '');
    let brokerId = null;
    let cache = 'private, max-age=300';

    if (token) {
      const trip = await loadTripForPublicToken(token);
      if (trip.error) return res.status(trip.error.code).json({ ok: false, reason: trip.error.reason });
      brokerId = await brokerIdForTrip(trip.data);
    } else if (email) {
      const auth = await authorizeOps(req, {});
      if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
      brokerId = brokerDocId(email);
      cache = 'private, no-store';
    } else {
      return res.status(400).json({ ok: false, error: 'token or email required' });
    }

    if (!brokerId) return res.status(404).json({ ok: false, error: 'No logo' });
    const logo = await readLogoForBroker(brokerId);
    if (!logo) return res.status(404).json({ ok: false, error: 'No logo' });

    res.setHeader('Content-Type', logo.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(logo.bytes.length));
    res.setHeader('Cache-Control', cache);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).send(logo.bytes);
  } catch (e) {
    console.error('[broker-logo]', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Logo unavailable' });
  }
}
