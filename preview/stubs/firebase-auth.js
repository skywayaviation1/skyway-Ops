// Auth stand-in so the real App renders as an already-approved user.
// The role comes from ?role= on the preview URL, which is what lets the same
// harness capture both the pilot phone experience and the administrator console.
// Who those people are comes from the active tenant, never from a fixed roster.

import { CURRENT_USER, PILOT_USER, TENANT, USERS, emailFor } from '../sample-data.js';

function requestedRole() {
  if (typeof window === 'undefined') return 'admin';
  const role = new URLSearchParams(window.location.search).get('role');
  return ['crew', 'ops', 'sales', 'maint', 'accounting', 'admin'].includes(role) ? role : 'admin';
}

function profileFor(role) {
  if (role === 'crew') {
    const pilot = TENANT.crew[0];
    return {
      ...PILOT_USER,
      emailSignature: `${pilot.name}\nCaptain\n${TENANT.company}`,
    };
  }
  if (role === 'admin') return CURRENT_USER;

  const staff = TENANT.staff.find((s) => s.role === role);
  if (staff) {
    return {
      uid: staff.uid, id: staff.uid, name: staff.name, callsign: staff.first,
      role: staff.role, approved: true, active: true, email: emailFor(staff),
    };
  }
  return USERS.find((u) => u.role === role) || CURRENT_USER;
}

export function watchAuth(onChange) {
  const profile = profileFor(requestedRole());
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
export function microsoftTenant() { return TENANT.domain; }
export function microsoftTenantConfigured() { return true; }
