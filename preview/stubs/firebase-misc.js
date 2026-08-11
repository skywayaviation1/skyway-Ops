// Remaining Firestore-backed modules the full App touches. Reads return sample
// data or empty collections; writes are accepted and discarded so the preview
// never needs a project. Anything not listed simply resolves.

import { EXPENSES, MANIFESTS, TRIPS, USERS, WALLET_CARDS } from '../sample-data.js';

const emit = (value) => (cb) => {
  if (typeof cb === 'function') cb(value);
  return () => {};
};
const noop = async () => {};

/* ── firebase-comms ─────────────────────────────────────────────────────── */
export const ROLES = { crew: 'crew', ops: 'ops', admin: 'admin' };
export const canDm = () => true;
export const canCreateGroup = () => true;
export const canReadAllDms = () => true;
export const isParticipant = () => true;
export const canOpenConversation = () => true;
export const dmKey = (a, b) => [a, b].sort().join('::');
export const openOrCreateDm = async () => 'conv-1';
export const createGroup = async () => 'conv-2';
export const addGroupMembers = noop;
export const removeGroupMember = noop;
export const renameGroup = noop;
export const subscribeToConversation = (_id, cb) => emit([])(cb);
export const sendMessage = noop;
export const markRead = noop;
export const setMuted = noop;
export const subscribeMuted = (_u, _t, cb) => emit(false)(cb);
export const softDeleteMessage = noop;
export const TYPING_FRESHNESS_MS = 6000;
export const setTyping = noop;
export const subscribeTyping = (_id, _uid, cb) => emit([])(cb);
export const markMessagesRead = noop;
export const subscribeInboxFor = (_user, cb) => emit([])(cb);
export const legacyTripConvId = (id) => `trip-${id}`;
export const subscribeLegacyTripThread = (_id, cb) => emit([])(cb);
export const sendLegacyTripMessage = noop;
export const sendStatusStepPush = noop;
export const softDeleteLegacyTripMessage = noop;

/* ── firebase-manifests ─────────────────────────────────────────────────── */
export const manifestId = () => 'manifest-1';
export const localDateString = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
export const saveManifest = noop;
export const fetchManifest = async () => MANIFESTS[0] || null;
export const deleteManifest = noop;
export const subscribeToAllManifests = (cb) => emit(MANIFESTS)(cb);
export const autoAddTripToManifest = noop;
export const buildLegFromTrip = (trip) => ({
  tripUid: trip?.uid || null,
  from: trip?.info?.from || '',
  to: trip?.info?.to || '',
  pax: [],
});
export const diffManifestVsSchedule = () => ({ newTrips: [], removedTripUids: [], unchanged: true });

/* ── firebase-mel ───────────────────────────────────────────────────────── */
export const MEL_STATUS = { open: 'open', cleared: 'cleared' };
export const saveDraftRevision = noop;
export const subscribeRevisions = (cb) => emit([])(cb);
export const getActiveRevision = async () => null;
export const subscribeActiveRevision = (cb) => emit(null)(cb);
export const activateRevision = noop;
export const deleteDraftRevision = noop;
export const searchMelItems = async () => [];
export const resolveRefs = async () => [];
export const melItemToDeferralInput = () => ({});

/* ── firebase-mx ────────────────────────────────────────────────────────── */
export const PROJECT_STATUS_LABELS = { open: 'Open', closed: 'Closed' };
export const PROJECT_TYPE_LABELS = { inspection: 'Inspection' };
export const subscribeToMxProjects = (cb) => emit([])(cb);
export const createMxProject = noop;
export const updateMxProject = noop;
export const deleteMxProject = noop;
export const computeSuggestedStatus = () => 'open';
export const maybeApplyAutoStatus = noop;
export const setProjectStatus = noop;
export const addTask = noop;
export const updateTask = noop;
export const completeTask = noop;
export const uncompleteTask = noop;
export const deleteTask = noop;
export const requestPart = noop;
export const approvePart = noop;
export const denyPart = noop;
export const updatePartStatus = noop;
export const setInspectionPdf = noop;
export const addChecklistItem = noop;
export const toggleChecklistItem = noop;
export const deleteChecklistItem = noop;

/* ── firebase-quickbooks ────────────────────────────────────────────────── */
export const subscribeToQuickBooksConnection = (cb) => emit({
  connected: true,
  companyName: 'Skyway Aviation LLC',
  environment: 'production',
  realmId: '9341454801234567',
  connectedByName: 'Jim Skyway',
  connectedAt: Date.now() - 40 * 86_400_000,
  refreshTokenExpiresAt: Date.now() + 80 * 86_400_000,
})(cb);
export const getQuickBooksConnection = async () => ({ connected: true });
export const buildOAuthStartUrl = async () => '#preview';
export const disconnectQuickBooks = async () => ({ message: 'Preview only' });
export const formatRefreshTokenExpiry = () => 'valid for 80 more days';

/* ── firebase-reports ───────────────────────────────────────────────────── */
export const newReportId = () => 'report-1';
export const saveReport = noop;
export const fetchReport = async () => null;
export const deleteReport = noop;
export const subscribeToAllReports = (cb) => emit([])(cb);

/* ── firebase-service ───────────────────────────────────────────────────── */
export const subscribeToServiceRequests = (cb) => emit([])(cb);
export const createServiceRequest = noop;
export const updateServiceRequest = noop;
export const completeServiceRequest = noop;
export const appendServiceLogEntry = noop;
export const deleteServiceRequest = noop;
export const addLogbookEntry = noop;
export const updateLogbookEntryPdf = noop;
export const deleteLogbookEntry = noop;
export const addReferenceDoc = noop;
export const removeReferenceDoc = noop;
export const markReferenceEmailed = noop;
export const postSkywayChatReply = noop;

/* ── firebase-storage ───────────────────────────────────────────────────── */
export const storage = {};
export const computeTripGroupId = (t) => t?.uid || 'group-1';
export const uploadTripSheet = async () => ({ url: '#', path: 'preview' });
export const deleteTripSheet = noop;
export const uploadAogReference = async () => ({ url: '#', path: 'preview' });
export const deleteAogReference = noop;
export const uploadServiceReference = async () => ({ url: '#', path: 'preview' });
export const deleteServiceReference = noop;
export const uploadTripAttachment = async () => ({ url: '#', path: 'preview' });
export const uploadCommsAttachment = async () => ({ url: '#', path: 'preview' });
export const uploadMelRevisionPdf = async () => ({ url: '#', path: 'preview' });
export const uploadPilotDoc = async () => ({ url: '#', path: 'preview' });
export const deletePilotDoc = noop;

/* ── firebase-travel ────────────────────────────────────────────────────── */
export const newBookingId = () => 'booking-1';
export const saveBooking = noop;
export const deleteBooking = noop;
export const subscribeToUserBookings = (_uid, cb) => emit([])(cb);

/* ── firebase-wallet ────────────────────────────────────────────────────── */
export const newCardId = () => 'card-1';
export const saveCard = noop;
export const deleteCard = noop;
export const subscribeToAllCards = (cb) => emit(WALLET_CARDS)(cb);

/* ── firebase-pilotdocs ────────────────────────────────────────────────── */
export const PILOT_DOC_TYPES = ['medical', 'license', 'passport', 'training'];
export const docTypeLabel = (t) => String(t || '').replace(/^./, (c) => c.toUpperCase());
export const newPilotDocId = () => 'doc-1';
export const savePilotDoc = noop;
export const deletePilotDocRecord = noop;
export const subscribeToUserPilotDocs = (_uid, cb) => emit([])(cb);
export const subscribeToAllPilotDocs = (cb) => emit([])(cb);
export function expirationStatus(expiresAt) {
  if (!expiresAt) return { status: 'unknown', daysRemaining: null };
  const days = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { status: 'expired', daysRemaining: days };
  if (days <= 30) return { status: 'expiring', daysRemaining: days };
  return { status: 'current', daysRemaining: days };
}

/* ── firebase-push ─────────────────────────────────────────────────────── */
export const pushSupported = () => true;
export const iosNeedsHomeScreenInstall = () => false;
export const notificationPermissionState = () => 'granted';
export const enablePush = async () => ({ ok: true });
export const disablePush = async () => ({ ok: true });
export const listenForForegroundPush = () => () => {};

/* ── firebase-expenses ─────────────────────────────────────────────────── */
export const subscribeToAllExpenses = (cb) => emit(EXPENSES)(cb);
export const subscribeToExpenses = (_uid, cb) => emit(EXPENSES)(cb);
export const subscribeToUserExpenses = (_uid, cb) => emit(EXPENSES)(cb);
export const uploadReceipt = async () => ({ url: '#', path: 'preview' });
export const deleteReceiptFile = noop;
export const saveExpense = noop;
export const deleteExpense = noop;
export const approveExpense = noop;
export const rejectExpense = noop;
export const newExpenseId = () => 'exp-new';
export const EXPENSE_CATEGORIES = [
  'Fuel', 'Catering', 'Hangar', 'Landing fees', 'Crew meals', 'Ground transport', 'Lodging', 'Other',
];
export const PAYMENT_METHODS = ['Company card', 'Personal card', 'Cash'];

/* Trips list, for screens that read the schedule from Firestore. */
export const subscribeManualTrips = (cb) => emit(TRIPS)(cb);
export const subscribeAllUsers = (cb) => emit(USERS)(cb);
