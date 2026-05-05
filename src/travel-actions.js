// Travel action helpers — manage-trip links + hotel directions/phone.
//
// IMPORTANT (May 2026): Modern airline sites are JavaScript SPAs that no
// longer honor URL parameters for pre-filling conf codes. We tried it,
// it doesn't work reliably (lands on 404 / "page must have taken flight"
// pages). The honest pattern:
//   1. Open the airline's correct manage-trip page (which IS reliable)
//   2. Provide a one-tap COPY CONF button so the user pastes the code
//      instead of typing it
// This trades the dream of "one click to your boarding pass" for a
// pattern that consistently works: "two taps to your boarding pass".
//
// Worth re-testing these URLs every 6-12 months — airlines redesign
// regularly. The failure mode if a URL goes stale is graceful (lands
// on the airline's homepage or 404 page).

/**
 * Extract the last name from a passenger name.
 * Kept for display purposes — not used in URL params anymore.
 */
export function extractLastName(passengerName) {
  if (!passengerName) return '';
  const trimmed = String(passengerName).trim();
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim();
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || '';
}

/**
 * Build a manage-trip URL for an airline. Returns the airline's correct
 * "find your trip" / "my trips" landing page. URLs verified May 2026.
 *
 * Where the airline supports iOS Universal Links / Android App Links, we
 * use the path declared in the airline's AASA / asset-links manifest.
 * On a phone with the airline's app installed, tapping the URL opens
 * the app directly to that screen. On phones without the app, or on
 * desktop, it falls back to the web page. Same URL handles both.
 *
 * Returns: { url, airline } or null when no airline match.
 */
export function buildManageTripUrl(booking) {
  if (!booking) return null;
  const code = String(booking.airlineCode || '').toUpperCase();
  const name = String(booking.airline || '').toLowerCase();
  const conf = String(booking.confirmationCode || '').trim().toUpperCase();
  const lastName = extractLastName(booking.passengerName).toUpperCase();

  const isAirline = (aliases) => aliases.some(a => {
    const al = a.toLowerCase();
    return code === a.toUpperCase() || name.includes(al);
  });

  // === American Airlines ===
  // AASA-listed Universal Link path. iOS opens the AA app if installed;
  // otherwise loads the web page. Query params don't web-pre-fill but
  // the AA app may use them; harmless if it doesn't.
  if (isAirline(['AA', 'american'])) {
    const params = new URLSearchParams();
    if (conf) params.set('recordLocator', conf);
    if (lastName) params.set('lastName', lastName);
    const qs = params.toString();
    return {
      url: `https://www.aa.com/reservation/view/find-your-reservation${qs ? '?' + qs : ''}`,
      airline: 'American Airlines',
    };
  }

  // === Delta ===
  // Delta's iOS app declares fly.delta.com via Universal Links.
  if (isAirline(['DL', 'delta'])) {
    return {
      url: 'https://www.delta.com/my-trips/trip-details',
      airline: 'Delta',
    };
  }

  // === United ===
  if (isAirline(['UA', 'united'])) {
    return {
      url: 'https://www.united.com/en/us/manageres/mytrips',
      airline: 'United',
    };
  }

  // === Southwest ===
  if (isAirline(['WN', 'southwest'])) {
    return {
      url: 'https://www.southwest.com/air/manage-reservation/index.html',
      airline: 'Southwest',
    };
  }

  // === JetBlue ===
  if (isAirline(['B6', 'jetblue'])) {
    return { url: 'https://www.jetblue.com/manage-trips', airline: 'JetBlue' };
  }
  if (isAirline(['AS', 'alaska'])) {
    return { url: 'https://www.alaskaair.com/manage', airline: 'Alaska Airlines' };
  }
  if (isAirline(['NK', 'spirit'])) {
    return { url: 'https://www.spirit.com/my-trip', airline: 'Spirit' };
  }
  if (isAirline(['F9', 'frontier'])) {
    return { url: 'https://www.flyfrontier.com/travel/my-trips/', airline: 'Frontier' };
  }
  if (isAirline(['HA', 'hawaiian'])) {
    return { url: 'https://www.hawaiianairlines.com/manage-flights', airline: 'Hawaiian' };
  }
  if (isAirline(['G4', 'allegiant'])) {
    return { url: 'https://www.allegiantair.com/manage-travel', airline: 'Allegiant' };
  }

  // === International carriers ===
  if (isAirline(['AC', 'air canada'])) {
    return { url: 'https://www.aircanada.com/us/en/aco/home/manage.html', airline: 'Air Canada' };
  }
  if (isAirline(['BA', 'british airways'])) {
    return { url: 'https://www.britishairways.com/travel/managebooking/public/en_us', airline: 'British Airways' };
  }
  if (isAirline(['LH', 'lufthansa'])) {
    return { url: 'https://www.lufthansa.com/us/en/manage-my-booking', airline: 'Lufthansa' };
  }
  if (isAirline(['AF', 'air france'])) {
    return { url: 'https://www.airfrance.us/manage-booking', airline: 'Air France' };
  }
  if (isAirline(['KL', 'klm'])) {
    return { url: 'https://www.klm.com/travel/us_en/prepare_for_travel/manage_my_booking/index.htm', airline: 'KLM' };
  }
  if (isAirline(['EK', 'emirates'])) {
    return { url: 'https://www.emirates.com/us/english/manage-booking/manage-booking.aspx', airline: 'Emirates' };
  }
  if (isAirline(['QR', 'qatar'])) {
    return { url: 'https://www.qatarairways.com/en-us/manage-booking.html', airline: 'Qatar Airways' };
  }

  return null;
}

// Backward-compatibility alias — App.jsx still imports buildCheckInUrl
export const buildCheckInUrl = buildManageTripUrl;

/**
 * Build a Google Maps directions URL for a hotel.
 * Uses the hotel address if available, falls back to name + city.
 */
export function buildHotelDirectionsUrl(booking) {
  if (!booking) return null;
  const parts = [];
  if (booking.address) parts.push(booking.address);
  if (booking.city) parts.push(booking.city);
  if (booking.state) parts.push(booking.state);
  let query = parts.join(', ');
  if (!query && booking.hotelName) {
    query = booking.city
      ? `${booking.hotelName}, ${booking.city}`
      : booking.hotelName;
  }
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Build a tel: URL for the hotel phone number.
 */
export function buildHotelPhoneUrl(booking) {
  if (!booking?.phone) return null;
  const clean = String(booking.phone).replace(/[^\d+]/g, '');
  if (!clean) return null;
  return `tel:${clean}`;
}
