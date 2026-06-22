// src/CommsStream.jsx
//
// Two surfaces, one file:
//
//   <CommsStreamScreen>   default export — the main COMMS section in the top
//                         nav. Shows DMs and ad-hoc group chats. Trip-specific
//                         channels are hidden here (they live inside each
//                         trip's COMMS tab instead).
//
//   <TripChatStream>      named export — single-trip chat used by TripDetail's
//                         COMMS tab. Renders just the one channel for that
//                         trip, with auto-add of the right members on first
//                         open. No channel list, no global UI.
//
// Both share the same Stream client (singleton — Stream's React SDK is
// designed so multiple <Channel> components can coexist on one client).

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
import 'stream-chat-react/dist/css/v2/index.css';
import './commsStream.css';

import { Loader2, Plus, X, MessageCircle, Users as UsersIcon, Check } from 'lucide-react';

/* ─────────────────────────────────────────────────────────────────────
   Channel id helpers
   ───────────────────────────────────────────────────────────────────── */

// Stream channel ids are limited to [A-Za-z0-9_-], max 64 chars.
function safeChannelId(raw) {
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function dmChannelId(uidA, uidB) {
  const [a, b] = [uidA, uidB].sort();
  return safeChannelId(`dm-${a}-${b}`).slice(0, 60);
}

function tripChannelId(tripUid) {
  return safeChannelId(`trip-${tripUid}`).slice(0, 60);
}

// Group channel id — short timestamp + random suffix for uniqueness.
// Group names are stored in the channel's `name` custom field separately.
function groupChannelId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return safeChannelId(`group-${ts}-${rand}`);
}

/* ─────────────────────────────────────────────────────────────────────
   Hook: connect to Stream (shared by both surfaces)
   ───────────────────────────────────────────────────────────────────── */

function useStreamClient(currentUser, getIdToken) {
  const [client, setClient] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!currentUser?.uid) return;
        const idToken = await getIdToken();
        if (!idToken) throw new Error('No idToken from Firebase');

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

        const chatClient = StreamChat.getInstance(apiKey);

        // Stream's React SDK uses one singleton client. If a previous user
        // is still connected (e.g. admin impersonation switched), drop them
        // before connecting the new one. If the same user is already
        // connected, skip the redundant connect.
        if (chatClient.userID && chatClient.userID !== user.id) {
          await chatClient.disconnectUser();
        }
        if (!chatClient.userID) {
          await chatClient.connectUser(
            { id: user.id, name: user.name },
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
      // Don't disconnect on unmount — the singleton is shared across
      // CommsStreamScreen and TripChatStream. Sign-out is what tears it
      // down, handled by App.jsx's auth listener.
    };
  }, [currentUser?.uid, getIdToken]);

  return { client, error };
}

/* ─────────────────────────────────────────────────────────────────────
   Helpers: trip channel members
   ───────────────────────────────────────────────────────────────────── */

// Given a trip and the users roster, derive the uids that should be
// channel members for the trip's chat:
//   - caller (passed in)
//   - assigned PIC and SIC (matched by name against `users`)
//   - all ops / admin / maint (so dispatch and maintenance can chime in)
//
// Returns a sorted, deduplicated array of uids.
function deriveTripMemberUids(trip, currentUid, users) {
  const set = new Set();
  if (currentUid) set.add(currentUid);

  const opsRoles = new Set(['ops', 'admin', 'maint']);
  for (const u of users) {
    if (u.uid && opsRoles.has(u.role)) set.add(u.uid);
  }

  function nameToUid(name) {
    if (!name) return null;
    const trimmed = String(name).trim().toLowerCase();
    if (!trimmed) return null;
    const match = users.find((u) =>
      (u.name || '').toLowerCase() === trimmed ||
      (u.jetinsightName || '').toLowerCase() === trimmed
    );
    return match?.uid || null;
  }
  const picUid = nameToUid(trip?.info?.pic);
  const sicUid = nameToUid(trip?.info?.sic);
  if (picUid) set.add(picUid);
  if (sicUid) set.add(sicUid);

  return [...set];
}

/* ─────────────────────────────────────────────────────────────────────
   NEW DM modal
   ───────────────────────────────────────────────────────────────────── */

function NewDmModal({ users, currentUser, client, onClose }) {
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
   NEW GROUP modal — multi-select picker + group name
   ───────────────────────────────────────────────────────────────────── */

function NewGroupModal({ users, currentUser, client, onClose }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => u.uid && u.uid !== currentUser.uid && u.approved !== false)
      .filter((u) => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [users, query, currentUser.uid]);

  const toggle = (uid) => {
    setSelected((s) => {
      const next = new Set(s);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });
  };

  const create = async () => {
    if (selected.size === 0) {
      alert('Pick at least one member.');
      return;
    }
    if (creating) return;
    setCreating(true);
    try {
      const id = groupChannelId();
      const members = [currentUser.uid, ...selected];
      const ch = client.channel('messaging', id, {
        members,
        // Custom field so the channel header / list shows a meaningful
        // name. If the user didn't type one, derive from member count.
        name: name.trim() || `Group · ${members.length} people`,
        // Marker so the main COMMS filter can distinguish groups from
        // trip channels (which set is_trip: true). Groups aren't trip-
        // scoped; they appear in main COMMS only.
        is_group: true,
      });
      await ch.create();
      onClose();
    } catch (err) {
      console.error('[CommsStream] group create failed:', err);
      alert('Could not create group: ' + err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-3 border-b border-slate-800 shrink-0">
          <h3 className="text-sm tracking-widest text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>NEW GROUP CHAT</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3 space-y-2 shrink-0 border-b border-slate-800">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name (optional)…"
            className="w-full bg-slate-950 border border-slate-700 p-2 text-sm text-slate-100"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members…"
            className="w-full bg-slate-950 border border-slate-700 p-2 text-sm text-slate-100"
          />
          <div className="text-[10px] text-slate-500"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {selected.size} SELECTED
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-sm italic">No matches</div>
          ) : (
            candidates.map((u) => {
              const isSelected = selected.has(u.uid);
              return (
                <button
                  key={u.uid}
                  type="button"
                  onClick={() => toggle(u.uid)}
                  className={`w-full text-left p-3 border-b border-slate-800 last:border-b-0 flex items-center justify-between ${
                    isSelected ? 'bg-cyan-500/10 hover:bg-cyan-500/15' : 'hover:bg-slate-800'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-slate-100 truncate">{u.name || u.email}</div>
                    <div className="text-[10px] text-slate-500"
                      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {(u.role || 'crew').toUpperCase()}
                      {u.email && u.name ? ` · ${u.email}` : ''}
                    </div>
                  </div>
                  <div className={`w-5 h-5 border ${isSelected ? 'border-cyan-400 bg-cyan-500/20' : 'border-slate-700'} flex items-center justify-center shrink-0`}>
                    {isSelected && <Check className="w-3 h-3 text-cyan-300" />}
                  </div>
                </button>
              );
            })
          )}
        </div>
        <div className="p-3 border-t border-slate-800 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-2 text-[11px] tracking-widest text-slate-400 hover:text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >CANCEL</button>
          <button
            onClick={create}
            disabled={creating || selected.size === 0}
            className="px-4 py-2 text-[11px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
          >
            {creating && <Loader2 className="w-3 h-3 animate-spin" />}
            CREATE GROUP
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   <CommsStreamScreen> — main COMMS top-nav section
   ───────────────────────────────────────────────────────────────────── */

export default function CommsStreamScreen({ currentUser, users = [], allTrips = [], getIdToken }) {
  const { client, error } = useStreamClient(currentUser, getIdToken);
  const [showNewDm, setShowNewDm] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);

  // ChannelList query: this user's messaging channels.
  const filters = useMemo(() => {
    if (!client?.userID) return null;
    return {
      type: 'messaging',
      members: { $in: [client.userID] },
    };
  }, [client?.userID]);

  const sort = useMemo(() => ({ last_message_at: -1 }), []);
  const options = useMemo(() => ({ state: true, presence: true, limit: 30 }), []);

  // Client-side filter to HIDE trip-scoped channels from main COMMS.
  // Trip channels (id `trip-...`) live inside the trip's COMMS tab,
  // not here. We filter client-side rather than on the server query
  // because Stream filter operators don't have a clean "id prefix
  // does not match" expression. The list is small enough that filtering
  // a handful of channels on the client is fine.
  const channelRenderFilterFn = (channels) =>
    channels.filter((c) => !String(c.id || '').startsWith('trip-'));

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
          >RETRY</button>
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
          {/* SIDEBAR — DMs + groups only. Trip channels excluded. */}
          <aside className="w-72 shrink-0 border-r border-slate-800 flex flex-col bg-slate-950/60">
            <div className="p-3 border-b border-slate-800">
              <h2 className="text-sm tracking-widest text-slate-200 mb-3"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>COMMS</h2>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewDm(true)}
                  className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] tracking-widest text-cyan-300 hover:text-cyan-200 border border-cyan-500/30 hover:border-cyan-400"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  title="Start a 1:1 direct message"
                >
                  <MessageCircle className="w-3 h-3" /> NEW DM
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewGroup(true)}
                  className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] tracking-widest text-cyan-300 hover:text-cyan-200 border border-cyan-500/30 hover:border-cyan-400"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  title="Create an ad-hoc group chat with selected members"
                >
                  <UsersIcon className="w-3 h-3" /> NEW GROUP
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <ChannelList
                filters={filters}
                sort={sort}
                options={options}
                showChannelSearch
                channelRenderFilterFn={channelRenderFilterFn}
              />
            </div>
          </aside>

          {/* MAIN PANE */}
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
        />
      )}
      {showNewGroup && (
        <NewGroupModal
          users={users}
          currentUser={currentUser}
          client={client}
          onClose={() => setShowNewGroup(false)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   <TripChatStream> — single-trip chat for TripDetail's COMMS tab
   ───────────────────────────────────────────────────────────────────── */

export function TripChatStream({ trip, currentUser, users = [], getIdToken }) {
  const { client, error } = useStreamClient(currentUser, getIdToken);
  const [channel, setChannel] = useState(null);
  const [ensureError, setEnsureError] = useState(null);

  // On mount (and when trip/client changes), ensure the trip's channel
  // exists with the right members. Channel.create() is idempotent — if
  // the channel exists with the same members it's a no-op; if a member
  // is missing it's added. This is what makes trip channels "lazy" —
  // they spring into existence the first time anyone opens this tab.
  useEffect(() => {
    if (!client?.userID || !trip?.uid) return;
    let cancelled = false;

    (async () => {
      try {
        const id = tripChannelId(trip.uid);
        const memberUids = deriveTripMemberUids(trip, client.userID, users);
        const ch = client.channel('messaging', id, {
          name: `${trip.info?.tail || ''} ${trip.info?.from || ''}→${trip.info?.to || ''}`.trim(),
          members: memberUids,
          // Custom fields. is_trip lets the main COMMS list filter this
          // out (we also do a client-side id-prefix filter for safety).
          is_trip: true,
          trip_uid: trip.uid,
          tail: trip.info?.tail || '',
          from: trip.info?.from || '',
          to: trip.info?.to || '',
          trip_start: trip.start instanceof Date
            ? trip.start.toISOString()
            : (trip.start || ''),
        });
        await ch.watch();
        if (cancelled) return;
        setChannel(ch);
      } catch (err) {
        console.error('[TripChatStream] ensure failed:', err);
        if (!cancelled) setEnsureError(err?.message || 'Could not open chat');
      }
    })();

    return () => { cancelled = true; };
  }, [client?.userID, trip?.uid, users]);

  if (error) {
    return (
      <div className="p-6 text-center">
        <div className="text-red-400 text-sm mb-2"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>CHAT UNAVAILABLE</div>
        <div className="text-slate-400 text-xs">{error}</div>
      </div>
    );
  }
  if (ensureError) {
    return (
      <div className="p-6 text-center">
        <div className="text-red-400 text-sm mb-2"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>COULDN'T OPEN TRIP CHAT</div>
        <div className="text-slate-400 text-xs">{ensureError}</div>
      </div>
    );
  }
  if (!client || !channel) {
    return (
      <div className="p-8 flex items-center justify-center text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Opening trip chat…
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 comms-stream">
      <Chat client={client} theme="str-chat__theme-dark">
        <Channel channel={channel}>
          <Window>
            <MessageList />
            <MessageInput />
          </Window>
          <Thread />
        </Channel>
      </Chat>
    </div>
  );
}
