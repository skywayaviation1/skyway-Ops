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
import { Paperclip, Image as ImageIcon, ArrowUp, Loader2, Trash2, Reply, CornerDownRight, X as XIcon } from 'lucide-react';

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
  onSend = null,             // async (text, opts?) => void — opts can include { replyTo }
  onAttach = null,           // async (file) => void — optional; hides attach buttons when absent
  onSendGif = null,          // async () => void — opens GIF picker; hides button when absent
  onTyping = null,           // (boolean) => void — optional, debounced internally
  onDelete = null,           // async (message) => void — optional; hides delete control when absent
  canDelete = null,          // (message) => boolean — optional; defaults to "mine || isAdmin?"
  usersByUid = {},           // { [uid]: { name, ... } } — used to resolve read-receipt names
  loading = false,
  emptyText = 'No messages yet — start the conversation.',
  headerTitle = null,        // optional; parent often supplies its own chrome
  headerSubtitle = null,
  className = '',
  maxHeight = '70vh',        // caller can override for embedded contexts
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Reply draft: the message currently being replied to, or null. Cleared
  // after a successful send or when the user taps the X on the preview.
  const [replyDraft, setReplyDraft] = useState(null);
  // Which message has its read-receipts panel expanded. One at a time;
  // tap a message to expand, tap again or tap another to switch.
  const [expandedReceiptsId, setExpandedReceiptsId] = useState(null);
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
    // Snapshot the reply draft into the message payload. We build the
    // snippet from text first, then fall back to attachment description
    // so replies to image-only messages still get a useful preview.
    let replyTo = null;
    if (replyDraft) {
      const att = Array.isArray(replyDraft.attachments) && replyDraft.attachments[0];
      const snippet = replyDraft.text
        ? replyDraft.text
        : att ? (att.kind === 'gif' ? 'GIF' : att.kind === 'image' ? 'Photo' : (att.name || 'Attachment'))
        : '';
      replyTo = {
        id: replyDraft.id,
        senderName: replyDraft.author || 'Unknown',
        snippet,
        hasAttachment: !!att,
      };
    }
    try {
      await onSend(t, { replyTo });
      setText('');
      setReplyDraft(null);   // clear preview banner on success
      atBottomRef.current = true;
      // refocus the composer on desktop; on mobile the keyboard is already up
      composerRef.current && composerRef.current.focus();
    } catch (e) {
      // Keep the text AND the reply draft so the user can retry; surface
      // a minimal hint.
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
    if (e.key === 'Escape' && replyDraft) {
      setReplyDraft(null);
    }
  };

  // Begin replying to a message. Stores a SNAPSHOT (not a live reference)
  // so the reply preview keeps working even if the original is soft-deleted
  // between now and when the user actually sends.
  const startReply = (msg) => {
    if (!msg || msg.deletedAt) return;
    setReplyDraft({
      id: msg.id,
      author: msg.author,
      text: msg.text,
      attachments: msg.attachments,
    });
    setExpandedReceiptsId(null); // close any open receipts panel
    // Defer focus by a tick so React commits the new state first
    setTimeout(() => { composerRef.current && composerRef.current.focus(); }, 0);
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
              {g.items.map(({ msg, mine, showSender, showTime }) => {
                const isDeleted = !!msg.deletedAt;
                // Default permission: own messages only. Caller can override
                // (e.g. admins delete anything) by passing canDelete.
                const allowDelete = !isDeleted && onDelete && (
                  canDelete ? canDelete(msg) : mine
                );
                const allowReply = !isDeleted && onSend;
                // Resolve read-receipt names (excluding self). Only meaningful
                // for own messages in conversations with 3+ readers (groups).
                const otherReaders = mine && !isDeleted && Array.isArray(msg.readBy)
                  ? msg.readBy.filter((u) => u && u !== myUid)
                  : [];
                const readerNames = otherReaders.map((uid) => {
                  const u = usersByUid[uid];
                  return (u && (u.name || u.email)) || 'Unknown user';
                });
                const isReceiptsExpanded = expandedReceiptsId === msg.id;
                return (
                <div key={msg.id} className={`group flex flex-col max-w-[78%] ${mine ? 'ml-auto items-end' : 'mr-auto items-start'} mb-0.5`}>
                  {showSender && (
                    <span className="text-[10.5px] text-slate-500 mx-2 mb-0.5">{msg.author || 'Unknown'}</span>
                  )}
                  {isDeleted ? (
                    <div className="px-3 py-2 rounded-2xl text-[13px] italic bg-slate-50 text-slate-400 border border-dashed border-slate-200">
                      message deleted
                    </div>
                  ) : (
                    <>
                      {/* Reply quote snippet — shown ABOVE the message bubble
                          when this message is a reply. Uses a paler shade of
                          the bubble color so the relationship is visually clear
                          without dominating. */}
                      {msg.replyTo && msg.replyTo.id && (
                        <div className={`mb-0.5 max-w-full ${mine ? 'self-end' : 'self-start'}`}>
                          <div className={`px-3 py-1.5 text-[11.5px] border-l-2 rounded-r-md ${
                            mine
                              ? 'bg-blue-50 border-blue-400 text-slate-700'
                              : 'bg-slate-50 border-slate-400 text-slate-600'
                          }`}>
                            <div className="font-medium text-[10px] tracking-wider uppercase opacity-70" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                              <CornerDownRight className="w-3 h-3 inline -mt-0.5 mr-1" />
                              {msg.replyTo.senderName || 'Unknown'}
                            </div>
                            <div className="truncate" style={{ maxWidth: 280 }}>
                              {msg.replyTo.hasAttachment && !msg.replyTo.snippet ? '📎 Attachment' :
                               msg.replyTo.hasAttachment ? `📎 ${msg.replyTo.snippet}` :
                               (msg.replyTo.snippet || '(empty message)')}
                            </div>
                          </div>
                        </div>
                      )}

                      {Array.isArray(msg.attachments) && msg.attachments.map((a, ai) => {
                        const isImage = a.kind === 'image' || a.kind === 'gif';
                        // Images and GIFs render inline. The user wants to
                        // see the picture in the message, not as a pill
                        // they have to tap. Click the image to open the
                        // full original in a new tab.
                        if (isImage && a.url) {
                          return (
                            <a
                              key={ai}
                              href={a.url}
                              target="_blank"
                              rel="noreferrer"
                              className="mb-1 block max-w-[260px] sm:max-w-[320px]"
                              title={a.name || (a.kind === 'gif' ? 'GIF' : 'Photo')}
                            >
                              <img
                                src={a.url}
                                alt={a.name || (a.kind === 'gif' ? 'GIF' : 'Photo')}
                                loading="lazy"
                                className={`block w-full h-auto rounded-2xl ${
                                  mine ? 'rounded-br-md' : 'rounded-bl-md'
                                } border border-slate-200/60`}
                                style={{ maxHeight: 360, objectFit: 'cover' }}
                                onError={(e) => {
                                  // If the image fails to load (deleted from
                                  // storage, network issue, etc.), gracefully
                                  // fall back to a small placeholder so the
                                  // message bubble doesn't appear empty.
                                  e.currentTarget.style.display = 'none';
                                  const fallback = e.currentTarget.nextSibling;
                                  if (fallback) fallback.style.display = 'inline-flex';
                                }}
                              />
                              <span
                                style={{ display: 'none' }}
                                className={`px-3 py-2 rounded-2xl text-[13px] items-center gap-2 ${
                                  mine ? 'bg-blue-600 text-white rounded-br-md' : 'bg-slate-100 text-slate-900 rounded-bl-md'
                                }`}
                              >
                                <ImageIcon className="w-3.5 h-3.5" />
                                <span className="truncate max-w-[180px]">
                                  {a.name || (a.kind === 'gif' ? 'GIF (unavailable)' : 'Image (unavailable)')}
                                </span>
                              </span>
                            </a>
                          );
                        }
                        // Non-image files keep the pill UI — opens the file
                        // in a new tab when tapped.
                        return (
                          <a
                            key={ai}
                            href={a.url || '#'}
                            target="_blank"
                            rel="noreferrer"
                            className={`mb-1 px-3 py-2 rounded-2xl text-[13px] inline-flex items-center gap-2 ${mine ? 'bg-blue-600 text-white rounded-br-md' : 'bg-slate-100 text-slate-900 rounded-bl-md'}`}
                          >
                            <Paperclip className="w-3.5 h-3.5" />
                            <span className="truncate max-w-[180px]">{a.name || 'Attachment'}</span>
                          </a>
                        );
                      })}
                      {msg.text && (
                        <div
                          className={`relative px-3 py-2 rounded-2xl text-[13.5px] leading-snug whitespace-pre-wrap break-words ${
                            mine ? 'bg-blue-600 text-white rounded-br-md' : 'bg-slate-100 text-slate-900 rounded-bl-md'
                          } ${msg.pending ? 'opacity-60' : ''} ${mine && readerNames.length > 0 ? 'cursor-pointer' : ''}`}
                          onClick={() => {
                            // Tap own message → toggle read-receipts panel
                            // (only meaningful when ≥1 other person has read).
                            if (mine && readerNames.length > 0) {
                              setExpandedReceiptsId(isReceiptsExpanded ? null : msg.id);
                            }
                          }}
                        >
                          {msg.text}
                          {/* Hover/long-press action buttons. On mobile (no
                              hover), they're revealed by tapping the bubble
                              first (the click handler above expands the
                              receipts panel, and the focus-within selector
                              also reveals these). To make them tappable on
                              mobile, we also show them when the receipts
                              panel is open. */}
                          {(allowReply || allowDelete) && (
                            <div
                              className={`absolute top-0 ${mine ? '-left-1 -translate-x-full' : '-right-1 translate-x-full'} flex flex-col gap-1 pr-1 pl-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 ${isReceiptsExpanded ? 'opacity-100' : ''} transition-opacity`}
                            >
                              {allowReply && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); startReply(msg); }}
                                  className="w-6 h-6 rounded-full bg-white border border-slate-300 text-slate-500 hover:text-blue-500 hover:border-blue-300 flex items-center justify-center"
                                  title="Reply"
                                  aria-label="Reply"
                                >
                                  <Reply className="w-3 h-3" />
                                </button>
                              )}
                              {allowDelete && (
                                <button
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!window.confirm('Delete this message? Anyone in the chat will see it disappear.')) return;
                                    try { await onDelete(msg); } catch (err) {
                                      console.error('[BubbleChat] delete failed:', err);
                                      window.alert('Couldn’t delete — try again.');
                                    }
                                  }}
                                  className="w-6 h-6 rounded-full bg-white border border-slate-300 text-slate-500 hover:text-red-500 hover:border-red-300 flex items-center justify-center"
                                  title="Delete message"
                                  aria-label="Delete message"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {/* For attachment-only messages (no text bubble), still
                          show a small reply action on hover so the user can
                          reply to a photo or GIF. */}
                      {!msg.text && Array.isArray(msg.attachments) && msg.attachments.length > 0 && allowReply && (
                        <button
                          onClick={() => startReply(msg)}
                          className="mt-1 text-[10px] text-slate-400 hover:text-blue-500 underline opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          Reply
                        </button>
                      )}
                    </>
                  )}
                  {showTime && (
                    <div className={`text-[10.5px] text-slate-500 mx-2 mt-0.5 flex items-center gap-1 ${mine ? 'flex-row-reverse' : ''}`}>
                      <span>{formatTimeLabel(msg.timestamp)}</span>
                      {mine && !isDeleted && readerNames.length > 0 && (
                        <span className="text-blue-500" title={`Read by ${readerNames.join(', ')}`}>✓✓</span>
                      )}
                      {mine && msg.pending && <span className="text-slate-400">sending…</span>}
                    </div>
                  )}
                  {/* Read-receipts panel — appears below the message when
                      expanded. Lists the names of everyone other than the
                      sender who has read the message. Only relevant for own
                      messages (you don't see who's read someone else's). */}
                  {mine && isReceiptsExpanded && readerNames.length > 0 && (
                    <div className="mx-2 mt-1 px-2 py-1 bg-blue-50 border border-blue-100 rounded text-[10px] text-blue-700 max-w-[260px]">
                      <span className="font-medium tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>READ BY</span>
                      <span className="ml-1.5">{readerNames.join(', ')}</span>
                    </div>
                  )}
                </div>
                );
              })}
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

      <div className="border-t border-slate-200 bg-slate-50 flex-shrink-0">
        {/* Reply preview banner — appears above the composer when the user
            has tapped Reply on a message. Shows the snippet they're
            replying to with an X to cancel. The actual replyTo payload is
            built when send() fires. */}
        {replyDraft && (
          <div className="px-3 pt-2 pb-1 border-b border-slate-200 bg-white flex items-start gap-2">
            <Reply className="w-3.5 h-3.5 text-blue-500 mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-blue-600 tracking-wider uppercase" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                Replying to {replyDraft.author || 'Unknown'}
              </div>
              <div className="text-[12px] text-slate-600 truncate">
                {replyDraft.text || (Array.isArray(replyDraft.attachments) && replyDraft.attachments[0]
                  ? (replyDraft.attachments[0].kind === 'gif' ? '📎 GIF'
                     : replyDraft.attachments[0].kind === 'image' ? '📎 Photo'
                     : `📎 ${replyDraft.attachments[0].name || 'Attachment'}`)
                  : '(empty message)')}
              </div>
            </div>
            <button
              onClick={() => setReplyDraft(null)}
              className="p-1 text-slate-400 hover:text-slate-700 rounded-full hover:bg-slate-100 shrink-0"
              title="Cancel reply"
              aria-label="Cancel reply"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="px-2 py-2 flex items-end gap-1.5">
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
        {onSendGif && (
          <button
            type="button"
            onClick={onSendGif}
            className="px-1.5 py-1 text-[10px] font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md tracking-wider"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title="Send a GIF"
          >
            GIF
          </button>
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
    </div>
  );
}

export default BubbleChat;
