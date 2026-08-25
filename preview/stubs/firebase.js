// Auth/Firestore stand-in for the preview harness. Aliased over src/firebase.js
// so real components can call getIdToken() without a Firebase project.

export const AUTH_DOMAIN = 'preview.local';

export const auth = {
  currentUser: {
    uid: 'admin-1',
    email: 'jim@flyskyway.com',
    displayName: 'Jim Skyway',
    getIdToken: async () => 'preview-id-token',
    getIdTokenResult: async () => ({ claims: {} }),
  },
};

export const db = {};
export default { auth, db, AUTH_DOMAIN };
