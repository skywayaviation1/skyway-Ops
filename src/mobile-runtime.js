import { Capacitor } from '@capacitor/core';

const isNative = Capacitor.isNativePlatform();
const apiBase = String(
  import.meta.env.VITE_API_BASE_URL || 'https://skyway-ops.vercel.app',
).replace(/\/+$/, '');

/**
 * Native builds load bundled files from capacitor://localhost, while the
 * serverless API remains on the production web origin. Keep existing
 * `fetch('/api/...')` call sites working without coupling every feature to
 * Capacitor. CapacitorHttp handles the resulting cross-origin native request.
 */
if (isNative && typeof window !== 'undefined' && !window.__skywayNativeFetch) {
  const browserFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return browserFetch(`${apiBase}${input}`, init);
    }
    if (input instanceof URL && input.pathname.startsWith('/api/')) {
      return browserFetch(new URL(`${input.pathname}${input.search}`, apiBase), init);
    }
    return browserFetch(input, init);
  };
  window.__skywayNativeFetch = true;
}

export function isNativeApp() {
  return isNative;
}

export function apiUrl(path) {
  return isNative && path.startsWith('/api/') ? `${apiBase}${path}` : path;
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
