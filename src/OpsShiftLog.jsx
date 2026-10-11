import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Loader2,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button, Card, EmptyState, StatusChip, cx } from './ui.jsx';
import {
  HANDOFF_CATEGORIES,
  HANDOFF_RETENTION_DAYS,
  HANDOFF_TEXT_LIMIT,
  isSubmittedHandoff,
  visibleHandoffs,
} from './shift-handoff.js';

const CATEGORIES = {
  handoff: { label: 'Handoff', tone: 'accent', icon: ClipboardList },
  risk: { label: 'Risk', tone: 'danger', icon: AlertTriangle },
  decision: { label: 'Decision', tone: 'warning', icon: CheckCircle2 },
  update: { label: 'Update', tone: 'neutral', icon: BookOpen },
};

const OPS_ROLES = ['ops', 'admin'];

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

function CategoryPicker({ value, onChange, disabled }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {HANDOFF_CATEGORIES.map((id) => {
        const item = CATEGORIES[id];
        const Icon = item.icon;
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(id)}
            className={cx(
              'flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-semibold',
              value === id
                ? 'border-accent-border bg-accent-soft text-accent'
                : 'border-edge bg-surface text-content-muted hover:border-edge-strong',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" /> {item.label}
          </button>
        );
      })}
    </div>
  );
}

export default function OpsShiftLog({ currentUser }) {
  const canUse = OPS_ROLES.includes(currentUser?.role) && currentUser?.appReviewer !== true;
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState('handoff');
  const [pinned, setPinned] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editCategory, setEditCategory] = useState('handoff');
  const [editPinned, setEditPinned] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await callOps('list-shift-notes');
      setNotes(body.notes || []);
    } catch (err) {
      setError(err.message || 'Could not load shift handoff');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canUse) return undefined;
    load();
    return undefined;
  }, [canUse, load]);

  const ordered = useMemo(() => {
    const visible = visibleHandoffs(notes);
    return [...visible].sort((a, b) => (
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || Number(b.createdAt || 0) - Number(a.createdAt || 0)
    ));
  }, [notes]);

  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const body = await callOps('add-shift-note', { note: text, category, pinned });
      setNotes((current) => [body.note, ...current]);
      setText('');
      setPinned(false);
      setCategory('handoff');
    } catch (err) {
      setError(err.message || 'Could not add shift note');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (note) => {
    if (!isSubmittedHandoff(note)) return;
    setConfirmDeleteId(null);
    setEditingId(note.id);
    setEditText(note.text || '');
    setEditCategory(CATEGORIES[note.category] ? note.category : 'update');
    setEditPinned(note.pinned === true);
    setError('');
  };

  const saveEdit = async (event) => {
    event.preventDefault();
    if (!editingId || !editText.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const body = await callOps('update-shift-note', {
        noteId: editingId,
        note: editText,
        category: editCategory,
        pinned: editPinned,
      });
      setNotes((current) => current.map((note) => (note.id === body.note.id ? body.note : note)));
      setEditingId(null);
    } catch (err) {
      setError(err.message || 'Could not update handoff');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (note) => {
    if (!isSubmittedHandoff(note) || busy) return;
    setBusy(true);
    setError('');
    try {
      await callOps('delete-shift-note', { noteId: note.id });
      setNotes((current) => current.filter((item) => item.id !== note.id));
      if (editingId === note.id) setEditingId(null);
      setConfirmDeleteId(null);
    } catch (err) {
      setError(err.message || 'Could not delete handoff');
    } finally {
      setBusy(false);
    }
  };

  if (!canUse) return null;

  return (
    <section id="shift-handoff" aria-label="Shift handoff" data-testid="shift-handoff">
      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-content">
              <ClipboardList className="h-4 w-4 shrink-0 text-content-subtle" />
              Shift handoff
            </h2>
            <p className="mt-1 max-w-2xl text-2xs leading-relaxed text-content-muted">
              Notes are saved as submitted. There is no draft. Any operations or admin user can edit or delete a submitted handoff. Notes older than {HANDOFF_RETENTION_DAYS} days are removed automatically.
            </p>
          </div>
          <Button icon={RefreshCw} variant="secondary" size="sm" className="min-h-11" onClick={load} loading={loading}>
            Refresh
          </Button>
        </div>
        {error && (
          <p className="border-b border-danger-border bg-danger-soft px-4 py-2 text-xs text-danger" role="alert">{error}</p>
        )}

        <div className="grid min-w-0 lg:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.15fr)]">
          <form className="min-w-0 space-y-3 border-b border-edge p-4 lg:border-b-0 lg:border-r" onSubmit={submit}>
            <div>
              <h3 className="text-sm font-semibold text-content">Add a handoff</h3>
              <p className="mt-1 text-2xs leading-relaxed text-content-muted">
                Aircraft swaps, crew concerns, weather, and decisions the next controller needs. Submitting writes the note immediately.
              </p>
            </div>
            <CategoryPicker value={category} onChange={setCategory} disabled={busy} />
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={5}
              maxLength={HANDOFF_TEXT_LIMIT}
              placeholder="What should the next shift know?"
              className="w-full resize-y rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-base text-content outline-none focus:border-accent md:text-sm"
            />
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-content-muted">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(event) => setPinned(event.target.checked)}
                className="h-4 w-4 accent-cyan-500"
              />
              <Pin className="h-3.5 w-3.5" /> Pin for the next shift
            </label>
            <Button type="submit" block variant="primary" icon={Plus} className="min-h-11" loading={busy} disabled={!text.trim()}>
              Add to shift log
            </Button>
          </form>

          <div className="min-w-0">
            <div className="border-b border-edge px-4 py-3">
              <h3 className="text-sm font-semibold text-content">Recent handoffs</h3>
              <p className="mt-0.5 text-2xs text-content-muted">
                {ordered.length} from the last {HANDOFF_RETENTION_DAYS} days
              </p>
            </div>
            {loading && notes.length === 0 ? (
              <div className="flex items-center justify-center py-16 text-content-muted">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading shift handoff…
              </div>
            ) : ordered.length === 0 ? (
              <EmptyState icon={ClipboardList} title="No shift handoffs yet" description="Add the first note for the next controller." />
            ) : (
              <div className="max-h-[32rem] overflow-y-auto">
                {ordered.map((note) => {
                  const item = CATEGORIES[note.category] || CATEGORIES.update;
                  const submitted = isSubmittedHandoff(note);
                  const editing = editingId === note.id;
                  return (
                    <article
                      key={note.id}
                      className="border-b border-edge px-4 py-4 last:border-b-0"
                      data-handoff-id={note.id}
                      data-handoff-status={submitted ? 'submitted' : (note.status || 'unsubmitted')}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusChip tone={item.tone} size="sm" icon={item.icon}>{item.label}</StatusChip>
                        {note.pinned && <StatusChip tone="warning" size="sm" icon={Pin}>Pinned</StatusChip>}
                        {submitted ? (
                          <StatusChip tone="success" size="sm">Submitted</StatusChip>
                        ) : (
                          <StatusChip tone="neutral" size="sm">Unsubmitted</StatusChip>
                        )}
                        <span className="ml-auto text-2xs text-content-subtle">{formatStamp(note.submittedAt || note.createdAt)}</span>
                      </div>

                      {editing ? (
                        <form className="mt-3 space-y-3" onSubmit={saveEdit}>
                          <CategoryPicker value={editCategory} onChange={setEditCategory} disabled={busy} />
                          <textarea
                            value={editText}
                            onChange={(event) => setEditText(event.target.value)}
                            rows={4}
                            maxLength={HANDOFF_TEXT_LIMIT}
                            className="w-full resize-y rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-base text-content outline-none focus:border-accent md:text-sm"
                          />
                          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-content-muted">
                            <input
                              type="checkbox"
                              checked={editPinned}
                              onChange={(event) => setEditPinned(event.target.checked)}
                              className="h-4 w-4 accent-cyan-500"
                            />
                            <Pin className="h-3.5 w-3.5" /> Pin for the next shift
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <Button type="submit" variant="primary" icon={CheckCircle2} className="min-h-11" loading={busy} disabled={!editText.trim()}>
                              Save
                            </Button>
                            <Button type="button" variant="secondary" className="min-h-11" onClick={() => setEditingId(null)} disabled={busy}>
                              Cancel
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-content">{note.text}</p>
                      )}

                      <p className="mt-2 text-2xs text-content-muted">
                        {note.authorName || 'Operations'}
                        {note.updatedByName ? ` · Edited by ${note.updatedByName}` : ''}
                      </p>

                      {submitted && !editing && (
                        confirmDeleteId === note.id ? (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <p className="w-full text-xs text-content-muted sm:w-auto">Delete this submitted handoff?</p>
                            <Button variant="danger" icon={Trash2} className="min-h-11" loading={busy} onClick={() => remove(note)}>
                              Delete
                            </Button>
                            <Button variant="secondary" className="min-h-11" onClick={() => setConfirmDeleteId(null)} disabled={busy}>
                              Keep
                            </Button>
                          </div>
                        ) : (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button variant="secondary" icon={Pencil} className="min-h-11" onClick={() => startEdit(note)} disabled={busy}>
                              Edit
                            </Button>
                            <Button variant="danger-outline" icon={Trash2} className="min-h-11" onClick={() => setConfirmDeleteId(note.id)} disabled={busy}>
                              Delete
                            </Button>
                          </div>
                        )
                      )}
                      {!submitted && (
                        <p className="mt-3 text-2xs text-content-muted">Only submitted handoffs can be edited or deleted.</p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
