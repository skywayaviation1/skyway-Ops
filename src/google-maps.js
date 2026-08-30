/**
 * Lazy Google Maps JavaScript API loader.
 *
 * The API key is fetched at runtime so deployments can use different
 * referrer-restricted keys without compiling credentials into the bundle.
 */

let googleMapsPromise = null;
const authFailureListeners = new Set();
let authFailed = false;

async function fetchConfig() {
  const response = await fetch('/api/google-maps-config', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.key) {
    const error = new Error(data.error || `Google Maps configuration returned ${response.status}`);
    error.code = response.status === 503 ? 'google_maps_not_configured' : 'google_maps_config_failed';
    throw error;
  }
  return data;
}

function installAuthFailureHandler() {
  if (window.__skywayGoogleAuthHandlerInstalled) return;
  const previous = window.gm_authFailure;
  window.gm_authFailure = () => {
    authFailed = true;
    if (typeof previous === 'function') {
      try { previous(); } catch { /* another integration's handler failed */ }
    }
    authFailureListeners.forEach((listener) => {
      try { listener(); } catch { /* one listener must not block the others */ }
    });
  };
  window.__skywayGoogleAuthHandlerInstalled = true;
}

function loadScript(key) {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  return new Promise((resolve, reject) => {
    const callback = `__skywayGoogleMapsReady_${Date.now()}`;
    const script = document.createElement('script');
    const cleanup = () => { try { delete window[callback]; } catch { window[callback] = undefined; } };
    window[callback] = () => {
      cleanup();
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error('Google Maps JavaScript API did not initialize'));
    };
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${callback}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      cleanup();
      reject(new Error('Google Maps JavaScript API could not be loaded'));
    };
    document.head.appendChild(script);
  });
}

export function loadGoogleMaps() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = (async () => {
    installAuthFailureHandler();
    const { key } = await fetchConfig();
    return loadScript(key);
  })().catch((error) => {
    googleMapsPromise = null;
    throw error;
  });
  return googleMapsPromise;
}

export function onGoogleMapsAuthFailure(listener) {
  authFailureListeners.add(listener);
  if (authFailed) queueMicrotask(listener);
  return () => authFailureListeners.delete(listener);
}

export function googleMapType(basemap) {
  if (basemap === 'satellite') return 'satellite';
  if (basemap === 'terrain') return 'hybrid';
  return 'roadmap';
}

export const GOOGLE_BASEMAP_LABELS = Object.freeze({
  dark: 'Google Roadmap',
  satellite: 'Google Satellite',
  terrain: 'Google Hybrid',
});

export const GOOGLE_DARK_STYLES = Object.freeze([
  { elementType: 'geometry', stylers: [{ color: '#17202b' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#17202b' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9ca3af' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#263341' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#07111d' }] },
]);
