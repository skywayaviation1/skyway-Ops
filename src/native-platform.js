/**
 * Whether this JavaScript context is the Capacitor shell.
 *
 * The website must follow `Capacitor.isNativePlatform()` and nothing else.
 * Treating `webkit.messageHandlers.bridge`, `androidBridge`, or a
 * `capacitor:` / `ionic:` origin as native on their own sent desktop
 * Microsoft sign-in down the shell path: IndexedDB-only auth, and the
 * fetch/XHR bypass that replaced XMLHttpRequest. Firestore then opened no
 * listen channel and the profile read failed as `unavailable`.
 *
 * `win` is unused on purpose. Bridge objects and custom protocols are not
 * a second definition of "native" — Capacitor already consults the bridge
 * inside `isNativePlatform()`, and a false extra signal must not flip the
 * website off `getAuth`.
 */
export function readNativePlatform(_win, isNativePlatform) {
  if (typeof isNativePlatform !== 'function') return false;
  try {
    return isNativePlatform() === true;
  } catch {
    return false;
  }
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
