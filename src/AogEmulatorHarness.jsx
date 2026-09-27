// Signs into the Firebase Auth emulator as a synthetic ops user and mounts
// the AOG Coverage page. Only loaded when VITE_FIREBASE_EMULATORS=1.

import { useEffect, useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebase.js';
import AogRecoveryTab from './AogRecoveryTab.jsx';

const EMAIL = 'ops@example-charter.test';
const PASSWORD = 'synthetic-ops-pass';

export default function AogEmulatorHarness() {
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    signInWithEmailAndPassword(auth, EMAIL, PASSWORD)
      .then((cred) => setUser({
        uid: cred.user.uid,
        email: EMAIL,
        role: 'ops',
        name: 'Synthetic Ops',
      }))
      .catch((err) => setError(err.message || 'Emulator sign-in failed'));
  }, []);

  if (error) return <p role="alert">Emulator sign-in failed: {error}</p>;
  if (!user) return <p>Signing in to the emulator…</p>;
  return <AogRecoveryTab currentUser={user} scheduleTrips={[]} />;
}
