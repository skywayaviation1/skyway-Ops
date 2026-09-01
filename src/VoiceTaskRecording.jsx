import { useState } from 'react';
import { AlertTriangle, Play, RotateCcw } from 'lucide-react';
import { Button } from './ui.jsx';
import { postJson } from './api-json.js';

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
      const data = await postJson('/api/voice-task-call', {
        idToken: await idToken(),
        action: 'recording',
        callId,
      });
      if (!data.recordingUrl) throw new Error('Recording is not ready');
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

