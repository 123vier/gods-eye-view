import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import bitcoinLayers, {
  BITCOIN_LIGHTNING_LAYER_ID,
  BITCOIN_MERCHANTS_LAYER_ID,
  BITCOIN_NODES_LAYER_ID,
  MERCHANT_VIEWPORT_MAX_DEGREES,
  boxContains,
  createBitcoinPointLayer,
  boltHeight,
  formatBtc,
  lightningPixelSize,
  lightningRecord,
  meetupRecord,
  merchantRecord,
  merchantRequestBox,
  nodeRecord,
} from './bitcoinLayers.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

test('the three layers are registered with share-link tokens', () => {
  assert.deepEqual(
    bitcoinLayers.map((layer) => layer.id),
    [BITCOIN_LIGHTNING_LAYER_ID, 'bitcoin-channels', BITCOIN_NODES_LAYER_ID, BITCOIN_MERCHANTS_LAYER_ID, 'bitcoin-meetups'],
  );
  for (const layer of bitcoinLayers) {
    assert.ok(LAYER_STATE_REGISTRY.some((entry) => entry.id === layer.id), layer.id);
    for (const method of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats']) {
      assert.equal(typeof layer[method], 'function', `${layer.id}.${method}`);
    }
  }
});

test('BTC amounts and Lightning point sizes stay readable across magnitudes', () => {
  assert.equal(formatBtc(0), '0 BTC');
  assert.equal(formatBtc(5_200_000), '0.052 BTC');
  assert.equal(formatBtc(12.34e8), '12.3 BTC');
  assert.equal(formatBtc(1204.4e8), '1,204 BTC');
  assert.equal(lightningPixelSize(0), 4);
  assert.ok(lightningPixelSize(1e8) > 4);
  assert.ok(lightningPixelSize(100e8) > lightningPixelSize(1e8));
  assert.equal(lightningPixelSize(1e15), 14);
  assert.equal(boltHeight(0), 22);
  assert.equal(boltHeight(1e15), 42);
});

test('cards say what the data is and is not', () => {
  const hub = lightningRecord({
    id: '47.3643,8.5437', lat: 47.3643, lon: 8.5437, country: 'CH',
    nodeCount: 3, capacitySat: 501e8, channels: 552,
    top: [{ alias: 'hub-a', pubkey: 'a'.repeat(66) }, { alias: '', pubkey: 'b'.repeat(66) }],
  });
  assert.equal(hub.title, '3 Lightning nodes');
  assert.equal(hub.details[0], '501 BTC · 552 channels · CH');
  assert.equal(hub.details[1], 'Top: hub-a, bbbbbbbbbb…');
  assert.match(hub.details.at(-1), /IP-geolocated/);

  const single = lightningRecord({ id: 'x', lat: 0, lon: 0, nodeCount: 1, capacitySat: 0, channels: 0, top: [{ alias: 'solo', pubkey: 'c'.repeat(66) }] });
  assert.equal(single.title, 'solo');
  assert.equal(single.details.length, 2, 'no "Top" line for a single node');

  const node = nodeRecord({ id: '1,2', lat: 1, lon: 2 });
  assert.match(node.details.join(' '), /Tor/);

  const atm = merchantRecord({ id: 7, lat: 1, lon: 2, name: 'ATM', category: 'atm', atm: true, address: 'Main St 1' });
  assert.equal(atm.id, '7');
  assert.deepEqual(atm.details, ['Bitcoin ATM · unverified', 'Main St 1']);
  const cafe = merchantRecord({ id: 8, lat: 1, lon: 2, name: 'Cafe', category: 'cafe', atm: false, openingHours: 'Mo-Fr 08-16', verifiedAt: '2025-01-02' });
  assert.deepEqual(cafe.details, ['Cafe · verified 2025-01-02', 'Mo-Fr 08-16']);
  assert.notEqual(atm.color, cafe.color);
});

test('merchant request box pads the view but never exceeds the proxy limit', () => {
  assert.equal(merchantRequestBox(null), null);
  assert.equal(merchantRequestBox({ south: 0, west: 0, north: 11, east: 1 }), null, 'zoom in');
  assert.equal(merchantRequestBox({ south: 0, west: 170, north: 1, east: -170 }), null, 'antimeridian');
  const small = merchantRequestBox({ south: 47, west: 8, north: 48, east: 9 });
  assert.ok(small.south < 47 && small.north > 48 && small.west < 8 && small.east > 9);
  const big = merchantRequestBox({ south: 40, west: 0, north: 49.5, east: 9.5 });
  assert.ok(big.north - big.south <= MERCHANT_VIEWPORT_MAX_DEGREES + 1e-9);
  assert.ok(big.east - big.west <= MERCHANT_VIEWPORT_MAX_DEGREES + 1e-9);
  const polar = merchantRequestBox({ south: 85, west: 0, north: 89.9, east: 5 });
  assert.ok(polar.north <= 90);
  assert.equal(boxContains(small, { south: 47.2, west: 8.2, north: 47.8, east: 8.8 }), true);
  assert.equal(boxContains(small, { south: 46, west: 8.2, north: 47.8, east: 8.8 }), false);
});

function fakeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    raise() { for (const fn of [...listeners]) fn(); },
  };
}

function fakeViewer(viewRectangle) {
  const primitives = new Set();
  return {
    primitives,
    scene: {
      canvas: {},
      primitives: { add(p) { primitives.add(p); return p; }, remove(p) { return primitives.delete(p); } },
      preRender: fakeEvent(),
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick: () => null,
    },
    camera: {
      // Above the equator/prime meridian, 20,000 km up.
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 2.0e7),
      moveEnd: fakeEvent(),
      computeViewRectangle: () => viewRectangle(),
    },
  };
}

function fakeHandlerFactory() {
  const handlers = [];
  const factory = () => {
    const handler = {
      action: null,
      destroyed: false,
      setInputAction(fn) { this.action = fn; },
      destroy() { this.destroyed = true; },
    };
    handlers.push(handler);
    return handler;
  };
  return { handlers, factory };
}

function withWindow(fn) {
  const real = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  return Promise.resolve(fn(events)).finally(() => { globalThis.window = real; });
}

function overlayRecorder() {
  const calls = [];
  return {
    calls,
    setEntries: (id, entries) => calls.push(['set', id, entries.map((entry) => entry.title)]),
    setVisible: (id, visible) => calls.push(['visible', id, visible]),
    clearSource: (id) => calls.push(['clear', id]),
  };
}

test('global layer loads once, culls the far side, and selects a clicked point', () => withWindow(async (events) => {
  const requests = [];
  const overlay = overlayRecorder();
  const { handlers, factory } = fakeHandlerFactory();
  const layer = createBitcoinPointLayer({
    id: 'btc-test', name: 'Test', icon: 'T', source: 'test', route: 'nodes', mode: 'global',
    refreshInterval: 3600_000,
    toRecords: (payload) => payload.locations.map(nodeRecord),
    summary: (payload) => `${payload.locations.length} locations`,
  }, {
    overlayHost: overlay,
    screenSpaceEventHandlerFactory: factory,
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(JSON.stringify({
        fetchedAt: 1, stale: false,
        // One point under the camera, one on the far side of the Earth.
        locations: [{ id: 'near', lat: 0, lon: 0 }, { id: 'far', lat: 0, lon: 180 }],
      }), { status: 200 });
    },
  });
  const viewer = fakeViewer(() => null);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.deepEqual(requests, ['/api/bitcoin/nodes']);
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.status, 'ready');
  assert.equal(stats.loadingLabel, '2 locations');

  const [collection] = viewer.primitives;
  const near = collection.get(0);
  const far = collection.get(1);
  assert.equal(near.show, true);
  assert.equal(far.show, false, 'far-side point is hidden by the horizon pass');

  await layer.update();
  assert.equal(requests.length, 1, 'a recent snapshot is not re-fetched');

  const click = handlers[0].action;
  viewer.scene.pick = () => ({ collection, primitive: near, id: 'btc-test:near' });
  click({ position: {} });
  assert.deepEqual(overlay.calls.at(-1), ['set', 'btc-test-selected', ['Bitcoin full node location']]);
  assert.ok(events.includes('gev:entity-selected'));

  viewer.scene.pick = () => null;
  click({ position: {} });
  assert.deepEqual(overlay.calls.at(-1), ['clear', 'btc-test-selected']);

  layer.disable();
  assert.equal(collection.show, false);
  assert.equal(handlers[0].destroyed, true);
  assert.equal(viewer.camera.moveEnd.listeners.size, 0);
  assert.equal(viewer.scene.preRender.listeners.size, 0);
  layer.destroy(viewer);
  assert.equal(viewer.primitives.size, 0);
}));

test('viewport layer asks to zoom in, then loads only the padded view', () => withWindow(async () => {
  const requests = [];
  let view = { south: 0, west: 0, north: 30, east: 30 };
  const toRad = (box) => box && new Cesium.Rectangle(
    Cesium.Math.toRadians(box.west), Cesium.Math.toRadians(box.south),
    Cesium.Math.toRadians(box.east), Cesium.Math.toRadians(box.north),
  );
  const layer = createBitcoinPointLayer({
    id: 'btc-view-test', name: 'Test', icon: 'T', source: 'test', route: 'merchants', mode: 'viewport',
    toRecords: (payload) => payload.places.map(merchantRecord),
    summary: (payload) => `${payload.places.length} places in view`,
  }, {
    overlayHost: overlayRecorder(),
    screenSpaceEventHandlerFactory: fakeHandlerFactory().factory,
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(JSON.stringify({
        fetchedAt: 1, stale: false, total: 1, truncated: false,
        places: [{ id: 1, lat: 47.5, lon: 8.5, name: 'Cafe', category: 'cafe', atm: false }],
      }), { status: 200 });
    },
  });
  const viewer = fakeViewer(() => toRad(view));
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(requests.length, 0);
  assert.equal(layer.getStats().status, 'zoom-in');
  assert.match(layer.getStats().loadingLabel, /zoom in/);

  view = { south: 47, west: 8, north: 48, east: 9 };
  await layer.update();
  assert.equal(requests.length, 1);
  const query = new URL(requests[0], 'http://local').searchParams;
  assert.ok(Number(query.get('south')) < 47 && Number(query.get('north')) > 48);
  assert.equal(layer.getStats().count, 1);

  view = { south: 47.3, west: 8.3, north: 47.7, east: 8.7 };
  await layer.update();
  assert.equal(requests.length, 1, 'zooming into a complete answer re-uses it');

  view = { south: 0, west: 0, north: 30, east: 30 };
  await layer.update();
  assert.equal(layer.getStats().count, 0, 'zooming out clears viewport points');
  layer.destroy(viewer);
}));

test('an upstream failure is reported and clears on the next successful update', () => withWindow(async () => {
  let fail = false;
  const layer = createBitcoinPointLayer({
    id: 'btc-fail-test', name: 'Test', icon: 'T', source: 'test', route: 'lightning', mode: 'global',
    refreshInterval: 0,
    toRecords: (payload) => payload.locations.map(nodeRecord),
    summary: () => 'ok',
  }, {
    overlayHost: overlayRecorder(),
    screenSpaceEventHandlerFactory: fakeHandlerFactory().factory,
    fetchImpl: async () => (fail
      ? new Response(JSON.stringify({ error: 'upstream unavailable and no cache available' }), { status: 502 })
      : new Response(JSON.stringify({ locations: [{ id: 'a', lat: 0, lon: 0 }] }), { status: 200 })),
  });
  const viewer = fakeViewer(() => null);
  layer.init(viewer);
  layer.enable();
  fail = true;
  await layer.update();
  assert.equal(layer.getStats().status, 'unavailable');
  assert.match(layer.getStats().error, /upstream unavailable/);
  fail = false;
  await layer.update();
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);
  layer.destroy(viewer);
}));

test('icon layers draw billboards and swap to the highlighted icon on selection', () => withWindow(async () => {
  const handlers = fakeHandlerFactory();
  const overlay = overlayRecorder();
  const layer = createBitcoinPointLayer({
    id: 'btc-icon-test', name: 'Test', icon: 'T', source: 'test', route: 'lightning', mode: 'global',
    refreshInterval: 3600_000,
    markerImages: () => ({ normal: 'data:image/png;base64,normal', selected: 'data:image/png;base64,selected' }),
    toRecords: (payload) => payload.locations.map(lightningRecord),
    summary: () => 'ok',
  }, {
    overlayHost: overlay,
    screenSpaceEventHandlerFactory: handlers.factory,
    fetchImpl: async () => new Response(JSON.stringify({
      locations: [{ id: 'hub', lat: 0, lon: 0, nodeCount: 2, capacitySat: 100e8, channels: 10, top: [] }],
    }), { status: 200 }),
  });
  const viewer = fakeViewer(() => null);
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const [collection] = viewer.primitives;
  assert.ok(collection instanceof Cesium.BillboardCollection);
  const bolt = collection.get(0);
  assert.equal(bolt.image, 'data:image/png;base64,normal');
  assert.ok(bolt.height > 10 && bolt.width < bolt.height, 'a bolt is taller than wide');

  viewer.scene.pick = () => ({ collection, primitive: bolt, id: 'btc-icon-test:hub' });
  handlers.handlers[0].action({ position: {} });
  assert.equal(bolt.image, 'data:image/png;base64,selected');
  assert.equal(bolt.scale, 1.5);
  viewer.scene.pick = () => null;
  handlers.handlers[0].action({ position: {} });
  assert.equal(bolt.image, 'data:image/png;base64,normal');
  assert.equal(bolt.scale, 1);
  layer.destroy(viewer);
}));

test('meetup cards show place, next or last meetup, and activity; inactive badges fade', () => {
  const base = { id: 11, lat: 53.1, lon: 8.2, name: 'Einundzwanzig Oldenburg', city: 'Oldenburg', country: 'DE', links: { portal: 'https://p' } };
  const upcoming = meetupRecord({ ...base, active: true, lastEventAt: Date.UTC(2026, 7, 30), nextEvent: { at: Date.UTC(2026, 9, 2, 16), venue: 'Kleine Burg' } }, 'UTC');
  assert.equal(upcoming.id, '11');
  assert.equal(upcoming.title, 'Einundzwanzig Oldenburg');
  assert.deepEqual(upcoming.details, ['Oldenburg, DE', 'Next: 2 Oct 2026, 16:00 · Kleine Burg', 'Active · met or meets within 6 months']);
  assert.equal(upcoming.markerKey, 'normal');
  assert.equal(upcoming.properties.nextEvent.at, '2026-10-02T16:00:00.000Z');

  const dormant = meetupRecord({ ...base, active: false, lastEventAt: Date.UTC(2025, 0, 15), nextEvent: null }, 'UTC');
  assert.deepEqual(dormant.details, ['Oldenburg, DE', 'Last meetup: 15 Jan 2025', 'Inactive · no meetup within 6 months']);
  assert.equal(dormant.markerKey, 'inactive');
  assert.ok(dormant.markerWidth < upcoming.markerWidth);

  const unknown = meetupRecord({ ...base, active: null, lastEventAt: null, nextEvent: null }, 'UTC');
  assert.deepEqual(unknown.details, ['Oldenburg, DE', 'Activity unknown']);
  assert.equal(unknown.markerKey, 'normal');
});
