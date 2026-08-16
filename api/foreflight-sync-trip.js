// Push (or update) one ops trip into ForeFlight Dispatch and remember the
// resulting flightId on trip-state so the Flight Plan tab can release / refresh.

import {
  authorizeForeFlightCaller,
  getDb,
  publicForeFlightConfig,
  readConfig,
  runForeFlightAction,
} from './_foreflight.js';
import { tripToDispatchFlight } from '../src/foreflight.js';

function resolveCrew(trip, users, crewEmails) {
  if (Array.isArray(crewEmails) && crewEmails.length) return crewEmails;
  const list = Array.isArray(users) ? users : [];
  const matchEmail = (name) => {
    if (!name) return null;
    const needle = String(name).toLowerCase().trim();
    const hit = list.find((u) => {
      const candidates = [u.jetinsightName, u.name, u.displayName]
        .filter(Boolean)
        .map((n) => String(n).toLowerCase());
      return candidates.some((c) => c === needle || c.includes(needle) || needle.includes(c));
    });
    return hit?.email || null;
  };

  const crew = [];
  const picEmail = matchEmail(trip?.info?.pic);
  const sicEmail = matchEmail(trip?.info?.sic);
  if (picEmail) crew.push({ position: 'PIC', crewId: picEmail });
  if (sicEmail) crew.push({ position: 'SIC', crewId: sicEmail });
  return crew;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const caller = await authorizeForeFlightCaller(req.body?.idToken, ['admin', 'ops', 'pilot']);
    const {
      trip,
      cruiseFt,
      routeNotes,
      alternate,
      callsign,
      flightRule,
      atcTypeOfFlight,
      dispatcherNotes,
      tags,
      users,
      crewEmails,
      release = false,
      releaseAsEditable = true,
      forceUpdate = false,
    } = req.body || {};

    if (!trip?.uid) {
      res.status(400).json({ error: 'trip with uid is required' });
      return;
    }

    const config = await readConfig();
    if (!config?.apiKey || config.enabled === false) {
      res.status(400).json({
        error: 'ForeFlight Dispatch is not connected',
        ...publicForeFlightConfig(config),
      });
      return;
    }

    const crew = resolveCrew(trip, users, crewEmails);
    const flight = tripToDispatchFlight(trip, {
      cruiseFt,
      routeNotes,
      alternate,
      callsign,
      flightRule,
      atcTypeOfFlight,
      crew,
      dispatcherNotes,
      tags,
    });

    const db = getDb();
    const stateRef = db.collection('trip-state').doc(String(trip.uid));
    const stateSnap = await stateRef.get();
    const existing = stateSnap.exists ? (stateSnap.data()?.foreflight || null) : null;
    const existingFlightId = existing?.flightId || null;

    let result;
    let mode;
    if (existingFlightId) {
      mode = 'update';
      try {
        result = await runForeFlightAction(config, 'updateFlight', {
          flightId: existingFlightId,
          flight,
          forceUpdate,
        });
      } catch (err) {
        // Filed flights cannot be updated via API — surface clearly.
        if (/Cannot modify filed flight/i.test(err.message || '')) {
          res.status(409).json({
            error: err.message,
            flightId: existingFlightId,
            filed: true,
          });
          return;
        }
        throw err;
      }
    } else {
      mode = 'create';
      result = await runForeFlightAction(config, 'createFlight', { flight });
    }

    const flightId = result?.flight?.flightId
      || result?.flightId
      || existingFlightId
      || null;

    let releaseResult = null;
    if (release && flightId) {
      releaseResult = await runForeFlightAction(config, 'releaseFlight', {
        flightId,
        releaseAsEditable,
      });
    }

    let detail = null;
    if (flightId) {
      try {
        detail = await runForeFlightAction(config, 'getFlight', { flightId });
      } catch {
        detail = null;
      }
    }

    const foreflight = {
      flightId,
      syncedAt: Date.now(),
      syncedByUid: caller.uid,
      syncedByName: caller.name,
      mode,
      releaseStatus: detail?.releaseStatus || (release ? 'Pending' : existing?.releaseStatus || 'NotReleased'),
      warnings: result?.flight?.warnings || result?.warnings || [],
      errors: result?.flight?.errors || result?.errors || [],
      lastPayload: {
        departure: flight.departure,
        destination: flight.destination,
        scheduledTimeOfDeparture: flight.scheduledTimeOfDeparture,
        aircraftRegistration: flight.aircraftRegistration,
      },
    };

    await stateRef.set({
      foreflight,
      foreflightUpdatedAt: Date.now(),
    }, { merge: true });

    res.status(200).json({
      ok: true,
      mode,
      flightId,
      foreflight,
      result,
      releaseResult,
      detail,
      organisationUUID: config.organisationUUID || null,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'ForeFlight sync failed',
      foreflight: err.foreflight || null,
    });
  }
}
