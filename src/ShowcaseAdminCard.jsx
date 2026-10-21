// Trade-show link controls for ops and administrators.
// Generate, regenerate, and disable the unguessable /showcase/<token> URL.

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Monitor, RefreshCw, ShieldOff } from 'lucide-react';
import { Button, Card, CardHeader } from './ui.jsx';
import { formatShowcaseDate } from './showcase-replay.js';

async function post(action) {
  const { auth } = await import('./firebase.js');
  if (!auth.currentUser) throw new Error('Sign in required');
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch('/api/showcase-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Showcase settings could not be saved');
  return data;
}

function when(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = formatShowcaseDate(ms);
  return `${date.day} ${date.year}`;
}

export default function ShowcaseAdminCard() {
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (action) => {
    setBusy(true);
    setError('');
    try {
      const next = await post(action);
      setView(next);
      setConfirming(null);
    } catch (err) {
      setError(err.message || 'Showcase settings could not be saved');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load('read'); }, [load]);

  async function copy() {
    if (!view?.url) return;
    try {
      await navigator.clipboard.writeText(view.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Copy the link from the field.');
    }
  }

  const from = when(view?.storedFrom);
  const to = when(view?.storedTo);

  return (
    <Card>
      <CardHeader
        title="Trade show map"
        subtitle="Full-screen replay for a booth TV. The link is the only key."
        icon={Monitor}
      />
      <p className="mb-3 text-sm leading-relaxed text-content-muted">
        The board plays completed legs stored by the schedule archive. The JetInsight feed only keeps a few days of history, so flights from before that collector was running are not on the loop.
      </p>
      {view && (
        <p className="mb-3 text-sm text-content">
          {view.legCount
            ? `On the loop: ${view.legCount.toLocaleString('en-US')} flights${from ? `, from ${from}` : ''}${to ? ` through ${to}` : ''}.`
            : `No completed ${view.year || ''} flights are stored yet.`}
        </p>
      )}
      {view?.url && (
        <div className="mb-3 flex items-center gap-2">
          <input
            readOnly
            value={view.url}
            aria-label="Trade show link"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-sunken px-3 py-2 font-mono text-xs text-content"
            onFocus={(event) => event.target.select()}
          />
          <Button type="button" variant="secondary" icon={copied ? Check : Copy} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {view?.hasToken && !view.enabled && (
        <p className="mb-3 text-sm text-content-muted">This link is off. The TV shows not found until a new one is generated.</p>
      )}
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!view?.enabled && (
          <Button type="button" variant="primary" icon={Monitor} loading={busy} onClick={() => load('generate')}>
            {view?.hasToken ? 'Generate new link' : 'Generate link'}
          </Button>
        )}
        {view?.enabled && confirming !== 'regenerate' && confirming !== 'disable' && (
          <>
            <Button type="button" variant="secondary" icon={RefreshCw} disabled={busy} onClick={() => setConfirming('regenerate')}>
              Regenerate
            </Button>
            <Button type="button" variant="secondary" icon={ShieldOff} disabled={busy} onClick={() => setConfirming('disable')}>
              Disable
            </Button>
          </>
        )}
        {confirming === 'regenerate' && (
          <>
            <Button type="button" variant="primary" icon={RefreshCw} loading={busy} onClick={() => load('regenerate')}>
              Rotate the link
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
          </>
        )}
        {confirming === 'disable' && (
          <>
            <Button type="button" variant="primary" icon={ShieldOff} loading={busy} onClick={() => load('disable')}>
              Disable the TV
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
          </>
        )}
      </div>
      {view?.updatedByName && (
        <p className="mt-3 text-2xs text-content-subtle">
          Last change by {view.updatedByName}
        </p>
      )}
    </Card>
  );
}
