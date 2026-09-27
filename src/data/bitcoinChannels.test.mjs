import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  BITCOIN_CHANNELS_LAYER_ID,
  channelAlpha,
  channelArc,
  channelCard,
  createBitcoinChannelsLayer,
} from './bitcoinChannels.js';

test('arcs start and end on the surface and peak at mid-span', () => {
  const a = { lat: 39.0469, lon: -77.4903 };
  const b = { lat: 45.8401, lon: -119.705 };
  const { positions, apex, distanceM } = channelArc(a, b);
  assert.ok(distanceM > 3.5e6 && distanceM < 4.0e6, `Ashburn–Oregon ≈ 3,700 km, got ${distanceM}`);
  const first = Cesium.Cartographic.fromCartesian(positions[0]);
  const last = Cesium.Cartographic.fromCartesian(positions.at(-1));
  assert.ok(Math.abs(first.height) < 1 && Math.abs(last.height) < 1);
  assert.ok(Math.abs(Cesium.Math.toDegrees(first.latitude) - a.lat) < 1e-6);
  assert.ok(Math.abs(Cesium.Math.toDegrees(last.longitude) - b.lon) < 1e-6);
  const peak = Cesium.Cartographic.fromCartesian(apex).height;
  assert.ok(Math.abs(peak - distanceM * 0.06) < 5000, `apex ≈ 6 % of span, got ${peak}`);
  assert.equal(positions.length, Math.ceil(distanceM / 250_000) + 1, 'one segment per 250 km');

  const long = channelArc({ lat: 0, lon: 0 }, { lat: 0, lon: 170 });
  assert.equal(long.positions.length, 33, 'segment count is capped');
  assert.ok(Cesium.Cartographic.fromCartesian(long.apex).height <= 8.0e5 + 1);
  const short = channelArc({ lat: 47.37, lon: 8.54 }, { lat: 47.38, lon: 8.55 });
  assert.equal(short.positions.length, 7, 'short arcs keep a minimum smoothness');
  assert.ok(Cesium.Cartographic.fromCartesian(short.apex).height >= 2999);
});

test('busy links read stronger and cards name both ends', () => {
  assert.equal(channelAlpha(1), 0.08);
  assert.ok(channelAlpha(8) > channelAlpha(2));
  assert.equal(channelAlpha(1e9), 0.85);
  const card = channelCard({ channels: 188, a: { aliases: ['ACINQ', 'x'] }, b: { aliases: [] } }, 3_812_345);
  assert.equal(card.title, '188 Lightning channels');
  assert.deepEqual(card.details, ['ACINQ, x ↔ unnamed nodes', '≈ 3,812 km · IP-geolocated sample']);
  assert.equal(channelCard({ channels: 1, a: {}, b: {} }, 1000).title, '1 Lightning channel');
});

function fakeViewer() {
  const primitives = new Set();
  return {
    primitives,
    scene: {
      canvas: {},
      primitives: { add(p) { primitives.add(p); return p; }, remove(p) { return primitives.delete(p); } },
      pick: () => null,
    },
  };
}

test('layer builds one primitive, reuses it for an unchanged snapshot, and selects a clicked arc', async () => {
  const real = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  const overlay = [];
  const anchors = [];
  const handlers = [];
  let fetchedAt = 1;
  let requests = 0;
  const payload = () => ({
    fetchedAt,
    stale: false,
    channelCount: 4,
    links: [
      { id: 'p1', a: { lat: 39, lon: -77, aliases: ['acinq'] }, b: { lat: 45, lon: -119, aliases: ['bfx'] }, channels: 3 },
      { id: 'p2', a: { lat: 47, lon: 8, aliases: [] }, b: { lat: 49, lon: 11, aliases: [] }, channels: 1 },
    ],
  });
  const layer = createBitcoinChannelsLayer({
    overlayHost: {
      setEntries: (sourceId, entries) => { overlay.push(['set', sourceId, entries[0].title]); anchors.push(entries[0].position); },
      setVisible: () => {},
      clearSource: (sourceId) => overlay.push(['clear', sourceId]),
    },
    screenSpaceEventHandlerFactory: () => {
      const handler = { setInputAction(fn) { this.action = fn; }, destroy() { this.destroyed = true; } };
      handlers.push(handler);
      return handler;
    },
    fetchImpl: async (url) => {
      requests += 1;
      assert.equal(url, '/api/bitcoin/channels');
      return new Response(JSON.stringify(payload()), { status: 200 });
    },
  });
  try {
    const viewer = fakeViewer();
    layer.init(viewer);
    layer.enable();
    await layer.update();
    assert.equal(layer.id, BITCOIN_CHANNELS_LAYER_ID);
    assert.equal(viewer.primitives.size, 1);
    const [primitive] = viewer.primitives;
    assert.ok(primitive instanceof Cesium.Primitive);
    assert.equal(primitive.show, true);
    const stats = layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.loadingLabel, '2 links · 4 channels (sample)');

    // A due refresh with the same upstream snapshot keeps the built primitive.
    await layer.update();
    assert.equal(requests, 1, 'recent data is not re-fetched');

    handlers[0].action({ position: {} });
    viewer.scene.pick = () => ({ primitive, id: `${BITCOIN_CHANNELS_LAYER_ID}:p1` });
    // Project each vertex to x = its longitude, so a click at x = -77 is
    // nearest the arc's Ashburn end rather than its mid-span apex.
    viewer.scene.cartesianToCanvasCoordinates = (position) => ({
      x: Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(position).longitude),
      y: 0,
    });
    handlers[0].action({ position: { x: -77, y: 0 } });
    const start = channelArc({ lat: 39, lon: -77 }, { lat: 45, lon: -119 }).positions[0];
    assert.ok(Cesium.Cartesian3.equalsEpsilon(anchors.at(-1), start, 0, 1), 'card anchors at the clicked end');
    assert.deepEqual(overlay.at(-1), ['set', `${BITCOIN_CHANNELS_LAYER_ID}-selected`, '3 Lightning channels']);
    assert.ok(events.includes('gev:entity-selected'));

    layer.disable();
    assert.equal(primitive.show, false);
    assert.equal(handlers[0].destroyed, true);
    assert.deepEqual(overlay.at(-1), ['clear', `${BITCOIN_CHANNELS_LAYER_ID}-selected`]);
    layer.destroy();
    assert.equal(viewer.primitives.size, 0);
  } finally {
    globalThis.window = real;
  }
});
