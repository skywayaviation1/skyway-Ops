// Maintenance, AOG, duty, crew-document and expense stand-ins. One file keeps
// the alias table short; the Vite plugin maps each module name to a named export
// group below via re-export shims.

import { MEL_ITEMS, SQUAWKS, dutyPeriods } from '../sample-data.js';

const emit = (value) => (cb) => {
  if (typeof cb === 'function') cb(value);
  return () => {};
};

/* ── firebase-maint ─────────────────────────────────────────────────────── */
export const subscribeSquawks = (cb) => emit(SQUAWKS)(cb);
export const subscribeMel = (cb) => emit(MEL_ITEMS)(cb);
export function deriveAircraftStatus(tail, squawks = [], mel = []) {
  const open = squawks.filter((s) => s?.tail === tail && s.status !== 'closed');
  const grounding = open.some((s) => s.grounding === true);
  const melOpen = mel.filter((m) => m?.tail === tail && m.status === 'open').length;
  if (grounding) {
    return { status: 'AOG', reasons: open.map((s) => s.description), melOpen };
  }
  if (melOpen > 0 || open.length > 0) {
    return {
      status: 'RESTRICTED',
      reasons: [
        ...mel.filter((m) => m?.tail === tail && m.status === 'open').map((m) => `MEL ${m.melNumber}: ${m.title}`),
        ...open.map((s) => s.description),
      ],
      melOpen,
    };
  }
  return { status: 'AIRWORTHY', reasons: [], melOpen: 0 };
}
export const VERYON_ENABLED = false;

/* ── firebase-aog ───────────────────────────────────────────────────────── */
export const subscribeToAogEvents = (cb) => emit([])(cb);

/* ── firebase-duty-v2 ───────────────────────────────────────────────────── */
export const subscribeRecentForAllPilots = (_days, cb) => emit(dutyPeriods())(cb);
export const subscribeAllOnDuty = (cb) => emit(dutyPeriods().filter((p) => p.status === 'on'))(cb);
export const subscribePeriodsForPilot = (_uid, cb) => emit(dutyPeriods())(cb);
export const subscribeOutsideFlyingForPilot = (_uid, cb) => emit([])(cb);

/* ── firebase-pilotdocs ─────────────────────────────────────────────────── */
export const subscribeToAllPilotDocs = (cb) => emit([])(cb);
export function expirationStatus(expiresAt) {
  if (!expiresAt) return { status: 'unknown', daysRemaining: null };
  const days = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { status: 'expired', daysRemaining: days };
  if (days <= 30) return { status: 'expiring', daysRemaining: days };
  return { status: 'current', daysRemaining: days };
}

/* ── firebase-expenses ──────────────────────────────────────────────────── */
export const subscribeToAllExpenses = (cb) => emit([])(cb);
export const subscribeToExpenses = (_uid, cb) => emit([])(cb);

/* ── firebase-user-mail ─────────────────────────────────────────────────── */
export const buildUserMailOAuthUrl = async () => '#preview-oauth';
export const disconnectUserMailbox = async () => ({ message: 'Preview only' });
