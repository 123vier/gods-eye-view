// Keyless location search proxy: request validation, hit normalization, cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geocodeSearchProxy,
  geocodeSearchRequest,
  normalizeGeocodeHit,
} from '../../server/providers/geocode.js';

function installed(options) {
  const plugin = geocodeSearchProxy(options);
  let handler = null;
  plugin.configureServer({ middlewares: { use(path, fn) { if (path === '/api/geocode/search') handler = fn; } } });
  return { plugin, handler };
}

async function call(handler, url, method = 'GET') {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; },
  };
  await handler({ method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}

test('geocode search requires a bounded query and sanitizes the language', () => {
  assert.equal(geocodeSearchRequest(new URLSearchParams('q=')), null);
  assert.equal(geocodeSearchRequest(new URLSearchParams(`q=${'x'.repeat(201)}`)), null);
  assert.deepEqual(geocodeSearchRequest(new URLSearchParams('q=Paris&lang=de-DE')), { query: 'Paris', language: 'de-DE' });
  assert.deepEqual(geocodeSearchRequest(new URLSearchParams('q=Paris&lang=<script>')), { query: 'Paris', language: 'en' });
});

test('normalized hits keep only numeric coordinates and framing fields', () => {
  assert.equal(normalizeGeocodeHit({ lat: 'x', lon: '1' }), null);
  assert.deepEqual(
    normalizeGeocodeHit({
      lat: '50.03', lon: '8.57', category: 'aeroway', type: 'aerodrome', addresstype: 'aeroway',
      importance: 0.58, display_name: 'Flughafen Frankfurt am Main', boundingbox: ['50.01', '50.06', '8.53', '8.61'],
      licence: 'ignored', osm_id: 1,
    }),
    {
      lat: 50.03, lon: 8.57, category: 'aeroway', type: 'aerodrome', addresstype: 'aeroway',
      importance: 0.58, displayName: 'Flughafen Frankfurt am Main', boundingbox: [50.01, 50.06, 8.53, 8.61],
    },
  );
});

test('geocode proxy installs in dev and preview, queries Nominatim once, then serves the cache', async () => {
  const urls = [];
  const { plugin, handler } = installed({
    fetchJson: async (url) => {
      urls.push(url);
      return [{ lat: '48.8584', lon: '2.2945', category: 'man_made', type: 'tower', display_name: 'Tour Eiffel' }];
    },
  });
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  const first = await call(handler, '/api/geocode/search?q=Eiffel%20Tower&lang=fr');
  assert.equal(first.status, 200);
  assert.equal(first.json.results[0].displayName, 'Tour Eiffel');
  assert.match(urls[0], /^https:\/\/nominatim\.openstreetmap\.org\/search\?q=Eiffel\+Tower&format=jsonv2&limit=5&accept-language=fr$/);
  const second = await call(handler, '/api/geocode/search?q=eiffel%20tower&lang=fr');
  assert.equal(second.headers['X-Geocode-Search'], 'HIT');
  assert.equal(urls.length, 1);
});

test('geocode proxy rejects bad requests and reports upstream failure as 503', async () => {
  const { handler } = installed({ fetchJson: async () => { throw new Error('down'); } });
  assert.equal((await call(handler, '/api/geocode/search?q=x', 'POST')).status, 405);
  assert.equal((await call(handler, '/api/geocode/search')).status, 400);
  assert.equal((await call(handler, '/api/geocode/search?q=nowhere-unique-123')).status, 503);
});
