// Auth stand-in so the real App renders as an already-approved user.
// The role comes from ?role= on the preview URL, which is what lets the same
// harness capture both the pilot phone experience and the administrator console.

import { CURRENT_USER, USERS } from '../sample-data.js';

function requestedRole() {
  if (typeof window === 'undefined') return 'admin';
  const role = new URLSearchParams(window.location.search).get('role');
  return ['crew', 'ops', 'sales', 'maint', 'accounting', 'admin'].includes(role) ? role : 'admin';
}

function profileFor(role) {
  if (role === 'crew') {
    return {
      ...USERS.find((u) => u.uid === 'pilot-max'),
      callsign: 'Max',
      certType: 'ATP',
      certNumber: '3458291',
      jetinsightName: 'Maxwell Hagberg',
      emailSignature: 'Maxwell Hagberg\nCaptain\nSkyway Aviation',
    };
  }
  if (role === 'admin') return CURRENT_USER;
  const match = USERS.find((u) => u.role === role);
  return match || CURRENT_USER;
}

export function watchAuth(onChange) {
  const role = requestedRole();
  const profile = profileFor(role);
  onChange({
    state: 'active',
    user: {
      uid: profile.uid,
      email: profile.email,
      displayName: profile.name,
      emailVerified: true,
      providerData: [{ providerId: 'microsoft.com', email: profile.email }],
      getIdToken: async () => 'preview-id-token',
    },
    profile,
    authError: null,
  });
  return () => {};
}

export function subscribeToUsers(onUpdate) {
  onUpdate(USERS);
  return () => {};
}

export async function completeMicrosoftRedirect() { return null; }
export async function signInWithMicrosoft() { return null; }
export async function signOut() {}
export async function updateUserProfile() {}
export async function approveUser() {}
export async function deleteUserProfile() {}
export function getLastDiagnostic() { return null; }
export function configuredAuthDomain() { return 'preview.local'; }
export function authDomainIsSameOrigin() { return true; }
export function microsoftTenant() { return 'flyskyway.com'; }
export function microsoftTenantConfigured() { return true; }
