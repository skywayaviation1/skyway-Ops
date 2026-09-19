import crypto from 'node:crypto';
import { publicMovementNotification } from '../src/broker-share-privacy.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOVEMENT_STEPS = new Set(['taxi_dep', 'wheels_up', 'landed']);

const subscriptionId = (shareTripId) => crypto
  .createHash('sha256')
  .update(String(shareTripId || ''))
  .digest('hex')
  .slice(0, 24);

const emails = (values) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => EMAIL_RE.test(value)),
)].slice(0, 20);

export async function syncBrokerShareSubscriptions({
  database,
  shareTripId,
  recipients,
  publicTripData,
  trackingUrl,
}) {
  if (!database || !shareTripId) return { subscribedLegIds: [] };
  const recipientList = emails(recipients);
  const anchorRef = database.collection('trip-state').doc(shareTripId);
  const anchorSnap = await anchorRef.get();
  const previousLegIds = Array.isArray(anchorSnap.data()?.brokerNotificationLegIds)
    ? anchorSnap.data().brokerNotificationLegIds.filter(Boolean)
    : [];
  const currentLegs = recipientList.length > 0
    ? (publicTripData?.legs || []).filter((leg) => (
        leg?.tripId
        && leg.tripId !== shareTripId
        && leg.notifyBroker === true
      ))
    : [];
  const currentIds = currentLegs.map((leg) => String(leg.tripId));
  const touchedIds = [...new Set([...previousLegIds, ...currentIds])];
  const id = subscriptionId(shareTripId);

  await Promise.all(touchedIds.map(async (legId) => {
    const ref = database.collection('trip-state').doc(legId);
    await database.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = Array.isArray(snap.data()?.brokerShareSubscriptions)
        ? snap.data().brokerShareSubscriptions
        : [];
      const withoutThisShare = existing.filter((item) => item?.id !== id);
      const selected = currentLegs.find((leg) => String(leg.tripId) === legId);
      if (selected) {
        withoutThisShare.push({
          id,
          shareTripId,
          recipients: recipientList,
          trackingUrl: String(trackingUrl || '').slice(0, 2000),
          privacyMode: selected.privacyMode === 'repositioning'
            ? 'repositioning' : 'standard',
          from: selected.from ? String(selected.from).slice(0, 8) : null,
          to: selected.to ? String(selected.to).slice(0, 8) : null,
          active: true,
          updatedAt: Date.now(),
        });
      }
      tx.set(ref, { brokerShareSubscriptions: withoutThisShare }, { merge: true });
    });
  }));

  await anchorRef.set({
    brokerNotificationLegIds: currentIds,
    brokerNotificationUpdatedAt: Date.now(),
  }, { merge: true });
  return { subscribedLegIds: currentIds };
}

export async function removeBrokerShareSubscriptions({ database, shareTripId }) {
  return syncBrokerShareSubscriptions({
    database,
    shareTripId,
    recipients: [],
    publicTripData: { legs: [] },
    trackingUrl: '',
  });
}

function eventTimeText(eventTimeMs, timezone) {
  const date = new Date(Number(eventTimeMs));
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return `${date.toISOString().slice(11, 16)}Z`;
  }
}

async function enqueue({ host, to, subject, text, tripId, stepId }) {
  const proto = String(host || '').includes('localhost') ? 'http' : 'https';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.INTERNAL_API_SECRET) {
    headers['x-internal-secret'] = process.env.INTERNAL_API_SECRET;
  }
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  const response = await fetch(`${proto}://${host}/api/email-enqueue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      to,
      subject,
      text,
      source: 'broker-share-linked-leg',
      tripId,
      statusKey: stepId,
      threadKey: `broker-share-${tripId}`,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`email queue ${response.status}: ${body.slice(0, 160)}`);
  }
}

export async function notifyBrokerShareSubscribers({
  database,
  host,
  tripUid,
  tripState,
  stepId,
  eventTimeMs,
  eventState = {},
}) {
  if (!database || !tripUid || !MOVEMENT_STEPS.has(stepId)) return { sent: 0 };
  const subscriptions = Array.isArray(tripState?.brokerShareSubscriptions)
    ? tripState.brokerShareSubscriptions.filter((item) => (
        item?.active !== false && emails(item?.recipients).length > 0
      ))
    : [];
  let sent = 0;
  for (const subscription of subscriptions) {
    const eventId = `${tripUid}__${stepId}__${subscription.id}`;
    const eventRef = database.collection('broker-share-notification-events').doc(eventId);
    const claim = await database.runTransaction(async (tx) => {
      const snap = await tx.get(eventRef);
      const prior = snap.exists ? snap.data() : {};
      if (prior.sentAt) return false;
      if (prior.pendingAt && Date.now() - prior.pendingAt < 5 * 60 * 1000) return false;
      tx.set(eventRef, {
        tripUid,
        stepId,
        subscriptionId: subscription.id,
        pendingAt: Date.now(),
        attempts: Number(prior.attempts || 0) + 1,
      }, { merge: true });
      return true;
    });
    if (!claim) continue;

    const from = subscription.from || tripState?.tripMeta?.from || eventState?.origin;
    const to = subscription.to || tripState?.tripMeta?.to || eventState?.destination;
    const timezone = stepId === 'landed'
      ? eventState?.destinationTz : eventState?.originTz;
    const content = publicMovementNotification({
      tail: tripState?.tripMeta?.tail || eventState?.ident,
      from,
      to,
      stepId,
      eventTimeText: eventTimeText(eventTimeMs, timezone),
      trackingUrl: subscription.trackingUrl,
    });
    if (!content) continue;
    try {
      await enqueue({
        host,
        to: emails(subscription.recipients),
        subject: content.subject,
        text: content.text,
        tripId: subscription.shareTripId,
        stepId,
      });
      await eventRef.set({ sentAt: Date.now(), pendingAt: null }, { merge: true });
      sent += emails(subscription.recipients).length;
    } catch (error) {
      await eventRef.set({
        pendingAt: null,
        lastError: error.message,
        failedAt: Date.now(),
      }, { merge: true });
    }
  }
  return { sent };
}
