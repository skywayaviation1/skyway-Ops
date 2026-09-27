import { useEffect, useMemo, useState } from 'react';
import { evaluatePilot, summarizeDutyFlightHours } from './pilot-safety.js';
import { planFlightLogSync } from './flight-log.js';
import {
  savePilotFlightEntry,
  savePilotLogbook,
  subscribeMyPilotFlightLog,
  subscribeMyPilotLogbook,
  subscribePilotFlightLog,
  subscribePilotLogbooks,
  subscribePilotSafetyStandards,
} from './firebase-pilot-safety.js';
import { subscribeMyPilotCurrency, subscribePilotCurrencies } from './firebase-currency.js';
import { subscribePeriodsForPilot, subscribeRecentForAllPilots } from './firebase-duty-v2.js';
import { subscribeToAllPilotDocs, subscribeToUserPilotDocs } from './firebase-pilotdocs.js';
import { subscribeAllTripStates } from './firebase-data.js';

const VIEW_ALL_ROLES = new Set(['admin', 'ops', 'sales']);
const FLIGHT_EDITOR = { uid: 'flight-log', name: 'Flight log' };

export function usePilotSafetyData(currentUser, { trips = null, aircraftByTail = null, users = [] } = {}) {
  const viewAll = VIEW_ALL_ROLES.has(currentUser?.role);
  const isCrew = currentUser?.role === 'crew';
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'ops';
  const trackFlights = Array.isArray(trips);
  const [logbooks, setLogbooks] = useState({});
  const [currencies, setCurrencies] = useState({});
  const [standards, setStandards] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [docs, setDocs] = useState([]);
  const [flightEntries, setFlightEntries] = useState([]);
  const [flightReady, setFlightReady] = useState(false);
  const [tripStates, setTripStates] = useState(null);
  const [todayMs] = useState(() => Date.now());

  useEffect(() => {
    if (!currentUser?.uid) return undefined;
    const unsubs = [subscribePilotSafetyStandards(setStandards)];
    if (viewAll) {
      unsubs.push(subscribePilotLogbooks(setLogbooks));
      unsubs.push(subscribePilotCurrencies(setCurrencies));
      unsubs.push(subscribeRecentForAllPilots(400, setPeriods));
      unsubs.push(subscribeToAllPilotDocs(setDocs));
    } else if (isCrew) {
      unsubs.push(subscribeMyPilotLogbook(currentUser.uid, (entry) => {
        setLogbooks(entry ? { [currentUser.uid]: entry } : {});
      }));
      unsubs.push(subscribeMyPilotCurrency(currentUser.uid, (entry) => {
        setCurrencies(entry ? { [currentUser.uid]: entry } : {});
      }));
      unsubs.push(subscribePeriodsForPilot(currentUser.uid, setPeriods));
      unsubs.push(subscribeToUserPilotDocs(currentUser.uid, setDocs));
    }
    return () => {
      unsubs.forEach((unsub) => {
        if (typeof unsub === 'function') unsub();
      });
    };
  }, [currentUser?.uid, currentUser?.role, viewAll, isCrew]);

  useEffect(() => {
    if (!currentUser?.uid || !trackFlights) return undefined;
    const deliver = (entries) => {
      setFlightEntries(entries || []);
      setFlightReady(true);
    };
    const unsub = viewAll || canEdit
      ? subscribePilotFlightLog(deliver)
      : subscribeMyPilotFlightLog(currentUser.uid, deliver);
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [currentUser?.uid, trackFlights, viewAll, canEdit]);

  useEffect(() => {
    if (!canEdit || !trackFlights) return undefined;
    const unsub = subscribeAllTripStates((map) => setTripStates(map));
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [canEdit, trackFlights]);

  useEffect(() => {
    if (!canEdit || !trackFlights || !flightReady || !tripStates) return undefined;
    let cancelled = false;
    const handle = setTimeout(() => {
      const plan = planFlightLogSync({
        trips,
        tripStates,
        aircraftByTail: aircraftByTail || {},
        users,
        existingEntries: flightEntries,
        logbooks,
        now: Date.now(),
        editor: FLIGHT_EDITOR,
      });
      if (cancelled || (!plan.entryWrites.length && !plan.logbookPatches.length)) return;
      (async () => {
        for (const entry of plan.entryWrites) {
          if (cancelled) return;
          await savePilotFlightEntry(entry, FLIGHT_EDITOR);
        }
        for (const patch of plan.logbookPatches) {
          if (cancelled) return;
          const book = logbooks[patch.uid];
          if (!book?.baseline?.asOf) continue;
          await savePilotLogbook(patch.uid, {
            ...book,
            hours: patch.hours,
            hoursMeta: patch.hoursMeta,
          }, FLIGHT_EDITOR);
        }
      })().catch((err) => {
        console.warn('[flight-log] sync error:', err?.message || err);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [canEdit, trackFlights, flightReady, tripStates, trips, aircraftByTail, users, flightEntries, logbooks]);

  const docsByUid = useMemo(() => {
    const map = {};
    for (const entry of docs || []) {
      if (!entry?.uid) continue;
      if (!map[entry.uid]) map[entry.uid] = [];
      map[entry.uid].push(entry);
    }
    return map;
  }, [docs]);

  const rate = (pilot, { role, focusType } = {}) => evaluatePilot({
    pilot,
    logbook: logbooks[pilot.uid],
    currencyDoc: currencies[pilot.uid],
    pilotDocs: docsByUid[pilot.uid] || [],
    standards,
    dutyHours: summarizeDutyFlightHours(periods, pilot.uid, todayMs),
    role,
    focusType,
    todayMs,
  });

  return {
    logbooks,
    currencies,
    standards,
    periods,
    docsByUid,
    flightEntries,
    todayMs,
    viewAll,
    canEdit,
    canSend: VIEW_ALL_ROLES.has(currentUser?.role),
    rate,
  };
}
