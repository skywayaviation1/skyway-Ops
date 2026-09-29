/**
 * Decisions shared by the MapKit token client and the basemap fallback.
 * Kept free of React and Capacitor so the rules can be unit tested.
 */

export const APPLE_BASEMAP_TIMEOUT_MS = 7000;

/** Fired by MapKit JS after the base map has actually painted. */
export const MAPKIT_TILE_MEASURES = Object.freeze([
  'mapkit-map-base-map-loaded',
  'mapkit-map-base-map-rendered',
]);

const NATIVE_TOKEN_PATH = '/api/apple-mapkit-token';

/**
 * Native shells must call the absolute production API. The origin query is
 * what the token endpoint trusts: CapacitorHttp's proxied GET often arrives
 * with the production Host and no Origin header.
 */
export function mapKitTokenUrl({ native = false, pageOrigin = '', apiBase = '' } = {}) {
  if (!native) return NATIVE_TOKEN_PATH;
  const base = String(apiBase || 'https://www.skyway.app').replace(/\/+$/, '');
  const url = new URL(`${base}${NATIVE_TOKEN_PATH}`);
  if (pageOrigin) url.searchParams.set('origin', pageOrigin);
  url.searchParams.set('platform', 'native');
  return url.toString();
}

export function isMapKitAssetUrl(input) {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const url = new URL(raw, 'https://localhost');
    const host = url.hostname.toLowerCase();
    return host === 'cdn.apple-mapkit.com' || host.endsWith('.apple-mapkit.com');
  } catch {
    return false;
  }
}

function requestUrl(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  if (typeof input.url === 'string') return input.url;
  return '';
}

/**
 * Whether the Apple layer may be shown.
 * `fallback` hides it. `wait` keeps the standard tiles in front.
 * A configuration event alone is not enough when tile measures can be
 * observed: MapKit paints its cream grid before (and without) tiles.
 */
export function nextAppleBasemapAction({
  authFailure = false,
  runtimeError = false,
  tilesLoaded = false,
  timedOut = false,
  configurationReady = false,
  canObserveTiles = true,
} = {}) {
  if (authFailure || runtimeError) return 'fallback';
  if (tilesLoaded) return 'apple';
  if (!timedOut) return 'wait';
  if (configurationReady && !canObserveTiles) return 'apple';
  return 'fallback';
}

/**
 * Watches a MapKit JS instance. Calls `onReady` only after tiles paint
 * (or, where tile measures cannot be observed, after bootstrap succeeds).
 * Calls `onFailure` on an auth/runtime error, including one that fired
 * before this watcher was attached, or when the timeout expires.
 * The error listener stays until `cancel` or failure so a later rejection
 * still leaves the standard map in front.
 */
export function watchAppleMapKit(mapkit, {
  timeoutMs = APPLE_BASEMAP_TIMEOUT_MS,
  onReady,
  onFailure,
} = {}) {
  let revealed = false;
  let failed = false;
  let configurationReady = false;
  let observer = null;
  let timer = null;
  const canObserveTiles = typeof PerformanceObserver === 'function';

  const finishFailure = (info) => {
    if (failed) return;
    failed = true;
    cleanup();
    if (onFailure) onFailure(info);
  };
  const finishReady = (info) => {
    if (failed || revealed) return;
    revealed = true;
    if (timer) clearTimeout(timer);
    if (observer) observer.disconnect();
    if (onReady) onReady(info);
  };

  const onError = (event) => finishFailure({
    reason: 'error',
    event,
    status: event?.status || '',
  });
  const onConfig = () => {
    configurationReady = true;
    const action = nextAppleBasemapAction({
      configurationReady: true,
      canObserveTiles,
    });
    if (action === 'apple') finishReady({ reason: 'configuration' });
  };

  if (mapkit && typeof mapkit.addEventListener === 'function') {
    mapkit.addEventListener('error', onError);
    mapkit.addEventListener('configuration-change', onConfig);
  }

  const watchStarted = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : 0;
  if (canObserveTiles) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          // startTime is the beginning of the measure, so a just-painted map
          // can start before this watcher. Accept it when the measure ends now.
          const endedAt = entry.startTime + (entry.duration || 0);
          if (MAPKIT_TILE_MEASURES.includes(entry.name) && endedAt >= watchStarted - 50) {
            finishReady({ reason: 'tiles', measure: entry.name });
            return;
          }
        }
      });
      observer.observe({ type: 'measure', buffered: true });
    } catch {
      observer = null;
    }
  }

  timer = setTimeout(() => {
    const action = nextAppleBasemapAction({
      timedOut: true,
      configurationReady,
      canObserveTiles: Boolean(observer),
    });
    if (action === 'apple') finishReady({ reason: 'configuration' });
    else finishFailure({ reason: 'timeout', configurationReady });
  }, timeoutMs);

  if (mapkit?.__skywayAuthFailure) {
    finishFailure({ reason: 'error', event: mapkit.__skywayAuthFailure, status: 'stored' });
  }

  function cleanup() {
    clearTimeout(timer);
    if (observer) observer.disconnect();
    if (mapkit && typeof mapkit.removeEventListener === 'function') {
      mapkit.removeEventListener('error', onError);
      mapkit.removeEventListener('configuration-change', onConfig);
    }
  }

  return {
    cancel() {
      failed = true;
      cleanup();
    },
  };
}
