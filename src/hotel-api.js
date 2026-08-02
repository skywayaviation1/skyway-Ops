// Client for Skyway lodging shopping.
//
// Talks to /api/hotel-* (Expedia Rapid proxy). When Rapid isn't configured
// — or a property id is demo-* — falls back to rapid-mock.js so ops can
// still walk the full booking + commission UI.

import { auth } from './firebase.js';
import {
  searchProperties as mockSearch,
  getPropertyDetail as mockDetail,
  bookRoom as mockBook,
  applyCommissionEstimate,
  DEMO_MODE as MOCK_DEMO_FLAG,
} from './rapid-mock.js';

async function idToken() {
  if (!auth.currentUser) throw new Error('Sign in required to shop hotels');
  return auth.currentUser.getIdToken();
}

async function post(path, body) {
  const token = await idToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function getHotelApiStatus() {
  try {
    const token = await idToken();
    const res = await fetch('/api/hotel-status', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'status failed');
    return data;
  } catch (e) {
    return {
      ok: true,
      live: false,
      demo: true,
      message: e.message || 'Unable to reach hotel API — using demo inventory.',
    };
  }
}

/**
 * Search hotels near an airport.
 * @returns {{ properties, demo, live, message? }}
 */
export async function searchHotels({
  airportCode, checkInDate, checkOutDate,
  occupancyAdults = 1, agencyIata, defaultCommissionPct = 10,
}) {
  let data;
  try {
    data = await post('/api/hotel-search', {
      airportCode, checkInDate, checkOutDate,
      occupancyAdults, agencyIata, defaultCommissionPct,
    });
  } catch (e) {
    // Network / auth failure → local demo so the window still works.
    data = { useClientDemo: true, demo: true, live: false, error: e.message };
  }

  if (data.useClientDemo || !Array.isArray(data.properties)) {
    const mock = await mockSearch({ airportCode, checkInDate, checkOutDate, occupancyAdults });
    // Attach from_nightly / from_commission using mock room rates.
    const properties = [];
    for (const p of mock.properties || []) {
      const detail = await mockDetail(p.property_id, { checkInDate, checkOutDate });
      const rooms = applyCommissionEstimate(detail.rooms, defaultCommissionPct);
      const lowest = rooms.flatMap((r) => r.rates).sort((a, b) =>
        (a.nightly_rate?.request_currency?.value || 0) - (b.nightly_rate?.request_currency?.value || 0)
      )[0];
      properties.push({
        ...p,
        rooms,
        from_nightly: lowest?.nightly_rate || null,
        from_commission: lowest?.marketing_fee || null,
      });
    }
    return {
      properties,
      demo: true,
      live: false,
      message: data.message || data.error || 'Demo inventory — connect Expedia Rapid to shop live commissionable rates.',
    };
  }

  return {
    properties: data.properties,
    demo: !!data.demo,
    live: !!data.live,
    nights: data.nights,
    message: data.message || null,
  };
}

export async function getHotelDetail({
  propertyId, checkInDate, checkOutDate,
  occupancyAdults = 1, defaultCommissionPct = 10,
}) {
  if (String(propertyId).startsWith('demo-')) {
    const detail = await mockDetail(propertyId, { checkInDate, checkOutDate });
    return {
      property: detail.property,
      rooms: applyCommissionEstimate(detail.rooms, defaultCommissionPct),
      demo: true,
      live: false,
    };
  }

  let data;
  try {
    data = await post('/api/hotel-detail', {
      propertyId, checkInDate, checkOutDate, occupancyAdults, defaultCommissionPct,
    });
  } catch (e) {
    data = { useClientDemo: true, error: e.message };
  }

  if (data.useClientDemo || !data.property) {
    const detail = await mockDetail(propertyId, { checkInDate, checkOutDate });
    return {
      property: detail.property,
      rooms: applyCommissionEstimate(detail.rooms, defaultCommissionPct),
      demo: true,
      live: false,
      message: data.message || data.error || null,
    };
  }

  return {
    property: data.property,
    rooms: data.rooms,
    demo: !!data.demo,
    live: !!data.live,
    nights: data.nights,
  };
}

export async function bookHotel(payload) {
  // Always go through the server so live Rapid never sees secrets in the
  // browser bundle. Demo property ids short-circuit server-side.
  try {
    return await post('/api/hotel-book', payload);
  } catch (e) {
    // If the API is unreachable and this is clearly demo inventory, book locally.
    if (String(payload.propertyId || '').startsWith('demo-')) {
      return mockBook({
        propertyId: payload.propertyId,
        roomId: payload.roomId,
        rateId: payload.rateId,
        guests: (payload.guests || []).map((g) => ({
          first_name: g.given_name,
          last_name: g.family_name,
          occupants: 1,
        })),
        dates: { checkIn: payload.checkInDate, checkOut: payload.checkOutDate },
        customerEmail: payload.email,
        customerPhone: payload.phone,
      });
    }
    throw e;
  }
}

export { MOCK_DEMO_FLAG };
