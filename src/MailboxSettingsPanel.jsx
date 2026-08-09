import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Inbox,
  Loader2,
  Mail,
  PlugZap,
  Unplug,
} from 'lucide-react';
import { Button, Card, CardHeader, StatusChip, cx } from './ui.jsx';

async function postMailApi(path, body = {}) {
  const { auth } = await import('./firebase.js');
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Sign in again to manage mailbox connections');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function Banner({ tone, children }) {
  return (
    <div className={cx(
      'mt-2 flex items-start gap-2 rounded-lg border p-2.5 text-xs',
      tone === 'success'
        ? 'border-success-border bg-success-soft text-success'
        : tone === 'warn'
          ? 'border-warning-border bg-warning-soft text-warning'
          : 'border-danger-border bg-danger-soft text-danger',
    )}>
      {tone === 'success'
        ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span className="leading-relaxed">{children}</span>
    </div>
  );
}

function PersonalMailboxCard({ currentUser, compact = false }) {
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const isAdmin = currentUser?.role === 'admin';

  const load = async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await postMailApi('/api/user-mail', { action: 'status' });
      setState({ loading: false, ...data });
    } catch (err) {
      setState({ loading: false, connected: false, configured: false, error: err.message });
    }
  };

  useEffect(() => {
    if (currentUser?._impersonating) {
      setState({ loading: false, connected: false, impersonating: true });
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const result = params.get('userMail');
    if (result === 'connected') {
      setMessage({ tone: 'success', text: `Connected ${params.get('msg') || 'your work mailbox'}.` });
      params.delete('userMail');
      params.delete('msg');
      const clean = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', clean);
    } else if (result === 'error') {
      setMessage({ tone: 'danger', text: params.get('msg') || 'Mailbox connection failed.' });
      params.delete('userMail');
      params.delete('msg');
      const clean = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', clean);
    }
    load();
  }, [currentUser?._impersonating]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setMessage(null);
    try {
      const { disconnectUserMailbox } = await import('./firebase-user-mail.js');
      const result = await disconnectUserMailbox();
      setState({ loading: false, connected: false, configured: state.configured !== false });
      setMessage({ tone: 'success', text: result.message || 'Mailbox disconnected.' });
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: err.message || 'Could not disconnect mailbox' });
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      <p className={cx('text-sm leading-relaxed', compact ? 'text-slate-400' : 'text-content-muted')}>
        Sign in once with {currentUser?.email || 'your @flyskyway.com account'} to use folders, search, send and replies inside Skyway. No mailbox password or setup values are required from you.
      </p>

      {state.loading ? (
        <p className={cx('mt-3 flex items-center gap-2 text-xs', compact ? 'text-slate-500' : 'text-content-muted')}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking connection…
        </p>
      ) : state.impersonating ? (
        <Banner tone="warn">Return to your own account before connecting a personal mailbox.</Banner>
      ) : state.connected ? (
        <div className="mt-3 space-y-2">
          <div className={cx(
            'rounded-lg border p-3',
            compact ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-success-border bg-success-soft',
          )}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone="success" size="sm">Connected</StatusChip>
              <span className={cx('text-sm font-medium', compact ? 'text-slate-100' : 'text-content')}>
                {state.mailbox || currentUser?.email}
              </span>
            </div>
            {state.connectedAt && (
              <p className={cx('mt-1 text-2xs', compact ? 'text-slate-500' : 'text-content-subtle')}>
                Connected {new Date(state.connectedAt).toLocaleString()}
              </p>
            )}
          </div>
          <Button size="sm" variant="outline" icon={Unplug} onClick={disconnect} loading={busy}>
            Disconnect my mailbox
          </Button>
        </div>
      ) : state.configured === false ? (
        <div className="mt-3 space-y-2">
          <Banner tone="warn">
            {isAdmin
              ? (state.setupHint
                || state.error
                || 'Personal work-mail integration is not configured on the server yet. Add the Microsoft mail environment variables once for the company, then redeploy.')
              : 'Microsoft mail sign-in is not available yet. Your administrator needs to enable it once for the company; there is nothing you need to enter.'}
          </Banner>
          {isAdmin && (
            <p className={cx('text-2xs', compact ? 'text-slate-500' : 'text-content-subtle')}>
              Administrator setup: docs/personal-work-mail-setup.md
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {state.error && <Banner tone="danger">{state.error}</Banner>}
          <Button variant="primary" icon={PlugZap} onClick={connect} loading={busy}>
            Continue with Microsoft
          </Button>
        </div>
      )}

      {message && (
        <Banner tone={message.tone === 'success' ? 'success' : 'danger'}>{message.text}</Banner>
      )}
    </>
  );

  if (compact) {
    return (
      <section>
        <h3
          className="mb-3 text-xs tracking-widest text-cyan-400"
          style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
        >
          MY WORK MAILBOX
        </h3>
        {body}
      </section>
    );
  }

  return (
    <Card>
      <CardHeader
        title="My work mailbox"
        subtitle="One Microsoft sign-in for your own @flyskyway.com inbox."
        icon={Mail}
      />
      {body}
    </Card>
  );
}

function SharedMailboxCard({ currentUser, compact = false }) {
  const canSee = ['admin', 'sales'].includes(currentUser?.role);
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    if (!canSee) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await postMailApi('/api/charter-mail', { action: 'status' });
        if (!cancelled) setState({ loading: false, ...data });
      } catch (err) {
        if (!cancelled) {
          setState({
            loading: false,
            connected: false,
            configured: false,
            error: err.message,
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [canSee]);

  if (!canSee) return null;

  const body = (
    <>
      <p className={cx('text-sm leading-relaxed', compact ? 'text-slate-400' : 'text-content-muted')}>
        Shared inbox for charters@flyskyway.com. Connection uses server-side Graph app credentials — there is no per-user OAuth for this mailbox.
      </p>
      {state.loading ? (
        <p className={cx('mt-3 flex items-center gap-2 text-xs', compact ? 'text-slate-500' : 'text-content-muted')}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking shared mailbox…
        </p>
      ) : state.connected ? (
        <div className={cx(
          'mt-3 rounded-lg border p-3',
          compact ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-success-border bg-success-soft',
        )}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone="success" size="sm">Live</StatusChip>
            <span className={cx('text-sm font-medium', compact ? 'text-slate-100' : 'text-content')}>
              {state.mailbox || 'charters@flyskyway.com'}
            </span>
          </div>
          {state.displayName && (
            <p className={cx('mt-1 text-2xs', compact ? 'text-slate-500' : 'text-content-subtle')}>
              {state.displayName}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <Banner tone="warn">
            {state.setupHint
              || state.error
              || 'Shared mailbox Graph credentials are not configured. Set MICROSOFT_MAIL_TENANT_ID, MICROSOFT_MAIL_CLIENT_ID, and MICROSOFT_MAIL_CLIENT_SECRET on the deployment.'}
          </Banner>
          <p className={cx('text-2xs', compact ? 'text-slate-500' : 'text-content-subtle')}>
            Setup steps: docs/charter-shared-inbox-setup.md — then open Email → Shared inbox.
          </p>
        </div>
      )}
    </>
  );

  if (compact) {
    return (
      <section>
        <h3
          className="mb-3 text-xs tracking-widest text-cyan-400"
          style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}
        >
          SHARED CHARTER INBOX
        </h3>
        {body}
      </section>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Shared charter inbox"
        subtitle="Server Graph access for charters@flyskyway.com (admin and sales)."
        icon={Inbox}
      />
      {body}
    </Card>
  );
}

/**
 * Mailbox connection controls for Profile, Organization settings, and Advanced tools.
 * @param {'profile'|'settings'|'advanced'} placement
 */
export default function MailboxSettingsPanel({
  currentUser,
  placement = 'settings',
  showShared = null,
}) {
  const includeShared = showShared ?? (
    placement !== 'profile' && ['admin', 'sales'].includes(currentUser?.role)
  );
  const compact = placement === 'advanced' || placement === 'profile';

  if (placement === 'advanced') {
    return (
      <>
        <PersonalMailboxCard currentUser={currentUser} compact />
        {includeShared && <SharedMailboxCard currentUser={currentUser} compact />}
      </>
    );
  }

  if (placement === 'profile') {
    return <PersonalMailboxCard currentUser={currentUser} compact />;
  }

  return (
    <div className="space-y-4">
      <PersonalMailboxCard currentUser={currentUser} />
      {includeShared && <SharedMailboxCard currentUser={currentUser} />}
    </div>
  );
}
