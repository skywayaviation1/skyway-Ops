import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  History,
  Loader2,
  Plus,
  PhoneCall,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button, Card, StatusChip } from './ui.jsx';
import FboCallListener from './FboCallListener.jsx';
import VoiceTaskRecording from './VoiceTaskRecording.jsx';
import { postJson } from './api-json.js';
import { formatVoiceTaskLog } from './voice-task-call.js';

const TONE = {
  dialing: 'accent',
  in_progress: 'accent',
  completed: 'success',
  failed: 'danger',
  needs_followup: 'warning',
};

async function token() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

function downloadLog(call) {
  const blob = new Blob([formatVoiceTaskLog(call)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `skyway-voice-task-${call.id}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fmt(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
}

export default function VoiceTaskCalls({ currentUser }) {
  const allowed = ['ops', 'admin'].includes(currentUser?.role);
  const [phone, setPhone] = useState('');
  const [task, setTask] = useState('');
  const [calls, setCalls] = useState([]);
  const [vendor, setVendor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [view, setView] = useState('new');
  const [busyCallId, setBusyCallId] = useState('');

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!allowed) return;
    if (!quiet) setLoading(true);
    try {
      const data = await postJson('/api/voice-task-call', {
        idToken: await token(),
        action: 'list',
      });
      setCalls(Array.isArray(data.calls) ? data.calls : []);
      setVendor(data.vendor || null);
    } catch (err) {
      if (!quiet) setError(err.message || 'Could not load voice tasks');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [allowed]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!calls.some((call) => (
      ['dialing', 'in_progress'].includes(call.status)
      || (!['dialing', 'in_progress'].includes(call.status) && call.transcriptStatus === 'pending')
    ))) return undefined;
    const timer = setInterval(() => load({ quiet: true }), 8000);
    return () => clearInterval(timer);
  }, [calls, load]);

  async function submit(event) {
    event.preventDefault();
    if (!allowed || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await postJson('/api/voice-task-call', {
        idToken: await token(),
        action: 'create',
        phone,
        task,
      });
      setPhone('');
      setTask('');
      setMessage('Call placed. Skyway will log the outcome and transcript below.');
      setView('active');
    } catch (err) {
      setError(err.message || 'The voice task call could not be placed');
    } finally {
      setBusy(false);
      await load({ quiet: true });
    }
  }

  async function act(action, call) {
    if (!call?.id || busyCallId) return;
    if (
      action === 'delete'
      && !window.confirm('Delete this finished AI voice call and its Skyway log?')
    ) return;
    setBusyCallId(call.id);
    setError('');
    setMessage('');
    try {
      const data = await postJson('/api/voice-task-call', {
        idToken: await token(),
        action,
        callId: call.id,
      });
      if (action === 'retry') {
        setMessage('Retry call placed with the same number and task.');
        setView('active');
      } else if (action === 'delete') {
        setMessage('Finished call deleted. Its deletion audit event was retained.');
      } else if (action === 'refreshArtifacts') {
        setMessage(data.call?.transcript
          ? 'Transcript and recording status refreshed from Vapi.'
          : 'Vapi has not finished the transcript yet. Try again shortly.');
      }
      await load({ quiet: true });
    } catch (err) {
      setError(err.message || `${action} failed`);
    } finally {
      setBusyCallId('');
    }
  }

  const sorted = useMemo(
    () => [...calls].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [calls],
  );
  const activeCalls = useMemo(
    () => sorted.filter((call) => ['dialing', 'in_progress'].includes(call.status)),
    [sorted],
  );
  const historyCalls = useMemo(
    () => sorted.filter((call) => !['dialing', 'in_progress'].includes(call.status)),
    [sorted],
  );
  const visibleCalls = view === 'active' ? activeCalls : historyCalls;

  if (!allowed) return null;

  return (
    <section className="mb-6 space-y-3">
      <Card padded>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold text-content">AI Voicebot control center</p>
            <p className="mt-1 max-w-2xl text-sm text-content-muted">
              Enter a number and a precise business task. The call starts immediately and its
              response, outcome, and transcript are saved as a downloadable text log.
            </p>
          </div>
          <div className="flex gap-2">
            <StatusChip tone={vendor?.configured ? 'success' : 'warning'} size="sm">
              {vendor?.configured
                ? 'Vapi ready'
                : `Missing on this deployment: ${(vendor?.missing || []).join(', ') || 'Vapi keys'}`}
            </StatusChip>
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => load()}>
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-edge bg-surface-sunken p-1.5">
          <button
            type="button"
            onClick={() => setView('new')}
            className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${view === 'new' ? 'bg-accent text-white' : 'text-content-muted hover:bg-surface'}`}
          >
            <Plus className="h-4 w-4" /> New call
          </button>
          <button
            type="button"
            onClick={() => setView('active')}
            className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${view === 'active' ? 'bg-accent text-white' : 'text-content-muted hover:bg-surface'}`}
          >
            <Activity className="h-4 w-4" /> Active ({activeCalls.length})
          </button>
          <button
            type="button"
            onClick={() => setView('history')}
            className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${view === 'history' ? 'bg-accent text-white' : 'text-content-muted hover:bg-surface'}`}
          >
            <History className="h-4 w-4" /> History ({historyCalls.length})
          </button>
        </div>

        {view === 'new' && (
        <form className="mt-4 grid gap-3" onSubmit={submit}>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              Destination phone
            </span>
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 (555) 555-0123"
              required
              className="w-full rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-sm text-content outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              Task for the agent
            </span>
            <textarea
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Example: Call the hotel and confirm the crew rooms are held for tonight. Ask for the confirmation number and cancellation deadline."
              required
              maxLength={3000}
              rows={4}
              className="w-full resize-y rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
            />
            <span className="mt-1 block text-right text-[10px] text-content-subtle">{task.length}/3000</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" icon={PhoneCall} loading={busy}>
              Call now and complete task
            </Button>
            <p className="text-xs text-content-subtle">
              The prompt and voice come from Vapi. That assistant’s prompt must include the
              <code className="mx-1">{'{{task}}'}</code> variable so it receives this task.
            </p>
          </div>
        </form>
        )}

        {vendor && !vendor.configured && (
          <p className="mt-3 text-sm text-content-muted">
            Add {(vendor.missing || []).join(' and ') || 'the Vapi variables'} in Vercel on the
            Production environment, then redeploy. Server variables only reach deployments created
            after they are saved.
          </p>
        )}
        {error && (
          <p className="mt-3 flex items-start gap-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
          </p>
        )}
        {message && (
          <p className="mt-3 flex items-start gap-2 text-sm text-success">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{message}
          </p>
        )}
      </Card>

      {view !== 'new' && (loading ? (
        <p className="text-sm text-content-muted">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading voice task logs…
        </p>
      ) : visibleCalls.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
            {view === 'active' ? 'Active voice calls' : 'Call history and logs'}
          </p>
          {visibleCalls.map((call) => (
            <Card key={call.id} padded>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip tone={TONE[call.status] || 'neutral'} size="sm">
                      {String(call.status || '').replace(/_/g, ' ')}
                    </StatusChip>
                    <span className="font-mono text-xs text-content-muted">{call.phone}</span>
                    <span className="text-xs text-content-subtle">{fmt(call.createdAt)}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm font-medium text-content">{call.task}</p>
                  {call.summary && <p className="mt-2 text-sm text-content-muted">{call.summary}</p>}
                  {call.outcome && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <StatusChip tone={call.outcome.taskCompleted ? 'success' : 'warning'} size="sm">
                        {call.outcome.taskCompleted ? 'Task completed' : 'Task not completed'}
                      </StatusChip>
                      {call.outcome.needsFollowUp && (
                        <StatusChip tone="warning" size="sm">Follow-up required</StatusChip>
                      )}
                    </div>
                  )}
                  {call.lastError && <p className="mt-2 text-sm text-danger">{call.lastError}</p>}
                  {call.transcript && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-semibold text-content-muted">
                        View call responses and transcript
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-sunken p-3 text-[11px] text-content-muted">
                        {call.transcript}
                      </pre>
                    </details>
                  )}
                  {!call.transcript && !['dialing', 'in_progress'].includes(call.status) && (
                    <div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
                      <p className="flex items-start gap-2 text-sm text-warning">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        {call.transcriptStatus === 'pending'
                          ? 'Transcript pending from Vapi.'
                          : 'No transcript was returned for this call.'}
                      </p>
                      <Button
                        className="mt-2"
                        size="sm"
                        variant="secondary"
                        icon={RefreshCw}
                        loading={busyCallId === call.id}
                        onClick={() => act('refreshArtifacts', call)}
                      >
                        Refresh transcript
                      </Button>
                    </div>
                  )}
                  {call.listenAvailable && (
                    <div className="mt-3">
                      <FboCallListener callId={call.id} apiPath="/api/voice-task-call" />
                    </div>
                  )}
                  {call.recordingAvailable && !['dialing', 'in_progress'].includes(call.status) && (
                    <div className="mt-3 border-t border-edge pt-3">
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                        Recorded call
                      </p>
                      <VoiceTaskRecording callId={call.id} />
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Download}
                    onClick={() => downloadLog(call)}
                  >
                    Download .txt
                  </Button>
                  {!['dialing', 'in_progress'].includes(call.status) && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={RotateCcw}
                        loading={busyCallId === call.id}
                        onClick={() => act('retry', call)}
                      >
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={Trash2}
                        loading={busyCallId === call.id}
                        onClick={() => act('delete', call)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card padded>
          <p className="text-sm text-content-muted">
            {view === 'active' ? 'No voice calls are active.' : 'No finished voice calls yet.'}
          </p>
        </Card>
      ))}
    </section>
  );
}

