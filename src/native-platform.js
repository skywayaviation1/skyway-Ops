/**
 * Whether this JavaScript context is the Capacitor shell.
 *
 * `Capacitor.isNativePlatform()` reads `webkit.messageHandlers.bridge` (iOS)
 * or `androidBridge` at call time. Sampling it once at module import freezes
 * "web" when that read happens before the bridge exists, and every later
 * check then takes the browser path: PWA install UI, a service worker, and
 * `signInWithRedirect` from `capacitor://localhost`.
 *
 * Firebase's web SDK only accepts http(s) origins as authorized domains, so
 * `capacitor://` and `ionic://` must be treated as the native app even when
 * the bridge probe has not reported yet.
 */
export function readNativePlatform(win, isNativePlatform) {
  if (typeof isNativePlatform === 'function') {
    try {
      if (isNativePlatform()) return true;
    } catch {
      // A test double can throw. The bridge and origin checks still apply.
    }
  }
  if (!win) return false;
  if (win.androidBridge) return true;
  if (win.webkit?.messageHandlers?.bridge) return true;
  const protocol = win.location?.protocol;
  return protocol === 'capacitor:' || protocol === 'ionic:';
}

/**
 * Web install UI. The native shell's WKWebView reports an iPhone Safari
 * user agent and is not `display-mode: standalone`, which is exactly the
 * signal the website uses to offer "Install on iPhone".
 */
export function shouldOfferPwaInstall({
  native = false,
  standalone = false,
  ios = false,
  nativePromptAvailable = false,
} = {}) {
  if (native) return false;
  return !standalone && Boolean(ios || nativePromptAvailable);
}
