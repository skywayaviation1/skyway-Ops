/* Stand-in for `firebase/messaging`. Push is inert in the harness. */

export function getMessaging() { return { __mockMessaging: true }; }
export function isSupported() { return Promise.resolve(false); }
export async function getToken() { return null; }
export function onMessage() { return () => {}; }
export function deleteToken() { return Promise.resolve(true); }
