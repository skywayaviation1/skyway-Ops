// POST /api/hotel-search
// Body: { airportCode, checkInDate, checkOutDate, occupancyAdults?, agencyIata?, defaultCommissionPct? }
import {
  rapidConfigured, rapidFetch, requireUser, sendJson,
  propertyIdsForAirport, nightsBetween, normalizeRate,
} from './_hotel-rapid.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    await requireUser(req);
    const {
      airportCode, checkInDate, checkOutDate,
      occupancyAdults = 1,
      defaultCommissionPct = 10,
    } = req.body || {};

    if (!airportCode || !checkInDate || !checkOutDate) {
      return sendJson(res, 400, { error: 'airportCode, checkInDate, and checkOutDate are required' });
    }

    // No Rapid credentials → tell the client to use local demo inventory.
    if (!rapidConfigured()) {
      return sendJson(res, 200, {
        ok: true,
        demo: true,
        live: false,
        properties: null,
        useClientDemo: true,
        agencyIata: req.body?.agencyIata || null,
      });
    }

    const propertyIds = propertyIdsForAirport(airportCode);
    if (!propertyIds.length) {
      return sendJson(res, 200, {
        ok: true,
        demo: true,
        live: true,
        useClientDemo: true,
        message: `No seeded Rapid property IDs for ${String(airportCode).toUpperCase()} yet — falling back to demo inventory. Add IDs in api/_hotel-rapid.js AIRPORT_PROPERTY_SEED.`,
        properties: null,
      });
    }

    const nights = nightsBetween(checkInDate, checkOutDate);
    const occupancy = String(Math.max(1, Math.min(4, Number(occupancyAdults) || 1)));

    const availability = await rapidFetch('/v3/properties/availability', {
      query: {
        checkin: checkInDate,
        checkout: checkOutDate,
        currency: 'USD',
        country_code: 'US',
        language: 'en-US',
        occupancy,
        property_id: propertyIds,
        sales_channel: 'agent_tool',
        sales_environment: 'hotel_only',
        rate_plan_count: 2,
        include: 'rooms.rates.marketing_fee_incentives',
      },
    });

    // Content for names/addresses
    let contentById = {};
    try {
      const content = await rapidFetch('/v3/properties/content', {
        query: {
          language: 'en-US',
          supply_source: 'expedia',
          property_id: propertyIds,
        },
      });
      contentById = content || {};
    } catch (err) {
      console.warn('[hotel-search] content fetch failed:', err.message);
    }

    const list = Array.isArray(availability) ? availability : [];
    const properties = list.map((avail) => {
      const id = String(avail.property_id);
      const content = contentById[id] || {};
      const rooms = (avail.rooms || []).map((room) => ({
        room_id: room.id,
        room_name: room.room_name || content?.rooms?.[room.id]?.name || 'Room',
        max_occupancy: room.occupancy || { total: Number(occupancy) },
        rates: (room.rates || [])
          .filter((r) => r.status === 'available' || !r.status)
          .map((r) => normalizeRate(r, { defaultCommissionPct, nights })),
      })).filter((r) => r.rates.length > 0);

      const lowest = rooms.flatMap((r) => r.rates).sort((a, b) =>
        (a.nightly_rate?.request_currency?.value || 0) - (b.nightly_rate?.request_currency?.value || 0)
      )[0];

      return {
        property_id: id,
        name: content.name || `Property ${id}`,
        brand: content.brand?.name || content.chain?.name || null,
        address: {
          line_1: content.address?.line_1 || '',
          city: content.address?.city || '',
          state_province_code: content.address?.state_province_code || '',
          postal_code: content.address?.postal_code || '',
          country_code: content.address?.country_code || 'US',
        },
        star_rating: content.ratings?.property?.rating || null,
        guest_rating: content.ratings?.guest?.overall || null,
        amenities: (content.amenities ? Object.values(content.amenities).map((a) => a.name) : []).slice(0, 8),
        images: (content.images || []).slice(0, 3).map((img) => ({
          caption: img.caption || '',
          url: img.links?.['1000px']?.href || img.links?.['350px']?.href || img.href || null,
        })).filter((i) => i.url),
        rooms,
        from_nightly: lowest?.nightly_rate || null,
        from_commission: lowest?.marketing_fee || null,
      };
    }).filter((p) => p.rooms?.length);

    return sendJson(res, 200, {
      ok: true,
      demo: false,
      live: true,
      properties,
      agencyIata: req.body?.agencyIata || null,
      nights,
    });
  } catch (e) {
    console.error('[hotel-search]', e);
    return sendJson(res, e.status || 500, {
      error: e.message || 'Hotel search failed',
      // Soft-fallback so ops can still shop in demo if Rapid errors.
      useClientDemo: true,
      demo: true,
    });
  }
}
