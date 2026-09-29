import { Capacitor } from '@capacitor/core';
import { isMapKitAssetUrl } from './mapkit-fallback.js';

export const PRODUCTION_API_BASE = 'https://www.skyway.app';

const isNative = Capacitor.isNativePlatform();
const apiBase = resolveApiBase(import.meta.env?.VITE_API_BASE_URL);

/**
 * Native builds load bundled files from capacitor://localhost, while the
 * serverless API remains on the production web origin. Keep existing
 * `fetch('/api/...')` call sites working without coupling every feature to
 * Capacitor. CapacitorHttp handles the resulting cross-origin native request.
 *
 * Canonical production is www.skyway.app (the old skyway-ops.vercel.app
 * default from PR #7 is no longer the public host).
 */
if (isNative && typeof window !== 'undefined' && !window.__skywayNativeFetch) {
  const patchedFetch = window.fetch.bind(window);
  // CapacitorHttp rewrites cross-origin GET through a native proxy that does
  // not send the WebView Origin. MapKit JS compares that header to the token,
  // so its bootstrap and tile fetches must stay on the WebView's own fetch.
  const webFetch = typeof window.CapacitorWebFetch === 'function'
    ? window.CapacitorWebFetch.bind(window)
    : null;
  window.fetch = (input, init) => {
    if (webFetch && isMapKitAssetUrl(input)) return webFetch(input, init);
    return patchedFetch(rewriteApiRequest(input, apiBase), init);
  };
  window.__skywayNativeFetch = true;
}

export function resolveApiBase(envValue) {
  return String(envValue || PRODUCTION_API_BASE).replace(/\/+$/, '');
}

export function rewriteApiRequest(input, base = apiBase) {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    return `${base}${input}`;
  }
  if (typeof URL !== 'undefined' && input instanceof URL && input.pathname.startsWith('/api/')) {
    return new URL(`${input.pathname}${input.search}`, base);
  }
  return input;
}

export function isNativeApp() {
  return isNative;
}

export function apiUrl(path) {
  return isNative && String(path || '').startsWith('/api/') ? `${apiBase}${path}` : path;
}

export async function initializeMobileRuntime() {
  if (!isNative || typeof document === 'undefined') return;

  document.documentElement.dataset.native = Capacitor.getPlatform();

  const [{ App }, { Network }, { StatusBar, Style }] = await Promise.all([
    import('@capacitor/app'),
    import('@capacitor/network'),
    import('@capacitor/status-bar'),
  ]);

  await StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});

  const applyNetworkState = ({ connected }) => {
    document.documentElement.toggleAttribute('data-offline', !connected);
    window.dispatchEvent(new CustomEvent('skyway:native-network', {
      detail: { connected },
    }));
  };

  applyNetworkState(await Network.getStatus());
  await Network.addListener('networkStatusChange', applyNetworkState);
  await App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) window.dispatchEvent(new Event('skyway:native-resume'));
  });
}

export async function nativeImpact() {
  if (!isNative) return;
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}
