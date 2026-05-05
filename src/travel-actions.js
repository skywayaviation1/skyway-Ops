// Travel action helpers — check-in deep links + hotel directions/phone.
//
// Airlines: each carrier has its own URL format for "manage trip" / "check
// in" pages. Where deep-linking with conf code is supported, we build the
// URL with parameters pre-filled. Where it isn't, we fall back to the
// airline's homepage.
//
// IMPORTANT: These URLs change when airlines redesign their sites. The
// failure mode is graceful — link still opens the airline's domain, the
// user just lands on a generic page instead of pre-filled check-in. Worth
// re-checking these every 6-12 months.
//
// Last-name extraction: most check-in URLs need just the last name. We
// split passengerName on whitespace and take the last token. Doesn't
// handle hyphenated or compound surnames perfectly, but works for ~95% of
// cases. The user can paste it manually if they land on a generic page.

/**
 * Extract the last name from a passenger name.
 * "Cole Zangler" -> "Zangler"
 * "ZANGLER, COLE" -> "ZANGLER" (handles "LAST, FIRST" format)
 * "Maria Garcia-Lopez" -> "Garcia-Lopez"
 */
export function extractLastName(passengerName) {
  if (!passengerName) return '';
  const trimmed = String(passengerName).trim();
  // "LAST, FIRST" comma format
  if (trimmed.includes(',')) {
    return trimmed.split(',')[0].trim();
  }
  // Take the last whitespace-separated token
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || '';
}

/**
 * Build a check-in / manage-trip URL for a given airline + booking.
 * Returns { url, deepLink } where deepLink=true means the URL targets
 * the actual check-in page with params, false means it's a homepage
 * fallback.
 */
export function buildCheckInUrl(booking) {
  if (!booking) return null;
  const conf = String(booking.confirmationCode || '').trim().toUpperCase();
  const lastName = extractLastName(booking.passengerName).toUpperCase();
  const code = String(booking.airlineCode || '').toUpperCase();
  const name = String(booking.airline || '').toLowerCase();

  // Helper: match either by IATA code or substring of airline name
  const isAirline = (aliases) => {
    return aliases.some(a => {
      const al = a.toLowerCase();
      return code === a.toUpperCase() || name.includes(al);
    });
  };

  // === American Airlines ===
  if (isAirline(['AA', 'american'])) {
    if (conf && lastName) {
      return {
        url: `https://www.aa.com/reservation/find-your-trip-view.do?recordLocator=${encodeURIComponent(conf)}&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'American Airlines',
      };
    }
    return { url: 'https://www.aa.com/reservation/view/find-your-trip', deepLink: false, airline: 'American Airlines' };
  }

  // === Delta ===
  if (isAirline(['DL', 'delta'])) {
    if (conf && lastName) {
      return {
        url: `https://www.delta.com/mytrips/findYourTripByConfirmationNumber.action?confirmationNumber=${encodeURIComponent(conf)}&firstName=&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'Delta Air Lines',
      };
    }
    return { url: 'https://www.delta.com/mytrips', deepLink: false, airline: 'Delta Air Lines' };
  }

  // === United ===
  if (isAirline(['UA', 'united'])) {
    if (conf && lastName) {
      return {
        url: `https://www.united.com/en/us/manageres/mytrips?confirmationNumber=${encodeURIComponent(conf)}&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'United Airlines',
      };
    }
    return { url: 'https://www.united.com/en/us/manageres/mytrips', deepLink: false, airline: 'United Airlines' };
  }

  // === Southwest ===
  if (isAirline(['WN', 'southwest'])) {
    const firstName = (() => {
      const trimmed = String(booking.passengerName || '').trim();
      if (trimmed.includes(',')) return (trimmed.split(',')[1] || '').trim().split(/\s+/)[0] || '';
      const parts = trimmed.split(/\s+/);
      return parts[0] || '';
    })().toUpperCase();
    if (conf && lastName && firstName) {
      return {
        url: `https://www.southwest.com/air/check-in/index.html?confirmationNumber=${encodeURIComponent(conf)}&firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'Southwest Airlines',
      };
    }
    return { url: 'https://www.southwest.com/air/check-in/', deepLink: false, airline: 'Southwest Airlines' };
  }

  // === JetBlue ===
  if (isAirline(['B6', 'jetblue'])) {
    if (conf && lastName) {
      return {
        url: `https://book.jetblue.com/B6/Manage?confirmationNumber=${encodeURIComponent(conf)}&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'JetBlue Airways',
      };
    }
    return { url: 'https://www.jetblue.com/manage-trips', deepLink: false, airline: 'JetBlue Airways' };
  }

  // === Alaska ===
  if (isAirline(['AS', 'alaska'])) {
    if (conf && lastName) {
      return {
        url: `https://www.alaskaair.com/booking/reservation-lookup?confirmationCode=${encodeURIComponent(conf)}&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'Alaska Airlines',
      };
    }
    return { url: 'https://www.alaskaair.com/manage', deepLink: false, airline: 'Alaska Airlines' };
  }

  // === Spirit ===
  if (isAirline(['NK', 'spirit'])) {
    if (conf && lastName) {
      return {
        url: `https://www.spirit.com/CheckIn?recordLocator=${encodeURIComponent(conf)}&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'Spirit Airlines',
      };
    }
    return { url: 'https://www.spirit.com/check-in', deepLink: false, airline: 'Spirit Airlines' };
  }

  // === Frontier ===
  if (isAirline(['F9', 'frontier'])) {
    if (conf && lastName) {
      return {
        url: `https://www.flyfrontier.com/travel/my-trips/check-in/?confirmationCode=${encodeURIComponent(conf)}&lastName=${encodeURIComponent(lastName)}`,
        deepLink: true,
        airline: 'Frontier Airlines',
      };
    }
    return { url: 'https://www.flyfrontier.com/travel/my-trips/', deepLink: false, airline: 'Frontier Airlines' };
  }

  // === Hawaiian ===
  if (isAirline(['HA', 'hawaiian'])) {
    return {
      url: 'https://www.hawaiianairlines.com/manage-flights',
      deepLink: false,
      airline: 'Hawaiian Airlines',
    };
  }

  // === Allegiant ===
  if (isAirline(['G4', 'allegiant'])) {
    return {
      url: 'https://www.allegiantair.com/manage-travel',
      deepLink: false,
      airline: 'Allegiant Air',
    };
  }

  // === International common carriers (homepage fallback) ===
  if (isAirline(['AC', 'air canada'])) {
    return { url: 'https://www.aircanada.com/us/en/aco/home/manage.html', deepLink: false, airline: 'Air Canada' };
  }
  if (isAirline(['BA', 'british airways'])) {
    return { url: 'https://www.britishairways.com/travel/managebooking/public/en_us', deepLink: false, airline: 'British Airways' };
  }
  if (isAirline(['LH', 'lufthansa'])) {
    return { url: 'https://www.lufthansa.com/us/en/manage-my-booking', deepLink: false, airline: 'Lufthansa' };
  }
  if (isAirline(['AF', 'air france'])) {
    return { url: 'https://www.airfrance.us/manage-booking', deepLink: false, airline: 'Air France' };
  }
  if (isAirline(['KL', 'klm'])) {
    return { url: 'https://www.klm.com/travel/us_en/prepare_for_travel/manage_my_booking/index.htm', deepLink: false, airline: 'KLM' };
  }
  if (isAirline(['EK', 'emirates'])) {
    return { url: 'https://www.emirates.com/us/english/manage-booking/manage-booking.aspx', deepLink: false, airline: 'Emirates' };
  }
  if (isAirline(['QR', 'qatar'])) {
    return { url: 'https://www.qatarairways.com/en-us/manage-booking.html', deepLink: false, airline: 'Qatar Airways' };
  }

  // === Unknown airline — no link available ===
  return null;
}

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
  // If we have no address parts, fall back to hotel name + city
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
 * Returns null if no phone number.
 */
export function buildHotelPhoneUrl(booking) {
  if (!booking?.phone) return null;
  // Strip non-digit chars except leading +
  const clean = String(booking.phone).replace(/[^\d+]/g, '');
  if (!clean) return null;
  return `tel:${clean}`;
}
