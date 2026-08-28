/**
 * Lazy MapKit JS loader.
 *
 * The tracking pages are public/cold routes, so MapKit is loaded only when a
 * map mounts. A failed token or CDN request rejects and TrackingMap falls back
 * to its existing Leaflet basemap without losing aircraft or status data.
 */

const MAPKIT_JS_URL = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js';
let mapKitPromise = null;
let firstToken = null;

async function fetchToken() {
  const response = await fetch('/api/apple-mapkit-token', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    const error = new Error(data.error || `Apple Maps token returned ${response.status}`);
    error.code = response.status === 503 ? 'apple_maps_not_configured' : 'apple_maps_token_failed';
    throw error;
  }
  return data.token;
}

function loadScript() {
  if (window.mapkit) return Promise.resolve(window.mapkit);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MAPKIT_JS_URL;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.onload = () => (
      window.mapkit ? resolve(window.mapkit) : reject(new Error('MapKit JS did not initialize'))
    );
    script.onerror = () => reject(new Error('Apple MapKit JS could not be loaded'));
    document.head.appendChild(script);
  });
}

export function loadAppleMapKit() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (mapKitPromise) return mapKitPromise;

  mapKitPromise = (async () => {
    // Fail fast before downloading the SDK when Apple Maps is not configured.
    firstToken = await fetchToken();
    const mapkit = await loadScript();
    mapkit.init({
      authorizationCallback(done) {
        if (firstToken) {
          const token = firstToken;
          firstToken = null;
          done(token);
          return;
        }
        fetchToken().then(done).catch((error) => {
          console.warn('[apple-mapkit] token refresh failed:', error.message);
          done('');
        });
      },
      language: 'en',
      libraries: ['full-map'],
    });
    return mapkit;
  })().catch((error) => {
    // A later remount should be allowed to retry after deployment/configuration
    // changes without requiring a hard page reload.
    mapKitPromise = null;
    throw error;
  });
  return mapKitPromise;
}

export function appleMapType(mapkit, basemap) {
  const types = mapkit?.Map?.MapTypes || {};
  if (basemap === 'satellite') return types.Satellite || 'satellite';
  if (basemap === 'terrain') return types.Hybrid || 'hybrid';
  return types.MutedStandard || types.Standard || 'mutedStandard';
}

export const APPLE_BASEMAP_LABELS = Object.freeze({
  dark: 'Apple Standard',
  satellite: 'Apple Satellite',
  terrain: 'Apple Hybrid',
});

