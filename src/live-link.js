/**
 * App-wide Firestore link state.
 *
 * Listeners that fail, or that only ever deliver a cache snapshot, used to
 * leave the screen looking current (empty milestones, last-known roster).
 * This module turns those signals into one phase the shell can show:
 *   live | reconnecting | offline
 *
 * A cache snapshot during a normal connect is not shown immediately. The
 * server snapshot usually lands well inside the grace window. The banner
 * appears only when that window expires, a listener errors, or the device
 * itself is offline.
 */

export const LIVE_LINK_CACHE_GRACE_MS = 2500;

const listeners = new Set();

let networkOffline = false;
let listenerFailures = 0;
let lastServerAt = 0;
let lastCacheAt = 0;
let graceTimer = null;
let phase = 'live';

function visiblePhase(now) {
  if (networkOffline) return 'offline';
  if (listenerFailures > 0) return 'reconnecting';
  if (lastCacheAt > lastServerAt && now - lastCacheAt >= LIVE_LINK_CACHE_GRACE_MS) {
    return 'reconnecting';
  }
  return 'live';
}

function armGrace(now) {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  // Unit tests pass a synthetic clock. Arming a real timer against that clock
  // would flip the phase a moment later and race the next test.
  if (Math.abs(Date.now() - now) > 10_000) return;
  if (lastCacheAt > lastServerAt && !networkOffline && listenerFailures === 0) {
    const wait = LIVE_LINK_CACHE_GRACE_MS - (now - lastCacheAt);
    if (wait > 0) graceTimer = setTimeout(() => publish(Date.now()), wait);
  }
}

function publish(now = Date.now()) {
  const next = visiblePhase(now);
  armGrace(now);
  if (next === phase) return phase;
  phase = next;
  const snapshot = getLiveLink();
  listeners.forEach((cb) => {
    try { cb(snapshot); } catch (err) { console.error('[live-link] subscriber', err); }
  });
  return phase;
}

export function getLiveLink() {
  return { phase };
}

/** Recompute the phase at `now` without recording a new snapshot. */
export function refreshLiveLink(now = Date.now()) {
  publish(now);
  return getLiveLink();
}

export function subscribeLiveLink(cb) {
  listeners.add(cb);
  cb(getLiveLink());
  return () => listeners.delete(cb);
}

/** A listener delivered a snapshot. `metadata.fromCache` is the server bit. */
export function noteSnapshotMetadata(metadata, now = Date.now()) {
  if (!metadata || typeof metadata.fromCache !== 'boolean') return getLiveLink();
  if (metadata.fromCache) lastCacheAt = now;
  else lastServerAt = now;
  publish(now);
  return getLiveLink();
}

/**
 * A listener failed. Returns a function the caller must run on the next
 * server snapshot and on unsubscribe, so one trip screen can't stick the
 * banner up after the user leaves it.
 */
export function noteListenerFailure() {
  listenerFailures += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    listenerFailures = Math.max(0, listenerFailures - 1);
    publish();
  };
}

export function noteDeviceNetwork(connected, now = Date.now()) {
  const wasOffline = networkOffline;
  networkOffline = connected === false;
  if (wasOffline && !networkOffline) {
    // Back on the network. Keep the banner until a server snapshot lands
    // rather than flashing "live" over data fetched before the drop.
    lastCacheAt = now - LIVE_LINK_CACHE_GRACE_MS;
    lastServerAt = 0;
  }
  publish(now);
  return getLiveLink();
}

export function installLiveLinkNetworkListeners() {
  if (typeof window === 'undefined' || window.__skywayLiveLinkNet) return;
  window.__skywayLiveLinkNet = true;
  window.addEventListener('online', () => noteDeviceNetwork(true));
  window.addEventListener('offline', () => noteDeviceNetwork(false));
  window.addEventListener('skyway:native-network', (event) => {
    noteDeviceNetwork(event?.detail?.connected !== false);
  });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    noteDeviceNetwork(false);
  }
}

export function resetLiveLinkForTests() {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = null;
  networkOffline = false;
  listenerFailures = 0;
  lastServerAt = 0;
  lastCacheAt = 0;
  phase = 'live';
  listeners.clear();
}

if (typeof window !== 'undefined') installLiveLinkNetworkListeners();
