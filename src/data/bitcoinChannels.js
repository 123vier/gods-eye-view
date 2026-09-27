import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

/**
 * Lightning channels as arcs between geolocated node locations
 * (mempool.space `channels-geo`, merged per location pair by
 * `/api/bitcoin/channels`).
 *
 * All arcs are ONE static Cesium.Primitive: built once in Cesium's workers,
 * then drawn in a single batch with no per-frame work. Arcs are ordinary
 * depth-tested geometry, so the visible hemisphere hides the ones behind the
 * Earth without a horizon pass.
 */

export const BITCOIN_CHANNELS_LAYER_ID = 'bitcoin-channels';

const ARC_COLOR = '#b98cff';
const SELECTED_COLOR = '#ffffff';
/** Peak arc height as a share of the surface distance, and its ceiling. */
const ARC_HEIGHT_RATIO = 0.06;
const ARC_MAX_HEIGHT_M = 8.0e5;
/** Arcs never rise less than this, so short links clear terrain. */
const ARC_MIN_HEIGHT_M = 3000;
const ARC_MIN_SEGMENTS = 6;
const ARC_MAX_SEGMENTS = 32;
const ARC_SEGMENT_LENGTH_M = 250_000;
const READY_POLL_MS = 150;
const READY_POLL_LIMIT = 200;

const SELECTED_OVERLAY_ID = `${BITCOIN_CHANNELS_LAYER_ID}-selected`;
const SELECTED_OVERLAY_OPTIONS = Object.freeze({ cohortLimit: 1, collisionCapacity: 0, moving: false });

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const geodesicScratch = new Cesium.EllipsoidGeodesic();
const cartographicScratch = new Cesium.Cartographic();

/**
 * Lifted great-circle arc between two points.
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {{positions: Array<Cesium.Cartesian3>, apex: Cesium.Cartesian3, distanceM: number}}
 */
export function channelArc(a, b) {
  const start = Cesium.Cartographic.fromDegrees(a.lon, a.lat, 0);
  const end = Cesium.Cartographic.fromDegrees(b.lon, b.lat, 0);
  geodesicScratch.setEndPoints(start, end);
  const distanceM = geodesicScratch.surfaceDistance;
  const peak = Math.max(ARC_MIN_HEIGHT_M, Math.min(ARC_MAX_HEIGHT_M, distanceM * ARC_HEIGHT_RATIO));
  const segments = Math.max(
    ARC_MIN_SEGMENTS,
    Math.min(ARC_MAX_SEGMENTS, Math.ceil(distanceM / ARC_SEGMENT_LENGTH_M)),
  );
  const positions = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const point = geodesicScratch.interpolateUsingFraction(t, cartographicScratch);
    positions.push(Cesium.Cartesian3.fromRadians(
      point.longitude,
      point.latitude,
      peak * Math.sin(Math.PI * t),
    ));
  }
  return { positions, apex: positions[Math.floor(segments / 2)], distanceM };
}

/**
 * Line opacity by channel count. Thousands of single-channel links overlap,
 * so they stay near-transparent and only busy links read at full strength.
 * @param {number} channels
 * @returns {number} Alpha in [0.08, 0.85].
 */
export function channelAlpha(channels) {
  const count = Math.max(1, Number(channels) || 1);
  return Math.min(0.85, 0.08 + 0.11 * Math.log2(count));
}

/**
 * Card copy for one link.
 * @param {object} link Normalized proxy record.
 * @param {number} distanceM
 * @returns {{title:string, details:Array<string>}}
 */
export function channelCard(link, distanceM) {
  const count = Number(link.channels) || 0;
  const end = (side) => (side?.aliases?.length ? side.aliases.join(', ') : 'unnamed nodes');
  return {
    title: `${count} Lightning channel${count === 1 ? '' : 's'}`,
    details: [
      `${end(link.a)} ↔ ${end(link.b)}`,
      `≈ ${Math.round(distanceM / 1000).toLocaleString('en-US')} km · IP-geolocated sample`,
    ],
  };
}

/**
 * Create the Lightning channels layer.
 * @param {object} [deps] Test seams.
 * @returns {object} Data layer implementing the manager contract.
 */
export function createBitcoinChannelsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = (...args) => globalThis.fetch(...args),
  screenSpaceEventHandlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  const id = BITCOIN_CHANNELS_LAYER_ID;
  const name = 'Lightning Channels';
  const source = 'mempool.space';
  const refreshInterval = 60 * 60_000;

  const state = {
    viewer: null,
    primitive: null,
    /** @type {Map<string, {link: object, apex: Cesium.Cartesian3, distanceM: number, color: Cesium.Color}>} */
    links: new Map(),
    enabled: false,
    loading: false,
    abort: null,
    error: null,
    stale: false,
    status: 'idle',
    statusLabel: '',
    lastUpdate: null,
    fetchedAt: null,
    selectedId: null,
    clickHandler: null,
    readyTimer: null,
  };

  const pickId = (linkId) => `${id}:${linkId}`;

  function requestRender(reason) {
    governorRequestRender(`${id}-${reason}`);
  }

  function setInstanceColor(key, color) {
    const primitive = state.primitive;
    if (!primitive?.ready) return;
    const attributes = primitive.getGeometryInstanceAttributes(key);
    if (attributes) attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color, attributes.color);
  }

  function clearSelection({ notify = true } = {}) {
    if (!state.selectedId) return;
    const entry = state.links.get(state.selectedId);
    if (entry) setInstanceColor(state.selectedId, entry.color);
    state.selectedId = null;
    overlayHost.clearSource(SELECTED_OVERLAY_ID);
    if (notify) clearSelectedEntityContextForLayer(id);
    removeEntityContextsForLayer(id);
    requestRender('deselect');
  }

  /**
   * Card anchor: the arc vertex drawn closest to the click, so a long arc's
   * card appears where the user pointed rather than at a far-away apex.
   */
  function anchorNear(entry, screenPosition) {
    const scene = state.viewer?.scene;
    if (!screenPosition || typeof scene?.cartesianToCanvasCoordinates !== 'function') return entry.apex;
    let best = entry.apex;
    let bestDistance = Infinity;
    for (const position of channelArc(entry.link.a, entry.link.b).positions) {
      const canvas = scene.cartesianToCanvasCoordinates(position);
      if (!canvas) continue;
      const distance = Math.hypot(canvas.x - screenPosition.x, canvas.y - screenPosition.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = position;
      }
    }
    return best;
  }

  function select(key, screenPosition = null) {
    const entry = state.links.get(key);
    if (!entry) return false;
    if (state.selectedId && state.selectedId !== key) clearSelection();
    state.selectedId = key;
    setInstanceColor(key, Cesium.Color.fromCssColorString(SELECTED_COLOR));
    const card = channelCard(entry.link, entry.distanceM);
    overlayHost.setEntries(SELECTED_OVERLAY_ID, [{
      id: key,
      position: anchorNear(entry, screenPosition),
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER,
      title: card.title,
      details: card.details,
      accent: ARC_COLOR,
      interactive: false,
      anchorRadiusPx: 6,
      minAnchorGapPx: 11,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    }], SELECTED_OVERLAY_OPTIONS);
    const carrier = { id: key };
    const apex = Cesium.Cartographic.fromCartesian(entry.apex);
    registerEntityContext(carrier, {
      id: key,
      layerId: id,
      layerName: name,
      source,
      label: card.title,
      latitude: Number(Cesium.Math.toDegrees(apex.latitude).toFixed(6)),
      longitude: Number(Cesium.Math.toDegrees(apex.longitude).toFixed(6)),
      properties: {
        channels: entry.link.channels,
        distanceKm: Math.round(entry.distanceM / 1000),
        endA: entry.link.a,
        endB: entry.link.b,
      },
    });
    selectEntityContext(carrier);
    requestRender('select');
    return true;
  }

  function removePrimitive() {
    clearInterval(state.readyTimer);
    state.readyTimer = null;
    if (state.primitive && state.viewer) state.viewer.scene.primitives.remove(state.primitive);
    state.primitive = null;
  }

  /**
   * An asynchronous primitive only advances while frames render, and the
   * render governor idles a parked camera. Keep asking for frames until the
   * workers deliver, then stop.
   */
  function pumpUntilReady(primitive) {
    let polls = 0;
    clearInterval(state.readyTimer);
    state.readyTimer = setInterval(() => {
      polls += 1;
      if (state.primitive !== primitive || primitive.ready || polls > READY_POLL_LIMIT) {
        clearInterval(state.readyTimer);
        state.readyTimer = null;
        if (state.primitive === primitive && primitive.ready && state.selectedId) {
          setInstanceColor(state.selectedId, Cesium.Color.fromCssColorString(SELECTED_COLOR));
        }
      }
      requestRender('build');
    }, READY_POLL_MS);
  }

  function build(links) {
    clearSelection({ notify: false });
    removePrimitive();
    state.links.clear();
    const instances = [];
    for (const link of links) {
      const key = pickId(link.id);
      if (state.links.has(key)) continue;
      const { positions, apex, distanceM } = channelArc(link.a, link.b);
      const color = Cesium.Color.fromCssColorString(ARC_COLOR).withAlpha(channelAlpha(link.channels));
      state.links.set(key, { link, apex, distanceM, color });
      instances.push(new Cesium.GeometryInstance({
        id: key,
        geometry: new Cesium.PolylineGeometry({
          positions,
          width: 1.0,
          arcType: Cesium.ArcType.NONE,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
      }));
    }
    if (!instances.length) return;
    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: true,
      // Geometry never changes after the build; keep only the GPU copy.
      releaseGeometryInstances: true,
      show: state.enabled,
    });
    state.primitive = state.viewer.scene.primitives.add(primitive);
    pumpUntilReady(primitive);
  }

  async function load({ force = false } = {}) {
    if (!state.enabled || !state.viewer) return;
    if (!force && state.links.size && state.lastUpdate
      && Date.now() - state.lastUpdate < refreshInterval / 2) return;
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.loading = true;
    try {
      const response = await fetchImpl(`/api/bitcoin/channels`, { signal: abort.signal });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* non-JSON error body */
      }
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (abort.signal.aborted || !state.enabled) return;
      const fetchedAt = Number(payload?.fetchedAt) || null;
      // An unchanged upstream snapshot keeps the already-built primitive.
      if (!state.primitive || fetchedAt !== state.fetchedAt) {
        build(Array.isArray(payload?.links) ? payload.links : []);
      }
      state.error = null;
      state.stale = payload?.stale === true;
      state.fetchedAt = fetchedAt;
      state.lastUpdate = Date.now();
      state.status = state.stale ? 'stale' : 'ready';
      const channels = Number(payload?.channelCount) || 0;
      state.statusLabel = `${state.links.size.toLocaleString('en-US')} links · ${channels.toLocaleString('en-US')} channels (sample)`;
      requestRender('load');
    } catch (error) {
      if (error?.name === 'AbortError' || abort.signal.aborted) return;
      state.error = error?.message || 'unavailable';
      state.status = state.links.size ? 'stale' : 'unavailable';
    } finally {
      if (state.abort === abort) {
        state.abort = null;
        state.loading = false;
      }
    }
  }

  function installClickHandler(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
    state.clickHandler.setInputAction((click) => {
      if (!state.enabled) return;
      const picked = viewer.scene.pick(click.position);
      const key = picked?.primitive === state.primitive && typeof picked.id === 'string' ? picked.id : null;
      if (key && state.links.has(key)) {
        if (key !== state.selectedId) select(key, click.position);
        return;
      }
      if (state.selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  return {
    id,
    name,
    icon: '〰',
    source,
    updateInterval: 0,
    refreshInterval,

    init(viewer) {
      state.viewer = viewer;
    },

    enable() {
      state.enabled = true;
      if (state.primitive) state.primitive.show = true;
      overlayHost.setVisible(SELECTED_OVERLAY_ID, true);
      registerPickOwner(id, (picked) => state.links.has(picked));
      installClickHandler(state.viewer);
      requestRender('enable');
      // The manager calls update() right after enable(); it owns the first load.
    },

    disable() {
      state.enabled = false;
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      clearSelection();
      unregisterPickOwner(id);
      state.clickHandler?.destroy();
      state.clickHandler = null;
      overlayHost.setVisible(SELECTED_OVERLAY_ID, false);
      if (state.primitive) state.primitive.show = false;
      state.status = 'idle';
      requestRender('disable');
    },

    update() {
      return load();
    },

    destroy() {
      this.disable();
      overlayHost.clearSource(SELECTED_OVERLAY_ID);
      removePrimitive();
      state.links.clear();
      state.viewer = null;
    },

    getStats() {
      return {
        count: state.links.size,
        lastUpdate: state.lastUpdate,
        fetchedAt: state.fetchedAt,
        stale: state.stale,
        error: state.error,
        status: state.status,
        loading: state.loading,
        loadingLabel: state.loading ? 'loading…' : state.statusLabel,
      };
    },
  };
}

export default createBitcoinChannelsLayer();
