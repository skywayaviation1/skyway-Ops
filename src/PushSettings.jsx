// PushSettings.jsx — user-facing push controls.
//
// Drop into the profile/settings area for the user to:
//   - Enable or disable lock-screen push on this device
//   - Set quiet hours (start/end, local tz auto-detected)
//   - Toggle AOG-override-quiet-hours (default ON — AOGs always wake you)
//
// Profile fields written:
//   quietHours: { enabled, startHour, endHour, tz }
//   aogOverridesQuietHours: boolean

import React, { useEffect, useState } from 'react';
import { Bell, AlertTriangle, Loader2, Check } from 'lucide-react';
import { db } from './firebase.js';
import { doc, updateDoc } from 'firebase/firestore';
import {
  enablePush, disablePush, pushSupported, iosNeedsHomeScreenInstall,
  notificationPermissionState,
} from './firebase-push.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const fmtHour = (h) => {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
};

function detectTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

function PushSettings({ currentUser, onClose }) {
  const [perm, setPerm] = useState(notificationPermissionState());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Quiet hours local state (mirrors what's in the user profile)
  const q = currentUser?.quietHours || {};
  const [enabled, setEnabled] = useState(!!q.enabled);
  const [startHour, setStartHour] = useState(Number.isFinite(q.startHour) ? q.startHour : 22);
  const [endHour, setEndHour] = useState(Number.isFinite(q.endHour) ? q.endHour : 6);
  const [aogOverride, setAogOverride] = useState(currentUser?.aogOverridesQuietHours !== false);
  const [savedTick, setSavedTick] = useState(false);

  const tz = detectTz();
  const supported = pushSupported();
  const iosNeedsInstall = iosNeedsHomeScreenInstall();

  const handleEnable = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      await enablePush(currentUser, {
        onForegroundMessage: () => {}, // host app can wire this for toasts
      });
      setPerm(notificationPermissionState());
      setMsg('Push enabled on this device.');
    } catch (e) {
      setErr(e.message || 'Could not enable push');
    } finally { setBusy(false); }
  };

  const handleDisable = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      await disablePush(currentUser);
      setMsg('Push disabled on this device.');
    } catch (e) {
      setErr(e.message || 'Could not disable');
    } finally { setBusy(false); }
  };

  const saveQuietHours = async () => {
    if (!currentUser) return;
    const uid = currentUser.uid || currentUser.id;
    if (!uid) return;
    setBusy(true); setErr('');
    try {
      await updateDoc(doc(db, 'users', uid), {
        quietHours: { enabled, startHour, endHour, tz },
        aogOverridesQuietHours: aogOverride,
      });
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 max-w-md">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          PUSH NOTIFICATIONS
        </h3>
        {onClose && <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-300">close</button>}
      </div>

      {/* Status / enable */}
      {!supported ? (
        <div className="text-xs text-amber-400 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>This browser doesn't support push notifications.</span>
        </div>
      ) : iosNeedsInstall ? (
        <div className="text-xs text-amber-400 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>On iPhone, push requires the app to be added to your Home Screen first. In Safari: share → "Add to Home Screen" → open it from the home-screen icon.</span>
        </div>
      ) : perm === 'denied' ? (
        <div className="text-xs text-red-400 mb-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>You blocked notifications for this site. Re-enable in your browser settings → Notifications.</span>
        </div>
      ) : perm === 'granted' ? (
        <div className="mb-4">
          <div className="text-xs text-emerald-400 flex items-center gap-1.5 mb-2"><Bell className="w-3.5 h-3.5" /> Push is enabled on this device.</div>
          <button onClick={handleDisable} disabled={busy} className="text-xs text-slate-400 hover:text-slate-200 underline">
            Disable on this device
          </button>
        </div>
      ) : (
        <div className="mb-4">
          <p className="text-xs text-slate-400 mb-2">
            Get a notification on your phone's lock screen when someone messages you.
          </p>
          <button onClick={handleEnable} disabled={busy} className="flex items-center gap-2 px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs tracking-widest font-medium" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
            ENABLE PUSH
          </button>
        </div>
      )}

      {/* Quiet hours */}
      <div className="border-t border-slate-800 pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>QUIET HOURS</p>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-cyan-400" />
            <span className="text-xs text-slate-300">on</span>
          </label>
        </div>
        <p className="text-[11px] text-slate-500 mb-2">
          No push during these hours (tz: {tz}). AOG messages can still punch through — toggle below.
        </p>
        <div className={`grid grid-cols-2 gap-2 mb-3 ${enabled ? '' : 'opacity-40 pointer-events-none'}`}>
          <label className="text-[10px] text-slate-500 tracking-widest">
            FROM
            <select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))} className="w-full mt-0.5 bg-slate-900/60 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-400">
              {HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
            </select>
          </label>
          <label className="text-[10px] text-slate-500 tracking-widest">
            TO
            <select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))} className="w-full mt-0.5 bg-slate-900/60 border border-slate-700 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-400">
              {HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 cursor-pointer mb-3">
          <input type="checkbox" checked={aogOverride} onChange={(e) => setAogOverride(e.target.checked)} className="accent-red-400" />
          <span className="text-xs text-slate-300">AOG messages override quiet hours</span>
        </label>
        <button onClick={saveQuietHours} disabled={busy} className="flex items-center gap-2 px-3 py-1.5 border border-slate-700 hover:border-cyan-500/50 text-xs tracking-widest text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {savedTick ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> SAVED</> : 'SAVE'}
        </button>
      </div>

      {msg && <p className="mt-3 text-[11px] text-emerald-400">{msg}</p>}
      {err && <p className="mt-3 text-[11px] text-red-400">{err}</p>}
    </div>
  );
}

export default PushSettings;
