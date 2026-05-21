// MuteToggle.jsx — a small bell-with-slash button that toggles whether
// the current user receives push notifications for this conversation or
// trip thread. Used in:
//   - CommsScreen conversation header (DMs + groups)
//   - Trip ChatPanel header (per-trip thread)
//
// Mute affects PUSH ONLY. Messages still arrive in the chat surface,
// unread badges still update, server still routes them — the recipient
// just doesn't get a lock-screen banner. Reasoning: muting a chat
// shouldn't make you blind to messages, just stop the buzz.

import React, { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';

function MuteToggle({ currentUser, target, className = '' }) {
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!currentUser || !target) return;
    let unsub = () => {};
    let cancelled = false;
    (async () => {
      try {
        const m = await import('./firebase-comms.js');
        unsub = m.subscribeMuted(currentUser, target, (isMuted) => {
          if (cancelled) return;
          setMuted(isMuted);
          setLoaded(true);
        });
      } catch (e) {
        console.warn('[mute] toggle subscribe failed:', e);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; try { unsub(); } catch (_) {} };
  }, [currentUser, target]);

  const toggle = async () => {
    if (!currentUser || !target || busy) return;
    setBusy(true);
    const next = !muted;
    // Optimistic — flip immediately; the listener will reconcile if the
    // write fails or is overridden from another device.
    setMuted(next);
    try {
      const m = await import('./firebase-comms.js');
      await m.setMuted(currentUser, target, next);
    } catch (e) {
      console.error('[mute] toggle failed:', e);
      // Revert optimistic flip on failure.
      setMuted(!next);
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null; // brief flash avoided — don't render until first read

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`p-1.5 rounded-full transition-colors ${
        muted
          ? 'text-amber-400 hover:bg-amber-500/10'
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
      } ${className}`}
      title={muted ? 'Unmute notifications for this thread' : 'Mute notifications for this thread'}
      aria-label={muted ? 'Unmute' : 'Mute'}
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : muted ? (
        <BellOff className="w-4 h-4" />
      ) : (
        <Bell className="w-4 h-4" />
      )}
    </button>
  );
}

export default MuteToggle;
