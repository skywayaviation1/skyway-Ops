// Public white-label operations wall.
//
// GET /api/white-label-board?token=...
//
// The token is the only credential. The response is display data for that
// one board: company name, accent, whether a logo exists, today's trips
// parsed from that board's feed, and FlightAware positions already stored
// by the fleet cron for those tails. It does not call AeroAPI. The feed
// URL, other boards, and Skyway trip documents are not included.

import {
  BOARD_CACHE_COLLECTION,
  BOARD_COLLECTION,
  cacheIsFresh,
  isPublicToken,
  loadBoardSchedule,
  metarFromNoaa,
  publicBoardResponse,
  sanitizePosition,
  weatherAirportsFromTrips,
} from '../src/white-label-board.js';
import { whiteLabelDb } from './_white-label.js';

export const config = { runtime: 'nodejs' };

const memory = new Map();

export function clearWhiteLabelMemory() {
  memory.clear();
}

async function findEnabledBoard(db, token) {
  if (!isPublicToken(token)) return null;
  const snap = await db.collection(BOARD_COLLECTION).where('publicToken', '==', token).limit(2).get();
  if (!snap || snap.empty || snap.size !== 1) return null;
  const doc = snap.docs[0];
  const data = doc.data() || {};
  if (data.enabled === false) return null;
  if (!data.companyName || !data.feedUrl) return null;
  return { id: doc.id, data };
}

async function readPositions(db, tails) {
  const positions = {};
  await Promise.all((tails || []).map(async (tail) => {
    try {
      const snap = await db.collection('flightaware-state').doc(tail).get();
      if (!snap.exists) return;
      const clean = sanitizePosition(snap.data() || {});
      if (clean) positions[tail] = clean;
    } catch (error) {
      console.warn('[white-label] position read failed', tail, error?.message || error);
    }
  }));
  return positions;
}

export async function fetchBoardWeather(icaos, fetchImpl = fetch) {
  const weather = {};
  await Promise.all((icaos || []).slice(0, 30).map(async (icao) => {
    try {
      const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&hours=2`;
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'SkywayOps/1.0 (white-label board)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return;
      const body = await response.json();
      const metar = metarFromNoaa(Array.isArray(body) ? body[0] : null);
      if (metar) weather[icao] = { metar };
    } catch {
      // Weather is decorative. A missed METAR still leaves the wall up.
    }
  }));
  return weather;
}

export async function servePublicBoard({ db, token, fetchImpl = fetch, resolveHost, now = Date.now() }) {
  const board = await findEnabledBoard(db, token);
  if (!board) return { status: 404, body: { ok: false } };

  const cacheRef = db.collection(BOARD_CACHE_COLLECTION).doc(board.id);
  let cached = null;
  const remembered = memory.get(board.id);
  const sameVersion = (entry) => !!entry && (entry.boardUpdatedAt || null) === (board.data.updatedAt || null);
  if (sameVersion(remembered) && cacheIsFresh(remembered.fetchedAt, now)) {
    cached = remembered;
  } else {
    try {
      const snap = await cacheRef.get();
      if (snap.exists && sameVersion(snap.data() || null)) cached = snap.data() || null;
    } catch (error) {
      console.warn('[white-label] cache read failed', board.id, error?.message || error);
    }
  }

  const loaded = await loadBoardSchedule({
    feedUrl: board.data.feedUrl,
    cached,
    now,
    fetchImpl,
    resolveHost,
    loadWeather: (icaos) => fetchBoardWeather(icaos.length ? icaos : weatherAirportsFromTrips(cached?.trips || []), fetchImpl),
  });

  if (loaded.source === 'feed') {
    const stored = {
      fetchedAt: loaded.fetchedAt,
      trips: loaded.trips,
      weather: loaded.weather,
      boardUpdatedAt: board.data.updatedAt || null,
    };
    memory.set(board.id, stored);
    try { await cacheRef.set(stored); } catch (error) {
      console.warn('[white-label] cache write failed', board.id, error?.message || error);
    }
  } else if (loaded.source === 'cache' || loaded.source === 'stale') {
    memory.set(board.id, {
      fetchedAt: loaded.fetchedAt,
      trips: loaded.trips,
      weather: loaded.weather,
      boardUpdatedAt: board.data.updatedAt || null,
    });
  }

  const positions = await readPositions(db, (loaded.trips || []).map((trip) => trip.info?.tail).filter(Boolean));
  const body = publicBoardResponse({
    board: board.data,
    trips: loaded.trips,
    positions,
    weather: loaded.weather,
    fetchedAt: loaded.fetchedAt,
    now,
    stale: loaded.stale,
    unavailable: loaded.unavailable,
  });
  console.info(`[white-label] public board=${board.id} source=${loaded.source}`);
  return { status: 200, body };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ ok: false });
    return;
  }
  try {
    const token = String(req.query?.token || '');
    const result = await servePublicBoard({ db: whiteLabelDb(), token });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[white-label] public failed', error?.message || error);
    res.status(500).json({ ok: false });
  }
}
