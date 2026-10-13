// Live broker itinerary.
//
// A tracking link stores a selection rule (which trip, which legs the operator
// pinned or excluded, whether passengers are visible). The page is rebuilt
// from the current schedule on every read. Times, airports, tails, and which
// legs exist come from that schedule, not from whatever the browser sent when
// the link was created.

import { normalizeAirport } from './crew-day.js';

export const SHARE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const CANCEL_GRACE_MS = 24 * 60 * 60 * 1000;
export const SCHEDULE_CACHE_TTL_MS = 3 * 60 * 1000;
export const LINK_EXPIRE_AFTER_LANDING_MS = 24 * 60 * 60 * 1000;
export const TRIP_CHANGED_REASON = 'Trip changed — contact your broker';

const CHAIN_GAP_MS = 30 * 60 * 60 * 1000;
const POST_REPO_GAP_MS = 12 * 60 * 60 * 1000;

export function legDocId(uid) {
  return String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

export function legStartMs(leg) {
  const raw = leg?.departure || leg?.start || null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export function brokersMatchFuzzy(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length < 5) return false;
  return longer.includes(shorter);
}

function brokerOf(leg) {
  return String(leg?.broker || leg?.customer || '').trim().toLowerCase();
}

function isRepoLeg(leg) {
  const lt = String(leg?.legType || '').toUpperCase();
  const cat = String(leg?.category || '').toUpperCase();
  return ['REPO', 'DEADHEAD', 'FERRY'].includes(lt) || ['REPO', 'DEADHEAD', 'FERRY'].includes(cat);
}

function sameAirport(a, b) {
  const left = normalizeAirport(a);
  const right = normalizeAirport(b);
  return Boolean(left && right && left === right);
}

export function isShareEligible(leg) {
  if (!leg || leg.cancelled) return false;
  if (leg.isFlight === false) return false;
  const rawCat = String(leg.category || '').toUpperCase();
  if (['HOLD', 'MX', 'TRAINING'].includes(rawCat)) return false;
  if (leg.from && leg.to && sameAirport(leg.from, leg.to)) return false;
  return legStartMs(leg) != null;
}

function withinWindow(leg, centerMs, windowMs) {
  const ms = legStartMs(leg);
  return ms != null && Math.abs(ms - centerMs) <= windowMs;
}

export function cancelledStillVisible(leg, now) {
  if (!leg?.cancelled) return true;
  const at = Number(leg.cancelledAt);
  if (!Number.isFinite(at)) return false;
  return now - at <= CANCEL_GRACE_MS;
}

/**
 * Feed legs replace anything with the same uid. A uid that was on the previous
 * schedule and is gone becomes cancelled, and stays visible through the grace
 * period. `sticky` legs (manual trips) are part of the live set, so dropping
 * them from the iCal feed does not cancel them.
 */
export function reconcileSchedule(previousLegs, liveLegs, now = Date.now()) {
  const liveByUid = new Map();
  for (const leg of liveLegs || []) {
    if (!leg?.uid) continue;
    liveByUid.set(leg.uid, {
      ...leg,
      cancelled: false,
      cancelledAt: null,
      lastSeenAt: now,
    });
  }
  const out = [];
  for (const leg of liveByUid.values()) out.push(leg);
  for (const prev of previousLegs || []) {
    if (!prev?.uid || liveByUid.has(prev.uid)) continue;
    if (prev.isFlight === false) continue;
    const rawCat = String(prev.category || '').toUpperCase();
    if (['HOLD', 'MX', 'TRAINING'].includes(rawCat)) continue;
    const cancelledAt = Number.isFinite(prev.cancelledAt) ? prev.cancelledAt : now;
    if (now - cancelledAt > CANCEL_GRACE_MS) continue;
    out.push({
      ...prev,
      cancelled: true,
      cancelledAt,
      lastSeenAt: prev.lastSeenAt || cancelledAt,
    });
  }
  return out;
}

/** Keep the cache document small: near-term legs plus cancellations still in grace. */
export function retainRelevantLegs(legs, now = Date.now()) {
  const past = 3 * 24 * 60 * 60 * 1000;
  const future = 21 * 24 * 60 * 60 * 1000;
  return (legs || []).filter((leg) => {
    if (leg?.cancelled) return cancelledStillVisible(leg, now);
    const ms = legStartMs(leg);
    if (ms == null) return false;
    return ms >= now - past && ms <= now + future;
  });
}

function cleanUidList(list, limit = 40) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const uid = String(item || '').trim().slice(0, 200);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
    if (out.length >= limit) break;
  }
  return out;
}

export function sanitizeShareSelection(raw, tripId) {
  const anchorUid = String(tripId || raw?.anchorUid || '').trim().slice(0, 200);
  if (!anchorUid) return null;
  const source = raw && typeof raw === 'object' ? raw : {};
  let pinned = cleanUidList(source.pinnedLegUids);
  if (!pinned.includes(anchorUid)) pinned = [anchorUid, ...pinned].slice(0, 40);
  const pinnedSet = new Set(pinned);
  const excluded = cleanUidList(source.excludedLegUids).filter((uid) => !pinnedSet.has(uid));
  const showPaxByLeg = {};
  if (source.showPaxByLeg && typeof source.showPaxByLeg === 'object') {
    for (const [key, value] of Object.entries(source.showPaxByLeg).slice(0, 40)) {
      const uid = String(key || '').trim().slice(0, 200);
      if (uid) showPaxByLeg[uid] = value === true;
    }
  }
  const windowMs = Number(source.windowMs);
  const anchorStart = typeof source.anchorStart === 'string' ? source.anchorStart.slice(0, 40) : null;
  return {
    anchorUid,
    tripCode: source.tripCode ? String(source.tripCode).trim().toUpperCase().slice(0, 16) : null,
    broker: source.broker ? String(source.broker).trim().slice(0, 120) : null,
    tail: source.tail ? String(source.tail).trim().toUpperCase().slice(0, 16) : null,
    windowMs: Number.isFinite(windowMs)
      ? Math.min(Math.max(windowMs, 60 * 60 * 1000), 7 * 24 * 60 * 60 * 1000)
      : SHARE_WINDOW_MS,
    anchorStart: anchorStart && !Number.isNaN(Date.parse(anchorStart)) ? new Date(Date.parse(anchorStart)).toISOString() : null,
    pinnedLegUids: pinned,
    excludedLegUids: excluded,
    showPax: source.showPax !== false,
    showPaxByLeg,
    theme: source.theme === 'classic' ? 'classic' : 'premium',
    brokerEmail: source.brokerEmail ? String(source.brokerEmail).trim().slice(0, 200) : null,
  };
}

/**
 * Old links stored a browser snapshot and no selection rule. Derive the rule
 * from that snapshot so the next read can try the live feed. The snapshot
 * itself stays on the document for the empty-feed fallback.
 */
export function deriveShareRule(data, tripId) {
  const existing = data?.shareRule;
  if (existing && typeof existing === 'object' && (existing.anchorUid || existing.tripCode || existing.tail || existing.pinnedLegUids)) {
    return {
      rule: sanitizeShareSelection(existing, existing.anchorUid || tripId),
      backfill: false,
      hadSnapshot: Array.isArray(data?.publicTripData?.legs) && data.publicTripData.legs.length > 0,
    };
  }
  const snapLegs = Array.isArray(data?.publicTripData?.legs) ? data.publicTripData.legs : [];
  const showPaxByLeg = {};
  const pinned = [];
  for (const leg of snapLegs) {
    if (!leg?.tripId) continue;
    const uid = String(leg.tripId);
    pinned.push(uid);
    showPaxByLeg[uid] = leg.showPax === true;
  }
  const starts = snapLegs.map((leg) => Date.parse(leg?.departure)).filter((n) => Number.isFinite(n));
  const rule = sanitizeShareSelection({
    tripCode: data?.tripCode || data?.tripMeta?.tripCode || null,
    broker: data?.brokerEmail || null,
    tail: data?.publicTripData?.tail || data?.tail || data?.tripMeta?.tail || null,
    windowMs: SHARE_WINDOW_MS,
    anchorStart: starts.length ? new Date(Math.min(...starts)).toISOString() : (data?.tripMeta?.start || null),
    pinnedLegUids: pinned,
    excludedLegUids: [],
    showPax: snapLegs.length ? snapLegs.some((leg) => leg?.showPax === true) : true,
    showPaxByLeg,
    theme: data?.shareTheme === 'classic' ? 'classic' : 'premium',
    brokerEmail: data?.brokerEmail || (typeof data?.lastSharedTo === 'string' ? data.lastSharedTo.split(',')[0].trim() : null),
  }, tripId);
  return { rule, backfill: true, hadSnapshot: snapLegs.length > 0 };
}

export function linkPatchFromRequest({ existing, tripId, rotate, shareSelection, now }) {
  const reuse = !rotate
    && typeof existing?.linkTokenIssuedAt === 'number'
    && existing?.linkRevoked !== true;
  const issuedAt = reuse ? existing.linkTokenIssuedAt : now;
  const patch = {};
  if (!reuse) {
    patch.linkTokenIssuedAt = issuedAt;
    patch.linkRevoked = false;
    patch.linkUpdatedAt = now;
  }
  const selection = shareSelection ? sanitizeShareSelection(shareSelection, tripId) : null;
  if (selection) patch.shareRule = selection;
  return { patch, issuedAt, reused: reuse, shareRule: selection || existing?.shareRule || null };
}

export function evaluateLinkAccess(data, verified, now, lastLandedAt) {
  if (!data) return { ok: false, code: 404, reason: 'trip not found' };
  if (data.linkRevoked === true) return { ok: false, code: 403, reason: 'link revoked' };
  if (typeof data.linkTokenIssuedAt === 'number' && verified?.issuedAt < data.linkTokenIssuedAt) {
    return { ok: false, code: 403, reason: 'link rotated' };
  }
  if (Number.isFinite(lastLandedAt) && (now - lastLandedAt) > LINK_EXPIRE_AFTER_LANDING_MS) {
    return { ok: false, code: 410, reason: 'link expired after trip completion' };
  }
  return { ok: true };
}

/** Subject line fields. The stored snapshot is not a source. */
export function trackingSubjectMeta(linkDoc, selection) {
  const rule = selection || linkDoc?.shareRule || {};
  return {
    tripCode: rule.tripCode || linkDoc?.tripCode || linkDoc?.tripMeta?.tripCode || null,
    tail: rule.tail || linkDoc?.tail || linkDoc?.tripMeta?.tail || null,
  };
}

export function trackingUrl(origin, token) {
  const base = String(origin || '').replace(/\/+$/, '');
  return `${base}/trip-track.html?token=${encodeURIComponent(token)}`;
}

function showPaxFor(rule, leg, fallback) {
  const map = rule?.showPaxByLeg;
  if (map && Object.prototype.hasOwnProperty.call(map, leg.uid)) return map[leg.uid] === true;
  if (rule?.showPax === false) return false;
  return fallback === true;
}

function chainUids(ordered, anchor, anchorIdx) {
  const anchorBroker = brokerOf(anchor);
  const chain = new Set([anchor.uid]);
  const continues = (other, expectedAirport, direction) => {
    const otherBroker = brokerOf(other);
    const brokerOk = !!anchorBroker && (
      otherBroker === anchorBroker
      || (otherBroker && brokersMatchFuzzy(otherBroker, anchorBroker))
    );
    const otherEdge = direction === 'back' ? other.to : other.from;
    const airportOk = sameAirport(otherEdge, expectedAirport);
    return brokerOk || (airportOk && (!otherBroker || isRepoLeg(other)));
  };
  {
    let expected = anchor.from;
    for (let i = anchorIdx - 1; i >= 0; i -= 1) {
      const prev = ordered[i];
      if (!continues(prev, expected, 'back')) break;
      chain.add(prev.uid);
      expected = prev.from;
    }
  }
  {
    let expected = anchor.to;
    for (let i = anchorIdx + 1; i < ordered.length; i += 1) {
      const next = ordered[i];
      if (!continues(next, expected, 'fwd')) break;
      chain.add(next.uid);
      expected = next.to;
    }
  }
  return chain;
}

/**
 * Rebuild the broker itinerary from live legs.
 * Returns { tripChanged, reason, legs, anchorUid, promotedFrom }.
 * `legs` is empty when nothing matched (caller may fall back to a legacy snapshot).
 * `tripChanged` is set when the anchor was cancelled and no later leg of the
 * same trip code is left to fly.
 */
export function assembleLiveItinerary(scheduleLegs, rule, now = Date.now()) {
  const selection = sanitizeShareSelection(rule, rule?.anchorUid);
  if (!selection) return { tripChanged: false, legs: [], anchorUid: null, promotedFrom: null };

  const byUid = new Map();
  for (const leg of scheduleLegs || []) {
    if (leg?.uid) byUid.set(leg.uid, leg);
  }
  const excluded = new Set(selection.excludedLegUids || []);
  const pinned = new Set(selection.pinnedLegUids || []);
  const code = String(selection.tripCode || '').toUpperCase();

  let anchor = byUid.get(selection.anchorUid) || null;
  const anchorWasCancelled = Boolean(anchor?.cancelled);
  const anchorMissing = !anchor;
  let promotedFrom = null;

  if (!anchor || anchor.cancelled) {
    const floor = anchor ? (legStartMs(anchor) || 0) : (Date.parse(selection.anchorStart || '') || 0);
    const next = (scheduleLegs || [])
      .filter((leg) => leg && leg.uid !== selection.anchorUid && !leg.cancelled && isShareEligible(leg))
      .filter((leg) => code && String(leg.tripCode || '').toUpperCase() === code)
      .filter((leg) => {
        const ms = legStartMs(leg);
        return ms != null && ms >= floor;
      })
      .sort((a, b) => legStartMs(a) - legStartMs(b))[0];
    if (next) {
      promotedFrom = selection.anchorUid;
      anchor = next;
    } else if (anchorWasCancelled) {
      return { tripChanged: true, reason: TRIP_CHANGED_REASON, legs: [], anchorUid: selection.anchorUid, promotedFrom: null };
    } else if (anchorMissing) {
      return { tripChanged: false, legs: [], anchorUid: selection.anchorUid, promotedFrom: null };
    }
  }

  if (!anchor) {
    return { tripChanged: false, legs: [], anchorUid: selection.anchorUid, promotedFrom: null };
  }

  const center = legStartMs(anchor) || Date.parse(selection.anchorStart || '') || now;
  const windowMs = selection.windowMs || SHARE_WINDOW_MS;
  const tail = String(anchor.tail || selection.tail || '').toUpperCase();
  const anchorBroker = brokerOf(anchor) || String(selection.broker || '').trim().toLowerCase();

  const inWindow = (leg) => withinWindow(leg, center, windowMs);
  const sameCode = (leg) => {
    const legCode = String(leg?.tripCode || '').toUpperCase();
    return Boolean(code && legCode && legCode === code);
  };

  const pool = (scheduleLegs || [])
    .filter((leg) => leg?.uid && isShareEligible(leg))
    .filter((leg) => String(leg.tail || '').toUpperCase() === tail)
    .filter((leg) => inWindow(leg))
    .sort((a, b) => legStartMs(a) - legStartMs(b));

  if (!pool.some((leg) => leg.uid === anchor.uid) && isShareEligible(anchor)) {
    pool.push(anchor);
    pool.sort((a, b) => legStartMs(a) - legStartMs(b));
  }
  const anchorIdx = Math.max(0, pool.findIndex((leg) => leg.uid === anchor.uid));
  const chained = pool.length ? chainUids(pool, anchor, anchorIdx) : new Set([anchor.uid]);

  const included = new Map();
  const add = (leg, paxFallback) => {
    if (!leg?.uid) return;
    if (excluded.has(leg.uid) && leg.uid !== anchor.uid && leg.uid !== selection.anchorUid) return;
    if (leg.cancelled && !cancelledStillVisible(leg, now)) return;
    const showPax = showPaxFor(selection, leg, paxFallback);
    if (!included.has(leg.uid)) included.set(leg.uid, { leg, showPax });
  };

  add(anchor, true);

  for (const leg of scheduleLegs || []) {
    if (!sameCode(leg)) continue;
    if (leg.cancelled) {
      if (cancelledStillVisible(leg, now)) add(leg, false);
      continue;
    }
    if (!isShareEligible(leg)) continue;
    if (!inWindow(leg) && !pinned.has(leg.uid)) continue;
    add(leg, !isRepoLeg(leg));
  }

  for (const leg of pool) {
    if (leg.uid === anchor.uid) continue;
    if (!chained.has(leg.uid)) continue;
    const legBroker = brokerOf(leg);
    const brokerOk = anchorBroker && legBroker && (
      legBroker === anchorBroker || brokersMatchFuzzy(legBroker, anchorBroker)
    );
    if (brokerOk) add(leg, !isRepoLeg(leg));
    else if (!legBroker || isRepoLeg(leg)) add(leg, false);
  }

  for (const uid of pinned) {
    const leg = byUid.get(uid);
    if (!leg) continue;
    if (leg.cancelled && !cancelledStillVisible(leg, now)) continue;
    if (!leg.cancelled && !isShareEligible(leg)) continue;
    add(leg, uid === anchor.uid);
  }

  if (anchorWasCancelled) {
    const original = byUid.get(selection.anchorUid);
    if (original?.cancelled && cancelledStillVisible(original, now)) add(original, false);
  }

  const sorted = [...included.values()]
    .sort((a, b) => (legStartMs(a.leg) || 0) - (legStartMs(b.leg) || 0));

  const legs = sorted.map(({ leg, showPax }, index) => ({
    tripId: leg.uid,
    uid: leg.uid,
    legNumber: index + 1,
    from: leg.from || null,
    to: leg.to || null,
    fromFbo: leg.fromFbo || null,
    toFbo: leg.toFbo || null,
    departure: leg.departure || null,
    arrival: leg.arrival || null,
    category: leg.legType || leg.category || 'REVENUE',
    tail: leg.tail || null,
    picName: leg.pic || null,
    sicName: leg.sic || null,
    tripCode: leg.tripCode || null,
    showPax: showPax === true,
    cancelled: leg.cancelled === true,
    aircraftType: leg.aircraftType || null,
  }));

  return {
    tripChanged: false,
    reason: null,
    legs,
    anchorUid: anchor.uid,
    promotedFrom,
    tail: legs.find((leg) => !leg.cancelled)?.tail || anchor.tail || selection.tail || null,
  };
}

export function activeTail(legs) {
  const list = Array.isArray(legs) ? legs : [];
  const open = list.filter((leg) => !leg?.cancelled);
  const source = open.length ? open : list;
  const airborne = source.find((leg) => leg?.status?.wheels_up && !leg?.status?.landed);
  if (airborne?.tail) return airborne.tail;
  const upcoming = source.find((leg) => !leg?.status?.landed);
  return (upcoming || source[0])?.tail || null;
}

export function overlayLiveLegData(legs, liveById = {}) {
  return (legs || []).map((leg) => {
    const live = liveById[leg.tripId] || liveById[leg.uid] || {};
    const hasCatering = typeof live.hasCatering === 'boolean'
      ? live.hasCatering
      : leg.hasCatering !== false;
    return {
      ...leg,
      fromFbo: live.fromFbo || leg.fromFbo || null,
      toFbo: live.toFbo || leg.toFbo || null,
      hasCatering,
      status: live.statuses && typeof live.statuses === 'object' ? live.statuses : (leg.status || {}),
      pax: leg.showPax === true
        ? (Array.isArray(live.pax) ? live.pax : (Array.isArray(leg.pax) ? leg.pax : []))
        : [],
      tail: leg.tail || live.tail || null,
    };
  });
}

/** Expiry follows the live last leg that is still part of the trip, not the anchor snapshot. */
export function lastLegLandedAt(legs) {
  const open = (legs || []).filter((leg) => !leg?.cancelled);
  const last = (open.length ? open : (legs || []))[Math.max(0, (open.length ? open : legs).length - 1)];
  if (!last) return null;
  const at = last.status?.landed?.at;
  return Number.isFinite(at) ? at : null;
}

export function toPublicLeg(leg) {
  return {
    legNumber: leg.legNumber,
    tripId: leg.tripId || leg.uid || null,
    from: leg.from || null,
    to: leg.to || null,
    fromFbo: leg.fromFbo || null,
    toFbo: leg.toFbo || null,
    departure: leg.departure || null,
    arrival: leg.arrival || null,
    category: leg.category || 'REVENUE',
    tail: leg.tail || null,
    pic: leg.picName || leg.pic || null,
    sic: leg.sicName || leg.sic || null,
    pax: leg.showPax === true && Array.isArray(leg.pax) ? leg.pax : [],
    showPax: leg.showPax === true,
    hasCatering: leg.hasCatering !== false,
    status: leg.status && typeof leg.status === 'object' ? leg.status : {},
    cancelled: leg.cancelled === true,
  };
}

export function publicTripFromLegs(tripId, rule, legs) {
  const list = (legs || []).map(toPublicLeg);
  const tail = activeTail(list);
  const aircraftType = (legs || []).find((leg) => leg.aircraftType)?.aircraftType || null;
  return {
    tripId,
    tripCode: rule?.tripCode || (legs || []).find((leg) => leg.tripCode)?.tripCode || null,
    tail,
    aircraftType,
    legs: list,
    statuses: Object.fromEntries(list.map((leg) => [leg.legNumber, leg.status || {}])),
    anchorPromoted: false,
    itinerarySource: 'live',
  };
}
