// Stream Chat -> Skyway FCM bridge.
//
// Stream remains the source of truth for messages. This webhook is only the
// notification delivery plane, so Skyway's existing controls apply to every
// message: per-chat mute, quiet hours, AOG override, private previews and dead
// token pruning. Configure this endpoint for the `message.new` event in the
// Stream dashboard. STREAM_API_SECRET signs the raw request body.

import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { StreamChat } from 'stream-chat';

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
  api: { bodyParser: false },
};

let adminApp;
let db;
let stream;

function getAdmin() {
  if (adminApp) return adminApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  const credential = admin.credential.cert(JSON.parse(raw));
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential });
  return adminApp;
}

function getDb() {
  if (!db) db = getFirestore(getAdmin(), 'appusers');
  return db;
}

function getStream() {
  if (stream) return stream;
  const key = process.env.STREAM_API_KEY;
  const secret = process.env.STREAM_API_SECRET;
  if (!key || !secret) throw new Error('Stream credentials not configured');
  stream = StreamChat.getInstance(key, secret);
  return stream;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function validSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isInQuietHours(profile, now = new Date()) {
  const q = profile?.quietHours;
  if (!q || q.enabled === false) return false;
  const start = Number(q.startHour);
  const end = Number(q.endHour);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  let hour;
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone: q.tz || 'UTC',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now).find((p) => p.type === 'hour');
    hour = Number(part?.value);
    if (hour === 24) hour = 0;
  } catch {
    return false;
  }
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function shouldNotify(profile, { muted = false, isAog = false } = {}) {
  if (!profile || profile.approved === false || profile.active === false) return false;
  if (muted) return false;
  if (!isInQuietHours(profile)) return true;
  return isAog && profile.aogOverridesQuietHours !== false;
}

function safeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function messageSummary(message) {
  if (String(message?.text || '').trim()) return String(message.text).trim();
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return 'New message';
  const type = attachments[0]?.type;
  if (type === 'image') return 'Sent a photo';
  if (type === 'video') return 'Sent a video';
  if (type === 'audio' || type === 'voiceRecording') return 'Sent a voice message';
  if (type === 'file') return 'Sent a file';
  return 'Sent an attachment';
}

function memberIds(state) {
  const raw = state?.members || state?.channel?.members || [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return [...new Set(list.map((m) => m?.user_id || m?.user?.id || m?.id).filter(Boolean))];
}

async function pruneDeadTokens(database, uid, tokens, response) {
  const staleCodes = [
    'registration-token-not-registered',
    'invalid-registration-token',
    'invalid-argument',
  ];
  await Promise.all(response.responses.map(async (item, index) => {
    if (item.success) return;
    const code = item.error?.code || item.error?.errorInfo?.code || '';
    if (!staleCodes.some((part) => code.includes(part))) return;
    await database.collection('users').doc(uid)
      .collection('push-tokens').doc(tokens[index]).delete().catch(() => {});
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const raw = await readRawBody(req);
    const signature = req.headers['x-signature'] || req.headers['x-stream-signature'];
    const sentApiKey = req.headers['x-api-key'];
    if (sentApiKey && sentApiKey !== process.env.STREAM_API_KEY) {
      return res.status(401).json({ error: 'invalid Stream API key' });
    }
    let event;
    try {
      // The SDK handles both normal and Stream's optional compressed webhook
      // envelope while still verifying the exact raw bytes.
      event = getStream().verifyAndParseWebhook(raw, signature);
    } catch {
      return res.status(401).json({ error: 'invalid webhook signature' });
    }
    if (event.type !== 'message.new' || !event.message) {
      return res.status(200).json({ ok: true, ignored: event.type || 'unknown' });
    }
    if (event.message.silent || event.message.shadowed) {
      return res.status(200).json({ ok: true, ignored: 'silent-message' });
    }

    const senderUid = event.message.user?.id || event.user?.id;
    const senderName = event.message.user?.name || event.user?.name || 'Skyway teammate';
    const channelType = event.channel_type || event.channel?.type || 'messaging';
    const channelId = event.channel_id || event.channel?.id;
    if (!event.message.id || !senderUid || !channelId) {
      return res.status(400).json({ error: 'message id/sender/channel missing' });
    }

    const database = getDb();

    // Stream retries webhooks. A completed marker suppresses later attempts.
    // We intentionally write it only after delivery: claiming before FCM would
    // turn a transient Firebase outage into a permanently lost notification.
    // Two concurrent attempts can still race, but Stream retries are serial in
    // normal operation and an occasional duplicate is safer than a missed AOG.
    const eventRef = database.collection('stream-push-events').doc(safeKey(event.message.id));
    if ((await eventRef.get()).exists) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const channel = getStream().channel(channelType, channelId);
    const state = await channel.query({ state: true, watch: false, presence: false });
    const recipients = memberIds(state).filter((uid) => uid !== senderUid);
    const data = state.channel || event.channel || {};
    const isTrip = data.is_trip === true || channelId.startsWith('trip-');
    const isAog = data.is_aog === true;
    const title = isTrip
      ? [data.tail, data.from && data.to ? `${data.from}→${data.to}` : ''].filter(Boolean).join(' · ') || 'Trip comms'
      : (data.name || (recipients.length === 1 ? senderName : 'Skyway group'));
    const preview = messageSummary(event.message).slice(0, 180);
    const url = isTrip && data.trip_uid
      ? `/?trip=${encodeURIComponent(data.trip_uid)}#chat`
      : `/?channel=${encodeURIComponent(channelId)}#comms`;
    const muteKey = `stream-${safeKey(channelId)}`;
    const messaging = getMessaging(getAdmin());

    let sent = 0;
    let suppressed = 0;
    await Promise.all(recipients.map(async (uid) => {
      const [profileSnap, muteSnap, tokenSnap] = await Promise.all([
        database.collection('users').doc(uid).get(),
        database.collection('users').doc(uid).collection('comms-mutes').doc(muteKey).get(),
        database.collection('users').doc(uid).collection('push-tokens').get(),
      ]);
      const profile = profileSnap.exists ? profileSnap.data() : null;
      const muted = muteSnap.exists && muteSnap.data().muted === true;
      if (!shouldNotify(profile, { muted, isAog })) {
        suppressed += 1;
        return;
      }
      const tokens = tokenSnap.docs.map((d) => d.data()?.token).filter(Boolean);
      if (!tokens.length) {
        suppressed += 1;
        return;
      }

      const showPreview = profile.messagePreviewInNotifications !== false;
      const body = showPreview
        ? `${senderName}: ${preview}`.slice(0, 220)
        : (isTrip ? 'New trip message' : 'New message');
      const response = await messaging.sendEachForMulticast({
        tokens,
        data: {
          title,
          body,
          url,
          channelId,
          senderUid,
          senderName,
          kind: isTrip ? 'trip' : 'stream',
        },
        android: { priority: 'high' },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', contentAvailable: true } },
        },
        webpush: { headers: { Urgency: isAog ? 'high' : 'normal', TTL: '300' } },
      });
      sent += response.successCount;
      await pruneDeadTokens(database, uid, tokens, response);
    }));

    await eventRef.set({
      channelId,
      senderUid,
      sent,
      suppressed,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    return res.status(200).json({
      ok: true,
      channelId,
      recipients: recipients.length,
      sent,
      suppressed,
    });
  } catch (err) {
    console.error('[stream-webhook]', err);
    return res.status(500).json({ error: 'webhook delivery failed' });
  }
}
