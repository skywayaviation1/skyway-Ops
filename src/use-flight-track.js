// Full-resolution FlightAware track log for one tail. The fleet poll only
// carries a downsample; the track log has altitude samples for the trail.

import { useEffect, useState } from 'react';
import { normalizeTrail } from './tracking-map.js';

export function useFullFlightTrack(tail, airborne) {
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!tail) {
      setPoints([]);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    let timer = null;

    async function load() {
      try {
        setLoading(true);
        const { auth } = await import('./firebase.js');
        const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
        if (!idToken) {
          if (!cancelled) {
            setPoints([]);
            setError('signed-out');
          }
          return;
        }
        const response = await fetch(`/api/flightaware-track-log?ident=${encodeURIComponent(tail)}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!response.ok) {
          if (!cancelled) {
            setPoints([]);
            setError(`track-${response.status}`);
          }
          return;
        }
        const data = await response.json();
        if (cancelled) return;
        setPoints(normalizeTrail(Array.isArray(data?.points) ? data.points : []));
        setError(null);
      } catch {
        if (!cancelled) {
          setPoints([]);
          setError('track-failed');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    if (airborne) timer = setInterval(load, 60000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [tail, airborne]);

  return { points, loading, error };
}
