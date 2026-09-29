// Signs into the Firebase Auth emulator as a synthetic ops user and mounts
// the AOG Coverage page. Only loaded when VITE_FIREBASE_EMULATORS=1.

import { useEffect, useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { collection, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase.js';
import AogRecoveryTab from './AogRecoveryTab.jsx';
import AogCfsConfirmedMark from './AogCfsConfirmed.jsx';
import { MobileNav } from './App.jsx';

const EMAIL = 'ops@example-charter.test';
const PASSWORD = 'synthetic-ops-pass';

function ConfirmedLegs() {
  const [legs, setLegs] = useState([]);
  useEffect(() => onSnapshot(collection(db, 'trip-state'), (snap) => {
    setLegs(snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })));
  }), []);
  const confirmed = legs.filter((leg) => leg.aogCfs?.status === 'cfs_confirmed');
  if (!confirmed.length) return null;
  return (
    <section aria-label="Trip detail" className="shrink-0 border-b border-edge bg-surface px-4 py-3">
      <h2 className="mb-2 text-sm font-semibold text-content">Trip detail</h2>
      <div className="space-y-2">
        {confirmed.map((leg) => (
          <AogCfsConfirmedMark
            key={leg.id}
            acknowledgement={leg.aogCfs}
            tripId={leg.aogCfs.tripId || ''}
            legLabel={[leg.tripMeta?.from, leg.tripMeta?.to].filter(Boolean).join(' → ')}
          />
        ))}
      </div>
    </section>
  );
}

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
        <ConfirmedLegs />
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
