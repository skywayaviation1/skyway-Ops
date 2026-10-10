import { Capacitor } from '@capacitor/core';
import { isMapKitAssetUrl } from './mapkit-fallback.js';
import { noteDeviceNetwork } from './live-link.js';
import { readNativePlatform } from './native-platform.js';
import { restoreWebViewXmlHttpRequest, shouldUseWebViewNetwork } from './native-http.js';

export const PRODUCTION_API_BASE = 'https://www.skyway.app';

const apiBase = resolveApiBase(import.meta.env?.VITE_API_BASE_URL);

/**
 * Native builds load bundled files from capacitor://localhost, while the
 * serverless API remains on the production web origin. Keep existing
 * `fetch('/api/...')` call sites working without coupling every feature to
 * Capacitor. CapacitorHttp handles the resulting cross-origin native request.
 *
 * Canonical production is www.skyway.app (the old skyway-ops.vercel.app
 * default from PR #7 is no longer the public host).
 *
 * The bypass also runs when Capacitor has already patched fetch/XHR, even if
 * an early `isNativePlatform()` read returned false. Otherwise Auth's calls
 * to identitytoolkit.googleapis.com and securetoken.googleapis.com stay on
 * the native proxy and fail as auth/network-request-failed.
 */
export function installNativeNetworkBypass(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || win.__skywayNativeFetch) return false;
  const httpPatched = typeof win.CapacitorWebFetch === 'function' || Boolean(win.CapacitorWebXMLHttpRequest);
  const native = readNativePlatform(win, () => Capacitor.isNativePlatform());
  if (!native && !httpPatched) return false;

  // Undo CapacitorHttp's XMLHttpRequest patch before Firestore or Auth opens
  // a channel. fetch stays patched below so /api calls still bypass CORS.
  restoreWebViewXmlHttpRequest(win);
  const patchedFetch = typeof win.fetch === 'function' ? win.fetch.bind(win) : null;
  // CapacitorHttp rewrites cross-origin GET through a native proxy that does
  // not send the WebView Origin. MapKit JS compares that header to the token,
  // so its bootstrap and tile fetches must stay on the WebView's own fetch.
  // Firestore, Auth, and the rest of *.googleapis.com have the same problem
  // for a different reason: the proxy buffers and re-decodes the listen URL,
  // which drops the named-database channel into offline mode and turns
  // identitytoolkit/securetoken posts into auth/network-request-failed.
  const webFetch = typeof win.CapacitorWebFetch === 'function'
    ? win.CapacitorWebFetch.bind(win)
    : null;
  // The bridge assigns CapacitorWebFetch and then replaces fetch in one
  // turn. If we latched the bypass in between, Auth would stay on the proxy.
  if (httpPatched && !webFetch) return false;
  if (patchedFetch && webFetch) {
    win.fetch = (input, init) => {
      const rewritten = rewriteApiRequest(input, apiBase);
      if (isMapKitAssetUrl(rewritten) || shouldUseWebViewNetwork(rewritten)) {
        return webFetch(rewritten, init);
      }
      return patchedFetch(rewritten, init);
    };
  }
  win.__skywayNativeFetch = true;
  return true;
}

installNativeNetworkBypass();
if (typeof window !== 'undefined') {
  // The bridge script is injected at document start. A second pass covers a
  // module that evaluated before that patch assigned CapacitorWebFetch.
  queueMicrotask(() => installNativeNetworkBypass());
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
  return readNativePlatform(
    typeof window !== 'undefined' ? window : undefined,
    () => Capacitor.isNativePlatform(),
  );
}

export function apiUrl(path) {
  return isNativeApp() && String(path || '').startsWith('/api/') ? `${apiBase}${path}` : path;
}

export async function initializeMobileRuntime() {
  if (!isNativeApp() || typeof document === 'undefined') return;

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
    noteDeviceNetwork(connected);
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
  if (!isNativeApp()) return;
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}
