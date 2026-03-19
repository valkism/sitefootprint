// functions/api/places.js — Google Places API (New) proxy
// Uses the modern Places API (New) endpoint: places.googleapis.com/v1/places:searchText
//
// In Google Cloud Console you need:
//   1. "Places API (New)" enabled
//   2. An API key with "Places API (New)" in its allowed APIs
//   3. Billing enabled on the project (required even for free tier)

export async function onRequestPost(context) {
  const { request, env } = context;
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const requestOrigin = request.headers.get('Origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Places-Key',
  };
  if (allowedOrigin !== '*' && requestOrigin && allowedOrigin !== '*') {
    const allowed = allowedOrigin.split(',').map(s => s.trim());
    const originOk = allowed.some(a => requestOrigin.startsWith(a) || a === '*');
    if (!originOk) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }
  }
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON', results: [] }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const userKey = request.headers.get('X-Places-Key');
  const apiKey = userKey || env.GOOGLE_PLACES_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'NO_KEY',
      results: []
    }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const { lat, lon, radius, keyword, locationName } = body;
  if (lat === undefined || lon === undefined) {
    return new Response(JSON.stringify({ error: 'lat and lon required', results: [] }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  try {
    // Places API (New) — Text Search
    // Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
    const place = locationName ? locationName.split(',').slice(0, 2).join(',').trim() : '';
    const textQuery = place
      ? `${keyword || 'local businesses'} in ${place}`
      : `${keyword || 'local businesses'}`;

    const requestBody = {
      textQuery,
      locationBias: {
        circle: {
          center: { latitude: lat, longitude: lon },
          radius: Math.min(Number(radius) || 5000, 50000),
        }
      },
      maxResultCount: 20,
      // Request specific fields — only pay for what you use
      // Basic fields are free, Contact/Atmosphere fields cost more
      // websiteUri is a Basic field — free
    };

    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Field mask — tells Google exactly what data to return
        // Basic fields (free): displayName, id, types, formattedAddress, location, rating, userRatingCount, businessStatus
        // Contact fields (paid): websiteUri, internationalPhoneNumber, regularOpeningHours
        'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.internationalPhoneNumber,places.businessStatus',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await r.json();

    // Handle API errors
    if (!r.ok || data.error) {
      const errMsg = data.error?.message || data.error?.status || `HTTP ${r.status}`;
      const errCode = data.error?.status || 'ERROR';
      console.error('Places API (New) error:', errCode, errMsg);

      const httpStatus = errCode === 'PERMISSION_DENIED' ? 403
        : errCode === 'RESOURCE_EXHAUSTED' ? 429
        : errCode === 'INVALID_ARGUMENT' ? 400
        : 502;

      return new Response(JSON.stringify({
        error: `${errCode}: ${errMsg}`,
        results: [],
      }), { status: httpStatus, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Normalise Places API (New) response to match what the engine expects
    const places = data.places || [];
    const results = places
      .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY')
      .map(p => ({
        place_id: p.id,
        name: p.displayName?.text || '',
        vicinity: p.formattedAddress || '',
        types: p.types || [],
        geometry: {
          location: {
            lat: p.location?.latitude,
            lng: p.location?.longitude,
          }
        },
        rating: p.rating || null,
        user_ratings_total: p.userRatingCount || 0,
        // These come from contact fields — may be undefined if not in field mask
        website: p.websiteUri || null,
        phone: p.internationalPhoneNumber || null,
      }));

    console.log(`Places (New): "${textQuery}" → ${results.length} results`);

    return new Response(JSON.stringify({
      results,
      status: 'OK',
      query: textQuery,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('Places proxy exception:', err.message);
    return new Response(JSON.stringify({ error: err.message, results: [] }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}
