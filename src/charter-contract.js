// Signed charter contracts found in the charters inbox are attached to the
// trip, not only to the AOG coverage row. Matching and versioning live here
// so the scan, the ops "attach" action, and the tests share one decision.
//
// Trip id wins and selects every leg with that id. Otherwise the tail, the
// first-leg route, and the departure date all have to agree. The same PDF
// (same sha256) is not stored again. A different PDF replaces the current
// file and keeps the previous one as a version.

import { normalizeAirport } from './aog-recovery.js';
import { normalizeTripId } from './trip-id.js';

export const CONTRACT_DATE_WINDOW_MS = 36 * 60 * 60 * 1000;
export const CONTRACT_VERSION_LIMIT = 8;

export function shouldAttachCharterContract({ isCheckout, hasPdf } = {}) {
  return isCheckout === true && hasPdf === true;
}

export function contractGroupKey(tripId) {
  const safe = String(tripId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  return safe || 'unkeyed';
}

export function contractStoragePath(tripId) {
  return `trip-contracts/${contractGroupKey(tripId)}/charter-contract.pdf`;
}

export function contractVersionPath(tripId, fingerprint) {
  const safe = String(fingerprint || '').toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 64) || 'previous';
  return `trip-contracts/${contractGroupKey(tripId)}/versions/${safe}.pdf`;
}

export function contractSourceFrom({ messageId, receivedAt, sender } = {}) {
  return {
    messageId: String(messageId || '').slice(0, 400),
    receivedAt: String(receivedAt || '').slice(0, 40),
    sender: String(sender || '').trim().slice(0, 160),
  };
}

function tripCodeOf(trip) {
  return normalizeTripId(trip?.tripCode);
}

function sameId(left, right) {
  return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase() && String(left || '').trim() !== '';
}

function expandByTripCode(hits, trips) {
  const codes = new Set(hits.map((trip) => tripCodeOf(trip).toUpperCase()).filter(Boolean));
  const byId = new Map();
  for (const trip of hits) if (trip?.id) byId.set(trip.id, trip);
  if (codes.size === 0) return [...byId.values()];
  for (const trip of trips) {
    if (!trip?.id) continue;
    if (codes.has(tripCodeOf(trip).toUpperCase())) byId.set(trip.id, trip);
  }
  return [...byId.values()];
}

/**
 * Legs that should receive this contract.
 * Trip id matches every leg with that id or trip-sheet code.
 * The fallback requires tail, route, and a departure within 36 hours.
 * Competing trip ids stay unmatched so ops can choose.
 */
export function matchContractToTrips(parsed, trips) {
  const list = (Array.isArray(trips) ? trips : []).filter(Boolean);
  const wantedId = normalizeTripId(parsed?.tripId);
  if (wantedId) {
    const hits = list.filter((trip) => sameId(wantedId, tripCodeOf(trip)) || sameId(wantedId, normalizeTripId(trip.id)));
    if (hits.length > 0) {
      return { status: 'linked', via: 'trip-id', ambiguous: false, matches: expandByTripCode(hits, list) };
    }
  }

  const tail = String(parsed?.tail || '').trim().toUpperCase();
  const from = normalizeAirport(parsed?.routeFrom);
  const to = normalizeAirport(parsed?.routeTo);
  const departMs = parsed?.departDate ? Date.parse(`${parsed.departDate}T12:00:00Z`) : NaN;
  if (!tail || !from || !to || !Number.isFinite(departMs)) {
    return { status: 'unmatched', via: 'incomplete', ambiguous: false, matches: [] };
  }

  const hits = list.filter((trip) => {
    if (tail !== String(trip.tail || '').trim().toUpperCase()) return false;
    if (from !== normalizeAirport(trip.from) || to !== normalizeAirport(trip.to)) return false;
    const startMs = Date.parse(trip.start || '');
    return Number.isFinite(startMs) && Math.abs(startMs - departMs) <= CONTRACT_DATE_WINDOW_MS;
  });
  if (hits.length === 0) return { status: 'unmatched', via: 'tail-route-date', ambiguous: false, matches: [] };

  const identities = new Set(hits.map((trip) => String(trip.tripCode || trip.id || '').trim().toUpperCase()));
  if (identities.size > 1) {
    return { status: 'unmatched', via: 'tail-route-date', ambiguous: true, matches: hits };
  }
  return { status: 'linked', via: 'tail-route-date', ambiguous: false, matches: expandByTripCode(hits, list) };
}

function sourceOf(incoming) {
  return contractSourceFrom(incoming?.source || {});
}

/**
 * Same fingerprint: keep the current file and its original source email.
 * A new fingerprint: replace the current file and append the previous one
 * to `versions` (capped). `versionPath` is where the caller copies the old PDF.
 */
export function planContractWrite({ existing, incoming, versionPath } = {}) {
  const fingerprint = String(incoming?.fingerprint || '').trim().toLowerCase();
  if (!fingerprint) return { action: 'skip', contract: existing || null };

  const next = {
    filename: String(incoming.filename || 'charter-contract.pdf').slice(0, 180),
    path: incoming.path || '',
    url: incoming.url || '',
    fingerprint,
    sizeBytes: Number(incoming.sizeBytes) || 0,
    attachedAt: incoming.attachedAt || '',
    source: sourceOf(incoming),
    versions: Array.isArray(existing?.versions) ? existing.versions.slice(-CONTRACT_VERSION_LIMIT) : [],
  };

  if (existing?.fingerprint && String(existing.fingerprint).toLowerCase() === fingerprint) {
    return { action: 'unchanged', contract: existing };
  }

  if (!existing?.fingerprint) {
    return { action: 'attached', contract: { ...next, versions: [] } };
  }

  const previous = {
    fingerprint: existing.fingerprint,
    path: versionPath || '',
    filename: existing.filename || 'charter-contract.pdf',
    attachedAt: existing.attachedAt || '',
    source: existing.source || null,
    replacedAt: incoming.attachedAt || '',
    preserved: Boolean(versionPath),
  };
  return {
    action: 'replaced',
    contract: {
      ...next,
      versions: [...(existing.versions || []), previous].slice(-CONTRACT_VERSION_LIMIT),
    },
    previous,
  };
}

export function contractIsOnTrip(status) {
  return status === 'attached' || status === 'replaced' || status === 'unchanged';
}

export function isUnmatchedContract(record) {
  if (!record?.charterContractPath) return false;
  return !contractIsOnTrip(record.contractAttachStatus);
}
