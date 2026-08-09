import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Pin,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Button, Card, EmptyState, PageHeader, StatusChip, cx } from './ui.jsx';

const CATEGORIES = {
  handoff: { label: 'Handoff', tone: 'accent', icon: ClipboardList },
  risk: { label: 'Risk', tone: 'danger', icon: AlertTriangle },
  decision: { label: 'Decision', tone: 'warning', icon: CheckCircle2 },
  update: { label: 'Update', tone: 'neutral', icon: BookOpen },
};

async function callOps(action, extra = {}) {
  const { auth } = await import('./firebase.js');
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Your operations session expired');
  const response = await fetch('/api/ops-control-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken, action, ...extra }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Operations log request failed');
  return body;
}

function formatStamp(value) {
  if (!value) return 'Unknown time';
  try {
    return new Date(value).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown time';
  }
}

export default function OpsShiftLog({ currentUser }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState('handoff');
  const [pinned, setPinned] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await callOps('list-shift-notes');
      setNotes(body.notes || []);
    } catch (err) {
      setError(err.message || 'Could not load shift log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const body = await callOps('add-shift-note', {
        note: text,
        category,
        pinned,
      });
      setNotes((current) => [body.note, ...current]);
      setText('');
      setPinned(false);
    } catch (err) {
      setError(err.message || 'Could not add shift note');
    } finally {
      setBusy(false);
    }
  };

  if (!['ops', 'admin'].includes(currentUser?.role)) return null;

  const ordered = [...notes].sort((a, b) => (
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || Number(b.createdAt || 0) - Number(a.createdAt || 0)
  ));

  return (
    <div className="mx-auto max-w-screen-2xl p-4 md:p-6">
      <PageHeader
        title="Shift log & handoff"
        subtitle="Permanent OCC decisions, risks and turnover notes for the next controller."
        actions={<Button icon={RefreshCw} variant="secondary" onClick={load} loading={loading}>Refresh</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(20rem,0.75fr)_minmax(0,1.25fr)]">
        <Card>
          <h2 className="text-sm font-semibold text-content">Add control-room entry</h2>
          <p className="mt-1 text-2xs leading-relaxed text-content-muted">
            Record decisions that should survive chat and shift changes. Entries are attributed to your signed-in account.
          </p>
          <form className="mt-4 space-y-3" onSubmit={submit}>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(CATEGORIES).map(([id, item]) => {
                const Icon = item.icon;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setCategory(id)}
                    className={cx(
                      'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-semibold',
                      category === id
                        ? 'border-accent-border bg-accent-soft text-accent'
                        : 'border-edge bg-surface text-content-muted hover:border-edge-strong',
                    )}
                  >
                    <Icon className="h-4 w-4" /> {item.label}
                  </button>
                );
              })}
            </div>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={7}
              maxLength={2000}
              placeholder="Aircraft swaps, crew concerns, pending broker decisions, weather strategy, maintenance coordination…"
              className="w-full resize-y rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content outline-none focus:border-accent"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(event) => setPinned(event.target.checked)}
                className="h-4 w-4 accent-cyan-500"
              />
              <Pin className="h-3.5 w-3.5" /> Pin for the next shift
            </label>
            <Button type="submit" block variant="primary" icon={Plus} loading={busy} disabled={!text.trim()}>
              Add to shift log
            </Button>
          </form>
          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </Card>

        <Card padded={false}>
          <div className="border-b border-edge px-4 py-3">
            <h2 className="text-sm font-semibold text-content">Control-room record</h2>
            <p className="mt-0.5 text-2xs text-content-muted">{notes.length} recent entries</p>
          </div>
          {loading && notes.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-content-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading shift log…
            </div>
          ) : ordered.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No shift entries yet" description="Add the first handoff note for the operation." />
          ) : (
            <div className="max-h-[42rem] overflow-y-auto">
              {ordered.map((note) => {
                const item = CATEGORIES[note.category] || CATEGORIES.update;
                return (
                  <article key={note.id} className="border-b border-edge px-4 py-4 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={item.tone} size="sm" icon={item.icon}>{item.label}</StatusChip>
                      {note.pinned && <StatusChip tone="warning" size="sm" icon={Pin}>Pinned</StatusChip>}
                      <span className="ml-auto text-2xs text-content-subtle">{formatStamp(note.createdAt)}</span>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-content">{note.text}</p>
                    <p className="mt-2 text-2xs text-content-muted">{note.authorName || 'Operations'}</p>
                  </article>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
