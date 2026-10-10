/**
 * CapacitorHttp, when enabled, replaces window.fetch and XMLHttpRequest with a
 * native URLSession proxy. That proxy is what lets capacitor://localhost call
 * www.skyway.app without browser CORS. It is also a buffering proxy: it
 * percent-decodes the target URL and holds the entire body before JavaScript
 * sees a byte.
 *
 * Firestore's listen channel is a long-poll (and, on GET, a carefully encoded
 * `database=projects%2F…%2Fdatabases%2Fappusers` query). Run through that proxy
 * the channel returns an HTML error page, the SDK drops into offline mode, and
 * onSnapshot keeps serving the empty memory cache — trip milestones stay at
 * 0/8 while the web app shows the real document. Every retry then sits on
 * URLSession.shared, which is why the whole shell feels slow.
 *
 * Google and Firebase hosts speak CORS to a WebView, so they must stay on
 * WKWebView's own networking. That includes Firebase Auth
 * (identitytoolkit.googleapis.com, securetoken.googleapis.com) as well as
 * Firestore. Skyway /api routes stay on CapacitorHttp.
 */

const WEBVIEW_NETWORK_SUFFIXES = [
  'googleapis.com',
  'firebaseio.com',
  'firebasedatabase.app',
];

export function requestHref(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  if (typeof input.url === 'string') return input.url;
  return '';
}

/** True when this URL must bypass CapacitorHttp and use the WebView stack. */
export function shouldUseWebViewNetwork(input) {
  const raw = requestHref(input);
  if (!raw) return false;
  let host = '';
  try {
    host = new URL(raw, 'https://localhost').hostname.toLowerCase();
  } catch {
    return false;
  }
  return WEBVIEW_NETWORK_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Capacitor's bridge overwrites XMLHttpRequest.prototype in place and
 * re-assigns those methods on every `new XMLHttpRequest()`. Putting the
 * original constructor back, with the original methods restored, stops
 * Firestore's XHR long-poll from entering the native proxy.
 * Returns false when the bridge never patched XHR (web, or tests).
 */
export function restoreWebViewXmlHttpRequest(target) {
  const saved = target?.CapacitorWebXMLHttpRequest;
  const Original = saved?.fullObject;
  if (!Original || typeof saved.open !== 'function') return false;
  const proto = Original.prototype;
  if (!proto) return false;
  proto.open = saved.open;
  if (typeof saved.send === 'function') proto.send = saved.send;
  if (typeof saved.abort === 'function') proto.abort = saved.abort;
  if (typeof saved.setRequestHeader === 'function') proto.setRequestHeader = saved.setRequestHeader;
  if (typeof saved.getAllResponseHeaders === 'function') proto.getAllResponseHeaders = saved.getAllResponseHeaders;
  if (typeof saved.getResponseHeader === 'function') proto.getResponseHeader = saved.getResponseHeader;
  target.XMLHttpRequest = Original;
  return true;
}
