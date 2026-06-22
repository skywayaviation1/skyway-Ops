// src/CommsStream.jsx
//
// Stream Chat-powered COMMS section. Replaces the old Firestore-based
// CommsScreen.jsx (which stays on disk as archive — see README).
//
// Auth flow:
//   1. On mount, POST /api/stream-token with the user's Firebase idToken.
//   2. Backend verifies, upserts the Stream user, returns a token + apiKey.
//   3. Initialize the Stream client and connect the user.
//   4. Auto-ensure channels exist for trips the user can see (so they
//      show up in the channel list without anyone manually creating them).
//
// Channels:
//   trip-{tripUid}   — per-trip group chat. Members = assigned crew + ops + admin.
//   dm-{a}-{b}       — 1:1 DM. Members = the two users, ids sorted.
//   team             — fleet-wide channel. Members = everyone.
//
// Theming: Stream uses CSS variables we override in commsStream.css to
// match Skyway's cyan-on-dark palette. We DO NOT use Stream's default
// light theme — looks wrong next to our UI.

import React, { useEffect, useMemo, useState } from 'react';
import { StreamChat } from 'stream-chat';
import {
  Chat,
  Channel,
  ChannelHeader,
  ChannelList,
  MessageInput,
  MessageList,
  Thread,
  Window,
} from 'stream-chat-react';
import 'stream-chat-react/dist/css/index.css';
import './commsStream.css';

import { Loader2, Plus, MessageCircle, X } from 'lucide-react';

/* ─────────────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────────────── */

// Stream channel ids are limited to [A-Za-z0-9_-], max 64 chars. UIDs from
// Firebase are already safe but we strip just in case.
function safeChannelId(raw) {
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

// DM channel id: sort the two UIDs so order doesn't matter. dm-{a}-{b}
// where a < b lexicographically. Means "Nick → Zach" and "Zach → Nick"
// resolve to the same channel.
function dmChannelId(uidA, uidB) {
  const [a, b] = [uidA, uidB].sort();
  return safeChannelId(`dm-${a}-${b}`).slice(0, 60);
}

function tripChannelId(tripUid) {
  return safeChannelId(`trip-${tripUid}`).slice(0, 60);
}

/* ─────────────────────────────────────────────────────────────────────
   Hook: connect to Stream
   ───────────────────────────────────────────────────────────────────── */

function useStreamClient(currentUser, getIdToken) {
  const [client, setClient] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let chatClient = null;

    (async () => {
      try {
        if (!currentUser?.uid) return;
        const idToken = await getIdToken();
        if (!idToken) throw new Error('No idToken from Firebase');

        // Mint a Stream token via our serverless proxy.
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

        chatClient = StreamChat.getInstance(apiKey);

        // Disconnect any previous user before connecting (handles fast user
        // switching during dev or impersonation flows).
        if (chatClient.userID && chatClient.userID !== user.id) {
          await chatClient.disconnectUser();
        }
        if (!chatClient.userID) {
          await chatClient.connectUser(
            {
              id: user.id,
              name: user.name,
            },
            token
          );
        }
        if (cancelled) {
          await chatClient.disconnectUser();
          return;
        }
        setClient(chatClient);
      } catch (err) {
        console.error('[CommsStream] connect failed:', err);
        if (!cancelled) setError(err.message || 'Connection failed');
      }
    })();

    return () => {
      cancelled = true;
      // Don't disconnect here — Stream's client is a singleton and
      // disconnecting on every unmount thrashes the connection during
      // route changes. We disconnect only on a hard sign-out, which
      // App.jsx already handles via its auth listener.
    };
  }, [currentUser?.uid, getIdToken]);

  return { client, error };
}

/* ─────────────────────────────────────────────────────────────────────
   Hook: ensure trip channels exist for the user's upcoming trips
   ───────────────────────────────────────────────────────────────────── */

function useEnsureTripChannels(client, currentUser, allTrips, users) {
  useEffect(() => {
    if (!client?.userID) return;
    if (!Array.isArray(allTrips) || allTrips.length === 0) return;

    // Limit to upcoming + active trips so we don't create channels for
    // every historical leg ever flown. Stream charges per channel.
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const upcoming = allTrips.filter((t) => {
      const ms = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
      return !isNaN(ms) && ms > now - 24 * 60 * 60 * 1000 && ms < now + SEVEN_DAYS;
    });

    // Map PIC/SIC names → uids by matching against the users list. For
    // crew not in the user roster (e.g., contract pilots), they just
    // won't be added as members — they'll need to be added manually if
    // they sign up later.
    function nameToUid(name) {
      if (!name) return null;
      const trimmed = name.trim().toLowerCase();
      const match = users.find((u) =>
        (u.name || '').toLowerCase() === trimmed ||
        (u.jetinsightName || '').toLowerCase() === trimmed
      );
      return match?.uid || null;
    }

    // Ops/admin uids are added to every trip channel so they have full
    // visibility without needing to be on the crew sheet.
    const opsAdminUids = users
      .filter((u) => u.role === 'ops' || u.role === 'admin' || u.role === 'maint')
      .map((u) => u.uid)
      .filter(Boolean);

    (async () => {
      for (const trip of upcoming) {
        try {
          const id = tripChannelId(trip.uid);
          const memberUids = new Set(opsAdminUids);
          memberUids.add(client.userID);  // always include caller
          const picUid = nameToUid(trip.info?.pic);
          const sicUid = nameToUid(trip.info?.sic);
          if (picUid) memberUids.add(picUid);
          if (sicUid) memberUids.add(sicUid);

          const ch = client.channel('messaging', id, {
            name: `${trip.info?.tail || ''} ${trip.info?.from || ''}→${trip.info?.to || ''}`,
            members: [...memberUids],
            // Custom fields surface in the channel list for our renderer.
            trip_uid: trip.uid,
            tail: trip.info?.tail || '',
            from: trip.info?.from || '',
            to: trip.info?.to || '',
            trip_start: trip.start instanceof Date
              ? trip.start.toISOString()
              : (trip.start || ''),
          });
          // .create() is idempotent — if the channel exists with the same
          // members, this is a no-op; if it's missing a member we just
          // added (e.g., a new ops user joined), it adds them.
          await ch.create();
        } catch (err) {
          // Don't fail the whole loop on one channel error
          console.warn(`[CommsStream] ensure trip channel failed: ${trip.uid}`, err.message);
        }
      }
    })();
  }, [client?.userID, allTrips, users]);
}

/* ─────────────────────────────────────────────────────────────────────
   NEW DM modal
   ───────────────────────────────────────────────────────────────────── */

function NewDmModal({ users, currentUser, client, onClose, onOpen }) {
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => u.uid && u.uid !== currentUser.uid && u.approved !== false)
      .filter((u) => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [users, query, currentUser.uid]);

  const startDm = async (otherUid) => {
    try {
      const id = dmChannelId(currentUser.uid, otherUid);
      const ch = client.channel('messaging', id, {
        members: [currentUser.uid, otherUid],
      });
      await ch.create();
      onOpen(ch);
      onClose();
    } catch (err) {
      console.error('[CommsStream] DM start failed:', err);
      alert('Could not start DM: ' + err.message);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700">
        <div className="flex items-center justify-between p-3 border-b border-slate-800">
          <h3 className="text-sm tracking-widest text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>NEW DIRECT MESSAGE</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or email…"
            className="w-full bg-slate-950 border border-slate-700 p-2 text-sm text-slate-100"
          />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-sm italic">No matches</div>
          ) : (
            candidates.map((u) => (
              <button
                key={u.uid}
                type="button"
                onClick={() => startDm(u.uid)}
                className="w-full text-left p-3 hover:bg-slate-800 border-b border-slate-800 last:border-b-0"
              >
                <div className="text-sm text-slate-100">{u.name || u.email}</div>
                <div className="text-[10px] text-slate-500"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {(u.role || 'crew').toUpperCase()}
                  {u.email && u.name ? ` · ${u.email}` : ''}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Main screen
   ───────────────────────────────────────────────────────────────────── */

export default function CommsStreamScreen({ currentUser, users = [], allTrips = [], getIdToken }) {
  const { client, error } = useStreamClient(currentUser, getIdToken);
  useEnsureTripChannels(client, currentUser, allTrips, users);

  const [showNewDm, setShowNewDm] = useState(false);

  // Channel list filters. We split into DMs (only the caller's two-person
  // channels) and TRIPS (channels with trip_uid set). Both are filtered to
  // ones the caller is a member of.
  const filters = useMemo(() => {
    if (!client?.userID) return null;
    return {
      type: 'messaging',
      members: { $in: [client.userID] },
    };
  }, [client?.userID]);

  const sort = useMemo(() => ({ last_message_at: -1 }), []);
  const options = useMemo(() => ({ state: true, presence: true, limit: 30 }), []);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="text-red-400 text-sm mb-2"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            CHAT CONNECTION FAILED
          </div>
          <div className="text-slate-400 text-xs">{error}</div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 text-[11px] tracking-widest border border-slate-700 text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            RETRY
          </button>
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Connecting to chat…
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 comms-stream">
      <Chat client={client} theme="str-chat__theme-dark">
        <div className="flex h-full min-h-0">
          {/* SIDEBAR — channel list */}
          <aside className="w-72 shrink-0 border-r border-slate-800 flex flex-col bg-slate-950/60">
            <div className="p-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm tracking-widest text-slate-200"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>COMMS</h2>
              <button
                type="button"
                onClick={() => setShowNewDm(true)}
                className="flex items-center gap-1.5 px-2 py-1 text-[10px] tracking-widest text-cyan-300 hover:text-cyan-200 border border-cyan-500/30 hover:border-cyan-400"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
                title="Start a new direct message"
              >
                <Plus className="w-3 h-3" /> NEW DM
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <ChannelList
                filters={filters}
                sort={sort}
                options={options}
                showChannelSearch
              />
            </div>
          </aside>

          {/* MAIN PANE — active channel */}
          <main className="flex-1 flex flex-col min-w-0">
            <Channel>
              <Window>
                <ChannelHeader />
                <MessageList />
                <MessageInput />
              </Window>
              <Thread />
            </Channel>
          </main>
        </div>
      </Chat>

      {showNewDm && (
        <NewDmModal
          users={users}
          currentUser={currentUser}
          client={client}
          onClose={() => setShowNewDm(false)}
          onOpen={(ch) => {
            // Stream's ChannelList listens to channel events — the new
            // channel will appear at the top of the list automatically
            // and click into it via the user's tap. No imperative
            // selection needed.
          }}
        />
      )}
    </div>
  );
}
