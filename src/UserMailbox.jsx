import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Mail, PlugZap, Unplug } from 'lucide-react';
import CharterInbox from './CharterInbox.jsx';
import { Button, Card, StatusChip, cx } from './ui.jsx';

async function statusRequest() {
  const { auth } = await import('./firebase.js');
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Your mailbox session expired');
  const response = await fetch('/api/user-mail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken, action: 'status' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not read mailbox connection');
  return data;
}

export default function UserMailbox({ currentUser }) {
  const [connection, setConnection] = useState({ loading: true, connected: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async () => {
    setConnection((current) => ({ ...current, loading: true }));
    try {
      setConnection({ ...(await statusRequest()), loading: false });
    } catch (err) {
      setConnection({ loading: false, connected: false, error: err.message });
    }
  };

  useEffect(() => {
    if (currentUser?._impersonating) return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get('userMail');
    if (result === 'connected') {
      setMessage({ tone: 'success', text: `Connected ${params.get('msg') || 'your work mailbox'}.` });
    } else if (result === 'error') {
      setMessage({ tone: 'danger', text: params.get('msg') || 'Mailbox connection failed.' });
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { buildUserMailOAuthUrl } = await import('./firebase-user-mail.js');
      window.location.href = await buildUserMailOAuthUrl();
    } catch (err) {
      setMessage({ tone: 'danger', text: err.message || 'Could not start Microsoft connection' });
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect your work mailbox from Skyway? Your mail remains in Microsoft 365.')) return;
    setBusy(true);
    try {
      const { disconnectUserMailbox } = await import('./firebase-user-mail.js');
      const result = await disconnectUserMailbox();
      setConnection({ loading: false, connected: false });
      setMessage({ tone: 'success', text: result.message || 'Mailbox disconnected.' });
    } catch (err) {
      setMessage({ tone: 'danger', text: err.message || 'Could not disconnect mailbox' });
    } finally {
      setBusy(false);
    }
  };

  if (currentUser?._impersonating) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface-sunken p-4">
        <Card className="max-w-lg text-center">
          <Mail className="mx-auto h-8 w-8 text-content-subtle" />
          <h2 className="mt-3 text-lg font-semibold text-content">Personal mail unavailable while viewing as another user</h2>
          <p className="mt-2 text-sm text-content-muted">Return to your administrator identity before opening or connecting a personal mailbox.</p>
        </Card>
      </div>
    );
  }

  if (connection.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-content-muted">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Checking your Microsoft mailbox…
      </div>
    );
  }

  if (!connection.connected) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface-sunken p-4">
        <Card className="w-full max-w-lg text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Mail className="h-7 w-7" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-content">Connect your work email</h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-content-muted">
            Use your own {currentUser?.email || '@flyskyway.com'} Microsoft mailbox inside Skyway for folders, search, sending, replies and attachments.
          </p>
          <div className="mt-4 rounded-lg border border-edge bg-surface-sunken p-3 text-left text-2xs leading-relaxed text-content-muted">
            Your password is never shared with Skyway. Microsoft grants a delegated mailbox token that is encrypted at rest by Firestore and only used by authenticated server APIs.
          </div>
          {connection.error && <p className="mt-3 text-xs text-danger">{connection.error}</p>}
          {message && (
            <div className={cx(
              'mt-3 flex items-start gap-2 rounded-lg border p-2.5 text-left text-xs',
              message.tone === 'success'
                ? 'border-success-border bg-success-soft text-success'
                : 'border-danger-border bg-danger-soft text-danger',
            )}>
              {message.tone === 'success' ? <Check className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
              {message.text}
            </div>
          )}
          <Button className="mt-5" variant="primary" icon={PlugZap} onClick={connect} loading={busy}>
            Connect Microsoft work email
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      {message && (
        <div className={cx(
          'absolute left-1/2 top-2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg',
          message.tone === 'success'
            ? 'border-success-border bg-success-soft text-success'
            : 'border-danger-border bg-danger-soft text-danger',
        )}>
          {message.tone === 'success' ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {message.text}
        </div>
      )}
      <CharterInbox
        currentUser={currentUser}
        mailboxMode="personal"
        connection={connection}
        onDisconnect={disconnect}
      />
      <div className="absolute bottom-3 left-3 z-40 hidden md:block">
        <Button size="sm" variant="outline" icon={Unplug} onClick={disconnect} loading={busy}>
          Disconnect my mailbox
        </Button>
      </div>
    </div>
  );
}
