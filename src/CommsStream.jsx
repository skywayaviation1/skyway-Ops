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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StreamChat } from 'stream-chat';
import {
  Chat,
  Channel,
  ChannelList,
  MessageInput,
  MessageList,
  Thread,
  Window,
  useChatContext,
} from 'stream-chat-react';
import 'stream-chat-react/dist/css/v2/index.css';
import './commsStream.css';

import {
  Bell, BellRing, Check, ChevronLeft, Info, Loader2, MessageCircle,
  Search, ShieldCheck, Users as UsersIcon, X,
} from 'lucide-react';
import { notify } from './ui.jsx';
import MuteToggle from './MuteToggle.jsx';
import {
  enablePush, iosNeedsHomeScreenInstall, notificationPermissionState, pushSupported,
} from './firebase-push.js';

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

async function fetchStreamSession(getIdToken) {
  const idToken = await getIdToken();
  if (!idToken) throw new Error('No idToken from Firebase');
  const response = await fetch('/api/stream-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Token mint failed (${response.status})`);
  }
  return response.json();
}

// Stream calls a token provider again before an expiring JWT lapses. Return the
// already-minted token on the initial connection, then obtain a fresh Firebase
// ID token and Stream JWT for every refresh.
function streamTokenProvider(getIdToken, initialToken) {
  let first = initialToken;
  return async () => {
    if (first) {
      const token = first;
      first = null;
      return token;
    }
    const session = await fetchStreamSession(getIdToken);
    return session.token;
  };
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
        const { token, apiKey, user } = await fetchStreamSession(getIdToken);
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
            streamTokenProvider(getIdToken, token),
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

function channelMembers(channel) {
  return Object.values(channel?.state?.members || {})
    .map((member) => member?.user || member)
    .filter((user) => user?.id);
}

function channelTitle(channel, currentUid) {
  if (!channel) return 'Messages';
  if (channel.data?.name) return channel.data.name;
  const other = channelMembers(channel).find((user) => user.id !== currentUid);
  return other?.name || other?.email || 'Direct message';
}

function ChannelToolbar({ currentUser, onSearch, onInfo }) {
  const { channel, client } = useChatContext();
  const members = channelMembers(channel);
  const muteTarget = useMemo(
    () => ({ id: `stream-${channel?.id || ''}`, kind: 'stream' }),
    [channel?.id],
  );
  const other = members.find((user) => user.id !== client.userID);
  const isDirect = !channel?.data?.is_group && !channel?.data?.is_trip && members.length <= 2;
  const online = members.filter((user) => user.online).length;
  const subtitle = isDirect
    ? (other?.online ? 'Online now' : 'Direct message')
    : `${members.length} members${online ? ` · ${online} online` : ''}`;

  return (
    /* A div, not a <header>: theme-classy.css paints every <header> as the
       dark app crown, which would leave this toolbar dark-on-dark in the
       light theme. */
    <div className="comms-channel-toolbar">
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-content">
          {channelTitle(channel, client.userID)}
        </h3>
        <p className="mt-0.5 truncate text-[11px] text-content-subtle">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onSearch}
          className="comms-icon-button"
          title="Search messages"
          aria-label="Search messages"
        >
          <Search className="h-4 w-4" />
        </button>
        <MuteToggle
          currentUser={currentUser}
          target={muteTarget}
          className="comms-icon-button"
        />
        <button
          type="button"
          onClick={onInfo}
          className="comms-icon-button"
          title="Conversation details"
          aria-label="Conversation details"
        >
          <Info className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ChannelInfoPanel({ channel, currentUid, onClose }) {
  const members = channelMembers(channel);
  return (
    <aside className="comms-details-panel">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-content">Conversation details</h3>
          <p className="mt-0.5 text-[11px] text-content-subtle">
            {members.length} {members.length === 1 ? 'member' : 'members'}
          </p>
        </div>
        <button type="button" onClick={onClose} className="comms-icon-button" aria-label="Close details">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-3">
        <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">Members</p>
        <div className="space-y-1">
          {members.map((user) => (
            <div key={user.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-raised">
              <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge bg-surface-raised text-xs font-semibold text-content">
                {(user.name || user.id).split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
                <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-surface ${
                  user.online ? 'bg-success' : 'bg-slate-600'
                }`} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm text-content">
                  {user.name || user.email || user.id}{user.id === currentUid ? ' (you)' : ''}
                </p>
                <p className="truncate text-[11px] text-content-subtle">
                  {user.skyway_role || (user.online ? 'online' : 'offline')}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-lg border border-edge bg-surface-sunken p-3 text-[11px] leading-relaxed text-content-subtle">
          <ShieldCheck className="mb-2 h-4 w-4 text-success" />
          Messages are carried by Skyway’s managed Stream workspace. Access follows channel membership and your approved company profile.
        </div>
      </div>
    </aside>
  );
}

function MessageSearchPanel({ client, currentUid, onOpenResult, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setError('');
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const response = await client.search(
          { type: 'messaging', members: { $in: [currentUid] } },
          term,
          { limit: 40, sort: [{ created_at: -1 }] },
        );
        if (!cancelled) setResults(response.results || []);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Search failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, currentUid, query]);

  return (
    <div className="comms-search-panel">
      <div className="flex items-center gap-2 border-b border-edge p-3">
        <Search className="h-4 w-4 shrink-0 text-content-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search every conversation…"
          className="min-w-0 flex-1 bg-transparent text-sm text-content outline-none placeholder:text-content-subtle"
        />
        {loading && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
        <button type="button" onClick={onClose} className="comms-icon-button" aria-label="Close search">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {!query.trim() ? (
          <div className="p-8 text-center">
            <Search className="mx-auto h-6 w-6 text-content-subtle" />
            <p className="mt-3 text-sm text-content-muted">Search messages across DMs and groups</p>
            <p className="mt-1 text-[11px] text-content-subtle">Type at least two characters.</p>
          </div>
        ) : error ? (
          <p className="p-4 text-sm text-danger">{error}</p>
        ) : !loading && results.length === 0 ? (
          <p className="p-8 text-center text-sm text-content-subtle">No messages found</p>
        ) : (
          results.map((result) => {
            const message = result.message || result;
            const channel = message.channel || result.channel;
            return (
              <button
                type="button"
                key={message.id}
                onClick={() => onOpenResult(channel, message)}
                className="w-full rounded-lg border-b border-edge px-3 py-3 text-left hover:bg-surface-raised"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-xs font-semibold text-content">
                    {channel?.name || message.user?.name || 'Conversation'}
                  </span>
                  <span className="shrink-0 text-[10px] text-content-subtle">
                    {message.created_at ? new Date(message.created_at).toLocaleDateString() : ''}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-content-muted">
                  {message.user?.name ? `${message.user.name}: ` : ''}{message.text || 'Attachment'}
                </p>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function NotificationOnboarding({ currentUser }) {
  const [permission, setPermission] = useState(notificationPermissionState());
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem('skyway_push_enabled') === '1'; }
    catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || enabled || !pushSupported() || permission === 'denied') return null;
  const needsInstall = iosNeedsHomeScreenInstall();

  const activate = async () => {
    setBusy(true);
    try {
      await enablePush(currentUser);
      localStorage.setItem('skyway_push_enabled', '1');
      setPermission(notificationPermissionState());
      setEnabled(true);
      notify.success('Message notifications enabled on this device.');
    } catch (err) {
      notify.error(err?.message || 'Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-3 rounded-xl border border-accent-border bg-accent-soft p-3">
      <div className="flex items-start gap-2.5">
        <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-content">Never miss a message</p>
          <p className="mt-1 text-[11px] leading-relaxed text-content-muted">
            {needsInstall
              ? 'On iPhone, add Skyway to your Home Screen first, then enable notifications here.'
              : 'Enable lock-screen alerts for DMs, groups and trip comms.'}
          </p>
          {!needsInstall && (
            <button
              type="button"
              disabled={busy}
              onClick={activate}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-content-inverse disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />}
              Enable notifications
            </button>
          )}
        </div>
        <button type="button" onClick={() => setDismissed(true)} className="text-content-subtle hover:text-content" aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
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
      notify.error('Could not start DM: ' + err.message);
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
      notify.error('Pick at least one member.');
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
      notify.error('Could not create group: ' + err.message);
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

export default function CommsStreamScreen({
  currentUser,
  users = [],
  allTrips = [],
  getIdToken,
  initialChannelId = '',
}) {
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
        <CommsLayoutInner
          filters={filters}
          sort={sort}
          options={options}
          channelRenderFilterFn={channelRenderFilterFn}
          currentUser={currentUser}
          initialChannelId={initialChannelId}
          onNewDm={() => setShowNewDm(true)}
          onNewGroup={() => setShowNewGroup(true)}
        />
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
   <CommsLayoutInner> — responsive sidebar + main with mobile back button

   This sub-component lives inside <Chat> so it can call useChatContext()
   and react to channel selection. On mobile (<768px) we render a single
   pane at a time, swapping between the channel list and the active
   channel; on desktop both render side by side. A "← BACK TO COMMS"
   button surfaces only on mobile so the user can return to the list.

   Why this split: tablet/desktop usage is fine with a two-pane layout,
   but on a phone the 288px sidebar would leave only ~100px for the
   chat area — Jake was seeing the message bar clipped off-screen and
   couldn't actually send messages.
   ───────────────────────────────────────────────────────────────────── */

function CommsLayoutInner({
  filters,
  sort,
  options,
  channelRenderFilterFn,
  currentUser,
  initialChannelId,
  onNewDm,
  onNewGroup,
}) {
  const { channel, client, setActiveChannel } = useChatContext();
  // 'list'   → sidebar full-width, main hidden (mobile only)
  // 'channel'→ main full-width, sidebar hidden (mobile only)
  // On md+ both panes always show, so this state is mobile-only signal.
  const [mobileView, setMobileView] = useState('list');
  const [listMode, setListMode] = useState('all');
  const [showSearch, setShowSearch] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  // When a channel becomes selected (user tapped one), flip to channel
  // view on mobile. We only react to cid changes — re-renders due to
  // message updates etc. won't bounce us back.
  useEffect(() => {
    if (channel?.cid) setMobileView('channel');
  }, [channel?.cid]);

  // Push notifications and copied links deep-link to a Stream channel id.
  // Resolve it after the Stream client connects, then clear the query so a
  // refresh does not repeatedly force the same conversation open.
  useEffect(() => {
    if (!initialChannelId || !client?.userID) return;
    let cancelled = false;
    (async () => {
      try {
        const target = client.channel('messaging', safeChannelId(initialChannelId));
        await target.watch();
        if (!cancelled) {
          setActiveChannel(target);
          setMobileView('channel');
        }
      } catch (err) {
        console.warn('[CommsStream] deep-linked channel unavailable:', err?.message || err);
      }
    })();
    return () => { cancelled = true; };
  }, [client, initialChannelId, setActiveChannel]);

  useEffect(() => {
    setShowInfo(false);
  }, [channel?.cid]);

  const visibleChannels = useCallback((channels) => {
    const withoutTrips = channelRenderFilterFn(channels);
    return listMode === 'unread'
      ? withoutTrips.filter((candidate) => candidate.countUnread() > 0)
      : withoutTrips;
  }, [channelRenderFilterFn, listMode]);

  const openSearchResult = useCallback(async (channelData) => {
    if (!channelData?.id) return;
    const target = client.channel(channelData.type || 'messaging', channelData.id);
    await target.watch();
    setActiveChannel(target);
    setShowSearch(false);
    setMobileView('channel');
  }, [client, setActiveChannel]);

  return (
    <div className="flex h-full min-h-0">
      {/* SIDEBAR */}
      <aside
        className={`
          ${mobileView === 'channel' ? 'hidden' : 'flex'}
          md:flex
          w-full md:w-72 md:shrink-0
          border-r border-slate-800 flex-col bg-slate-950/60
        `}
      >
        <div className="border-b border-slate-800 p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-content">Messages</h2>
              <p className="mt-0.5 text-[11px] text-content-subtle">Skyway team communications</p>
            </div>
            <span className="inline-flex items-center gap-1 text-[10px] text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> Connected
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onNewDm}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-accent-border bg-accent-soft px-2 py-2 text-[11px] font-semibold text-accent hover:bg-accent-soft"
              title="Start a 1:1 direct message"
            >
              <MessageCircle className="w-3.5 h-3.5" /> New message
            </button>
            <button
              type="button"
              onClick={onNewGroup}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-edge px-2 py-2 text-[11px] font-semibold text-content-muted hover:border-edge-strong hover:text-content"
              title="Create an ad-hoc group chat with selected members"
            >
              <UsersIcon className="w-3.5 h-3.5" /> New group
            </button>
          </div>
          <div className="mt-3 flex items-center gap-1 rounded-lg bg-surface-sunken p-1">
            {[
              ['all', 'Inbox'],
              ['unread', 'Unread'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setListMode(id)}
                className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium ${
                  listMode === id ? 'bg-surface-raised text-content shadow-card' : 'text-content-subtle hover:text-content-muted'
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => client.markAllRead()}
              className="rounded-md px-2 py-1.5 text-[10px] text-content-subtle hover:text-content"
              title="Mark every conversation read"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <NotificationOnboarding currentUser={currentUser} />
        <div className="flex-1 min-h-0 overflow-y-auto">
          <ChannelList
            filters={filters}
            sort={sort}
            options={options}
            showChannelSearch
            channelRenderFilterFn={visibleChannels}
          />
        </div>
      </aside>

      {/* MAIN PANE */}
      <main
        className={`
          ${mobileView === 'list' ? 'hidden' : 'flex'}
          md:flex
          flex-1 flex-col min-w-0
        `}
      >
        {/* Mobile-only back button so users can return to the channel list.
            md:hidden keeps it out of the way on tablets and desktops. */}
        <button
          type="button"
          onClick={() => setMobileView('list')}
          className="md:hidden flex items-center gap-2 px-3 py-2.5 border-b border-slate-800 bg-slate-950/80 text-[11px] tracking-widest text-cyan-300 hover:text-cyan-200 shrink-0"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <ChevronLeft className="w-4 h-4" />
          BACK TO COMMS
        </button>
        <div className="flex min-h-0 flex-1">
          <div className="comms-channel-stage">
            <Channel>
              <Window>
                <ChannelToolbar
                  currentUser={currentUser}
                  onSearch={() => setShowSearch(true)}
                  onInfo={() => setShowInfo((value) => !value)}
                />
                <MessageList />
                <MessageInput focus audioRecordingEnabled />
              </Window>
              <Thread />
            </Channel>
          </div>
          {showInfo && channel && (
            <ChannelInfoPanel channel={channel} currentUid={client.userID} onClose={() => setShowInfo(false)} />
          )}
        </div>
      </main>
      {showSearch && (
        <MessageSearchPanel
          client={client}
          currentUid={client.userID}
          onOpenResult={openSearchResult}
          onClose={() => setShowSearch(false)}
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

  // Compute trip member uids. This re-derives on every users-prop change,
  // BUT the effect below does NOT depend on the array reference — it
  // depends only on whether the list is ready. That keeps the channel
  // watch from being re-fired every React render, which is what was
  // tripping Stream's "Too many requests" rate limit (HTTP 429, code 9).
  const memberUids = useMemo(() => {
    if (!client?.userID || !trip?.uid || users.length === 0) return [];
    return deriveTripMemberUids(trip, client.userID, users);
  }, [client?.userID, trip?.uid, users]);
  const memberUidsReady = memberUids.length > 0;

  // Ensure the trip's channel exists with the right members. Fires
  // ONCE per (user, trip, users-loaded) combo — never on plain parent
  // re-renders. channel.create()/watch() is idempotent for the same
  // channel id; if a teammate later opens this same trip's chat, their
  // own call will add them. We don't have to track membership here.
  useEffect(() => {
    if (!client?.userID || !trip?.uid || !memberUidsReady) return;
    let cancelled = false;

    const tryWatch = async (attempt = 1) => {
      try {
        const id = tripChannelId(trip.uid);
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
        // Stream rate-limits at ~5-10 req/sec per channel. If we hit it
        // (most often after a fresh page load when many things race),
        // wait and retry up to 3 times with exponential backoff. The
        // bulk-user-sync in the token endpoint also draws from the same
        // budget, so backoff is genuinely useful here.
        const msg = String(err?.message || '');
        const isRateLimit = err?.code === 9 || msg.includes('Too many requests');
        if (isRateLimit && attempt < 3 && !cancelled) {
          const delayMs = 1500 * attempt; // 1.5s, then 3s
          console.warn(`[TripChatStream] rate-limited, retrying in ${delayMs}ms (attempt ${attempt})`);
          await new Promise((r) => setTimeout(r, delayMs));
          if (cancelled) return;
          return tryWatch(attempt + 1);
        }
        console.error('[TripChatStream] ensure failed:', err);
        if (!cancelled) {
          setEnsureError(
            isRateLimit
              ? 'Chat is rate-limited right now. Wait a moment and reopen this tab.'
              : (err?.message || 'Could not open chat')
          );
        }
      }
    };

    tryWatch();
    return () => { cancelled = true; };
    // Intentionally NOT depending on memberUids (array ref) or `users`.
    // We re-fire only when:
    //   - the signed-in user changes (impersonation/sign-out)
    //   - the trip changes (user navigated to a different trip)
    //   - the users roster transitioned from empty → loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client?.userID, trip?.uid, memberUidsReady]);

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
            <ChannelToolbar
              currentUser={currentUser}
              onSearch={() => notify.info('Open Messages to search across all conversations.')}
              onInfo={() => notify.info(`${channelMembers(channel).length} members in this trip channel.`)}
            />
            <MessageList />
            <MessageInput focus audioRecordingEnabled />
          </Window>
          <Thread />
        </Channel>
      </Chat>
    </div>
  );
}
