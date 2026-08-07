import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Hash,
  Loader2,
  MessageSquare,
  PlugZap,
  RefreshCw,
  Send,
  Users,
} from 'lucide-react';
import { Button, Card, EmptyState, IconButton, StatusChip, cx } from './ui.jsx';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function teamsIdToken() {
  const { auth } = await import('./firebase.js');
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const token = await auth.currentUser?.getIdToken(attempt > 0);
      if (token) return token;
      lastError = new Error('Your session expired — sign in again');
    } catch (err) {
      lastError = err;
      if (!String(err?.code || '').includes('network-request-failed')) break;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(400 * (attempt + 1));
  }
  throw new Error(lastError?.message || 'Your session expired — sign in again');
}

async function teamsApi(action, body = {}) {
  const idToken = await teamsIdToken();
  const response = await fetch('/api/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken, action, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Teams request failed (${response.status})`);
    error.code = data.code || null;
    throw error;
  }
  return data;
}

function fmtWhen(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function messageHtml(message) {
  const content = message?.body?.content || '';
  if ((message?.body?.type || 'html').toLowerCase() !== 'html') {
    return `<p>${String(content).replace(/[<>&]/g, '')}</p>`;
  }
  return content;
}

function ConnectPanel({ title, description, actionLabel, onAction, busy, error }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-surface-sunken p-4">
      <Card className="w-full max-w-lg text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Users className="h-7 w-7" />
        </span>
        <h1 className="mt-4 text-xl font-semibold text-content">{title}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-content-muted">{description}</p>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft p-2.5 text-left text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {onAction && (
          <Button className="mt-5" variant="primary" icon={PlugZap} loading={busy} onClick={onAction}>
            {actionLabel}
          </Button>
        )}
        <a
          href="https://teams.microsoft.com"
          target="_blank"
          rel="noreferrer"
          className="mt-3 block text-2xs text-accent hover:underline"
        >
          Open Microsoft Teams in a new tab
        </a>
      </Card>
    </div>
  );
}

export default function TeamsHub({ currentUser }) {
  const [status, setStatus] = useState({ loading: true });
  const [teams, setTeams] = useState([]);
  const [chats, setChats] = useState([]);
  const [channelsByTeam, setChannelsByTeam] = useState({});
  const [openTeamId, setOpenTeamId] = useState(null);
  const [target, setTarget] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobileView, setMobileView] = useState('list');
  const endRef = useRef(null);

  const impersonating = currentUser?._impersonating === true;

  const loadOverview = async () => {
    try {
      const data = await teamsApi('overview');
      setTeams(data.teams || []);
      setChats(data.chats || []);
    } catch (err) {
      setError(err.message || 'Could not load Teams');
    }
  };

  useEffect(() => {
    if (impersonating) {
      setStatus({ loading: false, impersonating: true });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await teamsApi('status');
        if (cancelled) return;
        setStatus({ loading: false, ...data });
        if (data.connected && data.teamsEnabled) await loadOverview();
      } catch (err) {
        if (!cancelled) setStatus({ loading: false, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [impersonating]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const connect = async () => {
    setBusy(true);
    try {
      const { buildUserMailOAuthUrl } = await import('./firebase-user-mail.js');
      window.location.href = await buildUserMailOAuthUrl();
    } catch (err) {
      setError(err.message || 'Could not start Microsoft connection');
      setBusy(false);
    }
  };

  const openTeam = async (team) => {
    const next = openTeamId === team.id ? null : team.id;
    setOpenTeamId(next);
    if (!next || channelsByTeam[team.id]) return;
    try {
      const data = await teamsApi('channels', { teamId: team.id });
      setChannelsByTeam((current) => ({ ...current, [team.id]: data.channels || [] }));
    } catch (err) {
      setError(err.message || 'Could not load channels');
    }
  };

  const openTarget = async (nextTarget) => {
    setTarget(nextTarget);
    setMessages([]);
    setDraft('');
    setError('');
    setLoadingMessages(true);
    setMobileView('thread');
    try {
      const data = nextTarget.kind === 'channel'
        ? await teamsApi('channelMessages', { teamId: nextTarget.teamId, channelId: nextTarget.channelId })
        : await teamsApi('chatMessages', { chatId: nextTarget.chatId });
      setMessages(data.messages || []);
    } catch (err) {
      setError(err.message || 'Could not load messages');
    } finally {
      setLoadingMessages(false);
    }
  };

  const send = async () => {
    if (!draft.trim() || !target) return;
    setSending(true);
    setError('');
    try {
      const data = target.kind === 'channel'
        ? await teamsApi('sendChannelMessage', { teamId: target.teamId, channelId: target.channelId, text: draft })
        : await teamsApi('sendChatMessage', { chatId: target.chatId, text: draft });
      setMessages((current) => [...current, data.message]);
      setDraft('');
    } catch (err) {
      setError(err.message || 'Message could not be sent');
    } finally {
      setSending(false);
    }
  };

  const targetTitle = useMemo(() => {
    if (!target) return '';
    return target.kind === 'channel' ? `${target.teamName} · ${target.channelName}` : target.name;
  }, [target]);

  if (status.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-content-muted">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Checking Microsoft Teams…
      </div>
    );
  }

  if (status.impersonating) {
    return (
      <ConnectPanel
        title="Teams unavailable while viewing as another user"
        description="Return to your own account to use Microsoft Teams."
      />
    );
  }

  if (status.configured === false) {
    return (
      <ConnectPanel
        title="Microsoft is not configured yet"
        description="An administrator needs to finish the Microsoft setup for the company before Teams can be used. There is nothing you need to enter."
        error={status.error}
      />
    );
  }

  if (!status.connected) {
    return (
      <ConnectPanel
        title="Connect Microsoft to use Teams"
        description={`Sign in once with ${currentUser?.email || 'your @flyskyway.com account'} to use your Teams channels and chats inside Skyway.`}
        actionLabel="Continue with Microsoft"
        onAction={connect}
        busy={busy}
        error={status.error}
      />
    );
  }

  if (!status.teamsEnabled) {
    return (
      <ConnectPanel
        title="Approve Teams access"
        description="Your Microsoft connection covers email but not Teams yet. Reconnect once to approve Teams channels and chats — your mailbox stays connected."
        actionLabel="Reconnect Microsoft for Teams"
        onAction={connect}
        busy={busy}
        error={status.error}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-surface-sunken">
      {/* Teams + chats rail */}
      <aside className={cx(
        'flex w-full shrink-0 flex-col border-r border-edge bg-surface md:w-72',
        mobileView === 'thread' ? 'hidden md:flex' : 'flex',
      )}>
        <div className="flex items-center gap-2 border-b border-edge p-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-content">Microsoft Teams</h1>
            <p className="truncate text-2xs text-content-muted">{status.account}</p>
          </div>
          <IconButton icon={RefreshCw} title="Refresh Teams" onClick={loadOverview} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <p className="px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-content-subtle">Teams</p>
          {teams.length === 0 && <p className="px-2 py-2 text-2xs text-content-subtle">No teams found.</p>}
          {teams.map((team) => (
            <div key={team.id}>
              <button
                type="button"
                onClick={() => openTeam(team)}
                className={cx(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors',
                  openTeamId === team.id ? 'bg-surface-raised text-content' : 'text-content-muted hover:bg-surface-raised hover:text-content',
                )}
              >
                <Users className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-medium">{team.name}</span>
              </button>
              {openTeamId === team.id && (
                <div className="mb-1 ml-3 border-l border-edge pl-2">
                  {(channelsByTeam[team.id] || []).length === 0 ? (
                    <p className="px-2 py-1.5 text-2xs text-content-subtle">Loading channels…</p>
                  ) : channelsByTeam[team.id].map((channel) => {
                    const active = target?.kind === 'channel' && target.channelId === channel.id;
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        onClick={() => openTarget({
                          kind: 'channel',
                          teamId: team.id,
                          teamName: team.name,
                          channelId: channel.id,
                          channelName: channel.name,
                          webUrl: channel.webUrl,
                        })}
                        className={cx(
                          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
                          active ? 'bg-accent-soft font-semibold text-accent' : 'text-content-muted hover:bg-surface-raised hover:text-content',
                        )}
                      >
                        <Hash className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          <p className="px-2 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-content-subtle">Chats</p>
          {chats.length === 0 && <p className="px-2 py-2 text-2xs text-content-subtle">No recent chats.</p>}
          {chats.map((chat) => {
            const active = target?.kind === 'chat' && target.chatId === chat.id;
            return (
              <button
                key={chat.id}
                type="button"
                onClick={() => openTarget({ kind: 'chat', chatId: chat.id, name: chat.name, webUrl: chat.webUrl })}
                className={cx(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors',
                  active ? 'bg-accent-soft font-semibold text-accent' : 'text-content-muted hover:bg-surface-raised hover:text-content',
                )}
              >
                <MessageSquare className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{chat.name}</span>
                {chat.chatType === 'group' && <StatusChip tone="neutral" size="sm">Group</StatusChip>}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Conversation */}
      <main className={cx(
        'flex min-w-0 flex-1 flex-col bg-surface',
        mobileView === 'list' ? 'hidden md:flex' : 'flex',
      )}>
        {!target ? (
          <EmptyState
            icon={MessageSquare}
            title="Select a channel or chat"
            description="Read and reply to Microsoft Teams conversations without leaving Skyway."
            className="h-full"
          />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
              <span className="md:hidden">
                <IconButton icon={ArrowLeft} title="Back" onClick={() => setMobileView('list')} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-content">{targetTitle}</h2>
              </div>
              <IconButton
                icon={RefreshCw}
                title="Refresh conversation"
                onClick={() => openTarget(target)}
              />
              {target.webUrl && (
                <a
                  href={target.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-2xs text-accent hover:bg-accent-soft"
                >
                  Open in Teams <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>

            {error && <p className="border-b border-danger-border bg-danger-soft px-3 py-2 text-2xs text-danger">{error}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {loadingMessages ? (
                <div className="flex h-full items-center justify-center text-content-muted">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading conversation…
                </div>
              ) : messages.length === 0 ? (
                <EmptyState icon={MessageSquare} title="No messages yet" />
              ) : (
                <div className="space-y-4">
                  {messages.map((message) => (
                    <article key={message.id} className="flex gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
                        {(message.from?.name || '?').charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-baseline gap-2">
                          <span className="truncate text-xs font-semibold text-content">{message.from?.name || 'Unknown'}</span>
                          <span className="shrink-0 text-[10px] text-content-subtle">{fmtWhen(message.createdAt)}</span>
                        </p>
                        {message.subject && <p className="text-xs font-medium text-content">{message.subject}</p>}
                        <div
                          className="teams-message mt-0.5 text-sm leading-relaxed text-content-muted [&_a]:text-accent [&_img]:max-w-full"
                          // Teams returns sanitized HTML from Microsoft Graph for
                          // content the signed-in user can already read in Teams.
                          dangerouslySetInnerHTML={{ __html: messageHtml(message) }}
                        />
                        {message.attachments.length > 0 && (
                          <ul className="mt-1 space-y-0.5">
                            {message.attachments.map((attachment) => (
                              <li key={attachment.id}>
                                <a
                                  href={attachment.contentUrl || '#'}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-2xs text-accent hover:underline"
                                >
                                  {attachment.name}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </article>
                  ))}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-edge p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  rows={2}
                  placeholder={`Message ${targetTitle}`}
                  className="min-w-0 flex-1 resize-y rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content outline-none focus:border-accent"
                />
                <Button variant="primary" icon={Send} loading={sending} disabled={!draft.trim()} onClick={send}>
                  Send
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-content-subtle">Posted to Teams as you · ⌘/Ctrl + Enter to send</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
