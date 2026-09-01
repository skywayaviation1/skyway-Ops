import { useEffect, useRef, useState } from 'react';
import { Headphones, Square } from 'lucide-react';
import { Button } from './ui.jsx';
import { postJson } from './api-json.js';

async function idToken() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

export default function FboCallListener({
  callId,
  size = 'sm',
  apiPath = '/api/fbo-call',
}) {
  const socketRef = useRef(null);
  const audioRef = useRef(null);
  const nextPlayAtRef = useRef(0);
  const formatRef = useRef({ sampleRate: 16000, channels: 2 });
  const manuallyStoppedRef = useRef(false);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  function stop() {
    manuallyStoppedRef.current = true;
    socketRef.current?.close();
    socketRef.current = null;
    audioRef.current?.close().catch(() => {});
    audioRef.current = null;
    nextPlayAtRef.current = 0;
    setStatus('idle');
  }

  useEffect(() => stop, []);

  async function playPcm(payload) {
    const context = audioRef.current;
    if (!context) return;
    const bytes = payload instanceof ArrayBuffer ? payload : await payload.arrayBuffer();
    const { sampleRate, channels } = formatRef.current;
    const channelCount = Math.max(1, Math.min(2, Number(channels) || 2));
    const frameCount = Math.floor(bytes.byteLength / (2 * channelCount));
    if (!frameCount) return;
    const view = new DataView(bytes);
    const buffer = context.createBuffer(channelCount, frameCount, Number(sampleRate) || 16000);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        output[frame] = view.getInt16((frame * channelCount + channel) * 2, true) / 32768;
      }
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.08, nextPlayAtRef.current);
    source.start(startAt);
    nextPlayAtRef.current = startAt + buffer.duration;
  }

  async function listen() {
    if (!callId || status !== 'idle') return;
    setStatus('connecting');
    setError('');
    manuallyStoppedRef.current = false;
    try {
      const data = await postJson(apiPath, {
        idToken: await idToken(),
        action: 'listen',
        callId,
      });
      if (!data.listenUrl) throw new Error('Live stream unavailable');

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('This browser cannot play the live call stream');
      const context = new AudioContextClass({ sampleRate: 16000 });
      await context.resume();
      audioRef.current = context;

      const socket = new WebSocket(data.listenUrl);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => setStatus('listening');
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'start') {
              formatRef.current = {
                sampleRate: Number(message.sampleRate) || 16000,
                channels: Number(message.channels) || 2,
              };
            }
          } catch {
            // Non-JSON control messages do not contain audio.
          }
          return;
        }
        playPcm(event.data).catch(() => setError('Could not decode live call audio'));
      };
      socket.onerror = () => setError('The live call audio connection failed');
      socket.onclose = () => {
        socketRef.current = null;
        audioRef.current?.close().catch(() => {});
        audioRef.current = null;
        setStatus('idle');
        if (!manuallyStoppedRef.current) setError('The live call stream ended');
      };
    } catch (err) {
      stop();
      setError(err.message || 'Could not listen to this call');
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      {status === 'idle' ? (
        <Button size={size} variant="secondary" icon={Headphones} onClick={listen}>
          Listen live
        </Button>
      ) : (
        <Button size={size} variant="secondary" icon={Square} onClick={stop}>
          {status === 'connecting' ? 'Connecting…' : 'Stop listening'}
        </Button>
      )}
      {error && <span className="max-w-52 text-right text-[10px] text-danger">{error}</span>}
    </span>
  );
}
