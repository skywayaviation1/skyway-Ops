// api/send-push.js
//
// Vercel serverless function that dispatches a push notification when a new
// message is sent. Called fire-and-forget by firebase-comms.sendMessage so
// the chat write stays fast and the notification is best-effort.
//
// Trust-critical logic lives HERE. Get any of these wrong and you train
// users to disable notifications:
//
//   1. NEVER notify the sender about their own message.
//   2. NEVER notify a user who's not a participant in the conversation.
//   3. Respect per-user quiet hours (user-set, local-tz), UNLESS the
//      message is from an AOG-tagged thread AND the user hasn't opted
//      out of AOG override (default: AOGs punch through).
//   4. Respect per-conversation mute (users/{uid}/comms-mutes/{convId}).
//   5. If a token returns "not-registered" or "invalid-argument" from
//      FCM, prune it — that device uninstalled or revoked permission.
//
// Auth: idToken of the sender. We verify before doing anything.
//
// Body: { idToken, conversationId, message: { text, senderUid, senderName }, isAog? }

export const config = { runtime: 'nodejs', maxDuration: 30 };

// ---- Lazy Firebase Admin init (mirrors existing endpoints) ---------------
let cachedAdmin = null;
async function getAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const admin = await import('firebase-admin');
  if (!admin.apps || admin.apps.length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured on server');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
    admin.default.initializeApp({ credential: admin.default.credential.cert(parsed) });
  }
  cachedAdmin = admin.default;
  return cachedAdmin;
}

let cachedDb = null;
async function getDb() {
  if (cachedDb) return cachedDb;
  await getAdmin();
  const { getFirestore } = await import('firebase-admin/firestore');
  cachedDb = getFirestore(cachedAdmin.app(), 'appusers');
  return cachedDb;
}

// ---- Quiet-hours logic ---------------------------------------------------
//
// User document fields (all optional, sensible defaults if missing):
//   quietHours: { enabled: bool, startHour: 0..23, endHour: 0..23, tz: 'America/New_York' }
//   aogOverridesQuietHours: bool   (default true — AOG always wakes you)
//
// Hours wrap correctly: start=22, end=6 means "10pm through 6am", which
// crosses midnight; we handle that.
export function isInQuietHours(profile, now = new Date()) {
  if (!profile || !profile.quietHours || profile.quietHours.enabled === false) return false;
  const startH = Number(profile.quietHours.startHour);
  const endH = Number(profile.quietHours.endHour);
  if (!Number.isFinite(startH) || !Number.isFinite(endH)) return false;
  if (startH === endH) return false; // no window
  const tz = profile.quietHours.tz || 'UTC';

  // Get current hour in the user's tz. Intl.DateTimeFormat is correct under
  // DST without us having to ship a tz database.
  let hour;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).formatToParts(now);
    const h = parts.find((p) => p.type === 'hour');
    hour = h ? Number(h.value) : null;
    // Intl can return '24' for midnight in some locales; normalize.
    if (hour === 24) hour = 0;
  } catch (_) {
    return false; // bad tz -> don't suppress
  }
  if (hour == null) return false;

  if (startH < endH) {
    // Same-day window, e.g. 13..17.
    return hour >= startH && hour < endH;
  }
  // Wrap-midnight window, e.g. 22..6 means hours 22,23,0,1,2,3,4,5.
  return hour >= startH || hour < endH;
}

export function shouldSendToUser({ recipientProfile, isAog, isMuted }) {
  if (!recipientProfile) return { send: false, reason: 'no-profile' };
  if (recipientProfile.approved === false) return { send: false, reason: 'unapproved' };
  if (isMuted) return { send: false, reason: 'muted' };
  const quiet = isInQuietHours(recipientProfile);
  if (quiet) {
    const overrides = recipientProfile.aogOverridesQuietHours !== false; // default TRUE
    if (isAog && overrides) return { send: true, reason: 'aog-override' };
    return { send: false, reason: 'quiet-hours' };
  }
  return { send: true, reason: 'ok' };
}

// ---- Auth + main handler -------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    await getAdmin();
    const { idToken, conversationId, message, isAog } = req.body || {};
    if (!idToken)          return res.status(400).json({ error: 'idToken required' });
    if (!conversationId)   return res.status(400).json({ error: 'conversationId required' });
    if (!message || !message.senderUid) return res.status(400).json({ error: 'message.senderUid required' });

    // Verify the sender is who they say they are.
    let decoded;
    try {
      decoded = await cachedAdmin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: 'invalid token: ' + err.message });
    }
    if (decoded.uid !== message.senderUid) {
      return res.status(403).json({ error: 'sender uid mismatch' });
    }

    const db = await getDb();

    // Load conversation; participants gate the entire dispatch.
    const convSnap = await db.collection('conversations').doc(conversationId).get();
    if (!convSnap.exists) return res.status(404).json({ error: 'conversation not found' });
    const conv = convSnap.data();
    if (!Array.isArray(conv.participants) || !conv.participants.includes(decoded.uid)) {
      return res.status(403).json({ error: 'sender not a participant' });
    }

    // Build the recipient list — everyone in participants EXCEPT the sender.
    const recipients = conv.participants.filter((u) => u && u !== decoded.uid);
    if (recipients.length === 0) {
      return res.status(200).json({ ok: true, dispatched: 0, reason: 'no-other-participants' });
    }

    // Title & body. Lock-screen content is INCLUDED per operator decision.
    const senderName = message.senderName || 'Someone';
    const isGroupOrTrip = conv.kind === 'group' || conv.kind === 'trip' || conv.kind === 'aog' || conv.kind === 'sr';
    const title = isGroupOrTrip
      ? (conv.title || (conv.kind === 'aog' ? 'AOG' : 'Group'))
      : senderName;
    const bodyPrefix = isGroupOrTrip ? `${senderName}: ` : '';
    const rawText = (message.text || '').slice(0, 200);
    const body = `${bodyPrefix}${rawText}`.slice(0, 220);
    const url = `/?c=${encodeURIComponent(conversationId)}#comms`;
    const isAogFlag = !!isAog || conv.kind === 'aog';

    // Per-recipient: fetch profile + mute + tokens, apply filters, dispatch.
    const { getMessaging } = await import('firebase-admin/messaging');
    const messaging = getMessaging(cachedAdmin.app());

    let dispatched = 0;
    let suppressed = 0;
    let pruned = 0;
    const results = [];

    await Promise.all(recipients.map(async (uid) => {
      // Profile
      const profSnap = await db.collection('users').doc(uid).get();
      const profile = profSnap.exists ? profSnap.data() : null;
      // Mute (users/{uid}/comms-mutes/{convId})
      let isMuted = false;
      try {
        const muteSnap = await db.collection('users').doc(uid)
          .collection('comms-mutes').doc(conversationId).get();
        isMuted = muteSnap.exists && muteSnap.data().muted === true;
      } catch (_) { /* non-fatal */ }

      const decision = shouldSendToUser({ recipientProfile: profile, isAog: isAogFlag, isMuted });
      if (!decision.send) {
        suppressed++;
        results.push({ uid, sent: false, reason: decision.reason });
        return;
      }

      // Tokens — users/{uid}/push-tokens/{token}
      const tokSnap = await db.collection('users').doc(uid).collection('push-tokens').get();
      if (tokSnap.empty) {
        suppressed++;
        results.push({ uid, sent: false, reason: 'no-tokens' });
        return;
      }

      const tokens = [];
      tokSnap.forEach((d) => { const t = d.data().token; if (t) tokens.push(t); });

      // Dispatch data-only payload (the SW renders the OS notification
      // with our click behavior; FCM would otherwise auto-render and
      // skip our click handler).
      const payload = {
        data: {
          title,
          body,
          url,
          conversationId,
          senderUid: decoded.uid,
          senderName,
          kind: conv.kind || 'dm',
        },
        // android: high-priority so the device actually wakes up
        android: { priority: 'high' },
        // apns: alert+sound so iOS Safari PWA respects the priority
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', contentAvailable: true } },
        },
        webpush: {
          headers: { Urgency: 'high', TTL: '300' },
        },
      };

      // sendEachForMulticast lets us see per-token failures (so we prune).
      try {
        const r = await messaging.sendEachForMulticast({ tokens, ...payload });
        dispatched += r.successCount;
        results.push({ uid, sent: true, count: r.successCount, failed: r.failureCount });

        // Prune invalid tokens. FCM returns 'messaging/registration-token-not-registered'
        // when the device uninstalled or browser cleared storage.
        for (let i = 0; i < r.responses.length; i++) {
          const resp = r.responses[i];
          if (!resp.success) {
            const code = resp.error && (resp.error.code || resp.error.errorInfo?.code) || '';
            if (
              code.includes('registration-token-not-registered') ||
              code.includes('invalid-registration-token') ||
              code.includes('invalid-argument')
            ) {
              try {
                await db.collection('users').doc(uid)
                  .collection('push-tokens').doc(tokens[i]).delete();
                pruned++;
              } catch (_) { /* non-fatal */ }
            }
          }
        }
      } catch (e) {
        results.push({ uid, sent: false, reason: 'fcm-error: ' + (e.message || 'unknown') });
      }
    }));

    return res.status(200).json({ ok: true, dispatched, suppressed, pruned, results });
  } catch (err) {
    console.error('[send-push]', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
