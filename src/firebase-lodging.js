// Agency lodging config — IATA / TAAP identity used when shopping hotels
// so Skyway earns commission on Expedia Rapid / TAAP bookings.
//
// Stored at app-config/lodging. Readable by authenticated ops users;
// writable by admin (enforced in the Settings UI; add Firestore rules
// to match when rules land in-repo).

import { db } from './firebase.js';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

const DOC_PATH = ['app-config', 'lodging'];

export const DEFAULT_LODGING_CONFIG = {
  agencyIata: '',
  agencyName: 'Skyway Aviation',
  taapPortalUrl: 'https://www.expedia.com/affiliates',
  // Used when Rapid doesn't return marketing_fee (demo / fallback).
  defaultCommissionPct: 10,
};

/**
 * Live subscribe to org lodging settings.
 * Calls onUpdate(config) immediately with defaults if the doc is missing.
 */
export function subscribeToLodgingConfig(onUpdate) {
  return onSnapshot(
    doc(db, ...DOC_PATH),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      onUpdate({
        ...DEFAULT_LODGING_CONFIG,
        ...data,
        agencyIata: String(data.agencyIata || '').trim(),
        agencyName: String(data.agencyName || DEFAULT_LODGING_CONFIG.agencyName).trim(),
        taapPortalUrl: String(data.taapPortalUrl || DEFAULT_LODGING_CONFIG.taapPortalUrl).trim(),
        defaultCommissionPct: Number.isFinite(Number(data.defaultCommissionPct))
          ? Number(data.defaultCommissionPct)
          : DEFAULT_LODGING_CONFIG.defaultCommissionPct,
      });
    },
    (err) => {
      console.error('[lodging-config] subscribe failed:', err);
      onUpdate({ ...DEFAULT_LODGING_CONFIG });
    },
  );
}

/** Persist agency IATA / TAAP settings. Admin-only at the call site. */
export async function saveLodgingConfig(patch, { updatedBy } = {}) {
  const clean = {};
  if (patch.agencyIata != null) {
    clean.agencyIata = String(patch.agencyIata).replace(/\s+/g, '').toUpperCase().slice(0, 16);
  }
  if (patch.agencyName != null) {
    clean.agencyName = String(patch.agencyName).trim().slice(0, 120);
  }
  if (patch.taapPortalUrl != null) {
    clean.taapPortalUrl = String(patch.taapPortalUrl).trim().slice(0, 500);
  }
  if (patch.defaultCommissionPct != null) {
    const n = Number(patch.defaultCommissionPct);
    if (!Number.isFinite(n) || n < 0 || n > 40) {
      throw new Error('Commission % must be between 0 and 40');
    }
    clean.defaultCommissionPct = n;
  }
  clean.updatedAt = Date.now();
  if (updatedBy) clean.updatedBy = updatedBy;
  await setDoc(doc(db, ...DOC_PATH), clean, { merge: true });
  return clean;
}

/** Build a TAAP / affiliate deep link for destination + stay dates. */
export function buildTaapSearchUrl(config, { destination, checkIn, checkOut } = {}) {
  const base = (config?.taapPortalUrl || DEFAULT_LODGING_CONFIG.taapPortalUrl).replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (destination) params.set('dest', String(destination).toUpperCase());
  if (checkIn) params.set('in', checkIn);
  if (checkOut) params.set('out', checkOut);
  if (config?.agencyIata) params.set('iata', config.agencyIata);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
