// GET /api/hotel-status — whether Expedia Rapid is configured + agency hints.
import {
  rapidConfigured, requireUser, sendJson,
} from './_hotel-rapid.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  try {
    await requireUser(req);
    const live = rapidConfigured();
    return sendJson(res, 200, {
      ok: true,
      live,
      demo: !live,
      baseUrl: live ? (process.env.EXPEDIA_RAPID_BASE_URL || 'https://test.ean.com') : null,
      message: live
        ? 'Expedia Rapid credentials detected. Searches use live inventory and marketing fees.'
        : 'Expedia Rapid credentials are not configured. Shopping runs in demo mode with estimated commission from your IATA settings. Set EXPEDIA_RAPID_API_KEY + EXPEDIA_RAPID_SHARED_SECRET on Vercel to go live.',
    });
  } catch (e) {
    return sendJson(res, e.status || 500, { error: e.message || 'Status failed' });
  }
}
