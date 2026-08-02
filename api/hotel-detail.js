// POST /api/hotel-detail
// Body: { propertyId, checkInDate, checkOutDate, occupancyAdults?, defaultCommissionPct? }
import {
  rapidConfigured, rapidFetch, requireUser, sendJson,
  nightsBetween, normalizeRate,
} from './_hotel-rapid.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    await requireUser(req);
    const {
      propertyId, checkInDate, checkOutDate,
      occupancyAdults = 1,
      defaultCommissionPct = 10,
    } = req.body || {};

    if (!propertyId || !checkInDate || !checkOutDate) {
      return sendJson(res, 400, { error: 'propertyId, checkInDate, and checkOutDate are required' });
    }

    if (!rapidConfigured() || String(propertyId).startsWith('demo-')) {
      return sendJson(res, 200, { ok: true, demo: true, useClientDemo: true, property: null, rooms: null });
    }

    const nights = nightsBetween(checkInDate, checkOutDate);
    const occupancy = String(Math.max(1, Math.min(4, Number(occupancyAdults) || 1)));

    const [availability, content] = await Promise.all([
      rapidFetch('/v3/properties/availability', {
        query: {
          checkin: checkInDate,
          checkout: checkOutDate,
          currency: 'USD',
          country_code: 'US',
          language: 'en-US',
          occupancy,
          property_id: propertyId,
          sales_channel: 'agent_tool',
          sales_environment: 'hotel_only',
          rate_plan_count: 8,
          include: 'rooms.rates.marketing_fee_incentives',
        },
      }),
      rapidFetch('/v3/properties/content', {
        query: {
          language: 'en-US',
          supply_source: 'expedia',
          property_id: propertyId,
        },
      }).catch(() => ({})),
    ]);

    const avail = (Array.isArray(availability) ? availability : [])[0] || {};
    const c = content?.[propertyId] || content || {};
    const rooms = (avail.rooms || []).map((room) => ({
      room_id: room.id,
      room_name: room.room_name || c?.rooms?.[room.id]?.name || 'Room',
      bed_groups: room.bed_groups || [],
      max_occupancy: room.occupancy || { total: Number(occupancy) },
      rates: (room.rates || [])
        .filter((r) => r.status === 'available' || !r.status)
        .map((r) => normalizeRate(r, { defaultCommissionPct, nights })),
    })).filter((r) => r.rates.length > 0);

    const property = {
      property_id: String(propertyId),
      name: c.name || `Property ${propertyId}`,
      brand: c.brand?.name || c.chain?.name || null,
      address: {
        line_1: c.address?.line_1 || '',
        city: c.address?.city || '',
        state_province_code: c.address?.state_province_code || '',
        postal_code: c.address?.postal_code || '',
        country_code: c.address?.country_code || 'US',
      },
      star_rating: c.ratings?.property?.rating || null,
      guest_rating: c.ratings?.guest?.overall || null,
      amenities: (c.amenities ? Object.values(c.amenities).map((a) => a.name) : []).slice(0, 12),
      images: (c.images || []).slice(0, 6).map((img) => ({
        caption: img.caption || '',
        url: img.links?.['1000px']?.href || img.links?.['350px']?.href || null,
      })).filter((i) => i.url),
      phone: c.phone || null,
    };

    return sendJson(res, 200, { ok: true, demo: false, live: true, property, rooms, nights });
  } catch (e) {
    console.error('[hotel-detail]', e);
    return sendJson(res, e.status || 500, {
      error: e.message || 'Hotel detail failed',
      useClientDemo: true,
      demo: true,
    });
  }
}
