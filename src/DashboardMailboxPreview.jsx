import React, { useEffect, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, Mail, RefreshCw } from 'lucide-react';
import { Button, EmptyState, IconButton } from './ui.jsx';

async function idToken() {
  const { auth } = await import('./firebase.js');
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Session expired');
  return token;
}

async function mailApi(path, action, body = {}) {
  const token = await idToken();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken: token, action, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Mailbox returned ${response.status}`);
  return data;
}

function when(value) {
  if (!value) return '';
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function DashboardMailboxPreview({
  mode,
  onOpen,
}) {
  const personal = mode === 'personal';
  const path = personal ? '/api/user-mail' : '/api/charter-mail';
  const [state, setState] = useState({ loading: true, connected: false, messages: [] });

  const load = async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const status = await mailApi(path, 'status');
      if (!status.connected || status.configured === false) {
        setState({ loading: false, messages: [], ...status });
        return;
      }
      const page = await mailApi(path, 'messages', { folderId: 'inbox' });
      setState({
        loading: false,
        connected: true,
        configured: true,
        mailbox: status.mailbox,
        messages: (page.messages || []).slice(0, 5),
      });
    } catch (error) {
      setState({ loading: false, connected: false, messages: [], error: error.message });
    }
  };

  useEffect(() => { load(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.loading) {
    return (
      <div className="flex min-h-48 items-center justify-center text-content-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading inbox…
      </div>
    );
  }

  if (!state.connected) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center p-4 text-center">
        {state.error ? <AlertTriangle className="h-7 w-7 text-warning" /> : <Mail className="h-7 w-7 text-content-subtle" />}
        <p className="mt-2 text-sm font-medium text-content">
          {state.error || (personal ? 'Personal mailbox not connected' : 'Shared inbox not configured')}
        </p>
        <Button className="mt-3" size="sm" variant="secondary" onClick={onOpen}>
          {personal ? 'Connect / open mailbox' : 'Open shared inbox'}
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        {personal ? <Mail className="h-4 w-4 text-content-subtle" /> : <Inbox className="h-4 w-4 text-content-subtle" />}
        <span className="min-w-0 flex-1 truncate text-2xs text-content-muted">{state.mailbox}</span>
        <IconButton icon={RefreshCw} title="Refresh inbox" size="sm" onClick={load} />
      </div>
      {state.messages.length === 0 ? (
        <EmptyState icon={Mail} title="Inbox is clear" className="min-h-44" />
      ) : (
        <div className="divide-y divide-edge">
          {state.messages.map((message) => (
            <button
              key={message.id}
              type="button"
              onClick={onOpen}
              className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-raised"
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${message.isRead ? 'bg-edge-strong' : 'bg-accent'}`} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-xs text-content ${message.isRead ? '' : 'font-semibold'}`}>
                  {message.from?.name || message.from?.address || 'Unknown'}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-content-muted">{message.subject || '(no subject)'}</span>
              </span>
              <span className="shrink-0 text-[10px] text-content-subtle">
                {when(message.receivedAt || message.sentAt)}
              </span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="w-full border-t border-edge px-3 py-2 text-center text-2xs font-semibold text-accent hover:bg-accent-soft"
      >
        Open full inbox
      </button>
    </div>
  );
}
