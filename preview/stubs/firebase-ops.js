// Maintenance, AOG, duty, crew-document and expense stand-ins. One file keeps
// the alias table short; the Vite plugin maps each module name to a named export
// group below via re-export shims.

import { FLEET_TAILS as FLEET_TAILS_SAMPLE, MEL_ITEMS, SQUAWKS, dutyPeriods } from '../sample-data.js';

const emitValue = (value) => (cb) => {
  if (typeof cb === 'function') cb(value);
  return () => {};
};

/* ── firebase-maint ─────────────────────────────────────────────────────── */
export const subscribeSquawks = (cb) => emitValue(SQUAWKS)(cb);
export const subscribeMel = (cb) => emitValue(MEL_ITEMS)(cb);
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
export const subscribeToAogEvents = (cb) => emitValue([])(cb);

/* ── firebase-duty-v2 ───────────────────────────────────────────────────── */
export const subscribeRecentForAllPilots = (_days, cb) => emitValue(dutyPeriods())(cb);
export const subscribeAllOnDuty = (cb) => emitValue(dutyPeriods().filter((p) => p.status === 'on'))(cb);
export const subscribePeriodsForPilot = (_uid, cb) => emitValue(dutyPeriods())(cb);
export const subscribeOutsideFlyingForPilot = (_uid, cb) => emitValue([])(cb);

/* ── firebase-pilotdocs ─────────────────────────────────────────────────── */
export const subscribeToAllPilotDocs = (cb) => emitValue([])(cb);
export function expirationStatus(expiresAt) {
  if (!expiresAt) return { status: 'unknown', daysRemaining: null };
  const days = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { status: 'expired', daysRemaining: days };
  if (days <= 30) return { status: 'expiring', daysRemaining: days };
  return { status: 'current', daysRemaining: days };
}

/* ── firebase-expenses ──────────────────────────────────────────────────── */
export const subscribeToAllExpenses = (cb) => emitValue([])(cb);
export const subscribeToExpenses = (_uid, cb) => emitValue([])(cb);

/* ── firebase-user-mail ─────────────────────────────────────────────────── */
export const buildUserMailOAuthUrl = async () => '#preview-oauth';
export const disconnectUserMailbox = async () => ({ message: 'Preview only' });

/* ── Remaining surface of the stubbed modules ────────────────────────────
   These exist so no screen can fail to import a binding. Reads return sample
   or empty data; writes are accepted and discarded. */

const write = async () => {};

/* firebase-maint */
export const FLEET_TAILS = FLEET_TAILS_SAMPLE;
export const MEL_CATEGORY_LIMITS = { A: null, B: 3, C: 10, D: 120 };
export const VERYON_SYNC_ENDPOINT = '/api/veryon-sync';
export const subscribeFleet = (cb) => emitValue(FLEET_TAILS_SAMPLE.map((tail) => ({ tail })))(cb);
export const subscribeTimelog = (cb) => emitValue([])(cb);
export const subscribeStagedTimes = (cb) => emitValue([])(cb);
export const createSquawk = write;
export const triageSquawk = write;
export const closeSquawk = write;
export const deleteSquawk = write;
export const createMelDeferral = write;
export const clearMelDeferral = write;
export const deleteMelDeferral = write;
export const melLimitDays = (category) => MEL_CATEGORY_LIMITS[category] ?? null;
export function melDaysRemaining(item) {
  if (!item?.dueAt) return null;
  return Math.ceil((item.dueAt - Date.now()) / 86_400_000);
}
export const confirmTimeEntry = write;
export const rejectTimeEntry = write;
export const stageTripTimes = write;
export const seedFleet = write;
export const upsertAircraft = write;
export const veryonPullStatus = async () => ({ ok: false, disabled: true, reason: 'Preview' });
export const pushConfirmedEntryToVeryon = async () => ({ ok: false, disabled: true, reason: 'Preview' });

/* firebase-aog */
export const declareAog = write;
export const updateAog = write;
export const resolveAog = write;
export const deleteAog = write;
export const appendAogLogEntry = write;
export const addReferenceDoc = write;
export const removeReferenceDoc = write;
export const markReferenceEmailed = write;
export const addLogbookEntry = write;
export const updateLogbookEntryPdf = write;
export const deleteLogbookEntry = write;
export const postSkywayChatReply = write;

/* firebase-duty-v2 */
export const RETENTION_DAYS = 365 * 2;
export const startDuty = write;
export const startDutyPair = write;
export const endDuty = write;
export const endDutyPair = write;
export const editPeriod = write;
export const confirmPendingDuty = write;
export const declinePendingDuty = write;
export const requestOverride = write;
export const approveOverride = write;
export const addFlightTimeToActive = write;
export const addOutsideFlying = write;
export const editOutsideFlying = write;
export const addPartnerToActiveDuty = write;
export const removePartnerFromDuty = write;
export const changePartner = write;
export const linkCrewPeriods = write;
export const unlinkCrewPeriods = write;
export const adminAddBackfillPeriod = write;
export const safeCreatePeriodDoc = write;
export const assertPairLegalForDispatch = async () => ({ ok: true, blockers: [] });
export const fetchOutsideFlyingForPilot = async () => [];
export const fetchOutsideFlyingForPilotInRange = async () => [];
export const fetchPeriodsForPilotInRange = async () => dutyPeriods();
export const fetchPeriodsByTailInRange = async () => dutyPeriods();
export const subscribeDutyReportForAllPilots = (_days, cb) => emitValue(dutyPeriods())(cb);
export const subscribeOutsideReportForAllPilots = (_days, cb) => emitValue([])(cb);
