import { useEffect, useMemo, useState } from 'react';
import { evaluatePilot, summarizeDutyFlightHours } from './pilot-safety.js';
import {
  subscribeMyPilotLogbook,
  subscribePilotLogbooks,
  subscribePilotSafetyStandards,
} from './firebase-pilot-safety.js';
import { subscribeMyPilotCurrency, subscribePilotCurrencies } from './firebase-currency.js';
import { subscribePeriodsForPilot, subscribeRecentForAllPilots } from './firebase-duty-v2.js';
import { subscribeToAllPilotDocs, subscribeToUserPilotDocs } from './firebase-pilotdocs.js';

const VIEW_ALL_ROLES = new Set(['admin', 'ops', 'sales']);

export function usePilotSafetyData(currentUser) {
  const viewAll = VIEW_ALL_ROLES.has(currentUser?.role);
  const isCrew = currentUser?.role === 'crew';
  const [logbooks, setLogbooks] = useState({});
  const [currencies, setCurrencies] = useState({});
  const [standards, setStandards] = useState(null);
  const [periods, setPeriods] = useState([]);
  const [docs, setDocs] = useState([]);
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
    todayMs,
    viewAll,
    canEdit: currentUser?.role === 'admin' || currentUser?.role === 'ops',
    canSend: VIEW_ALL_ROLES.has(currentUser?.role),
    rate,
  };
}
