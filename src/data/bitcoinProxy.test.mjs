import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIGHTNING_TOP_NODES,
  MERCHANT_MAX_RESULTS,
  merchantCategory,
  normalizeBitnodesCoordinates,
  normalizeBtcMapPlaces,
  normalizeLightningChannels,
  normalizeLightningWorld,
  normalizeMeetups,
  parseMerchantBox,
  selectMerchantsInBox,
} from '../../server/providers/bitcoin/normalize.js';
import { createCachedFeed, fetchUpstreamJson } from '../../server/providers/bitcoin/feed.js';

const pubkey = (n) => n.toString(16).padStart(66, '0');

test('Lightning nodes are merged per geolocated point with summed capacity', () => {
  const rows = [
    [8.5437, 47.3643, pubkey(1), 'hub-a', 400e8, 500, {}, 'CH'],
    [8.5437, 47.3643, pubkey(2), 'hub-b', 100e8, 50, {}, 'CH'],
    [8.5437, 47.3643, pubkey(3), 'small', 1e8, 2, {}, 'CH'],
    [8.5437, 47.3643, pubkey(4), 'tiny', 0, 0, {}, 'CH'],
    [-97.822, 37.751, pubkey(5), 'ACINQ', 365e8, 1841, {}, 'US'],
    [200, 37, pubkey(6), 'bad-lon', 1, 1, {}, 'XX'],
    [1, 2, 'not-a-pubkey', 'bad-key', 1, 1, {}, 'XX'],
    'garbage',
  ];
  const result = normalizeLightningWorld({ nodes: rows });
  assert.equal(result.nodeCount, 5);
  assert.equal(result.locations.length, 2);
  const [zurich, us] = result.locations;
  assert.equal(zurich.nodeCount, 4);
  assert.equal(zurich.capacitySat, 501e8);
  assert.equal(zurich.channels, 552);
  assert.equal(zurich.country, 'CH');
  assert.equal(zurich.top.length, LIGHTNING_TOP_NODES);
  assert.deepEqual(zurich.top.map((node) => node.alias), ['hub-a', 'hub-b', 'small']);
  assert.equal(us.nodeCount, 1);
  assert.equal(us.lat, 37.751);
  assert.equal(us.lon, -97.822);
});

test('Lightning payload without a nodes array is rejected, not cached as empty', () => {
  assert.throws(() => normalizeLightningWorld({ error: 'down' }), /no nodes array/);
});

test('Bitnodes coordinates are [lat, lon] pairs, de-duplicated and validated', () => {
  const result = normalizeBitnodesCoordinates({
    timestamp: 1790495654,
    total_nodes: 25377,
    coordinates: [[-45.0226, 168.7289], [-45.0226, 168.7289], [95, 0], ['x', 1], null, [null, 13], [52.5, 13.4]],
  });
  assert.equal(result.totalNodes, 25377);
  assert.equal(result.snapshotAt, 1790495654 * 1000);
  assert.deepEqual(result.locations.map(({ lat, lon }) => [lat, lon]), [[-45.0226, 168.7289], [52.5, 13.4]]);
  assert.throws(() => normalizeBitnodesCoordinates({ nodes: {} }), /no coordinates array/);
});

test('BTC Map places drop deleted and invalid rows and keep only card fields', () => {
  const places = normalizeBtcMapPlaces([
    { id: 1, lat: 40.94, lon: -74.2, name: 'LibertyX Bitcoin ATM', icon: 'local_atm', address: '1762 Ratzer Road', website: 'https://libertyx.com', osm_id: 'node:1' },
    { id: 2, lat: 3.07, lon: 101.67, name: '  Cafe  ', icon: 'local_cafe', website: 'javascript:alert(1)', verified_at: '2023-03-13' },
    { id: 3, lat: 1, lon: 1, name: 'Gone', icon: 'store', deleted_at: '2024-01-01' },
    { id: 4, lat: 999, lon: 1, name: 'Bad', icon: 'store' },
    { id: 'x', lat: 1, lon: 1, name: 'Bad id', icon: 'store' },
    { id: 5, lat: 1, lon: 1, icon: 'question_mark' },
  ]);
  assert.deepEqual(places.map((place) => place.id), [1, 2, 5]);
  assert.equal(places[0].atm, true);
  assert.equal(places[0].category, 'atm');
  assert.equal(places[1].name, 'Cafe');
  assert.equal(places[1].category, 'cafe');
  assert.equal(places[1].website, '', 'only http(s) links reach the client');
  assert.equal(places[1].verifiedAt, '2023-03-13');
  assert.equal(places[2].name, 'Unnamed place');
  assert.equal(places[2].category, 'other');
  assert.equal('osm_id' in places[0], false);
  assert.equal(merchantCategory('lunch_dining'), 'fast food');
  assert.equal(merchantCategory('palette'), 'art');
  assert.equal(merchantCategory('car_repair'), 'car repair');
  assert.equal(merchantCategory('local_grocery_store'), 'grocery store');
  assert.throws(() => normalizeBtcMapPlaces({}), /not an array/);
});

test('merchant viewport query must be a finite box of at most 10° per side', () => {
  const params = (obj) => new URLSearchParams(obj);
  assert.deepEqual(
    parseMerchantBox(params({ south: '47', west: '8', north: '48', east: '9' })),
    { south: 47, west: 8, north: 48, east: 9 },
  );
  assert.equal(parseMerchantBox(params({ south: '40', west: '0', north: '51', east: '5' })), null, 'too tall');
  assert.equal(parseMerchantBox(params({ south: '40', west: '0', north: '45', east: '10.2' })), null, 'too wide');
  assert.equal(parseMerchantBox(params({ south: '48', west: '8', north: '47', east: '9' })), null, 'inverted');
  assert.equal(parseMerchantBox(params({ south: '47', west: '8', north: '48' })), null, 'missing');
  assert.equal(parseMerchantBox(params({ south: 'NaN', west: '8', north: '48', east: '9' })), null);
  assert.equal(parseMerchantBox(params({ south: '-91', west: '8', north: '-85', east: '9' })), null);
});

test('merchants in a box are returned nearest-first and capped with the true total', () => {
  const places = [];
  for (let i = 0; i < 50; i += 1) places.push({ id: i, lat: 10 + i * 0.01, lon: 20 });
  places.push({ id: 999, lat: 30, lon: 20 });
  const box = { south: 9, west: 19, north: 11, east: 21 };
  const all = selectMerchantsInBox(places, box);
  assert.equal(all.total, 50);
  assert.equal(all.truncated, false);
  const capped = selectMerchantsInBox(places, box, 5);
  assert.equal(capped.total, 50);
  assert.equal(capped.truncated, true);
  // Box centre is lat 10: the five lowest-latitude places are nearest.
  assert.deepEqual(capped.places.map((place) => place.id), [0, 1, 2, 3, 4]);
  assert.equal(MERCHANT_MAX_RESULTS, 1000);
});

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    async writeFile(file, text) { files.set(file, text); },
    async mkdir() {},
  };
}

function quietFeed(options) {
  const warn = console.warn;
  console.warn = () => {};
  const feed = createCachedFeed(options);
  return {
    feed,
    async get() {
      console.warn = () => {};
      try { return await feed.get(); } finally { console.warn = warn; }
    },
    restore() { console.warn = warn; },
  };
}

test('cached feed serves fresh data, coalesces refreshes and persists to disk', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const fs = memoryFs();
  const { get, restore } = quietFeed({
    name: 'test-feed',
    ttlMs: 60_000,
    retryCooldownMs: 10_000,
    cacheDir: '/cache',
    now: () => clock,
    fs,
    load: async () => { calls += 1; await Promise.resolve(); return { value: calls }; },
  });
  try {
    const [a, b] = await Promise.all([get(), get()]);
    assert.equal(calls, 1, 'concurrent requests share one upstream pass');
    assert.deepEqual(a.data, { value: 1 });
    assert.equal(a.stale, false);
    assert.equal(b.data.value, 1);
    assert.ok(fs.files.has('/cache/test-feed.json'));
    clock += 59_000;
    assert.equal((await get()).data.value, 1);
    assert.equal(calls, 1, 'no upstream call inside the TTL');
    clock += 2_000;
    assert.equal((await get()).data.value, 2);
  } finally {
    restore();
  }
});

test('a fresh disk cache survives a restart without any upstream call', async () => {
  const fs = memoryFs({ '/cache/nodes.json': JSON.stringify({ at: 5_000, data: { locations: [] } }) });
  let calls = 0;
  const feed = createCachedFeed({
    name: 'nodes',
    ttlMs: 24 * 3600_000,
    retryCooldownMs: 3 * 3600_000,
    cacheDir: '/cache',
    now: () => 10_000,
    fs,
    load: async () => { calls += 1; return {}; },
  });
  const entry = await feed.get();
  assert.equal(calls, 0);
  assert.equal(entry.at, 5_000);
  assert.equal(entry.stale, false);
});

test('a failed refresh serves stale data and cools down before the next attempt', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const { get, restore } = quietFeed({
    name: 'cooldown',
    ttlMs: 1_000,
    retryCooldownMs: 10_000,
    cacheDir: '/cache',
    now: () => clock,
    fs: memoryFs(),
    load: async () => {
      calls += 1;
      if (fail) throw Object.assign(new Error('HTTP 429'), { retryAfterMs: 30_000 });
      return { ok: true };
    },
  });
  try {
    await get();
    fail = true;
    clock = 2_000;
    const stale = await get();
    assert.equal(stale.stale, true);
    assert.equal(stale.data.ok, true);
    assert.equal(calls, 2);
    clock = 20_000;
    await get();
    assert.equal(calls, 2, 'Retry-After (30 s) outranks the 10 s cooldown');
    clock = 33_000;
    fail = false;
    const fresh = await get();
    assert.equal(calls, 3);
    assert.equal(fresh.stale, false);
  } finally {
    restore();
  }
});

test('a synchronously failing load does not pin later refreshes', async () => {
  let clock = 0;
  let calls = 0;
  const { get, restore } = quietFeed({
    name: 'sync-fail',
    ttlMs: 1_000,
    retryCooldownMs: 100,
    cacheDir: '/cache',
    now: () => clock,
    fs: memoryFs(),
    load: () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return Promise.resolve({ ok: true });
    },
  });
  try {
    assert.equal(await get(), null, 'no cache and a failed upstream yields null');
    clock = 500;
    const entry = await get();
    assert.equal(calls, 2);
    assert.equal(entry.data.ok, true);
  } finally {
    restore();
  }
});

test('upstream fetch reports HTTP errors with Retry-After for the cooldown', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
  try {
    await assert.rejects(
      fetchUpstreamJson('https://example.test', undefined, 1000, async () => ({})),
      (err) => err.message === 'HTTP 429' && err.retryAfterMs === 120_000,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Lightning channels merge per undirected location pair and skip same-point channels', () => {
  const ash = [-77.4903, 39.0469];
  const ore = [-119.705, 45.8401];
  const nue = [11.0783, 49.4527];
  const row = (aliasA, [lonA, latA], aliasB, [lonB, latB]) => [pubkey(1), aliasA, lonA, latA, pubkey(2), aliasB, lonB, latB];
  const result = normalizeLightningChannels([
    row('acinq', ash, 'bfx', ore),
    row('bfx', ore, 'acinq', ash),
    row('bfx', ore, 'other', ash),
    row('lnd', ore, 'kraken', nue),
    row('same', ore, 'same2', ore),
    row('bad', [500, 1], 'x', ore),
    'garbage',
  ]);
  assert.equal(result.channelCount, 5);
  assert.equal(result.sameLocation, 1);
  assert.equal(result.links.length, 2);
  const [busy, single] = result.links;
  assert.equal(busy.channels, 3, 'both directions collapse onto one link');
  assert.deepEqual([busy.a.lat, busy.b.lat].sort(), [39.0469, 45.8401]);
  const oreEnd = busy.a.lat === 45.8401 ? busy.a : busy.b;
  assert.deepEqual(oreEnd.aliases, ['bfx']);
  const ashEnd = busy.a.lat === 39.0469 ? busy.a : busy.b;
  assert.deepEqual(ashEnd.aliases, ['acinq', 'other']);
  assert.equal(single.channels, 1);
  assert.throws(() => normalizeLightningChannels({}), /not an array/);
});

test('meetup activity comes from the event calendar: recent or upcoming within 6 months', () => {
  const now = Date.UTC(2026, 8, 27);
  const day = 24 * 3600_000;
  const portal = (slug) => `https://portal.einundzwanzig.space/de/meetup/${slug}`;
  const meetup = (id, slug, extra = {}) => ({
    id, name: `Meetup ${slug}`, city: slug, country: 'de', latitude: 50, longitude: 8 + id,
    portalLink: portal(slug), url: 'https://t.me/x', website: 'javascript:alert(1)', nostr: 'npub1x', next_event: null, ...extra,
  });
  const event = (slug, offsetDays, extra = {}) => ({
    'meetup.portalLink': portal(slug), start_iso: new Date(now + offsetDays * day).toISOString(), ...extra,
  });
  const result = normalizeMeetups([
    meetup(1, 'recent'),
    meetup(2, 'stale'),
    meetup(3, 'upcoming'),
    meetup(4, 'far-future'),
    meetup(5, 'never'),
    meetup(6, 'no-coords', { latitude: null }),
    meetup(7, 'null-island', { latitude: 0, longitude: 0 }),
  ], [
    event('recent', -30), event('recent', -400),
    event('stale', -200),
    event('upcoming', 10, { osm_name: 'Kleine Burg' }), event('upcoming', 40),
    event('far-future', 3000),
    { 'meetup.portalLink': portal('recent'), start_iso: 'not a date' },
  ], now);
  const byCity = Object.fromEntries(result.meetups.map((m) => [m.city, m]));
  assert.deepEqual(Object.keys(byCity), ['recent', 'stale', 'upcoming', 'far-future', 'never']);
  assert.equal(byCity.recent.active, true);
  assert.equal(byCity.recent.lastEventAt, now - 30 * day, 'the latest past event wins');
  assert.equal(byCity.stale.active, false);
  assert.equal(byCity.upcoming.active, true);
  assert.deepEqual(byCity.upcoming.nextEvent, { at: now + 10 * day, venue: 'Kleine Burg' });
  assert.equal(byCity['far-future'].active, false, 'a placeholder years ahead does not count');
  assert.equal(byCity['far-future'].nextEvent, null);
  assert.equal(byCity.never.active, false);
  assert.equal(result.activeCount, 2);
  assert.equal(byCity.recent.country, 'DE');
  assert.equal(byCity.recent.links.website, '', 'only http(s) links pass');
  assert.equal(byCity.recent.links.chat, 'https://t.me/x');
});

test('meetups still map with unknown activity when the event feed is unavailable', () => {
  const now = Date.UTC(2026, 8, 27);
  const result = normalizeMeetups([{
    id: 1, name: 'Oldenburg', city: 'Oldenburg', country: 'DE', latitude: 53.1, longitude: 8.2,
    portalLink: 'https://portal.einundzwanzig.space/de/meetup/oldenburg',
    next_event: { start: '2026-10-02T16:00:00.000000Z', location: 'Kleine Burg' },
  }], null, now);
  assert.equal(result.activeCount, null);
  assert.equal(result.meetups[0].active, null);
  assert.deepEqual(result.meetups[0].nextEvent, { at: Date.UTC(2026, 9, 2, 16), venue: 'Kleine Burg' });
  assert.throws(() => normalizeMeetups({}, null, now), /not an array/);
});
