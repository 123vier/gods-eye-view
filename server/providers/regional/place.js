import { fetchRegionalJson } from './http.js';
import { normalizeRegionalPlace } from '../../../src/data/regionalBrief.js';

let _nominatimQueue = Promise.resolve();

let _nominatimLastRequestAt = 0;

const NOMINATIM_HEADERS = Object.freeze({
  'User-Agent':
    'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
  Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
});

/**
 * Fetch a Nominatim URL through the shared process-wide queue so every caller
 * (cockpit reverse lookups and location search) stays within the public
 * instance's one-request-per-second usage policy.
 * @param {string} url
 * @returns {Promise<unknown>} Parsed JSON payload.
 */
function fetchNominatimJson(url) {
  const task = _nominatimQueue.then(async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - _nominatimLastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    _nominatimLastRequestAt = Date.now();
    return fetchRegionalJson(url, { headers: NOMINATIM_HEADERS });
  });
  _nominatimQueue = task.catch(() => null);
  return task;
}

async function fetchRegionalPlace(point) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: point.latitude.toFixed(5),
    lon: point.longitude.toFixed(5),
    zoom: '10',
    addressdetails: '1',
    'accept-language': 'en',
  });
  const payload = await fetchNominatimJson(
    `https://nominatim.openstreetmap.org/reverse?${params}`,
  );
  return normalizeRegionalPlace(payload);
}

export { fetchNominatimJson, fetchRegionalPlace };
