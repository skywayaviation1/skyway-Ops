// Public year-to-date replay for the trade-show TV.
// GET /api/showcase-replay?token=<unguessable>
//
// Unknown and disabled tokens are not found. A hit is cached for 15 minutes.
// The JSON legs contain only tail, airport codes, coordinates, and times.

import {
  loadPublicShowcase,
  readShowcaseConfig,
  requestToken,
  showcaseDb,
  showcaseTokenMatches,
} from './_showcase.js';
import { isShowcaseToken } from '../src/showcase-replay.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

function notFound(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Not found' });
}

export async function handleShowcaseReplay(req, res, deps = {}) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'GET only' });
    return;
  }
  const token = requestToken(req);
  if (!isShowcaseToken(token)) {
    notFound(res);
    return;
  }
  try {
    const db = deps.db || showcaseDb();
    const saved = await readShowcaseConfig(db);
    if (!saved || saved.enabled !== true || !showcaseTokenMatches(saved.token, token)) {
      notFound(res);
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
