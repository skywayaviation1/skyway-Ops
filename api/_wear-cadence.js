import { getAdminApp, getDb } from './_super-admin.js';

export const WEAR_LANDINGS_PER_CHECK = 10;

const normalizeTail = (tail) => String(tail || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
const statusAt = (value) => {
  const raw = value?.timestamp ?? value?.at ?? value?.ts;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};

function nameMatchesPilot(tripName, userName) {
  const userTokens = String(userName || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tripName || userTokens.length < 2) return false;
  const target = String(tripName).toLowerCase();
  const first = userTokens[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const last = userTokens[userTokens.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${first}\\b`, 'i').test(target)
    && new RegExp(`\\b${last}\\b`, 'i').test(target);
}

async function latestSession(database, tail) {
  const snap = await database.collection('wear-check-sessions').where('tail', '==', tail).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => Number(b.completedAtMs || 0) - Number(a.completedAtMs || 0))[0] || null;
}

async function tailTripStates(database, tail) {
  const snap = await database.collection('trip-state').where('tripMeta.tail', '==', tail).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export function landingCountSinceSession(trips, sessionCompletedAtMs = 0, currentLanding = null) {
  const byTrip = new Map();
  for (const trip of Array.isArray(trips) ? trips : []) {
    const landedAt = statusAt(trip?.statuses?.landed);
    if (landedAt && landedAt > sessionCompletedAtMs) byTrip.set(trip.id, landedAt);
  }
  if (
    currentLanding?.tripUid
    && Number(currentLanding.landedAtMs) > sessionCompletedAtMs
  ) {
    byTrip.set(currentLanding.tripUid, Number(currentLanding.landedAtMs));
  }
  return { count: byTrip.size, tripIds: [...byTrip.keys()] };
}

async function resolveUpcomingCrew(database, trips, now, fallback = {}) {
  const upcoming = trips
    .filter((trip) => {
      const start = new Date(trip?.tripMeta?.start || 0).getTime();
      return Number.isFinite(start) && start > now;
    })
    .sort((a, b) => new Date(a.tripMeta.start).getTime() - new Date(b.tripMeta.start).getTime())[0];
  const pic = upcoming?.tripMeta?.pic || fallback.pic || '';
  const sic = upcoming?.tripMeta?.sic || fallback.sic || '';
  const usersSnap = await database.collection('users').get();
  return usersSnap.docs
    .map((doc) => ({ uid: doc.id, ...doc.data() }))
    .filter((user) => (
      user.approved !== false
      && user.active !== false
      && (nameMatchesPilot(pic, user.name) || nameMatchesPilot(sic, user.name))
    ));
}

async function pushWearDue(database, tail, users, count, nextTripId) {
  const tokens = [];
  for (const user of users) {
    const tokenSnap = await database.collection('users').doc(user.uid).collection('push-tokens').get();
    tokenSnap.docs.forEach((doc) => tokens.push(doc.id));
  }
  if (!tokens.length) return { sent: 0, reason: 'no-crew-push-tokens' };
  const message = {
    tokens: [...new Set(tokens)],
    notification: {
      title: `${tail} · WEAR CHECK DUE`,
      body: `${count} landings since the last completed wear check. Complete it before the next departure.`,
    },
    data: {
      type: 'wear-check-due',
      tail,
      tripId: nextTripId || '',
      url: nextTripId ? `/?trip=${encodeURIComponent(nextTripId)}&wear=${encodeURIComponent(tail)}` : `/?wear=${encodeURIComponent(tail)}`,
    },
    webpush: {
      headers: { Urgency: 'high' },
      notification: {
        requireInteraction: true,
        tag: `wear-due-${tail}`,
      },
    },
  };
  const result = await getAdminApp().messaging().sendEachForMulticast(message);
  return { sent: result.successCount, failed: result.failureCount };
}

export async function recordWearLanding({
  tripUid,
  tail: rawTail,
  landedAtMs = Date.now(),
  pic = '',
  sic = '',
  source = 'unknown',
}) {
  const tail = normalizeTail(rawTail);
  if (!tripUid || !tail) throw new Error('tripUid and tail required');
  const database = getDb();
  const [session, trips] = await Promise.all([
    latestSession(database, tail),
    tailTripStates(database, tail),
  ]);
  const completedAtMs = Number(session?.completedAtMs || 0);
  const landings = landingCountSinceSession(trips, completedAtMs, { tripUid, landedAtMs });
  const due = landings.count >= WEAR_LANDINGS_PER_CHECK;
  const cycleId = session?.id || 'no-session';
  const ref = database.collection('wear-tail-state').doc(tail);
  const transactionResult = await database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prior = snap.exists ? snap.data() : {};
    const notify = due
      && prior.pushNotifiedForCycle !== cycleId
      && prior.pushPendingForCycle !== cycleId;
    tx.set(ref, {
      tail,
      lastSessionId: session?.id || null,
      lastSessionCompletedAtMs: completedAtMs,
      landingsSinceSession: landings.count,
      countedLandingIds: landings.tripIds.slice(-100),
      due,
      dueSinceMs: due ? (prior.dueSinceMs || Number(landedAtMs)) : null,
      lastCountedLanding: { tripUid, landedAtMs: Number(landedAtMs), source },
      pushPendingForCycle: notify ? cycleId : (prior.pushPendingForCycle || null),
      updatedAtMs: Date.now(),
    }, { merge: true });
    return { notify };
  });

  let push = null;
  if (transactionResult.notify) {
    try {
      const crew = await resolveUpcomingCrew(database, trips, Date.now(), { pic, sic });
      const upcoming = trips
        .filter((trip) => new Date(trip?.tripMeta?.start || 0).getTime() > Date.now())
        .sort((a, b) => new Date(a.tripMeta.start) - new Date(b.tripMeta.start))[0];
      push = await pushWearDue(database, tail, crew, landings.count, upcoming?.id);
      await ref.set({
        pushNotifiedForCycle: push.sent > 0 ? cycleId : null,
        pushPendingForCycle: null,
        pushLastResult: push,
        pushLastAttemptAtMs: Date.now(),
      }, { merge: true });
    } catch (error) {
      push = { sent: 0, error: error.message };
      await ref.set({
        pushPendingForCycle: null,
        pushLastResult: push,
        pushLastAttemptAtMs: Date.now(),
      }, { merge: true });
    }
  }
  return { tail, ...landings, due, push };
}

export async function resetWearCadence({ tail: rawTail, sessionId, completedAtMs = Date.now() }) {
  const tail = normalizeTail(rawTail);
  if (!tail) throw new Error('tail required');
  await getDb().collection('wear-tail-state').doc(tail).set({
    tail,
    lastSessionId: sessionId || null,
    lastSessionCompletedAtMs: Number(completedAtMs),
    landingsSinceSession: 0,
    countedLandingIds: [],
    due: false,
    dueSinceMs: null,
    pushPendingForCycle: null,
    pushNotifiedForCycle: null,
    updatedAtMs: Date.now(),
  }, { merge: true });
  return { tail, due: false, landingsSinceSession: 0 };
}

