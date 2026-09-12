import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { coalesceProxyRequest } from './common/http.js';
import { fetchNominatimJson } from './regional/place.js';

// ---------------------------------------------------------------------------
// Keyless location search proxy (OpenStreetMap Nominatim)
// ---------------------------------------------------------------------------
// The Location search box uses Google Geocoding when a Google Maps key is
// configured. Without one it resolves names here: server-side so requests carry
// an identifying User-Agent and share the one-request-per-second Nominatim queue
// with the cockpit briefing, as the public instance's usage policy requires.

const GEOCODE_SEARCH_CACHE_MS = 24 * 60 * 60_000;

const GEOCODE_SEARCH_MAX_CACHE = 200;

const GEOCODE_SEARCH_MAX_QUERY = 200;

const GEOCODE_SEARCH_LIMIT = 5;

const _geocodeSearchCache = new Map();

const _geocodeSearchInFlight = new Map();

const _geocodeSearchRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 20,
  globalMax: 60,
});

/**
 * Keep only the fields the client framing needs from a Nominatim hit.
 * @param {object} hit - Raw `format=jsonv2` search result.
 * @returns {object|null}
 */
function normalizeGeocodeHit(hit) {
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    category: String(hit.category ?? hit.class ?? ''),
    type: String(hit.type ?? ''),
    addresstype: String(hit.addresstype ?? ''),
    importance: Number.isFinite(Number(hit.importance))
      ? Number(hit.importance)
      : 0,
    displayName: String(hit.display_name ?? ''),
    boundingbox: Array.isArray(hit.boundingbox)
      ? hit.boundingbox.slice(0, 4).map(Number)
      : null,
  };
}

/**
 * Validate the `q` and optional `lang` search params.
 * @param {URLSearchParams} params
 * @returns {{query: string, language: string}|null}
 */
function geocodeSearchRequest(params) {
  const query = String(params.get('q') || '').trim();
  if (!query || query.length > GEOCODE_SEARCH_MAX_QUERY) return null;
  const rawLanguage = String(params.get('lang') || '').trim();
  const language = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(rawLanguage)
    ? rawLanguage
    : 'en';
  return { query, language };
}

function trimGeocodeSearchCache() {
  while (_geocodeSearchCache.size > GEOCODE_SEARCH_MAX_CACHE) {
    const oldest = _geocodeSearchCache.keys().next().value;
    if (oldest === undefined) break;
    _geocodeSearchCache.delete(oldest);
  }
}

function geocodeSearchProxy({ fetchJson = fetchNominatimJson } = {}) {
  async function refresh({ query, language }, key) {
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: String(GEOCODE_SEARCH_LIMIT),
      'accept-language': language,
    });
    const payload = await fetchJson(
      `https://nominatim.openstreetmap.org/search?${params}`,
    );
    const results = (Array.isArray(payload) ? payload : [])
      .map(normalizeGeocodeHit)
      .filter(Boolean);
    _geocodeSearchCache.set(key, { results, cachedAt: Date.now() });
    trimGeocodeSearchCache();
    return results;
  }

  function install(middlewares) {
    middlewares.use('/api/geocode/search', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_geocodeSearchRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const request = geocodeSearchRequest(
        new URL(req.url || '', 'http://localhost').searchParams,
      );
      if (!request) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A search query is required' }));
        return;
      }
      const key = `${request.language}|${request.query.toLowerCase()}`;
      const cached = _geocodeSearchCache.get(key);
      if (cached && Date.now() - cached.cachedAt <= GEOCODE_SEARCH_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Geocode-Search': 'HIT',
        });
        res.end(JSON.stringify({ results: cached.results }));
        return;
      }
      const inFlight = coalesceProxyRequest(_geocodeSearchInFlight, key, () =>
        refresh(request, key),
      );
      try {
        const results = await inFlight.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Geocode-Search': inFlight.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify({ results }));
      } catch {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Location search is temporarily unavailable',
          }),
        );
      }
    });
  }

  return {
    name: 'geocode-search-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { geocodeSearchProxy, geocodeSearchRequest, normalizeGeocodeHit };
