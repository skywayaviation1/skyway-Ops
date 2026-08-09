// PushSettings.jsx — user-facing push controls.
//
// Drop into the profile/settings area for the user to:
//   - Enable or disable lock-screen push on this device
//   - Set quiet hours (start/end, local tz auto-detected)
//   - Toggle AOG-override-quiet-hours (default ON — AOGs always wake you)
//   - Hide message previews on the lock screen
//
// Profile fields written:
//   quietHours: { enabled, startHour, endHour, tz }
//   aogOverridesQuietHours: boolean
//   messagePreviewInNotifications: boolean

import React, { useEffect, useState } from 'react';
import { Bell, AlertTriangle, Loader2, Check, Eye, EyeOff } from 'lucide-react';
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

  // The browser's Notification.permission stays 'granted' forever once the
  // user grants it — disablePush() can't actually revoke it (only the
  // browser settings can). So we can't use `perm === 'granted'` as the
  // source of truth for "is push currently enabled on this device."
  //
  // Instead we track a local 'enabled' flag persisted in localStorage,
  // updated whenever enablePush / disablePush succeed. Initial value
  // reads from localStorage (or falls back to: granted but unknown = treat
  // as enabled for backward compat with users who enabled before this fix).
  const PUSH_ENABLED_KEY = 'skyway_push_enabled';
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const stored = localStorage.getItem(PUSH_ENABLED_KEY);
      if (stored === '1') return true;
      if (stored === '0') return false;
      // Unknown: if browser perm is granted, assume previously enabled
      return notificationPermissionState() === 'granted';
    } catch (_) {
      return false;
    }
  });

  // Quiet hours local state (mirrors what's in the user profile)
  const q = currentUser?.quietHours || {};
  const [enabledQH, setEnabledQH] = useState(!!q.enabled);
  const [startHour, setStartHour] = useState(Number.isFinite(q.startHour) ? q.startHour : 22);
  const [endHour, setEndHour] = useState(Number.isFinite(q.endHour) ? q.endHour : 6);
  const [aogOverride, setAogOverride] = useState(currentUser?.aogOverridesQuietHours !== false);
  const [showPreviews, setShowPreviews] = useState(currentUser?.messagePreviewInNotifications !== false);
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
      setEnabled(true);
      try { localStorage.setItem(PUSH_ENABLED_KEY, '1'); } catch (_) {}
      setMsg('Push enabled on this device.');
    } catch (e) {
      setErr(e.message || 'Could not enable push');
    } finally { setBusy(false); }
  };

  const handleDisable = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      await disablePush(currentUser);
      setEnabled(false);
      try { localStorage.setItem(PUSH_ENABLED_KEY, '0'); } catch (_) {}
      setMsg('Push disabled on this device. To fully revoke notification permission, use your browser/OS settings.');
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
        quietHours: { enabled: enabledQH, startHour, endHour, tz },
        aogOverridesQuietHours: aogOverride,
        messagePreviewInNotifications: showPreviews,
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
      ) : enabled ? (
        <div className="mb-4">
          <div className="text-xs text-emerald-400 flex items-center gap-1.5 mb-2"><Bell className="w-3.5 h-3.5" /> Push is enabled on this device.</div>
          <button
            onClick={handleDisable}
            disabled={busy}
            className="text-xs text-slate-400 hover:text-slate-200 underline disabled:opacity-40"
          >
            {busy ? 'Disabling...' : 'Disable on this device'}
          </button>
        </div>
      ) : (
        <div className="mb-4">
          <p className="text-xs text-slate-400 mb-2">
            Get a notification on your phone's lock screen when someone messages you.
          </p>
          <button
            onClick={handleEnable}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs tracking-widest font-medium disabled:opacity-40"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
            {perm === 'granted' ? 'RE-ENABLE PUSH' : 'ENABLE PUSH'}
          </button>
          {perm === 'granted' && (
            <p className="text-[10px] text-slate-500 mt-2">
              Notification permission is still granted in your browser, so re-enabling won't prompt again.
            </p>
          )}
        </div>
      )}

      {/* Quiet hours */}
      <div className="border-t border-slate-800 pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>QUIET HOURS</p>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={enabledQH} onChange={(e) => setEnabledQH(e.target.checked)} className="accent-cyan-400" />
            <span className="text-xs text-slate-300">on</span>
          </label>
        </div>
        <p className="text-[11px] text-slate-500 mb-2">
          No push during these hours (tz: {tz}). AOG messages can still punch through — toggle below.
        </p>
        <div className={`grid grid-cols-2 gap-2 mb-3 ${enabledQH ? '' : 'opacity-40 pointer-events-none'}`}>
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
        <label className="mb-3 flex cursor-pointer items-start gap-2 border-t border-slate-800 pt-3">
          <input
            type="checkbox"
            checked={showPreviews}
            onChange={(e) => setShowPreviews(e.target.checked)}
            className="mt-0.5 accent-cyan-400"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-xs text-slate-300">
              {showPreviews ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              Show message previews
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
              Turn off to show only “New message” on your lock screen.
            </span>
          </span>
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
