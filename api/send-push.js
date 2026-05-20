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
// Body shape — choose ONE of:
//   { idToken, conversationId, message: {text, senderUid, senderName}, isAog? }
//   { idToken, tripId,         message: {text, senderUid, senderName}, isAog? }
//
// For trip dispatch, recipients are computed server-side as:
//   PIC of the trip (name-matched against user.name)
//   + SIC of the trip (name-matched against user.name)
//   + dispatchers:
//       - if trip.dispatcherUids is set and non-empty: those exact users
//       - otherwise: ALL users with role: 'ops' (Path 1 fallback for
//         legacy trips that predate the dispatcherUids field)
//   - sender (never notify self)

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

// ---- Name matching (mirrors src/App.jsx nameMatchesPilot) ----------------
// Matches a JetInsight-style name (e.g. "David Michael Chiles") against a
// user-profile name ("David Chiles") by requiring first AND last token of
// the profile name to both appear as whole words in the trip name.
// Kept in sync with the client-side helper so trip ownership matches
// symmetrically between "is this my trip" and "should I get push for it."
export function nameMatchesPilot(tripPilotName, userName) {
  if (!tripPilotName || !userName) return false;
  const tokens = String(userName).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const target = String(tripPilotName).toLowerCase();
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = (w) => new RegExp(`\\b${escape(w)}\\b`, 'i');
  return wordRe(first).test(target) && wordRe(last).test(target);
}

// ---- Auth + main handler -------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    await getAdmin();
    const { idToken, conversationId, tripId, message, isAog } = req.body || {};
    if (!idToken)          return res.status(400).json({ error: 'idToken required' });
    if (!conversationId && !tripId) return res.status(400).json({ error: 'conversationId or tripId required' });
    if (!message || !message.senderUid) return res.status(400).json({ error: 'message.senderUid required' });

    // Verify the sender is who they say they are.
    let decoded;
    try {
      decoded = await cachedAdmin.auth().verifyIdToken(idToken);
    } catch (err) {
      console.warn('[send-push] 401 invalid token:', err.message);
      return res.status(401).json({ error: 'invalid token: ' + err.message });
    }
    if (decoded.uid !== message.senderUid) {
      console.warn('[send-push] 403 sender uid mismatch',
        { tokenUid: decoded.uid, claimedSenderUid: message.senderUid, conversationId, tripId });
      return res.status(403).json({
        error: 'sender uid mismatch',
        tokenUid: decoded.uid,
        claimedSenderUid: message.senderUid,
      });
    }

    const db = await getDb();
    const senderName = message.senderName || 'Someone';
    const rawText = (message.text || '').slice(0, 200);

    // === Branch on dispatch type ===
    //   - conversationId : DM, group, or other conversations/{} thread
    //   - tripId         : trips/{}/messages legacy trip thread
    let recipients, title, body, url, isAogFlag, muteKey, threadKind;

    if (tripId) {
      // ---- TRIP THREAD ----
      const tripSnap = await db.collection('trips').doc(tripId).get();
      if (!tripSnap.exists) {
        console.warn('[send-push] 404 trip not found', { tripId, tokenUid: decoded.uid });
        return res.status(404).json({ error: 'trip not found', tripId });
      }
      const trip = tripSnap.data();
      const info = trip.info || {};

      // Resolve recipients: PIC (name-matched) + SIC (name-matched) +
      // every user with role: 'ops'. Caller (firebase-comms) is
      // expected to also flag isAog for trips that are AOG-tagged.
      const usersSnap = await db.collection('users').get();
      const allUsers = [];
      usersSnap.forEach((d) => allUsers.push({ uid: d.id, ...d.data() }));

      const matchedUids = new Set();
      const why = {};
      const picName = info.pic || '';
      const sicName = info.sic || '';
      const explicitDispatchers = Array.isArray(trip.dispatcherUids) ? trip.dispatcherUids : null;
      const useExplicitDispatchers = explicitDispatchers && explicitDispatchers.length > 0;

      for (const u of allUsers) {
        if (!u.uid) continue;
        if (u.approved === false) continue;
        // PIC name match
        if (picName && u.name && nameMatchesPilot(picName, u.name)) {
          matchedUids.add(u.uid); why[u.uid] = (why[u.uid] || []).concat(['PIC']);
        }
        // SIC name match
        if (sicName && u.name && nameMatchesPilot(sicName, u.name)) {
          matchedUids.add(u.uid); why[u.uid] = (why[u.uid] || []).concat(['SIC']);
        }
        // Dispatchers: prefer the explicit per-trip list when present;
        // otherwise fall back to "all ops users" (Path 1 behavior for
        // legacy trips without the dispatcherUids field).
        if (useExplicitDispatchers) {
          if (explicitDispatchers.includes(u.uid)) {
            matchedUids.add(u.uid); why[u.uid] = (why[u.uid] || []).concat(['dispatcher']);
          }
        } else if (u.role === 'ops') {
          matchedUids.add(u.uid); why[u.uid] = (why[u.uid] || []).concat(['ops-fallback']);
        }
      }

      // Self-skip: never notify the sender.
      matchedUids.delete(decoded.uid);

      recipients = Array.from(matchedUids);
      threadKind = 'trip';
      title = `Trip · ${info.tail || trip.tail || 'Comms'}`;
      body = `${senderName}: ${rawText}`.slice(0, 220);
      url = `/?trip=${encodeURIComponent(tripId)}#chat`;
      isAogFlag = !!isAog; // client tags this true for trips with active AOG
      muteKey = `trip:${tripId}`;

      console.log('[send-push] trip dispatch resolving',
        { tripId, picName, sicName, matched: recipients.length, why });

      if (recipients.length === 0) {
        return res.status(200).json({ ok: true, dispatched: 0, reason: 'no-recipients-resolved' });
      }
    } else {
      // ---- CONVERSATION (DM / group / etc.) ----
      const convSnap = await db.collection('conversations').doc(conversationId).get();
      if (!convSnap.exists) {
        console.warn('[send-push] 404 conversation not found',
          { conversationId, tokenUid: decoded.uid });
        return res.status(404).json({ error: 'conversation not found', conversationId });
      }
      const conv = convSnap.data();
      if (!Array.isArray(conv.participants) || !conv.participants.includes(decoded.uid)) {
        console.warn('[send-push] 403 sender not a participant',
          { tokenUid: decoded.uid, participants: conv.participants, conversationId, kind: conv.kind });
        return res.status(403).json({
          error: 'sender not a participant',
          tokenUid: decoded.uid,
          participants: conv.participants,
        });
      }
      recipients = conv.participants.filter((u) => u && u !== decoded.uid);
      if (recipients.length === 0) {
        return res.status(200).json({ ok: true, dispatched: 0, reason: 'no-other-participants' });
      }
      threadKind = conv.kind || 'dm';
      const isGroup = threadKind === 'group' || threadKind === 'trip' || threadKind === 'aog' || threadKind === 'sr';
      title = isGroup ? (conv.title || (threadKind === 'aog' ? 'AOG' : 'Group')) : senderName;
      body = (isGroup ? `${senderName}: ` : '') + rawText;
      body = body.slice(0, 220);
      url = `/?c=${encodeURIComponent(conversationId)}#comms`;
      isAogFlag = !!isAog || threadKind === 'aog';
      muteKey = conversationId;
    }

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
      // Mute (users/{uid}/comms-mutes/{muteKey})
      let isMuted = false;
      try {
        const muteSnap = await db.collection('users').doc(uid)
          .collection('comms-mutes').doc(muteKey).get();
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

      const payload = {
        data: {
          title,
          body,
          url,
          conversationId: conversationId || '',
          tripId: tripId || '',
          senderUid: decoded.uid,
          senderName,
          kind: threadKind,
        },
        android: { priority: 'high' },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', contentAvailable: true } },
        },
        webpush: {
          headers: { Urgency: 'high', TTL: '300' },
        },
      };

      try {
        const r = await messaging.sendEachForMulticast({ tokens, ...payload });
        dispatched += r.successCount;
        results.push({ uid, sent: true, count: r.successCount, failed: r.failureCount });

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
