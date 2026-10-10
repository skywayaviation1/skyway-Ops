/**
 * iOS push sequencing, kept free of Firebase so it can be tested without the
 * client SDK. FCM's getToken throws "No APNS token specified" when it runs
 * before didRegisterForRemoteNotifications. The Capacitor plugin retains
 * `apnsTokenReceived` until a listener exists.
 */

export const APNS_TOKEN_TIMEOUT_MS = 20000;

export const APNS_SETUP_HINT = 'Apple has not issued a push token for this iPhone yet. '
  + 'Confirm the signed build contains the Push Notifications entitlement '
  + '(aps-environment) and that an APNs auth key is uploaded in Firebase '
  + 'Console → Project settings → Cloud Messaging, then try again.';

export function waitForApnsToken(messaging, { timeoutMs = APNS_TOKEN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let handle = null;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.resolve(handle?.remove?.()).catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(APNS_SETUP_HINT);
      error.code = 'apns-token-timeout';
      finish(reject, error);
    }, timeoutMs);
    Promise.resolve(messaging.addListener('apnsTokenReceived', (event) => {
      if (event?.token) finish(resolve, event.token);
    })).then((next) => {
      handle = next;
      if (settled) Promise.resolve(next?.remove?.()).catch(() => {});
    }).catch((err) => finish(reject, err));
  });
}

export function nativePushFailureMessage(error) {
  const code = error?.code;
  const msg = String(error?.message || error || '');
  if (code === 'apns-token-timeout' || /no apns token/i.test(msg)) return APNS_SETUP_HINT;
  return msg || 'Could not enable push';
}
