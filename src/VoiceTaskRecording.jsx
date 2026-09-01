import { useState } from 'react';
import { AlertTriangle, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui.jsx';

async function idToken() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

export default function VoiceTaskRecording({ callId }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/voice-task-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: await idToken(),
          action: 'recording',
          callId,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.recordingUrl) {
        throw new Error(data.error || 'Recording is not ready');
      }
      setUrl(data.recordingUrl);
    } catch (err) {
      setError(err.message || 'Could not load the recording');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="secondary"
        icon={url ? RotateCcw : Play}
        loading={loading}
        onClick={load}
      >
        {url ? 'Refresh recording link' : 'Play recording'}
      </Button>
      {url && <audio className="w-full" controls preload="metadata" src={url} />}
      {error && (
        <p className="flex items-start gap-1 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
        </p>
      )}
    </div>
  );
}

