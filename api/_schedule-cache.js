// Live JetInsight schedule for broker links.
//
// A short Firestore cache (and an in-process copy) keeps a broker poll from
// pulling the feed on every request. A cron refreshes the same cache and
// writes legs/{uid}. When a previously seen leg disappears it is kept as
// cancelled until the grace period ends.

import {
  DEFAULT_ICAL_URL,
  eventsToScheduleLegs,
  icalHostAllowed,
} from '../src/ical-parse.js';
import {
  SCHEDULE_CACHE_TTL_MS,
  legDocId,
  reconcileSchedule,
  retainRelevantLegs,
} from '../src/trip-itinerary.js';

const CACHE_COLLECTION = 'schedule-cache';
const CACHE_DOC = 'jetinsight';
const LEGS_COLLECTION = 'legs';

let memory = null;

export function clearScheduleMemory() {
  memory = null;
}

export function scheduleFeedUrl(env = process.env) {
  return env.ICAL_FEED_URL || DEFAULT_ICAL_URL;
}

export async function fetchIcalText(feedUrl, fetchImpl = fetch) {
  if (!icalHostAllowed(feedUrl)) {
    throw new Error(`iCal host not allowed`);
  }
  const response = await fetchImpl(feedUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'SkywayOps/1.0 (schedule cache)',
      Accept: 'text/calendar, text/plain, */*',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    throw new Error(`iCal upstream ${response.status}`);
  }
  const text = await response.text();
  if (!text || !text.includes('BEGIN:VCALENDAR')) {
    throw new Error('iCal feed was empty');
  }
  return text;
}

async function readManualLegs(db) {
  if (!db?.collection) return [];
  try {
    const snap = await db.collection('manual-trips').limit(500).get();
    if (!snap?.docs) return [];
    return snap.docs.map((doc) => {
      const data = typeof doc.data === 'function' ? (doc.data() || {}) : {};
      const info = data.info || {};
      return {
        uid: data.uid || doc.id,
        from: info.from || null,
        to: info.to || null,
        departure: data.start || null,
        arrival: data.end || null,
        tail: String(info.tail || '').toUpperCase(),
        category: info.category || 'REVENUE',
        legType: info.legType || info.category || 'REVENUE',
        broker: info.broker || info.customer || '',
        customer: info.customer || '',
        tripCode: info.tripCode || null,
        pic: info.pic || '',
        sic: info.sic || '',
        isFlight: info.isFlight !== false,
        aircraftType: info.aircraftType || null,
        manual: true,
        cancelled: false,
        cancelledAt: null,
      };
    }).filter((leg) => leg.uid);
  } catch {
    return [];
  }
}

async function writeLegDocs(db, legs, now) {
  if (!db?.collection) return;
  const slice = legs.slice(0, 800);
  const chunkSize = 50;
  for (let i = 0; i < slice.length; i += chunkSize) {
    const chunk = slice.slice(i, i + chunkSize);
    await Promise.all(chunk.map((leg) => db.collection(LEGS_COLLECTION).doc(legDocId(leg.uid)).set({
      ...leg,
      updatedAt: now,
    }, { merge: true })));
  }
}

/**
 * @param {{ db: any, fetchImpl?: Function, now?: number, feedUrl?: string, force?: boolean }} opts
 * @returns {Promise<{ legs: object[], fetchedAt: number, source: string }>}
 */
export async function loadLiveSchedule(opts = {}) {
  const db = opts.db;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const feedUrl = opts.feedUrl || scheduleFeedUrl();
  const fetchImpl = opts.fetchImpl || fetch;
  const force = opts.force === true;

  if (!force && memory && Array.isArray(memory.legs) && (now - memory.fetchedAt) < SCHEDULE_CACHE_TTL_MS) {
    return { ...memory, source: 'memory' };
  }

  const cacheRef = db?.collection?.(CACHE_COLLECTION)?.doc?.(CACHE_DOC) || null;
  let cachedLegs = [];
  let cachedAt = 0;
  if (cacheRef) {
    try {
      const snap = await cacheRef.get();
      const data = snap?.exists ? (snap.data() || {}) : null;
      if (data && Array.isArray(data.legs)) {
        cachedLegs = data.legs;
        cachedAt = Number.isFinite(data.fetchedAt) ? data.fetchedAt : 0;
        if (!force && cachedAt && (now - cachedAt) < SCHEDULE_CACHE_TTL_MS) {
          memory = { legs: cachedLegs, fetchedAt: cachedAt, source: 'firestore' };
          return memory;
        }
      }
    } catch (error) {
      console.warn('[schedule] cache read failed:', error?.message || error);
    }
  }

  let text;
  try {
    text = await fetchIcalText(feedUrl, fetchImpl);
  } catch (error) {
    if (cachedLegs.length) {
      console.warn('[schedule] feed refresh failed, using last cache:', error?.message || error);
      memory = { legs: cachedLegs, fetchedAt: cachedAt || now, source: 'stale' };
      return memory;
    }
    throw error;
  }
  const live = eventsToScheduleLegs(text, now);
  const previous = cachedLegs;
  const manual = await readManualLegs(db);
  const reconciled = reconcileSchedule(previous, [...live, ...manual], now);
  const legs = retainRelevantLegs(reconciled, now);
  memory = { legs, fetchedAt: now, source: 'feed' };

  if (cacheRef) {
    try {
      await cacheRef.set({ fetchedAt: now, feedUrl, legs });
      await writeLegDocs(db, legs, now);
    } catch (error) {
      console.warn('[schedule] cache write failed:', error?.message || error);
    }
  }
  return memory;
}
