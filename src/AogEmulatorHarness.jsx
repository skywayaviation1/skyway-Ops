// Signs into the Firebase Auth emulator as a synthetic ops user and mounts
// the AOG Coverage page. Only loaded when VITE_FIREBASE_EMULATORS=1.

import { useEffect, useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebase.js';
import AogRecoveryTab from './AogRecoveryTab.jsx';
import { MobileNav } from './App.jsx';

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
  return (
    <div className="sw-app-shell bg-slate-950 text-slate-100">
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto scroll-area sw-panel-scroll">
          <AogRecoveryTab currentUser={user} scheduleTrips={[]} />
        </div>
        <MobileNav
          currentSection="aog"
          setCurrentSection={() => {}}
          currentUser={user}
          onOpenSettings={() => {}}
          onToggleTheme={() => {}}
          themeMode="dark"
          onLogout={() => {}}
        />
      </div>
    </div>
  );
}
