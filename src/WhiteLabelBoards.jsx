// Setup for white-label office TV boards. Ops and admin only. The public
// link is unguessable; the calendar feed stays on the server.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Monitor,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button, Card, PageHeader, StatusChip } from './ui.jsx';
import { useWhiteLabelLogo } from './use-white-label-logo.js';

const EMPTY = {
  companyName: '',
  accentColor: '#2DD4BF',
  feedUrl: '',
  poweredBy: true,
  enabled: true,
};

const FIELD = 'w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent';

function canManage(user) {
  return user && (user.role === 'admin' || user.role === 'ops') && user.appReviewer !== true;
}

async function postBoard(getIdToken, body) {
  const idToken = await getIdToken();
  const response = await fetch('/api/white-label-boards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, idToken }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Request failed');
  return data;
}

function readLogoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve(null);
      return;
    }
    const type = String(file.type || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    const allowed = type === 'image/png' || type === 'image/jpeg' || type === 'image/svg+xml'
      || /\.(png|jpe?g|svg)$/.test(name);
    if (!allowed) {
      reject(new Error('Logo must be a PNG, JPG, or SVG under 2MB'));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error('Logo must be a PNG, JPG, or SVG under 2MB'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve({
      dataBase64: String(reader.result || ''),
      contentType: file.type || '',
      preview: String(reader.result || ''),
    });
    reader.onerror = () => reject(new Error('Could not read the logo'));
    reader.readAsDataURL(file);
  });
}

function boardLink(token) {
  if (!token) return '';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://skyway.app';
  return `${origin}/board/${token}`;
}

function LogoMark({ token, hasLogo, preview, accent }) {
  const remote = useWhiteLabelLogo(token, Boolean(hasLogo && !preview));
  const src = preview || remote;
  if (!src) {
    return (
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-bold"
        style={{ background: `${accent}22`, color: accent }}
      >
        TV
      </span>
    );
  }
  return <img alt="" src={src} className="h-10 w-10 shrink-0 rounded-lg object-contain bg-slate-950" />;
}

export default function WhiteLabelBoards({ getIdToken, currentUser }) {
  const [boards, setBoards] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [logoFile, setLogoFile] = useState(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedCheck, setFeedCheck] = useState('');
  const getTokenRef = useRef(getIdToken);
  getTokenRef.current = getIdToken;

  const selected = useMemo(
    () => boards.find((board) => board.id === selectedId) || null,
    [boards, selectedId],
  );

  const load = useCallback(async () => {
    const data = await postBoard(() => getTokenRef.current(), { action: 'list' });
    setBoards(Array.isArray(data.boards) ? data.boards : []);
    return data.boards || [];
  }, []);

  useEffect(() => {
    if (!canManage(currentUser)) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const next = await load();
        if (cancelled) return;
        if (next[0]) {
          setSelectedId(next[0].id);
          setDraft({
            companyName: next[0].companyName || '',
            accentColor: next[0].accentColor || '#2DD4BF',
            feedUrl: next[0].feedUrl || '',
            poweredBy: next[0].poweredBy !== false,
            enabled: next[0].enabled !== false,
          });
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load boards');
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser, load]);

  function selectBoard(board) {
    setSelectedId(board?.id || null);
    setDraft(board ? {
      companyName: board.companyName || '',
      accentColor: board.accentColor || '#2DD4BF',
      feedUrl: board.feedUrl || '',
      poweredBy: board.poweredBy !== false,
      enabled: board.enabled !== false,
    } : EMPTY);
    setLogoFile(null);
    setRemoveLogo(false);
    setConfirmDelete(false);
    setConfirmRotate(false);
    setError('');
    setNotice('');
    setFeedCheck('');
    setCopied(false);
  }

  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const body = {
        action: selected ? 'update' : 'create',
        boardId: selected?.id,
        companyName: draft.companyName,
        accentColor: draft.accentColor,
        feedUrl: draft.feedUrl,
        poweredBy: draft.poweredBy,
        enabled: draft.enabled,
      };
      if (logoFile) body.logo = { dataBase64: logoFile.dataBase64, contentType: logoFile.contentType };
      else if (removeLogo && selected) body.logo = { remove: true };
      const data = await postBoard(() => getTokenRef.current(), body);
      const next = await load();
      const saved = data.board;
      if (saved) {
        const fresh = next.find((board) => board.id === saved.id) || saved;
        selectBoard(fresh);
        setNotice(selected ? 'Board saved.' : 'Board created. The public link is ready.');
      }
    } catch (err) {
      setError(err.message || 'Could not save the board');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await postBoard(() => getTokenRef.current(), { action: 'delete', boardId: selected.id });
      const next = await load();
      selectBoard(next[0] || null);
      setNotice('Board deleted. Its link no longer opens.');
    } catch (err) {
      setError(err.message || 'Could not delete the board');
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const data = await postBoard(() => getTokenRef.current(), { action: 'regenerate', boardId: selected.id });
      const next = await load();
      const fresh = next.find((board) => board.id === selected.id) || data.board;
      selectBoard(fresh);
      setNotice('New link issued. The previous link has stopped.');
    } catch (err) {
      setError(err.message || 'Could not regenerate the link');
    } finally {
      setBusy(false);
    }
  }

  async function checkFeed() {
    setBusy(true);
    setFeedCheck('');
    setError('');
    try {
      const data = await postBoard(() => getTokenRef.current(), { action: 'check-feed', feedUrl: draft.feedUrl });
      const tails = Array.isArray(data.tails) && data.tails.length ? data.tails.join(', ') : 'no aircraft today';
      setFeedCheck(`${data.tripsToday} trip${data.tripsToday === 1 ? '' : 's'} today · ${tails}`);
    } catch (err) {
      setError(err.message || 'The calendar feed did not respond');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    const link = boardLink(selected?.publicToken);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (!canManage(currentUser)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-content-muted">
        Operations access required.
      </div>
    );
  }

  const link = boardLink(selected?.publicToken);
  const accent = /^#[0-9A-Fa-f]{6}$/.test(draft.accentColor) ? draft.accentColor : '#2DD4BF';

  return (
    <div data-white-label-setup="" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-slate-950">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1400px] flex-col px-4 py-5 md:px-6">
        <PageHeader
          title="TV boards"
          subtitle="A company logo, accent, and calendar feed on the operations wall. The public link does not require a sign-in."
          actions={(
            <Button icon={Plus} onClick={() => selectBoard(null)}>New board</Button>
          )}
        />
        {error ? (
          <div className="mb-3 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>
        ) : null}
        {notice ? (
          <div className="mb-3 rounded-lg border border-edge bg-surface-raised px-3 py-2 text-sm text-content">{notice}</div>
        ) : null}
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card padded={false} className="min-h-0 overflow-hidden">
            <div className="border-b border-edge px-4 py-3 text-xs font-semibold uppercase tracking-wide text-content-muted">
              {boards.length} board{boards.length === 1 ? '' : 's'}
            </div>
            <div className="max-h-full overflow-y-auto">
              {boards.length === 0 ? (
                <p className="px-4 py-6 text-sm text-content-muted">No boards yet.</p>
              ) : boards.map((board) => (
                <button
                  key={board.id}
                  type="button"
                  onClick={() => selectBoard(board)}
                  className={`flex w-full items-center gap-3 border-b border-edge px-4 py-3 text-left ${selectedId === board.id ? 'bg-surface-raised' : ''}`}
                >
                  <LogoMark token={board.publicToken} hasLogo={board.hasLogo} accent={board.accentColor} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-content">{board.companyName}</span>
                    <span className="block truncate font-mono text-[11px] text-content-subtle">{board.publicPath}</span>
                  </span>
                  <StatusChip tone={board.enabled ? 'success' : 'neutral'} size="sm">
                    {board.enabled ? 'Live' : 'Off'}
                  </StatusChip>
                </button>
              ))}
            </div>
          </Card>

          <Card className="min-h-0 overflow-y-auto">
            <div className="mb-4 flex items-center gap-3">
              <LogoMark
                token={selected?.publicToken}
                hasLogo={selected?.hasLogo && !removeLogo}
                preview={logoFile?.preview}
                accent={accent}
              />
              <div>
                <h2 className="text-base font-semibold text-content">{selected ? 'Edit board' : 'New board'}</h2>
                <p className="text-2xs text-content-muted">PNG, JPG, or SVG · 2MB max · stored in Firebase Storage</p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-content-subtle">Company display name</span>
                <input
                  className={FIELD}
                  value={draft.companyName}
                  maxLength={80}
                  aria-label="Company display name"
                  onChange={(event) => setDraft((prev) => ({ ...prev, companyName: event.target.value }))}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-content-subtle">Accent color</span>
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Accent color"
                    value={accent}
                    onChange={(event) => setDraft((prev) => ({ ...prev, accentColor: event.target.value.toUpperCase() }))}
                    className="h-10 w-12 cursor-pointer rounded border border-edge bg-transparent"
                  />
                  <input
                    className={`${FIELD} font-mono`}
                    value={draft.accentColor}
                    aria-label="Accent hex"
                    onChange={(event) => setDraft((prev) => ({ ...prev, accentColor: event.target.value }))}
                  />
                </span>
              </label>
              <label className="block text-sm md:col-span-2">
                <span className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-content-subtle">Calendar feed URL</span>
                <input
                  className={`${FIELD} font-mono text-xs`}
                  value={draft.feedUrl}
                  placeholder="https://portal.jetinsight.com/schedule/….ics"
                  aria-label="Calendar feed URL"
                  onChange={(event) => setDraft((prev) => ({ ...prev, feedUrl: event.target.value }))}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-2xs font-semibold uppercase tracking-wide text-content-subtle">Logo</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
                  aria-label="Logo file"
                  className="block w-full text-xs text-content-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-raised file:px-3 file:py-2 file:text-xs file:font-semibold file:text-content"
                  onChange={async (event) => {
                    setError('');
                    try {
                      const next = await readLogoFile(event.target.files?.[0]);
                      setLogoFile(next);
                      setRemoveLogo(false);
                    } catch (err) {
                      setLogoFile(null);
                      setError(err.message);
                    }
                  }}
                />
              </label>
              <div className="flex flex-col justify-end gap-3">
                <label className="flex items-center gap-2 text-sm text-content">
                  <input
                    type="checkbox"
                    checked={draft.poweredBy}
                    onChange={(event) => setDraft((prev) => ({ ...prev, poweredBy: event.target.checked }))}
                  />
                  Powered by SKYWAY.app
                </label>
                <label className="flex items-center gap-2 text-sm text-content">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
                  />
                  Enabled
                </label>
              </div>
            </div>

            {feedCheck ? <p className="mt-3 text-sm text-content-muted">{feedCheck}</p> : null}

            {link ? (
              <div className="mt-4">
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">Public link</div>
                <div className="flex items-center gap-2">
                  <input readOnly className={`${FIELD} font-mono text-xs`} value={link} aria-label="Public link" />
                  <Button variant="secondary" icon={copied ? Check : Copy} onClick={copyLink}>Copy</Button>
                </div>
                <p className="mt-1 text-2xs text-content-muted">Anyone with this link can open the board. Regenerating it stops the old link.</p>
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button icon={Check} loading={busy} onClick={save}>Save</Button>
              <Button variant="secondary" icon={Upload} disabled={busy || !draft.feedUrl} onClick={checkFeed}>Check feed</Button>
              {selected ? (
                <Button
                  variant="secondary"
                  icon={RefreshCw}
                  disabled={busy}
                  onClick={() => (confirmRotate ? rotate() : setConfirmRotate(true))}
                >
                  {confirmRotate ? 'Confirm new link' : 'Regenerate link'}
                </Button>
              ) : null}
              {selected ? (
                <Button
                  variant="danger-outline"
                  icon={Trash2}
                  disabled={busy}
                  onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
                >
                  {confirmDelete ? 'Confirm delete' : 'Delete'}
                </Button>
              ) : null}
              {selected && selected.hasLogo ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => { setRemoveLogo(true); setLogoFile(null); }}
                >
                  Remove logo
                </Button>
              ) : null}
              <span className="ml-auto hidden items-center gap-2 text-2xs text-content-subtle md:flex">
                <Monitor className="h-3.5 w-3.5" />
                One screen · no sign-in
              </span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
