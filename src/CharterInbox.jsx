import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  FileText,
  Flag,
  Folder,
  FolderPlus,
  Forward,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Tag,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  IconButton,
  StatusChip,
  cx,
} from './ui.jsx';
import { applyContact, filterContacts } from './mail-contacts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// getIdToken() can throw auth/network-request-failed transiently, which is what
// blocked a second person opening the shared inbox. Retry a couple of times
// before surfacing an error so a brief connectivity blip is not fatal.
async function mailIdToken() {
  const { auth } = await import('./firebase.js');
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = await auth.currentUser?.getIdToken(attempt > 0);
      if (token) return token;
      lastError = new Error('Your mailbox session expired — sign in again');
    } catch (err) {
      lastError = err;
      if (!String(err?.code || '').includes('network-request-failed')) break;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(400 * (attempt + 1));
  }
  throw new Error(lastError?.message || 'Your mailbox session expired — sign in again');
}

async function mailboxApi(apiPath, action, body = {}) {
  const idToken = await mailIdToken();
  const response = await fetch(apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken, action, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Mailbox request failed (${response.status})`);
  return data;
}

function flattenFolders(folders, depth = 0) {
  const result = [];
  for (const folder of folders || []) {
    result.push({ ...folder, depth });
    result.push(...flattenFolders(folder.children, depth + 1));
  }
  return result;
}

function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addresses(values) {
  return (values || []).map((item) => item.address).filter(Boolean).join(', ');
}

function splitAddresses(value) {
  return String(value || '').split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean);
}

function senderLabel(message) {
  return message?.from?.name || message?.from?.address || 'Unknown sender';
}

function safeMessageHtml(message) {
  const content = message?.body?.content || '<p>No message body.</p>';
  // iframe sandbox disables scripts; CSP also prevents remote tracking pixels.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.55;color:#1f2937;padding:18px;margin:0;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#0369a1}</style></head><body>${content}</body></html>`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function FolderRow({ folder, active, onClick }) {
  const name = folder.name.toLowerCase();
  const Icon = name === 'inbox' ? Inbox
    : name.includes('sent') ? Send
      : name.includes('deleted') || name.includes('trash') ? Trash2
        : name.includes('archive') ? Archive : Folder;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2 rounded-lg py-2 pr-2 text-left text-xs transition-colors',
        active ? 'bg-accent-soft font-semibold text-accent' : 'text-content-muted hover:bg-surface-raised hover:text-content',
      )}
      style={{ paddingLeft: `${10 + folder.depth * 14}px` }}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
      {folder.unread > 0 && <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[9px] text-white">{folder.unread}</span>}
    </button>
  );
}

function MessageRow({ message, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'block w-full border-b border-edge px-3 py-3 text-left transition-colors',
        active ? 'bg-accent-soft' : 'hover:bg-surface-raised',
        !message.isRead && 'border-l-2 border-l-accent',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cx('truncate text-xs text-content', !message.isRead && 'font-semibold')}>
          {senderLabel(message)}
        </span>
        <span className="shrink-0 text-[10px] text-content-subtle">{fmtTime(message.receivedAt || message.sentAt)}</span>
      </div>
      <p className={cx('mt-1 truncate text-xs text-content-muted', !message.isRead && 'font-semibold text-content')}>
        {message.subject}
      </p>
      <p className="mt-1 line-clamp-2 text-2xs leading-relaxed text-content-subtle">{message.preview}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        {message.hasAttachments && <Paperclip className="h-3 w-3 text-content-subtle" />}
        {message.filing?.tripUid && <StatusChip tone="accent" size="sm" icon={Tag}>Trip filed</StatusChip>}
        {message.importance === 'high' && <StatusChip tone="danger" size="sm">High</StatusChip>}
      </div>
    </button>
  );
}

function RecipientInput({ value, onChange, placeholder, contacts }) {
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef(null);
  const suggestions = useMemo(
    () => (focused ? filterContacts(contacts, value) : []),
    [focused, contacts, value],
  );

  useEffect(() => { setHighlight(0); }, [value]);

  const choose = (contact) => {
    onChange(applyContact(value, contact.address));
    setHighlight(0);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={(event) => {
          if (!suggestions.length) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((h) => (h + 1) % suggestions.length); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); }
          else if (event.key === 'Enter' || event.key === 'Tab') {
            if (suggestions[highlight]) { event.preventDefault(); choose(suggestions[highlight]); }
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded border border-edge bg-surface-sunken px-3 py-2 text-sm text-content outline-none focus:border-accent"
      />
      {suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-edge bg-surface shadow-lg">
          {suggestions.map((contact, index) => (
            <li key={contact.address}>
              <button
                type="button"
                onMouseDown={(event) => { event.preventDefault(); choose(contact); }}
                className={cx(
                  'flex w-full flex-col items-start px-3 py-1.5 text-left',
                  index === highlight ? 'bg-accent-soft' : 'hover:bg-surface-raised',
                )}
              >
                {contact.name && <span className="text-xs font-medium text-content">{contact.name}</span>}
                <span className="text-2xs text-content-muted">{contact.address}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Composer({ mode = 'compose', source, currentUser, apiPath, sentAs, contacts = [], onClose, onSent }) {
  const [to, setTo] = useState(() => {
    if (mode === 'replyAll') {
      return [...(source?.from?.address ? [source.from.address] : []), ...((source?.to || []).map((item) => item.address))]
        .filter((value, index, all) => value !== currentUser.email && all.indexOf(value) === index)
        .join(', ');
    }
    if (mode === 'reply') return source?.from?.address || '';
    return '';
  });
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [importance, setImportance] = useState('normal');
  const [subject, setSubject] = useState(() => (
    mode === 'forward' ? `Fwd: ${source?.subject || ''}`
      : mode.startsWith('reply') ? `Re: ${source?.subject || ''}` : ''
  ));
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isThreadAction = mode !== 'compose';
  // Every mode now supports adding recipients and attachments, matching Outlook.
  const showTo = mode === 'compose' || mode === 'forward';

  const addFiles = (event) => {
    const selected = [...(event.target.files || [])];
    event.target.value = '';
    const total = [...files, ...selected].reduce((sum, file) => sum + file.size, 0);
    if (selected.some((file) => file.size > 2 * 1024 * 1024) || total > 3 * 1024 * 1024) {
      setError('Each attachment must be 2 MB or smaller and total 3 MB or less.');
      return;
    }
    setFiles((current) => [...current, ...selected]);
  };

  const readAttachments = async () => {
    const attachments = [];
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const contentBase64 = await fileToBase64(file);
      attachments.push({ name: file.name, contentType: file.type, contentBase64 });
    }
    return attachments;
  };

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const attachments = await readAttachments();
      if (isThreadAction) {
        await mailboxApi(apiPath, 'reply', {
          messageId: source.id,
          mode,
          text,
          to: mode === 'forward' ? splitAddresses(to) : undefined,
          cc: splitAddresses(cc),
          bcc: splitAddresses(bcc),
          attachments,
        });
      } else {
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${text.split(/\r?\n/).map((line) => line ? line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '<br>').join('<br>')}</div>`;
        await mailboxApi(apiPath, 'send', {
          to: splitAddresses(to),
          cc: splitAddresses(cc),
          bcc: splitAddresses(bcc),
          subject,
          html,
          importance,
          attachments,
        });
      }
      onSent?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Email could not be sent');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <IconButton icon={X} title="Close composer" onClick={onClose} />
        <h2 className="text-sm font-semibold text-content">
          {mode === 'compose' ? 'New message' : mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply all' : 'Reply'}
        </h2>
      </div>
      <div className="space-y-2 border-b border-edge p-3">
        {showTo && (
          <RecipientInput value={to} onChange={setTo} placeholder="To" contacts={contacts} />
        )}
        {!showCc ? (
          <button type="button" onClick={() => setShowCc(true)} className="text-2xs font-medium text-accent hover:underline">
            Add Cc / Bcc
          </button>
        ) : (
          <>
            <RecipientInput value={cc} onChange={setCc} placeholder="Cc" contacts={contacts} />
            <RecipientInput value={bcc} onChange={setBcc} placeholder="Bcc" contacts={contacts} />
          </>
        )}
        <div className="flex items-center gap-2">
          <input value={subject} onChange={(event) => setSubject(event.target.value)} readOnly={isThreadAction} placeholder="Subject" className="min-w-0 flex-1 rounded border border-edge bg-surface-sunken px-3 py-2 text-sm text-content outline-none focus:border-accent read-only:opacity-70" />
          {mode === 'compose' && (
            <select value={importance} onChange={(event) => setImportance(event.target.value)} title="Importance" className="rounded border border-edge bg-surface-sunken px-2 py-2 text-2xs text-content-muted">
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
          )}
        </div>
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Write your message…"
        className="min-h-[16rem] flex-1 resize-none bg-surface p-4 text-sm leading-relaxed text-content outline-none"
      />
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-edge px-3 py-2">
          {files.map((file, index) => (
            <button key={`${file.name}-${index}`} type="button" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))} className="inline-flex items-center gap-1 rounded bg-surface-raised px-2 py-1 text-2xs text-content-muted">
              <Paperclip className="h-3 w-3" /> {file.name} <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}
      {error && <p className="border-t border-danger-border bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2 border-t border-edge p-3">
        <label className="cursor-pointer rounded-lg border border-edge p-2 text-content-muted hover:text-content" title="Attach files">
          <Paperclip className="h-4 w-4" />
          <input type="file" multiple className="hidden" onChange={addFiles} />
        </label>
        <p className="min-w-0 flex-1 truncate text-2xs text-content-subtle">
          Sent as {sentAs || currentUser.email} · your saved signature is added automatically
        </p>
        <Button variant="primary" icon={Send} loading={busy} disabled={!text.trim() || (showTo && !to.trim())} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}

export function TripEmailPanel({ tripUid, currentUser }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await mailboxApi('/api/charter-mail', 'tripMessages', { tripUid });
        if (!cancelled) setMessages(result.messages || []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load filed emails');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tripUid]);

  if (!['admin', 'sales'].includes(currentUser?.role)) return null;
  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <Card padded={false}>
        <CardHeader
          title="Filed charter emails"
          subtitle="Messages filed from the shared charters@ mailbox"
          icon={Mail}
          className="p-4 pb-2"
        />
        <div className="border-t border-edge">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-content-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading emails…
            </div>
          ) : error ? (
            <p className="px-4 py-3 text-xs text-danger">{error}</p>
          ) : messages.length === 0 ? (
            <EmptyState icon={Mail} title="No emails filed to this trip" description="Admin or sales can file messages from Shared Inbox." />
          ) : messages.map((message) => (
            <a
              key={message.id}
              href={message.webLink || undefined}
              target={message.webLink ? '_blank' : undefined}
              rel="noreferrer"
              className="flex items-center gap-3 border-b border-edge px-4 py-3 last:border-b-0 hover:bg-surface-raised"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                {message.unavailable ? <FileText className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-content">{message.subject}</span>
                <span className="block truncate text-2xs text-content-muted">
                  {senderLabel(message)} · {fmtTime(message.receivedAt || message.sentAt)}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-content-subtle" />
            </a>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default function CharterInbox({
  currentUser,
  trips = [],
  initialTripUid = null,
  mailboxMode = 'shared',
  connection = null,
  onDisconnect = null,
}) {
  const personal = mailboxMode === 'personal';
  const apiPath = personal ? '/api/user-mail' : '/api/charter-mail';
  const attachmentPath = personal ? '/api/user-mail-attachment' : '/api/charter-mail-attachment';
  const [status, setStatus] = useState(null);
  const [mailReady, setMailReady] = useState(false);
  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState('inbox');
  const [messages, setMessages] = useState([]);
  const [next, setNext] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [composer, setComposer] = useState(null);
  const [mobileView, setMobileView] = useState('list');
  const [filingTrip, setFilingTrip] = useState(initialTripUid || '');
  const [contacts, setContacts] = useState([]);

  const flatFolders = useMemo(() => flattenFolders(folders), [folders]);
  const selected = messages.find((message) => message.id === selectedId) || detail;

  const loadFolders = async () => {
    const result = await mailboxApi(apiPath, 'folders');
    setFolders(result.folders || []);
  };

  const loadMessages = async ({ append = false, query = search } = {}) => {
    setLoading(true);
    setError('');
    try {
      const result = await mailboxApi(apiPath, 'messages', {
        folderId,
        search: query,
        next: append ? next : null,
      });
      setMessages((current) => append ? [...current, ...(result.messages || [])] : (result.messages || []));
      setNext(result.next || null);
    } catch (err) {
      setError(err.message || 'Could not load mailbox');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mailStatus = await mailboxApi(apiPath, 'status');
        if (cancelled) return;
        if (mailStatus?.configured === false) {
          setStatus(mailStatus);
          setError(
            mailStatus.setupHint
              || (personal
                ? 'Personal work-mail integration is not configured on the server yet.'
                : 'Shared mailbox Graph credentials are not configured. An administrator must set MICROSOFT_MAIL_* on the deployment (see Organization settings → Mailboxes).'),
          );
          return;
        }
        await loadFolders();
        // Deliberately sequential. Starting folders, contacts and messages in
        // parallel is enough to trip Graph's shared MailboxConcurrency limit.
        const addressBook = await mailboxApi(apiPath, 'contacts').catch(() => ({ contacts: [] }));
        if (cancelled) return;
        setContacts(addressBook.contacts || []);
        setStatus(mailStatus);
        setMailReady(true);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Shared mailbox is not configured');
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mailReady || status?.configured === false) return;
    loadMessages({ query: '' });
  }, [folderId, status?.configured, mailReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const openMessage = async (message) => {
    setSelectedId(message.id);
    setDetail(message);
    setDetailLoading(true);
    setMobileView('message');
    setFilingTrip(message.filing?.tripUid || '');
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, isRead: true } : item));
    try {
      const result = await mailboxApi(apiPath, 'message', { messageId: message.id });
      setDetail(result.message);
      setFilingTrip(result.message?.filing?.tripUid || '');
    } catch (err) {
      setError(err.message || 'Could not open message');
    } finally {
      setDetailLoading(false);
    }
  };

  const fileMessage = async (tripUid) => {
    if (!detail) return;
    setFilingTrip(tripUid);
    try {
      if (tripUid) {
        const result = await mailboxApi(apiPath, 'fileTrip', {
          messageId: detail.id,
          tripUid,
          conversationId: detail.conversationId,
          subject: detail.subject,
          from: detail.from,
          receivedAt: detail.receivedAt,
        });
        setDetail((current) => ({ ...current, filing: result.filing }));
        setMessages((current) => current.map((item) => item.id === detail.id ? { ...item, filing: result.filing } : item));
      } else {
        await mailboxApi(apiPath, 'unfileTrip', {
          messageId: detail.id,
          conversationId: detail.conversationId,
        });
        setDetail((current) => ({ ...current, filing: null }));
        setMessages((current) => current.map((item) => item.id === detail.id ? { ...item, filing: null } : item));
      }
    } catch (err) {
      setError(err.message || 'Could not file email');
    }
  };

  const moveMessage = async (destinationId) => {
    if (!detail || !destinationId) return;
    try {
      await mailboxApi(apiPath, 'move', { messageId: detail.id, destinationId });
      setMessages((current) => current.filter((item) => item.id !== detail.id));
      setDetail(null);
      setSelectedId(null);
      setMobileView('list');
      await loadFolders();
    } catch (err) {
      setError(err.message || 'Could not move email');
    }
  };

  const deleteMessage = async () => {
    if (!detail) return;
    try {
      await mailboxApi(apiPath, 'delete', { messageId: detail.id });
      setMessages((current) => current.filter((item) => item.id !== detail.id));
      setDetail(null);
      setSelectedId(null);
      setMobileView('list');
      await loadFolders();
    } catch (err) {
      setError(err.message || 'Could not delete email');
    }
  };

  const toggleRead = async () => {
    if (!detail) return;
    const nextRead = !detail.isRead;
    try {
      await mailboxApi(apiPath, 'markRead', { messageId: detail.id, isRead: nextRead });
      setDetail((current) => ({ ...current, isRead: nextRead }));
      setMessages((current) => current.map((item) => item.id === detail.id ? { ...item, isRead: nextRead } : item));
    } catch (err) {
      setError(err.message || 'Could not update message');
    }
  };

  const toggleFlag = async () => {
    if (!detail) return;
    const flagStatus = detail.flag === 'flagged' ? 'notFlagged' : 'flagged';
    try {
      await mailboxApi(apiPath, 'flag', { messageId: detail.id, flagStatus });
      setDetail((current) => ({ ...current, flag: flagStatus }));
      setMessages((current) => current.map((item) => item.id === detail.id ? { ...item, flag: flagStatus } : item));
    } catch (err) {
      setError(err.message || 'Could not flag message');
    }
  };

  const createFolder = async () => {
    const name = window.prompt('New mailbox folder name:');
    if (!name?.trim()) return;
    try {
      await mailboxApi(apiPath, 'createFolder', { name: name.trim() });
      await loadFolders();
    } catch (err) {
      setError(err.message || 'Could not create folder');
    }
  };

  const downloadAttachment = async (attachment) => {
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch(attachmentPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, messageId: detail.id, attachmentId: attachment.id }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Could not download attachment');
    }
  };

  const tripSuggestions = useMemo(() => {
    if (!detail) return trips.slice(0, 50);
    const haystack = `${detail.subject} ${detail.from?.address || ''}`.toLowerCase();
    return [...trips].sort((a, b) => {
      const score = (trip) => {
        let value = 0;
        if (trip.info?.tail && haystack.includes(String(trip.info.tail).toLowerCase())) value += 4;
        if (trip.info?.broker && haystack.includes(String(trip.info.broker).toLowerCase())) value += 5;
        if (trip.info?.from && haystack.includes(String(trip.info.from).toLowerCase())) value += 1;
        if (trip.info?.to && haystack.includes(String(trip.info.to).toLowerCase())) value += 1;
        return value;
      };
      return score(b) - score(a) || new Date(b.start) - new Date(a.start);
    }).slice(0, 100);
  }, [detail, trips]);

  if (!personal && !['admin', 'sales'].includes(currentUser?.role)) return null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-surface-sunken">
      {/* Folder rail */}
      <aside className={cx(
        'w-56 shrink-0 border-r border-edge bg-surface p-2',
        mobileView !== 'list' ? 'hidden lg:block' : 'hidden md:block',
      )}>
        <Button block variant="primary" icon={Plus} onClick={() => setComposer({ mode: 'compose' })}>New email</Button>
        <div className="mt-3 flex items-center justify-between px-2">
          <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Folders</span>
          <IconButton icon={FolderPlus} title="New folder" size="sm" onClick={createFolder} />
        </div>
        <div className="mt-1 max-h-[calc(100vh-14rem)] overflow-y-auto">
          {flatFolders.map((folder) => (
            <FolderRow key={folder.id} folder={folder} active={folderId === folder.id} onClick={() => {
              setFolderId(folder.id);
              setSelectedId(null);
              setDetail(null);
              setSearch('');
              setSearchDraft('');
            }} />
          ))}
        </div>
      </aside>

      {/* Message list */}
      <section className={cx(
        'flex h-full w-full shrink-0 flex-col border-r border-edge bg-surface md:w-80 lg:w-96',
        mobileView === 'message' || composer ? 'hidden md:block' : 'block',
      )}>
        <div className="border-b border-edge p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold text-content">{status?.displayName || 'Charter Inbox'}</h1>
              <p className="truncate text-2xs text-content-muted">{status?.mailbox || 'charters@flyskyway.com'}</p>
            </div>
            <IconButton icon={RefreshCw} title="Refresh mailbox" onClick={() => loadMessages()} />
            {personal && onDisconnect && (
              <IconButton icon={Unplug} title="Disconnect my mailbox" onClick={onDisconnect} />
            )}
            <span className="md:hidden"><IconButton icon={Plus} title="New email" onClick={() => setComposer({ mode: 'compose' })} /></span>
          </div>
          <form className="relative mt-3" onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft.trim());
            loadMessages({ query: searchDraft.trim() });
          }}>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-content-subtle" />
            <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search this folder" className="w-full rounded-lg border border-edge bg-surface-sunken py-2 pl-9 pr-3 text-xs text-content outline-none focus:border-accent" />
          </form>
        </div>
        {error && <p className="border-b border-danger-border bg-danger-soft px-3 py-2 text-2xs text-danger">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && !messages.length ? (
            <div className="flex items-center justify-center py-16 text-content-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading mail…</div>
          ) : messages.length === 0 ? (
            <EmptyState icon={MailOpen} title={search ? 'No search results' : 'Folder is empty'} />
          ) : messages.map((message) => (
            <MessageRow key={message.id} message={message} active={message.id === selectedId} onClick={() => openMessage(message)} />
          ))}
          {next && (
            <Button block variant="ghost" loading={loading} onClick={() => loadMessages({ append: true })}>Load more</Button>
          )}
        </div>
      </section>

      {/* Reading / compose pane */}
      <main className={cx(
        'min-w-0 flex-1 bg-surface',
        mobileView === 'list' && !composer ? 'hidden md:block' : 'block',
      )}>
        {composer ? (
          <Composer
            mode={composer.mode}
            source={composer.source}
            currentUser={currentUser}
            apiPath={apiPath}
            contacts={contacts}
            sentAs={status?.mailbox || connection?.mailbox || currentUser.email}
            onClose={() => setComposer(null)}
            onSent={() => loadMessages()}
          />
        ) : detail ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-edge px-3 py-2">
              <div className="flex items-center gap-1">
                <span className="md:hidden"><IconButton icon={ArrowLeft} title="Back to messages" onClick={() => setMobileView('list')} /></span>
                <IconButton icon={Reply} title="Reply" onClick={() => setComposer({ mode: 'reply', source: detail })} />
                <IconButton icon={ReplyAll} title="Reply all" onClick={() => setComposer({ mode: 'replyAll', source: detail })} />
                <IconButton icon={Forward} title="Forward" onClick={() => setComposer({ mode: 'forward', source: detail })} />
                <IconButton
                  icon={Flag}
                  title={detail.flag === 'flagged' ? 'Clear flag' : 'Flag'}
                  onClick={toggleFlag}
                  className={detail.flag === 'flagged' ? 'text-danger' : undefined}
                />
                <IconButton
                  icon={detail.isRead ? Mail : MailOpen}
                  title={detail.isRead ? 'Mark unread' : 'Mark read'}
                  onClick={toggleRead}
                />
                <IconButton icon={Trash2} title="Delete" onClick={deleteMessage} />
                <select value="" onChange={(event) => moveMessage(event.target.value)} className="ml-1 rounded border border-edge bg-surface px-2 py-1.5 text-2xs text-content-muted">
                  <option value="">Move to…</option>
                  {flatFolders.filter((folder) => folder.id !== detail.parentFolderId).map((folder) => (
                    <option key={folder.id} value={folder.id}>{'—'.repeat(folder.depth)} {folder.name}</option>
                  ))}
                </select>
                {detail.webLink && (
                  <a href={detail.webLink} target="_blank" rel="noreferrer" className="ml-auto rounded px-2 py-1.5 text-2xs text-accent hover:bg-accent-soft">
                    Open in Outlook
                  </a>
                )}
              </div>
            </div>
            <div className="shrink-0 border-b border-edge p-4">
              <h2 className="text-lg font-semibold leading-tight text-content">{detail.subject}</h2>
              <div className="mt-3 flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent">
                  {senderLabel(detail).charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-content">{senderLabel(detail)}</p>
                  <p className="truncate text-2xs text-content-muted">{detail.from?.address}</p>
                  <details className="mt-1 text-2xs text-content-subtle">
                    <summary className="cursor-pointer">To {addresses(detail.to) || '—'} · {fmtTime(detail.receivedAt || detail.sentAt)}</summary>
                    {detail.cc?.length > 0 && <p className="mt-1">Cc: {addresses(detail.cc)}</p>}
                  </details>
                </div>
              </div>
              {!personal && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Tag className="h-4 w-4 text-content-subtle" />
                <select value={filingTrip} onChange={(event) => fileMessage(event.target.value)} className="min-w-0 max-w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-xs text-content">
                  <option value="">Not filed to a trip</option>
                  {tripSuggestions.map((trip) => (
                    <option key={trip.uid} value={trip.uid}>
                      {trip.info?.tail || '?'} · {trip.info?.from || '?'} → {trip.info?.to || '?'} · {new Date(trip.start).toLocaleDateString()}
                    </option>
                  ))}
                </select>
                {detail.filing?.filedByName && <span className="text-2xs text-content-subtle">Filed by {detail.filing.filedByName}</span>}
              </div>
              )}
              {detail.attachments?.filter((attachment) => !attachment.isInline).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {detail.attachments.filter((attachment) => !attachment.isInline).map((attachment) => (
                    <button key={attachment.id} type="button" onClick={() => downloadAttachment(attachment)} className="inline-flex items-center gap-2 rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-2xs text-content-muted hover:text-content">
                      <File className="h-4 w-4" />
                      <span>{attachment.name}</span>
                      <span className="text-content-subtle">{Math.ceil(attachment.size / 1024)} KB</span>
                      <Download className="h-3 w-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {detailLoading ? (
                <div className="flex h-full items-center justify-center text-content-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading message…</div>
              ) : (
                <iframe title={detail.subject} sandbox="" srcDoc={safeMessageHtml(detail)} className="h-full w-full border-0 bg-white" />
              )}
            </div>
          </div>
        ) : (
          <EmptyState icon={Mail} title="Select a message" description="Read, reply, move, or file charter communication to a trip." className="h-full" />
        )}
      </main>
    </div>
  );
}
