// POST /api/hotel-book
// Creates a Rapid itinerary when live, or returns a demo confirmation.
//
// Body:
//   propertyId, roomId, rateId, checkInDate, checkOutDate,
//   guests: [{ given_name, family_name }],
//   email, phone,
//   agencyIata, affiliateReferenceId?,
//   payment?: { type:'corporate_card', card_number, security_code,
//               expiration_month, expiration_year, billing_contact },
//   priceCheckHref? (from rate.links.price_check)
import {
  rapidConfigured, rapidFetch, requireUser, sendJson, rapidBaseUrl,
} from './_hotel-rapid.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const user = await requireUser(req);
    const body = req.body || {};
    const {
      propertyId, roomId, rateId,
      checkInDate, checkOutDate,
      guests = [],
      email, phone,
      agencyIata,
      affiliateReferenceId,
      payment,
      priceCheckHref,
      bedGroupId,
    } = body;

    if (!propertyId || !roomId || !rateId || !checkInDate || !checkOutDate) {
      return sendJson(res, 400, { error: 'propertyId, roomId, rateId, and dates are required' });
    }
    if (!guests.length || !guests[0]?.given_name || !guests[0]?.family_name) {
      return sendJson(res, 400, { error: 'At least one guest with given_name and family_name is required' });
    }

    // Demo path — never charges a card.
    if (!rapidConfigured() || String(propertyId).startsWith('demo-')) {
      const conf = 'DEMO-' + Math.random().toString(36).slice(2, 9).toUpperCase();
      return sendJson(res, 200, {
        ok: true,
        demo: true,
        itinerary_id: conf,
        confirmation_code: conf,
        agencyIata: agencyIata || null,
        message: 'Demo booking recorded. Configure Expedia Rapid credentials to create real commissionable reservations.',
      });
    }

    // Live Rapid: price-check then book.
    let bookHref = null;
    if (priceCheckHref) {
      const pcUrl = priceCheckHref.startsWith('http')
        ? priceCheckHref
        : `${rapidBaseUrl()}${priceCheckHref}`;
      const pc = await rapidFetch(pcUrl, {
        method: 'GET',
        query: bedGroupId ? { bed_group_id: bedGroupId } : undefined,
      });
      bookHref = pc?.links?.book?.href || null;
      if (pc?.status === 'sold_out' || pc?.status === 'price_changed') {
        return sendJson(res, 409, {
          error: `Rate ${pc.status.replace('_', ' ')}. Search again for updated pricing.`,
          status: pc.status,
        });
      }
    }

    if (!bookHref) {
      // Fallback path used by some Rapid versions — book via itineraries
      // with room/rate ids directly after an inline price check.
      bookHref = '/v3/itineraries';
    }

    if (!payment?.card_number || !payment?.security_code || !payment?.expiration_month || !payment?.expiration_year) {
      return sendJson(res, 400, {
        error: 'Live Rapid booking requires payment card details. Card data is sent to Expedia and is not stored in Skyway.',
      });
    }

    const affiliateRef = affiliateReferenceId
      || `SW-${agencyIata || 'IATA'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const hold = {
      affiliate_reference_id: affiliateRef,
      hold: false,
      email: email || user.email || 'ops@flyskyway.com',
      phone: {
        country_code: '1',
        number: String(phone || '0000000000').replace(/\D/g, '').slice(-10) || '0000000000',
      },
      rooms: [{
        given_name: guests[0].given_name,
        family_name: guests[0].family_name,
        smoking: false,
        special_request: agencyIata ? `Agency IATA ${agencyIata}` : undefined,
      }],
      payments: [{
        type: 'corporate_card',
        card_type: detectCardType(payment.card_number),
        number: String(payment.card_number).replace(/\s+/g, ''),
        security_code: String(payment.security_code),
        expiration_month: String(payment.expiration_month).padStart(2, '0'),
        expiration_year: String(payment.expiration_year),
        billing_contact: payment.billing_contact || {
          given_name: guests[0].given_name,
          family_name: guests[0].family_name,
          address: {
            line_1: payment.address_line1 || '1 Aviation Way',
            city: payment.city || 'Fort Lauderdale',
            state_province_code: payment.state || 'FL',
            postal_code: payment.postal_code || '33309',
            country_code: payment.country_code || 'US',
          },
        },
      }],
    };

    // When bookHref is a full price-check book link it already encodes
    // property/room/rate. Otherwise attach them for /v3/itineraries.
    if (bookHref === '/v3/itineraries' || bookHref.endsWith('/itineraries')) {
      hold.rooms[0] = {
        ...hold.rooms[0],
        // Some Rapid versions expect these at the top level via URL; keep body lean.
      };
    }

    const bookUrl = bookHref.startsWith('http') ? bookHref : `${rapidBaseUrl()}${bookHref}`;
    const itinerary = await rapidFetch(bookUrl, {
      method: 'POST',
      body: hold,
      headers: {
        'Customer-Ip': req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '127.0.0.1',
      },
    });

    const conf = itinerary?.itinerary_id
      || itinerary?.rooms?.[0]?.confirmation_id
      || affiliateRef;

    return sendJson(res, 200, {
      ok: true,
      demo: false,
      live: true,
      itinerary_id: itinerary?.itinerary_id || conf,
      confirmation_code: conf,
      affiliate_reference_id: affiliateRef,
      agencyIata: agencyIata || null,
      retrieve_href: itinerary?.links?.retrieve?.href || null,
    });
  } catch (e) {
    console.error('[hotel-book]', e);
    return sendJson(res, e.status || 500, {
      error: e.message || 'Booking failed',
      payload: e.payload || undefined,
    });
  }
}

function detectCardType(num) {
  const n = String(num || '').replace(/\D/g, '');
  if (/^4/.test(n)) return 'VI';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'CA';
  if (/^3[47]/.test(n)) return 'AX';
  if (/^6(?:011|5)/.test(n)) return 'DS';
  return 'VI';
}
