// Public year-to-date replay for the trade-show TV.
// GET /api/showcase-replay?token=<unguessable>
//
// Unknown and disabled tokens are not found. A hit is cached for 15 minutes.
// The JSON legs contain a tail only when Firestore has one, plus airport
// codes, coordinates, times, and block hours.

import {
  loadPublicShowcase,
  readShowcaseConfig,
  recordShowcaseMiss,
  requestToken,
  showcaseClientIp,
  showcaseDb,
  showcaseMissLimited,
  showcaseTokenMatches,
} from './_showcase.js';
import { isShowcaseToken, normalizeShowcaseToken } from '../src/showcase-replay.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

function notFound(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Not found' });
}

function tooMany(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '600');
  res.status(429).json({ error: 'Too many lookups' });
}

export async function handleShowcaseReplay(req, res, deps = {}) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'GET only' });
    return;
  }
  const token = normalizeShowcaseToken(requestToken(req));
  const ip = deps.ip || showcaseClientIp(req);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const misses = deps.misses;
  const deny = () => {
    if (showcaseMissLimited(ip, now, misses)) {
      tooMany(res);
      return;
    }
    recordShowcaseMiss(ip, now, misses);
    notFound(res);
  };
  if (!isShowcaseToken(token)) {
    deny();
    return;
  }
  try {
    const db = deps.db || showcaseDb();
    const saved = await readShowcaseConfig(db);
    if (!saved || saved.enabled !== true || !showcaseTokenMatches(saved.token, token)) {
      deny();
      return;
    }
    const { body } = await loadPublicShowcase({ ...deps, db, token });
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.status(200).json(body);
  } catch (error) {
    console.error('[showcase-replay]', error?.message || error);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Showcase replay is unavailable' });
  }
}

export default function handler(req, res) {
  return handleShowcaseReplay(req, res);
}
