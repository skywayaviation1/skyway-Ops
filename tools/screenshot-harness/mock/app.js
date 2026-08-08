/* Stand-in for `firebase/app`. */

const app = { name: '[DEFAULT]', options: { projectId: 'skyway-ops-harness' } };

export function initializeApp() { return app; }
export function getApp() { return app; }
export function getApps() { return [app]; }
export function deleteApp() { return Promise.resolve(); }
