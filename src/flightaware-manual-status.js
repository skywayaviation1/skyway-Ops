const SUPPORTED_STEPS = new Set(['taxi_dep', 'wheels_up', 'landed']);

export async function resolveManualStatusTimestamp({
  stepId,
  trip,
  idToken,
  clickedAt = Date.now(),
  fetchImpl = fetch,
}) {
  const fallback = {
    timestamp: clickedAt,
    timestampSource: 'manual',
    faFlightId: null,
  };
  if (!SUPPORTED_STEPS.has(stepId) || !trip?.info?.tail || !idToken) return fallback;

  try {
    const response = await fetchImpl('/api/flightaware-event-time', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        ident: trip.info.tail,
        stepId,
        from: trip.info.from || '',
        to: trip.info.to || '',
        scheduledStart: trip.start instanceof Date
          ? trip.start.toISOString()
          : trip.start || null,
      }),
    });
    if (!response.ok) return fallback;
    const data = await response.json();
    const timestamp = Number(data?.event?.timestampMs);
    if (
      data?.matched !== true
      || !Number.isFinite(timestamp)
      || timestamp > clickedAt + 5 * 60 * 1000
    ) {
      return fallback;
    }
    return {
      timestamp,
      timestampSource: 'flightaware',
      faFlightId: data.event.faFlightId || null,
    };
  } catch {
    return fallback;
  }
}
