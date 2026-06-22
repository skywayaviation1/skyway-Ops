// src/stream-presence.jsx
//
// Persistent Stream Chat presence layer. Mounted near the top of the
// signed-in tree (in App.jsx). Two responsibilities:
//
//   1. Maintain a single, app-lifetime Stream client connection so
//      unread-count events flow even when the user is not on COMMS.
//      Exposes totalUnread and per-channel unread via React Context.
//
//   2. Register the user's FCM push tokens with Stream's 'firebase'
//      push provider so Stream's server can send pushes when the user
//      is offline. Reads tokens from users/{uid}.fcmTokens — the same
//      array Skyway's existing PushSettings flow writes to. Re-syncs
//      whenever the doc changes.
//
// Why "persistent": CommsStream and TripChatStream each call their own
// useStreamClient hook, but those only fire when their component is
// mounted. To get badges on the COMMS top-nav tab when the user is
// somewhere completely different in the app, we need a connection that
// outlives any one screen. StreamChat.getInstance() is a singleton —
// connecting here means CommsStream/TripChatStream find an already-
// connected client when they mount (their own connectUser becomes a
// no-op).
//
// IMPORTANT: stream-chat is dynamically imported inside the provider's
// effect, NOT at the top of this file. That lets App.jsx import
// { useStreamPresence, useTripUnread } statically (for the hooks)
// without pulling stream-chat into the main bundle. The 'stream-chat'
// chunk only loads when the provider actually mounts (i.e. after the
// user signs in).

import React, { createContext, useContext, useEffect, useState } from 'react';

/* ─────────────────────────────────────────────────────────────────────
   Context
   ───────────────────────────────────────────────────────────────────── */

const PresenceContext = createContext({
  totalUnread: 0,    // Sum of DM + group unreads (trip-channels excluded;
                     // those surface as per-trip badges instead).
  channelUnread: {}, // { [cid]: count } for every channel with unread.
                     // cid is `messaging:trip-{tripUid}` for trip channels.
  isConnected: false,
});

export function useStreamPresence() {
  return useContext(PresenceContext);
}

// Convenience hook for trip-detail badges. Returns the unread count for
// a specific trip's channel, or 0 if the channel hasn't been opened yet
// or has no unread.
export function useTripUnread(tripUid) {
  const { channelUnread } = useStreamPresence();
  if (!tripUid) return 0;
  // Channel id format must match what TripChatStream uses to create the
  // channel. See `tripChannelId` in CommsStream.jsx for the exact rules.
  const safe = String(tripUid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const id = `trip-${safe}`.slice(0, 60);
  return channelUnread[`messaging:${id}`] || 0;
}

/* ─────────────────────────────────────────────────────────────────────
   Provider
   ───────────────────────────────────────────────────────────────────── */

export function StreamPresenceProvider({ currentUser, getIdToken, children }) {
  const [channelUnread, setChannelUnread] = useState({});
  const [isConnected, setIsConnected] = useState(false);

  // Derived: total unread COUNTS DM and group channels only. Trip channels
  // are excluded from the COMMS top-nav badge because clicking COMMS won't
  // get the user to those messages anyway — they live inside trip detail.
  // Each trip's tab gets its own per-channel badge via useTripUnread().
  const totalUnread = React.useMemo(() => {
    let sum = 0;
    for (const [cid, n] of Object.entries(channelUnread)) {
      if (cid.startsWith('messaging:trip-')) continue;
      sum += n;
    }
    return sum;
  }, [channelUnread]);

  useEffect(() => {
    // Tear down on sign-out / user switch.
    if (!currentUser?.uid) {
      setChannelUnread({});
      setIsConnected(false);
      return;
    }

    let cancelled = false;
    let streamClient = null;
    const cleanups = [];
    const registeredFcmTokens = new Set();

    (async () => {
      try {
        // 0. Lazy-load stream-chat so the sign-in screen doesn't pay
        //    for it. StreamChat.getInstance returns the same singleton
        //    that CommsStream / TripChatStream use, so no duplicate
        //    connections.
        const { StreamChat } = await import('stream-chat');

        // 1. Mint Stream token via backend (also bulk-syncs all approved
        //    users to Stream so any of them can be channel members later).
        const idToken = await getIdToken();
        if (!idToken) throw new Error('No Firebase idToken');

        const resp = await fetch('/api/stream-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || `Token mint failed (${resp.status})`);
        }
        const { token, apiKey, user } = await resp.json();
        if (cancelled) return;

        // 2. Connect the Stream singleton. If a previous user is still
        //    on the client (admin impersonation switched), drop them
        //    first so we don't end up with mixed state.
        streamClient = StreamChat.getInstance(apiKey);
        if (streamClient.userID && streamClient.userID !== user.id) {
          await streamClient.disconnectUser();
        }
        if (!streamClient.userID) {
          await streamClient.connectUser({ id: user.id, name: user.name }, token);
        }
        if (cancelled) return;

        // 3. Initial unread state: query all channels the user is a
        //    member of, read their unread counts. This is one batched
        //    Stream API call (watch:false so we don't subscribe to each
        //    channel — events for new messages still arrive via the
        //    notification.message_new firehose).
        try {
          const channels = await streamClient.queryChannels(
            { members: { $in: [user.id] } },
            { last_message_at: -1 },
            { state: true, watch: false, presence: false, limit: 50 }
          );
          if (cancelled) return;
          const initial = {};
          for (const ch of channels) {
            const n = ch.countUnread();
            if (n > 0 && ch.cid) initial[ch.cid] = n;
          }
          setChannelUnread(initial);
        } catch (err) {
          // Non-fatal — events below will populate the map on the next
          // incoming message.
          console.warn('[StreamPresence] initial queryChannels failed:', err?.message || err);
        }
        if (!cancelled) setIsConnected(true);

        // 4. Live updates. Stream fires:
        //      notification.message_new — message arrived in a channel the
        //        user is a member of but NOT actively watching. Has cid and
        //        a per-channel unread_count field.
        //      message.new — message in a watched channel (rare for our
        //        usage; usually only fires for the channel the user is
        //        actively reading, which would auto-mark-read).
        //      notification.mark_read — user marked one channel read.
        //        cid present.
        //      notification.mark_unread — user marked unread. Treat as new.
        //    Stream re-issues these on reconnect, so the map stays
        //    consistent across short network blips.
        const onMsgNew = (event) => {
          if (cancelled || !event?.cid) return;
          setChannelUnread((prev) => ({
            ...prev,
            [event.cid]:
              typeof event.unread_count === 'number'
                ? event.unread_count
                : (prev[event.cid] || 0) + 1,
          }));
        };
        const onMarkRead = (event) => {
          if (cancelled) return;
          if (!event?.cid) {
            // Bulk mark-all-read — wipe everything.
            setChannelUnread({});
            return;
          }
          setChannelUnread((prev) => {
            const next = { ...prev };
            delete next[event.cid];
            return next;
          });
        };

        streamClient.on('notification.message_new', onMsgNew);
        streamClient.on('notification.mark_unread', onMsgNew);
        streamClient.on('notification.mark_read', onMarkRead);

        cleanups.push(() => streamClient.off('notification.message_new', onMsgNew));
        cleanups.push(() => streamClient.off('notification.mark_unread', onMsgNew));
        cleanups.push(() => streamClient.off('notification.mark_read', onMarkRead));

        // 5. FCM device registration. Skyway's PushSettings flow writes
        //    each device's FCM token as a document in the SUBCOLLECTION
        //    `users/{uid}/push-tokens`. Each doc looks like:
        //      { token: 'cfSz6YM9...:APA91bFI...',
        //        platform: 'ios' | 'web' | 'android',
        //        userAgent: '...',
        //        createdAt, lastSeenAt }
        //    The token field is what Stream's 'firebase' provider needs;
        //    Stream relays it through FCM to APNs for iOS PWAs.
        //
        //    We watch the subcollection and register each token with
        //    Stream as a separate device. registeredFcmTokens guards
        //    against duplicate API calls — Stream dedupes server-side
        //    too, but skipping when we know we already pushed it is
        //    cheaper.
        try {
          const { db } = await import('./firebase.js');
          const { collection, onSnapshot } = await import('firebase/firestore');
          const tokensRef = collection(db, 'users', user.id, 'push-tokens');

          const unsubTokens = onSnapshot(
            tokensRef,
            async (snap) => {
              if (cancelled) return;
              for (const docSnap of snap.docs) {
                const data = docSnap.data();
                const fcmToken = data?.token;
                if (!fcmToken) continue;
                if (registeredFcmTokens.has(fcmToken)) continue;
                try {
                  // Device id can be any stable string per device. The
                  // FCM token itself is the most stable identifier we
                  // have (per device + per app install). Sanitize to
                  // Stream's allowed chars and trim to a tail slice so
                  // it fits comfortably in Stream's 60-char limit.
                  const deviceId =
                    'fcm-' +
                    fcmToken
                      .slice(-32)
                      .replace(/[^A-Za-z0-9_-]/g, '_');
                  await streamClient.addDevice(fcmToken, 'firebase', deviceId);
                  registeredFcmTokens.add(fcmToken);
                  console.log(
                    '[StreamPresence] FCM device registered with Stream:',
                    deviceId,
                    '(platform:', data.platform || 'unknown', ')'
                  );
                } catch (err) {
                  // Most commonly fails with "InvalidArgument" if the
                  // Stream dashboard hasn't been configured with a
                  // Firebase service account yet, or if the token is
                  // dead. Both are recoverable — log and move on.
                  console.warn(
                    '[StreamPresence] addDevice failed (token may be stale or dashboard not configured):',
                    err?.message || err
                  );
                }
              }
            },
            (err) => {
              console.warn('[StreamPresence] push-tokens snapshot error:', err);
            }
          );
          cleanups.push(unsubTokens);
        } catch (err) {
          console.warn(
            '[StreamPresence] FCM device hookup failed (push will not work for this session):',
            err?.message || err
          );
        }
      } catch (err) {
        console.warn('[StreamPresence] connect failed:', err?.message || err);
        if (!cancelled) setIsConnected(false);
      }
    })();

    return () => {
      cancelled = true;
      for (const fn of cleanups) {
        try { fn(); } catch {}
      }
      // We do NOT call disconnectUser() here. The Stream singleton is
      // shared with CommsStream and TripChatStream — disconnecting would
      // tear out a connection that other surfaces depend on. The cleanup
      // path above already removes our event handlers, which is what
      // this effect actually owns.
      //
      // Disconnect happens implicitly when the user signs out: the new
      // currentUser?.uid is null, the effect's early return above wipes
      // state, and the next sign-in's connectUser swaps the user cleanly.
    };
  }, [currentUser?.uid, getIdToken]);

  const value = React.useMemo(
    () => ({ totalUnread, channelUnread, isConnected }),
    [totalUnread, channelUnread, isConnected]
  );

  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}
