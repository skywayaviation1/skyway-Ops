// rapid-mock.js — mock client for Expedia Rapid Hotel API.
//
// EVERYTHING IN THIS FILE IS FAKE DATA.
//
// When real Rapid API credentials are issued, replace each function in
// this file with a real fetch() to the Rapid endpoints. The data shapes
// (property_id, room_id, rate_id, total_in_request_currency, etc.) are
// modeled on the public Rapid documentation at
// https://developers.expediagroup.com/rapid so the UI doesn't need to
// change when we swap.
//
// THE DEMO_MODE flag below is the master switch. Until it's false AND
// real credentials are wired up, anything calling these functions gets
// fake results — bookings made via these functions are NOT real
// reservations. The UI must surface this clearly to users.

// === Master demo switch. Flip to false when real Rapid integration goes live. ===
export const DEMO_MODE = true;

// === Mock hotel database — realistic enough to look real, distinctive
// enough to be obviously not. All in airport-adjacent locations Skyway
// actually visits. ===
const MOCK_PROPERTIES = [
  {
    property_id: 'demo-htl-001',
    name: 'Hilton Garden Inn',
    brand: 'Hilton',
    address: { line_1: '4900 SE 1st Pl', city: 'Hialeah', state_province_code: 'FL', postal_code: '33013', country_code: 'US' },
    location: { coordinates: { latitude: 25.823, longitude: -80.282 } },
    star_rating: 3.5, guest_rating: 4.2,
    amenities: ['24-hour front desk', 'Airport shuttle', 'Free Wi-Fi', 'Fitness center', 'Business center', 'Restaurant'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800' }],
    nearby_airports: ['FXE', 'MIA', 'OPF'],
  },
  {
    property_id: 'demo-htl-002',
    name: 'Courtyard by Marriott',
    brand: 'Marriott',
    address: { line_1: '1100 SE 17th St', city: 'Fort Lauderdale', state_province_code: 'FL', postal_code: '33316', country_code: 'US' },
    location: { coordinates: { latitude: 26.099, longitude: -80.138 } },
    star_rating: 3, guest_rating: 4.3,
    amenities: ['24-hour front desk', 'Free Wi-Fi', 'Pool', 'Fitness center', 'Restaurant', 'Pet-friendly'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=800' }],
    nearby_airports: ['FXE', 'FLL'],
  },
  {
    property_id: 'demo-htl-003',
    name: 'Hampton Inn & Suites',
    brand: 'Hilton',
    address: { line_1: '2900 SW 31st Ave', city: 'Fort Lauderdale', state_province_code: 'FL', postal_code: '33312', country_code: 'US' },
    location: { coordinates: { latitude: 26.082, longitude: -80.179 } },
    star_rating: 3, guest_rating: 4.4,
    amenities: ['24-hour front desk', 'Free breakfast', 'Free Wi-Fi', 'Pool', 'Fitness center', 'Pet-friendly'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=800' }],
    nearby_airports: ['FXE', 'FLL', 'HWO'],
  },
  {
    property_id: 'demo-htl-004',
    name: 'Renaissance Fort Lauderdale Cruise Port',
    brand: 'Marriott',
    address: { line_1: '1617 SE 17th St', city: 'Fort Lauderdale', state_province_code: 'FL', postal_code: '33316', country_code: 'US' },
    location: { coordinates: { latitude: 26.097, longitude: -80.131 } },
    star_rating: 4, guest_rating: 4.1,
    amenities: ['24-hour front desk', 'Restaurant', 'Bar', 'Pool', 'Fitness center', 'Spa', 'Business center'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=800' }],
    nearby_airports: ['FXE', 'FLL'],
  },
  {
    property_id: 'demo-htl-005',
    name: 'Residence Inn',
    brand: 'Marriott',
    address: { line_1: '1180 N University Dr', city: 'Plantation', state_province_code: 'FL', postal_code: '33322', country_code: 'US' },
    location: { coordinates: { latitude: 26.135, longitude: -80.249 } },
    star_rating: 3, guest_rating: 4.5,
    amenities: ['Kitchen in room', 'Free breakfast', 'Free Wi-Fi', 'Pool', 'Fitness center', 'Pet-friendly', '24-hour front desk'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=800' }],
    nearby_airports: ['FXE', 'FLL'],
  },
  // Toronto area — for CYYZ trips
  {
    property_id: 'demo-htl-006',
    name: 'Sheraton Gateway Hotel Toronto Airport',
    brand: 'Marriott',
    address: { line_1: 'Toronto AMF, PO Box 3000', city: 'Mississauga', state_province_code: 'ON', postal_code: 'L5P 1C4', country_code: 'CA' },
    location: { coordinates: { latitude: 43.681, longitude: -79.610 } },
    star_rating: 4, guest_rating: 4.0,
    amenities: ['24-hour front desk', 'Airport shuttle', 'Restaurant', 'Bar', 'Pool', 'Fitness center', 'Business center', 'In-terminal'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=800' }],
    nearby_airports: ['CYYZ'],
  },
  {
    property_id: 'demo-htl-007',
    name: 'Hilton Toronto Airport Hotel & Suites',
    brand: 'Hilton',
    address: { line_1: '5875 Airport Rd', city: 'Mississauga', state_province_code: 'ON', postal_code: 'L4V 1N1', country_code: 'CA' },
    location: { coordinates: { latitude: 43.696, longitude: -79.601 } },
    star_rating: 4, guest_rating: 4.1,
    amenities: ['24-hour front desk', 'Airport shuttle', 'Restaurant', 'Bar', 'Pool', 'Fitness center', 'Business center'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1455587734955-081b22074882?w=800' }],
    nearby_airports: ['CYYZ'],
  },
  // Teterboro area — for TEB trips
  {
    property_id: 'demo-htl-008',
    name: 'Renaissance Newark Airport Hotel',
    brand: 'Marriott',
    address: { line_1: '1000 Spring St', city: 'Elizabeth', state_province_code: 'NJ', postal_code: '07201', country_code: 'US' },
    location: { coordinates: { latitude: 40.682, longitude: -74.196 } },
    star_rating: 4, guest_rating: 4.0,
    amenities: ['24-hour front desk', 'Airport shuttle', 'Restaurant', 'Bar', 'Fitness center', 'Business center'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=800' }],
    nearby_airports: ['TEB', 'EWR'],
  },
  {
    property_id: 'demo-htl-009',
    name: 'Marriott at Glenpointe',
    brand: 'Marriott',
    address: { line_1: '100 Frank W Burr Blvd', city: 'Teaneck', state_province_code: 'NJ', postal_code: '07666', country_code: 'US' },
    location: { coordinates: { latitude: 40.886, longitude: -74.013 } },
    star_rating: 4, guest_rating: 4.2,
    amenities: ['24-hour front desk', 'Restaurant', 'Bar', 'Pool', 'Fitness center', 'Spa', 'Business center'],
    images: [{ caption: 'Hotel exterior', url: 'https://images.unsplash.com/photo-1568084680786-a84f91d1153c?w=800' }],
    nearby_airports: ['TEB'],
  },
];

// Mock room types — what's offered when you "select" a hotel
const MOCK_ROOMS = [
  {
    room_id: 'room-king',
    room_name: 'King Bed Room',
    bed_groups: [{ configuration: [{ type: 'King', size: 'King', quantity: 1 }] }],
    max_occupancy: { total: 2 },
    rates: [
      {
        rate_id: 'rate-king-flex',
        merchant_of_record: 'expedia',
        refundable: true,
        cancel_penalties: [],
        total_in_request_currency: { request_currency: { value: 219, currency: 'USD' } },
        nightly_rate: { request_currency: { value: 219, currency: 'USD' } },
        meal_plan: 'Room Only',
      },
      {
        rate_id: 'rate-king-prepaid',
        merchant_of_record: 'expedia',
        refundable: false,
        cancel_penalties: [{ amount: { request_currency: { value: 219, currency: 'USD' } } }],
        total_in_request_currency: { request_currency: { value: 189, currency: 'USD' } },
        nightly_rate: { request_currency: { value: 189, currency: 'USD' } },
        meal_plan: 'Room Only',
      },
    ],
  },
  {
    room_id: 'room-double',
    room_name: 'Two Queen Beds',
    bed_groups: [{ configuration: [{ type: 'Queen', size: 'Queen', quantity: 2 }] }],
    max_occupancy: { total: 4 },
    rates: [
      {
        rate_id: 'rate-double-flex',
        merchant_of_record: 'expedia',
        refundable: true,
        cancel_penalties: [],
        total_in_request_currency: { request_currency: { value: 239, currency: 'USD' } },
        nightly_rate: { request_currency: { value: 239, currency: 'USD' } },
        meal_plan: 'Room Only',
      },
    ],
  },
  {
    room_id: 'room-suite',
    room_name: 'Junior Suite',
    bed_groups: [{ configuration: [{ type: 'King', size: 'King', quantity: 1 }] }],
    max_occupancy: { total: 3 },
    rates: [
      {
        rate_id: 'rate-suite-flex',
        merchant_of_record: 'expedia',
        refundable: true,
        cancel_penalties: [],
        total_in_request_currency: { request_currency: { value: 329, currency: 'USD' } },
        nightly_rate: { request_currency: { value: 329, currency: 'USD' } },
        meal_plan: 'Breakfast included',
      },
    ],
  },
];

// === MOCK API FUNCTIONS ===
// Each one matches the shape of the corresponding Rapid endpoint
// response so the UI doesn't need changes when real API is wired up.

/**
 * Mock: Property search by airport code or city.
 * Real Rapid call would be GET /v3/properties/availability with
 * filters for airport/city. Returns the same response shape: a list
 * of properties with embedded rate availability.
 *
 * @param {Object} params
 * @param {string} params.airportCode  3- or 4-letter ICAO/IATA
 * @param {string} params.checkInDate  YYYY-MM-DD
 * @param {string} params.checkOutDate YYYY-MM-DD
 * @param {number} params.occupancyAdults defaults to 1
 * @returns {Promise<{properties: Array, demo: true}>}
 */
export async function searchProperties({ airportCode, checkInDate, checkOutDate, occupancyAdults = 1 }) {
  // Simulate API latency so the UI loading state is exercised
  await new Promise((r) => setTimeout(r, 600));

  if (!airportCode) return { properties: [], demo: true };
  const code = String(airportCode).toUpperCase().trim();
  // Match by nearby airports (with K-prefix tolerance)
  const matched = MOCK_PROPERTIES.filter((p) =>
    p.nearby_airports.some((a) =>
      a === code || a === code.replace(/^K/, '') || ('K' + a) === code
    )
  );
  return { properties: matched, demo: true };
}

/**
 * Mock: Get full property content + room availability.
 * Real Rapid call would be GET /v3/properties/{property_id}/content
 * for the static content, then /v3/properties/{property_id}/availability
 * for live rates. We collapse both into one mock call here for simplicity.
 *
 * @param {string} propertyId
 * @param {Object} dates
 * @returns {Promise<{property: Object, rooms: Array, demo: true}>}
 */
export async function getPropertyDetail(propertyId, dates) {
  await new Promise((r) => setTimeout(r, 400));
  const property = MOCK_PROPERTIES.find((p) => p.property_id === propertyId);
  if (!property) return { property: null, rooms: [], demo: true };
  return { property, rooms: MOCK_ROOMS, demo: true };
}

/**
 * Mock: Create a booking (price-check + book in one call).
 * Real Rapid call would be a two-step:
 *   1. POST /v3/properties/{id}/rooms/{room_id}/rates/{rate_id}/price-check
 *   2. POST /v3/itineraries with guest info + payment
 *
 * In demo mode we skip both steps and return a fake confirmation.
 * In production this is where we'd send payment data and get back
 * an itinerary_id from Expedia.
 */
export async function bookRoom({ propertyId, roomId, rateId, guests, dates, customerEmail, customerPhone }) {
  await new Promise((r) => setTimeout(r, 800));
  const property = MOCK_PROPERTIES.find((p) => p.property_id === propertyId);
  const room = MOCK_ROOMS.find((r) => r.room_id === roomId);
  const rate = room?.rates.find((r) => r.rate_id === rateId);
  if (!property || !room || !rate) {
    return { ok: false, error: 'Property/room/rate not found', demo: true };
  }
  // Generate a fake but identifiable conf number
  const conf = 'DEMO-' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return {
    ok: true,
    demo: true,
    itinerary_id: conf,
    confirmation_code: conf,
    property,
    room,
    rate,
  };
}
