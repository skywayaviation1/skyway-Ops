// CommsScreen — unified communications hub (Slice 4 of the chat build).
//
// Layout: inbox (left) + chat pane (right) with BubbleChat for messages.
// Includes: new DM picker, group create dialog (admin-only), unread badges,
// search, and the bridge for legacy trip threads. Privacy: strictly
// participant-scoped per the explicit decision (no admin override).
//
// Visual: the surrounding chrome stays dark to match the rest of the app;
// the BubbleChat surface inside is light (the Option 1 decision).

import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageSquare, Plus, Search, X, ChevronLeft,
  Loader2, UserPlus, Bell,
} from 'lucide-react';
import BubbleChat from './BubbleChat.jsx';

/* ============================================================
   Enable-push banner — gentle, dismissible, per-device.
   Shows when:
     - push is supported on this browser
     - the user hasn't already granted permission
     - the user hasn't dismissed it in the last DISMISS_WINDOW
     - on iPhone, the PWA is opened from home screen (otherwise push
       cannot work, so prompting would create false expectations)
   ============================================================ */
const PUSH_DISMISS_KEY = 'skyway_push_banner_dismissed_at';
const DISMISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

function EnablePushBanner({ currentUser }) {
  const [show, setShow] = useState(false);
  const [why, setWhy] = useState('');         // 'normal' | 'ios-install' | null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const M = await import('./firebase-push.js');
        if (cancelled) return;
        if (!M.pushSupported()) return;                       // browser doesn't support
        if (M.notificationPermissionState() === 'granted') return; // already on
        if (M.notificationPermissionState() === 'denied') return;  // user said no at OS level; don't nag
        // Per-device cooldown so we don't re-prompt after a recent dismiss.
        try {
          const last = parseInt(localStorage.getItem(PUSH_DISMISS_KEY) || '0', 10);
          if (last && (Date.now() - last) < DISMISS_WINDOW_MS) return;
        } catch (_) { /* localStorage may be unavailable in private mode */ }
        // iPhone-specific: PWA must be added to home screen first.
        const iosNeedsInstall = M.iosNeedsHomeScreenInstall();
        setWhy(iosNeedsInstall ? 'ios-install' : 'normal');
        setShow(true);
      } catch (_) { /* push module load failed — silently skip */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(PUSH_DISMISS_KEY, String(Date.now())); } catch (_) {}
    setShow(false);
  };

  const handleEnable = async () => {
    setBusy(true); setErr('');
    try {
      const M = await import('./firebase-push.js');
      await M.enablePush(currentUser);
      // Success — banner hides. Don't store a dismiss timestamp; permission
      // state itself now blocks future shows.
      setShow(false);
    } catch (e) {
      setErr(e.message || 'Could not enable push');
    } finally { setBusy(false); }
  };

  if (!show) return null;

  return (
    <div className="border-b border-cyan-500/30 bg-cyan-500/5 px-4 py-2.5 flex items-start gap-3">
      <Bell className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        {why === 'ios-install' ? (
          <>
            <p className="text-xs text-slate-200 leading-tight">Get notified on your phone when someone messages you.</p>
            <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
              On iPhone: open this in Safari → share → Add to Home Screen → open from the home-screen icon.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs text-slate-200 leading-tight">Get notified when someone messages you.</p>
            <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
              We'll only buzz your phone for direct messages and groups you're in.
            </p>
          </>
        )}
        {err && <p className="text-[11px] text-red-400 mt-1">{err}</p>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {why !== 'ios-install' && (
          <button
            onClick={handleEnable}
            disabled={busy}
            className="px-2.5 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[11px] tracking-widest font-medium disabled:opacity-50"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {busy ? '...' : 'ENABLE'}
          </button>
        )}
        <button
          onClick={dismiss}
          className="text-slate-500 hover:text-slate-200 p-1"
          title="Dismiss for a week"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function fmtWhen(ts, now = Date.now()) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  const sameWeek = (now - ts) < 6 * 24 * 60 * 60 * 1000;
  if (sameWeek) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function convTitle(conv, currentUser, usersByUid) {
  if (!conv) return '';
  if (conv.kind === 'group') return conv.title || 'Group';
  if (conv.kind === 'dm') {
    const otherUid = (conv.participants || []).find((u) => u !== (currentUser.uid || currentUser.id));
    const other = otherUid && usersByUid[otherUid];
    return (other && (other.name || other.email)) || 'Direct message';
  }
  if (conv.kind === 'trip') return conv.title || 'Trip';
  if (conv.kind === 'aog') return conv.title || 'AOG';
  if (conv.kind === 'sr')   return conv.title || 'Service request';
  return conv.title || '(conversation)';
}

function kindTag(kind) {
  switch (kind) {
    case 'dm':    return { label: 'DM',    cls: 'bg-violet-500/15 text-violet-300' };
    case 'group': return { label: 'GROUP', cls: 'bg-purple-500/15 text-purple-300' };
    case 'trip':  return { label: 'TRIP',  cls: 'bg-cyan-500/15 text-cyan-300' };
    case 'aog':   return { label: 'AOG',   cls: 'bg-red-500/15 text-red-300' };
    case 'sr':    return { label: 'SR',    cls: 'bg-amber-500/15 text-amber-300' };
    default:      return { label: '?',     cls: 'bg-slate-700/30 text-slate-400' };
  }
}

function hasUnread(conv, currentUser) {
  if (!conv || !conv.lastMessage) return false;
  const uid = currentUser.uid || currentUser.id;
  if (conv.lastMessage.senderUid === uid) return false;
  const myRead = (conv.readAt || {})[uid] || 0;
  return (conv.lastAt || 0) > myRead;
}

/* ============================================================
   New conversation / Group create modals
   ============================================================ */
function NewConversationDialog({ open, onClose, users, currentUser, isAdmin, onDmCreated, onGroupCreated }) {
  const [mode, setMode] = useState('dm');     // dm | group
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (open) { setMode('dm'); setSearch(''); setPicked(new Set()); setTitle(''); setBusy(false); setErr(''); }
  }, [open]);

  if (!open) return null;

  const myUid = currentUser.uid || currentUser.id;
  const candidates = (users || [])
    .filter((u) => (u.uid || u.id) && (u.uid || u.id) !== myUid)
    .filter((u) => u.approved !== false)
    .filter((u) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const toggle = (uid) => {
    const next = new Set(picked);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    setPicked(next);
  };

  const startDm = async (uid) => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const target = (users || []).find((u) => (u.uid || u.id) === uid);
      if (!target) throw new Error('User not found');
      const M = await import('./firebase-comms.js');
      const conv = await M.openOrCreateDm(currentUser, target);
      onDmCreated && onDmCreated(conv.id);
      onClose();
    } catch (e) { setErr(e.message || 'Could not start DM'); }
    finally { setBusy(false); }
  };

  const createGroup = async () => {
    if (busy) return;
    if (!title.trim()) { setErr('Group name required'); return; }
    if (picked.size < 1) { setErr('Pick at least one other member'); return; }
    setBusy(true); setErr('');
    try {
      const M = await import('./firebase-comms.js');
      const id = await M.createGroup(currentUser, title.trim(), Array.from(picked));
      onGroupCreated && onGroupCreated(id);
      onClose();
    } catch (e) { setErr(e.message || 'Could not create group'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(2,6,23,0.7)' }}>
      <div className="w-full max-w-md bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col" style={{ maxHeight: '85vh' }}>
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <p className="text-sm font-medium text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            NEW {mode === 'dm' ? 'DIRECT MESSAGE' : 'GROUP'}
          </p>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 pt-3 flex gap-1.5">
          <button onClick={() => setMode('dm')} className={`flex-1 text-[11px] py-1.5 tracking-widest border ${mode === 'dm' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>DIRECT</button>
          <button onClick={() => setMode('group')} disabled={!isAdmin} title={!isAdmin ? 'Only admins can create groups' : ''} className={`flex-1 text-[11px] py-1.5 tracking-widest border disabled:opacity-40 disabled:cursor-not-allowed ${mode === 'group' ? 'border-purple-500/50 bg-purple-500/10 text-purple-300' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            GROUP {!isAdmin && '(admin)'}
          </button>
        </div>

        {mode === 'group' && (
          <div className="px-4 pt-3">
            <label className="text-[10px] text-slate-500 tracking-widest block mb-1">GROUP NAME</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full bg-slate-900/60 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" placeholder="e.g. Pilots, Ops Team" />
          </div>
        )}

        <div className="px-4 pt-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…" className="w-full bg-slate-900/60 border border-slate-700 pl-8 pr-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[180px]">
          {candidates.length === 0 ? (
            <p className="text-center text-xs text-slate-600 py-8">No matching users.</p>
          ) : candidates.map((u) => {
            const uid = u.uid || u.id;
            const checked = picked.has(uid);
            return (
              <button
                key={uid}
                onClick={() => mode === 'dm' ? startDm(uid) : toggle(uid)}
                disabled={busy}
                className={`w-full flex items-center gap-2 px-2 py-2 hover:bg-slate-900/50 text-left ${mode === 'group' && checked ? 'bg-purple-500/10' : ''}`}
              >
                <div className="w-7 h-7 rounded-full bg-cyan-500/10 border border-cyan-500/40 flex items-center justify-center text-cyan-300 text-xs">
                  {(u.name || u.email || '?').charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-slate-200 truncate">{u.name || u.email}</p>
                  <p className="text-[10px] text-slate-500 truncate">{(u.role || '').toUpperCase()}{u.email ? ` · ${u.email}` : ''}</p>
                </div>
                {mode === 'group' && (
                  <div className={`w-4 h-4 border rounded ${checked ? 'border-purple-400 bg-purple-500' : 'border-slate-600'}`}>
                    {checked && <span className="block text-white text-[10px] leading-4 text-center">✓</span>}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {err && <p className="px-4 pb-2 text-[11px] text-red-400">{err}</p>}

        {mode === 'group' && (
          <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between">
            <p className="text-[11px] text-slate-500">{picked.size} selected</p>
            <button onClick={createGroup} disabled={busy || !title.trim() || picked.size < 1} className="flex items-center gap-2 px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs tracking-widest disabled:opacity-40" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />} CREATE
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   CommsScreen — main
   ============================================================ */
function CommsScreen({ currentUser, users, onJumpToEntity }) {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [typingNames, setTypingNames] = useState([]);
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState(false);

  const isAdmin = currentUser?.role === 'admin';
  const usersByUid = useMemo(() => {
    const out = {};
    (users || []).forEach((u) => { const k = u.uid || u.id; if (k) out[k] = u; });
    return out;
  }, [users]);

  // Inbox subscription (own + admin-visible if applicable, governed by data layer).
  useEffect(() => {
    if (!currentUser) return;
    let unsub = null;
    let cancelled = false;
    (async () => {
      const M = await import('./firebase-comms.js');
      if (cancelled) return;
      unsub = M.subscribeInboxFor(currentUser, (list) => {
        setConversations(list);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; if (unsub) try { unsub(); } catch (_) {} };
  }, [currentUser]);

  // Message subscription for the selected conversation.
  useEffect(() => {
    if (!selectedId) { setMessages([]); setTypingNames([]); return; }
    let unsubMsg = null;
    let unsubTyping = null;
    let cancelled = false;
    setMsgLoading(true);
    (async () => {
      const M = await import('./firebase-comms.js');
      if (cancelled) return;
      const conv = conversations.find((c) => c.id === selectedId);
      const uid = currentUser.uid || currentUser.id;

      if (conv && conv.kind === 'trip' && conv._legacyTripId) {
        // Legacy trip threads: no typing/read on the legacy path (no schema for it).
        unsubMsg = M.subscribeLegacyTripThread(conv._legacyTripId, (msgs) => {
          setMessages(msgs); setMsgLoading(false);
        });
      } else {
        unsubMsg = M.subscribeToConversation(selectedId, (msgs) => {
          setMessages(msgs); setMsgLoading(false);
          // Mark messages from OTHER senders as read, on each delivery.
          if (uid) M.markMessagesRead(selectedId, msgs, uid).catch(() => {});
        });
        unsubTyping = M.subscribeTyping(selectedId, uid, (names) => {
          setTypingNames(names);
        });
      }
      // Mark the conversation itself read (lastSeen marker on the parent doc).
      if (uid && conv && conv.kind !== 'trip') {
        try { await M.markRead(selectedId, uid); } catch (_) {}
      }
    })();
    return () => {
      cancelled = true;
      if (unsubMsg) try { unsubMsg(); } catch (_) {}
      if (unsubTyping) try { unsubTyping(); } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, currentUser]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      const t = convTitle(c, currentUser, usersByUid).toLowerCase();
      const lm = (c.lastMessage && c.lastMessage.text || '').toLowerCase();
      return t.includes(q) || lm.includes(q);
    });
  }, [conversations, search, currentUser, usersByUid]);

  const selected = conversations.find((c) => c.id === selectedId) || null;

  const handleSend = async (text) => {
    if (!selected) return;
    const M = await import('./firebase-comms.js');
    if (selected.kind === 'trip' && selected._legacyTripId) {
      await M.sendLegacyTripMessage(selected._legacyTripId, currentUser, text);
    } else {
      await M.sendMessage(selected.id, currentUser, text);
    }
  };

  // Typing presence: only on the new conversations path. Legacy trip threads
  // don't have a typing schema and are skipped.
  const handleTyping = (isTyping) => {
    if (!selected || (selected.kind === 'trip' && selected._legacyTripId)) return;
    import('./firebase-comms.js').then((M) => {
      M.setTyping(selected.id, currentUser, isTyping).catch(() => {});
    });
  };

  // Attachment upload: uploads to Firebase Storage at
  // comms-attachments/{convId}/{file}, then posts a message with the
  // attachment metadata. Legacy trip threads (which have no
  // attachments schema) skip — message-only sending is preserved.
  const handleAttach = async (file) => {
    if (!selected) return;
    if (selected.kind === 'trip' && selected._legacyTripId) {
      throw new Error('Attachments not supported on legacy trip threads');
    }
    const { uploadCommsAttachment } = await import('./firebase-storage.js');
    const att = await uploadCommsAttachment(file, selected.id);
    const M = await import('./firebase-comms.js');
    // Message text is empty; the attachment carries the content.
    await M.sendMessage(selected.id, currentUser, '', {
      attachments: [{ name: att.name, url: att.url, kind: att.kind }],
    });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <NewConversationDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        users={users}
        currentUser={currentUser}
        isAdmin={isAdmin}
        onDmCreated={(id) => { setSelectedId(id); setMobileShowChat(true); }}
        onGroupCreated={(id) => { setSelectedId(id); setMobileShowChat(true); }}
      />

      <div className="border-b border-slate-800 bg-slate-950 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm tracking-widest text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>COMMS</h2>
        </div>
        <button onClick={() => setShowNew(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs tracking-widest font-medium" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <Plus className="w-3.5 h-3.5" /> NEW
        </button>
      </div>

      <EnablePushBanner currentUser={currentUser} />

      <div className="flex-1 flex overflow-hidden">
        {/* INBOX */}
        <div className={`${mobileShowChat ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-80 lg:w-96 border-r border-slate-800 bg-slate-950`}>
          <div className="p-2 border-b border-slate-800/60">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations…" className="w-full bg-slate-900/60 border border-slate-700 pl-8 pr-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-400" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-12 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center">
                <MessageSquare className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                <p className="text-xs text-slate-500">{search ? 'No matches.' : 'No conversations yet.'}</p>
                {!search && <button onClick={() => setShowNew(true)} className="mt-3 text-xs text-cyan-400 hover:text-cyan-300">Start one →</button>}
              </div>
            ) : filtered.map((c) => {
              const tag = kindTag(c.kind);
              const unread = hasUnread(c, currentUser);
              const isSel = c.id === selectedId;
              const lm = c.lastMessage;
              return (
                <button
                  key={c.id}
                  onClick={() => { setSelectedId(c.id); setMobileShowChat(true); }}
                  className={`w-full text-left px-3 py-2.5 border-b border-slate-800/60 hover:bg-slate-900/40 ${isSel ? 'bg-cyan-500/10 border-l-2 border-l-cyan-400' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className={`text-xs truncate ${unread ? 'text-slate-100 font-medium' : 'text-slate-300'}`}>{convTitle(c, currentUser, usersByUid)}</p>
                    <span className="text-[10px] text-slate-500 shrink-0">{fmtWhen(c.lastAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[9px] px-1.5 py-0.5 tracking-widest ${tag.cls}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>{tag.label}</span>
                    <p className={`text-[11px] truncate flex-1 ${unread ? 'text-slate-300' : 'text-slate-500'}`}>
                      {lm ? (lm.senderName ? `${lm.senderName.split(' ')[0]}: ${lm.text}` : lm.text) : '(no messages yet)'}
                    </p>
                    {unread && <span className="w-2 h-2 rounded-full bg-cyan-400 shrink-0" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* CHAT PANE */}
        <div className={`${mobileShowChat ? 'flex' : 'hidden md:flex'} flex-col flex-1 bg-slate-950/40`}>
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-slate-600">
              <div className="text-center">
                <MessageSquare className="w-10 h-10 text-slate-800 mx-auto mb-2" />
                <p className="text-xs text-slate-500">Choose a conversation</p>
              </div>
            </div>
          ) : (
            <>
              <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-950 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <button onClick={() => setMobileShowChat(false)} className="md:hidden text-slate-500 hover:text-slate-200">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <p className="text-sm text-slate-100 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{convTitle(selected, currentUser, usersByUid)}</p>
                    <p className="text-[10px] text-slate-500 truncate">
                      {selected.kind === 'group' ? `${(selected.participants || []).length} members` :
                       selected.kind === 'dm' ? 'Direct message — only you two' :
                       (selected.entityRef && selected.entityRef.kind ? `Linked to ${selected.entityRef.kind}` : '')}
                    </p>
                  </div>
                </div>
                {selected.entityRef && onJumpToEntity && (
                  <button onClick={() => onJumpToEntity(selected.entityRef)} className="text-[10px] text-cyan-400 hover:text-cyan-300 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    OPEN →
                  </button>
                )}
              </div>
              <div className="flex-1 overflow-hidden p-3">
                <BubbleChat
                  messages={messages}
                  currentUser={currentUser}
                  typingUsers={typingNames}
                  onSend={handleSend}
                  onAttach={selected.kind === 'trip' ? null : handleAttach}
                  onTyping={selected.kind === 'trip' ? null : handleTyping}
                  loading={msgLoading}
                  emptyText={selected.kind === 'dm' ? 'Say hi.' : 'No messages in this conversation yet.'}
                  className="h-full"
                  maxHeight="100%"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default CommsScreen;
