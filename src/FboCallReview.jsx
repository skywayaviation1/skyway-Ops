import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MinusCircle,
  Play,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { Button } from './ui.jsx';

const CHECKS = [
  ['movementConfirmed', 'Movement on board'],
  ['fuelConfirmed', 'Fuel / handling'],
  ['hangarConfirmed', 'Hangar / overnight'],
  ['cateringConfirmed', 'Catering'],
  ['groundTransportConfirmed', 'Ground transportation'],
  ['hoursVerified', 'Operating hours'],
];

async function idToken() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

function CheckRow({ label, value }) {
  const confirmed = value === true || (typeof value === 'string' && value.trim());
  const rejected = value === false;
  const Icon = confirmed ? CheckCircle2 : (rejected ? XCircle : MinusCircle);
  const tone = confirmed ? 'text-success' : (rejected ? 'text-danger' : 'text-content-subtle');
  const result = typeof value === 'string' && value.trim()
    ? value.trim()
    : (confirmed ? 'Confirmed' : (rejected ? 'Not confirmed' : 'Not reported'));
  return (
    <li className="flex items-start gap-2 rounded-lg border border-edge bg-surface px-3 py-2">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 text-sm text-content">{label}</span>
      <span className={`max-w-[45%] text-right text-xs ${tone}`}>{result}</span>
    </li>
  );
}

function CallRecording({ callId }) {
  const [recordingUrl, setRecordingUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadRecording() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/fbo-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: await idToken(), action: 'recording', callId }),
      });
      const data = await response.json();
      if (!response.ok || !data.recordingUrl) {
        throw new Error(data.error || 'Call recording is unavailable');
      }
      setRecordingUrl(data.recordingUrl);
    } catch (err) {
      setError(err.message || 'Could not load the call recording');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-3 border-t border-edge pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
          Call recording
        </p>
        <Button
          size="sm"
          variant="secondary"
          icon={recordingUrl ? RotateCcw : Play}
          loading={loading}
          onClick={loadRecording}
        >
          {recordingUrl ? 'Refresh recording link' : 'Load recording'}
        </Button>
      </div>
      {recordingUrl && (
        <audio className="mt-2 w-full" controls preload="metadata" src={recordingUrl}>
          <track kind="captions" />
        </audio>
      )}
      {error && (
        <p className="mt-2 flex items-start gap-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
        </p>
      )}
      {loading && (
        <p className="mt-2 text-xs text-content-muted">
          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />Requesting a private playback link…
        </p>
      )}
    </div>
  );
}

export default function FboCallReview({ call, canPlayRecording = false }) {
  const confirmations = call?.confirmations || {};
  const hasChecklist = Boolean(
    call?.confirmations
    || ['completed', 'failed', 'needs_followup'].includes(call?.status),
  );
  if (!hasChecklist && !call?.recordingAvailable) return null;

  return (
    <div className="mt-3 rounded-xl border border-edge bg-surface-sunken p-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
        FBO confirmation checklist
      </p>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {CHECKS.map(([key, label]) => (
          <CheckRow key={key} label={label} value={confirmations[key]} />
        ))}
      </ul>
      {confirmations.needsFollowUp === true && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          FBO response requires operations follow-up.
        </p>
      )}
      {confirmations.notes && (
        <p className="mt-2 text-sm text-content-muted">
          <span className="font-semibold text-content">Notes:</span> {confirmations.notes}
        </p>
      )}
      {canPlayRecording && call.recordingAvailable && <CallRecording callId={call.id} />}
    </div>
  );
}
