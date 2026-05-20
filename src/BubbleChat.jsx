// BubbleChat — presentational chat component (Slice 1).
//
// Renders a txt-message-style conversation: day separators, sender-aligned
// bubbles, contiguous-message grouping, read receipts, typing indicator,
// attach/photo hooks, autoscroll (only if user is already at bottom), and
// keyboard-safe composer. The surface is intentionally LIGHT — per the
// Option 1 decision, messaging reads better light even inside the app's
// dark UI; the rest of the app stays dark.
//
// PRESENTATIONAL ON PURPOSE: data source is the caller's problem. Pass in
// a normalized `messages` array and an `onSend` handler. This makes the
// same component reusable for:
//   - existing per-trip threads (Slice 3: wired through firebase-chat.js)
//   - per-AOG threads (Slice 3)
//   - new conversations / DMs / groups (Slice 4–5)
// without rebuilding the UI each time.
//
// MESSAGE SHAPE (caller normalizes):
//   {
//     id: string,
//     senderUid?: string | null,    // preferred — used to identify "me"
//     author: string,               // display name; also "me" fallback if no uid
//     text: string,
//     timestamp: number,            // epoch ms (caller converts Firestore TS)
//     readBy?: string[],            // uids; renders ✓✓ when contains a non-me uid
//     attachments?: Array<{name, url?, kind: 'image'|'file'}>,
//     pending?: boolean,            // optimistic send before server confirms
//   }
//
// Caller is responsible for ordering messages ascending by timestamp.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Image as ImageIcon, ArrowUp, Loader2 } from 'lucide-react';

/* ------------------------------------------------------------------
   Pure helpers — easy to unit-test.
   ------------------------------------------------------------------ */

export function formatDayLabel(ts, now = Date.now()) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  const sameWeek = (now - ts) < 6 * 24 * 60 * 60 * 1000;
  if (sameWeek) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

export function formatTimeLabel(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Identify a message as belonging to the current user. Prefer uid match;
// fall back to display-name match for legacy data (existing trip-thread
// docs only have `author` as a string).
export function isMine(message, currentUser) {
  if (!message || !currentUser) return false;
  const myUid = currentUser.uid || currentUser.id || null;
  if (myUid && message.senderUid && myUid === message.senderUid) return true;
  if (!message.senderUid && currentUser.name && message.author === currentUser.name) return true;
  return false;
}

// Group messages into [{ day, items: [{ msg, showSender, showTime, mine }] }].
// "Run" = contiguous same-sender messages within RUN_WINDOW ms; only the
// last in a run shows a timestamp, only the first shows the sender's name
// (for "them" only).
const RUN_WINDOW_MS = 5 * 60 * 1000;
export function groupMessages(messages, currentUser, now = Date.now()) {
  const groups = [];
  let lastDayKey = null;
  let lastSender = null;
  let lastTs = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const d = new Date(m.timestamp || now);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (dayKey !== lastDayKey) {
      groups.push({ day: formatDayLabel(m.timestamp || now, now), items: [] });
      lastDayKey = dayKey;
      lastSender = null;
      lastTs = 0;
    }
    const mine = isMine(m, currentUser);
    const senderKey = m.senderUid || m.author || '';
    const inRun = senderKey === lastSender && (m.timestamp - lastTs) < RUN_WINDOW_MS;
    const next = messages[i + 1];
    const nextInRun = next
      && (next.senderUid || next.author || '') === senderKey
      && (next.timestamp - m.timestamp) < RUN_WINDOW_MS
      && (new Date(next.timestamp).getDate() === d.getDate());
    groups[groups.length - 1].items.push({
      msg: m,
      mine,
      // Show sender label on the FIRST of a "them" run only.
      showSender: !mine && !inRun,
      // Show timestamp on the LAST of any run.
      showTime: !nextInRun,
    });
    lastSender = senderKey;
    lastTs = m.timestamp || now;
  }
  return groups;
}

/* ------------------------------------------------------------------
   Component.
   ------------------------------------------------------------------ */

function BubbleChat({
  messages = [],
  currentUser = null,
  typingUsers = [],          // names of OTHER users currently typing
  onSend = null,             // async (text) => void
  onAttach = null,           // async (file) => void — optional; hides attach buttons when absent
  onTyping = null,           // (boolean) => void — optional, debounced internally
  loading = false,
  emptyText = 'No messages yet — start the conversation.',
  headerTitle = null,        // optional; parent often supplies its own chrome
  headerSubtitle = null,
  className = '',
  maxHeight = '70vh',        // caller can override for embedded contexts
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollerRef = useRef(null);
  const composerRef = useRef(null);
  const atBottomRef = useRef(true);
  const typingTimerRef = useRef(null);

  // Autoscroll: jump to bottom on mount, and on new messages ONLY if the
  // user is already at the bottom (don't yank them up to date if they
  // scrolled up to read history).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, typingUsers.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const slack = 24;
      atBottomRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < slack;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // initial jump
    el.scrollTop = el.scrollHeight;
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const groups = useMemo(() => groupMessages(messages, currentUser), [messages, currentUser]);
  const myUid = currentUser?.uid || currentUser?.id || null;

  const fireTyping = (val) => {
    if (!onTyping) return;
    onTyping(true);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => onTyping(false), 1500);
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending || !onSend) return;
    setSending(true);
    try {
      await onSend(t);
      setText('');
      atBottomRef.current = true;
      // refocus the composer on desktop; on mobile the keyboard is already up
      composerRef.current && composerRef.current.focus();
    } catch (e) {
      // Keep the text so the user can retry; surface a minimal hint.
      console.error('[BubbleChat] send failed:', e);
      window.alert('Couldn’t send — try again.');
    } finally {
      setSending(false);
      if (onTyping) onTyping(false);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !onAttach) return;
    try { await onAttach(file); }
    catch (err) { console.error('[BubbleChat] attach failed:', err); window.alert('Attach failed.'); }
    finally { e.target.value = ''; }
  };

  // Light "messaging surface" — intentionally light per Option 1, sits
  // INSIDE the app's dark UI like a chat document embedded in the page.
  return (
    <div
      className={`bubblechat flex flex-col bg-white rounded-lg overflow-hidden border border-slate-200 ${className}`}
      style={{ maxHeight, minHeight: '320px' }}
    >
      {(headerTitle || headerSubtitle) && (
        <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          {headerTitle && <p className="text-sm font-medium text-slate-900 leading-tight">{headerTitle}</p>}
          {headerSubtitle && <p className="text-xs text-slate-500 leading-tight mt-0.5">{headerSubtitle}</p>}
        </div>
      )}

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-3" style={{ overscrollBehavior: 'contain' }}>
        {loading ? (
          <div className="h-full flex items-center justify-center text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : messages.length === 0 && typingUsers.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm px-6 text-center">
            {emptyText}
          </div>
        ) : (
          groups.map((g, gi) => (
            <div key={gi}>
              <div className="flex justify-center my-2">
                <span className="text-[10.5px] uppercase tracking-widest text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full">
                  {g.day}
                </span>
              </div>
              {g.items.map(({ msg, mine, showSender, showTime }) => (
                <div key={msg.id} className={`flex flex-col max-w-[78%] ${mine ? 'ml-auto items-end' : 'mr-auto items-start'} mb-0.5`}>
                  {showSender && (
                    <span className="text-[10.5px] text-slate-500 mx-2 mb-0.5">{msg.author || 'Unknown'}</span>
                  )}
                  {Array.isArray(msg.attachments) && msg.attachments.map((a, ai) => (
                    <a key={ai} href={a.url || '#'} target="_blank" rel="noreferrer"
                       className={`mb-1 px-3 py-2 rounded-2xl text-[13px] inline-flex items-center gap-2 ${mine ? 'bg-blue-600 text-white rounded-br-md' : 'bg-slate-100 text-slate-900 rounded-bl-md'}`}>
                      {a.kind === 'image' ? <ImageIcon className="w-3.5 h-3.5" /> : <Paperclip className="w-3.5 h-3.5" />}
                      <span className="truncate max-w-[180px]">{a.name || (a.kind === 'image' ? 'Photo' : 'Attachment')}</span>
                    </a>
                  ))}
                  {msg.text && (
                    <div className={`px-3 py-2 rounded-2xl text-[13.5px] leading-snug whitespace-pre-wrap break-words ${
                      mine ? 'bg-blue-600 text-white rounded-br-md' : 'bg-slate-100 text-slate-900 rounded-bl-md'
                    } ${msg.pending ? 'opacity-60' : ''}`}>
                      {msg.text}
                    </div>
                  )}
                  {showTime && (
                    <div className={`text-[10.5px] text-slate-500 mx-2 mt-0.5 flex items-center gap-1 ${mine ? 'flex-row-reverse' : ''}`}>
                      <span>{formatTimeLabel(msg.timestamp)}</span>
                      {mine && Array.isArray(msg.readBy) && msg.readBy.some((u) => u && u !== myUid) && (
                        <span className="text-blue-500" title="Read">✓✓</span>
                      )}
                      {mine && msg.pending && <span className="text-slate-400">sending…</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        )}

        {typingUsers.length > 0 && (
          <div className="flex flex-col items-start max-w-[78%] mr-auto mb-1 mt-1">
            <span className="text-[10.5px] text-slate-500 mx-2 mb-0.5">
              {typingUsers.length === 1 ? `${typingUsers[0]} is typing…` :
               typingUsers.length === 2 ? `${typingUsers[0]} and ${typingUsers[1]} are typing…` :
               `${typingUsers.length} people are typing…`}
            </span>
            <div className="px-3 py-2 rounded-2xl bg-slate-100 rounded-bl-md flex gap-1 w-12">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '160ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '320ms' }} />
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 bg-slate-50 px-2 py-2 flex items-end gap-1.5 flex-shrink-0">
        {onAttach && (
          <>
            <label className="p-1.5 text-slate-500 hover:text-slate-800 cursor-pointer rounded-full hover:bg-slate-100" title="Attach file">
              <Paperclip className="w-4 h-4" />
              <input type="file" className="hidden" onChange={onFile} />
            </label>
            <label className="p-1.5 text-slate-500 hover:text-slate-800 cursor-pointer rounded-full hover:bg-slate-100" title="Attach photo">
              <ImageIcon className="w-4 h-4" />
              <input type="file" accept="image/*" className="hidden" onChange={onFile} />
            </label>
          </>
        )}
        <textarea
          ref={composerRef}
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); fireTyping(); }}
          onKeyDown={onKey}
          placeholder="Message…"
          className="flex-1 bg-white border border-slate-200 rounded-2xl px-3 py-2 text-[13.5px] text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-400 resize-none max-h-32"
          style={{ minHeight: '36px' }}
          disabled={sending || !onSend}
        />
        <button
          onClick={send}
          disabled={!text.trim() || sending || !onSend}
          className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition ${
            !text.trim() || sending || !onSend
              ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          }`}
          title="Send"
          aria-label="Send"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

export default BubbleChat;
