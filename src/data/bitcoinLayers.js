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
import {
  cachedGroundFloor,
  floorAltitudeM,
  resolveGroundFloorCellsBounded,
} from './groundFloor.js';
import { horizonOccluder } from './iconOrientation.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

/**
 * Bitcoin network + economy layers: Lightning node locations (mempool.space),
 * reachable full-node locations (Bitnodes) and places that accept bitcoin
 * (BTC Map). All three are served by the `/api/bitcoin/*` proxy
 * (server/providers/bitcoin.js), which owns the upstream caching.
 *
 * Built for modest hardware: each layer draws ONE PointPrimitiveCollection (a
 * single batched draw), keeps no per-point entities, and registers selection
 * context only for the point the user actually clicks. Merchants are fetched
 * per viewport and capped server-side, so the ~30k-place catalog never reaches
 * the browser.
 */

export const BITCOIN_LIGHTNING_LAYER_ID = 'bitcoin-lightning';
export const BITCOIN_NODES_LAYER_ID = 'bitcoin-nodes';
export const BITCOIN_MERCHANTS_LAYER_ID = 'bitcoin-merchants';

/** Largest viewport (degrees per axis) for which merchants are requested. */
export const MERCHANT_VIEWPORT_MAX_DEGREES = 10;
const MERCHANT_REQUEST_DEBOUNCE_MS = 600;
/** Viewport padding per side, so short pans reuse the last response. */
const MERCHANT_VIEWPORT_PAD_RATIO = 0.2;
const HORIZON_CULL_INTERVAL_MS = 200;

const COLORS = Object.freeze({
  lightning: '#b98cff',
  node: '#f7931a',
  merchant: '#3ddc84',
  atm: '#4dd0e1',
  selected: '#ffffff',
});

const SELECTED_OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Satoshis → short BTC text ("0.052 BTC", "12.3 BTC", "1,204 BTC").
 * @param {number} sat
 * @returns {string}
 */
export function formatBtc(sat) {
  const btc = Number(sat) / 1e8;
  if (!Number.isFinite(btc) || btc <= 0) return '0 BTC';
  if (btc < 1) return `${btc.toFixed(3)} BTC`;
  if (btc < 100) return `${btc.toFixed(1)} BTC`;
  return `${Math.round(btc).toLocaleString('en-US')} BTC`;
}

/**
 * Point size for a Lightning location, log-scaled by its summed capacity so a
 * few hub locations do not dwarf the long tail.
 * @param {number} capacitySat
 * @returns {number} Pixel size in [4, 14].
 */
export function lightningPixelSize(capacitySat) {
  const btc = Math.max(0, Number(capacitySat) / 1e8 || 0);
  return Math.min(14, 4 + 2.2 * Math.log10(1 + btc * 10));
}

/**
 * Lightning location → render/card record.
 * @param {object} location Normalized proxy record.
 * @returns {object}
 */
export function lightningRecord(location) {
  const count = Number(location.nodeCount) || 0;
  const top = Array.isArray(location.top) ? location.top : [];
  const names = top.map((node) => node.alias || `${String(node.pubkey).slice(0, 10)}…`);
  const title = count === 1 ? (names[0] || 'Lightning node') : `${count} Lightning nodes`;
  const summary = [
    formatBtc(location.capacitySat),
    `${Number(location.channels) || 0} channels`,
    location.country,
  ].filter(Boolean).join(' · ');
  const details = [summary];
  if (count > 1 && names.length) details.push(`Top: ${names.join(', ')}`);
  details.push('IP-geolocated · approximate');
  return {
    id: location.id,
    lat: location.lat,
    lon: location.lon,
    color: COLORS.lightning,
    pixelSize: lightningPixelSize(location.capacitySat),
    title,
    details,
    properties: {
      nodeCount: count,
      capacitySat: Number(location.capacitySat) || 0,
      channels: Number(location.channels) || 0,
      country: location.country || null,
      topNodes: top.map((node) => ({ alias: node.alias, pubkey: node.pubkey })),
    },
  };
}

/**
 * Full-node location → render/card record.
 * @param {object} location Normalized proxy record.
 * @returns {object}
 */
export function nodeRecord(location) {
  return {
    id: location.id,
    lat: location.lat,
    lon: location.lon,
    color: COLORS.node,
    pixelSize: 5,
    title: 'Bitcoin full node location',
    details: ['Reachable node(s) · IP-geolocated · approximate', 'Tor nodes have no location and are not shown'],
    properties: {},
  };
}

/**
 * BTC Map place → render/card record.
 * @param {object} place Normalized proxy record.
 * @returns {object}
 */
export function merchantRecord(place) {
  const category = place.atm ? 'Bitcoin ATM' : (place.category || 'other');
  const headline = [
    category.charAt(0).toUpperCase() + category.slice(1),
    place.verifiedAt ? `verified ${place.verifiedAt}` : 'unverified',
  ].join(' · ');
  const details = [headline];
  if (place.address) details.push(place.address);
  else if (place.openingHours) details.push(place.openingHours);
  return {
    id: String(place.id),
    lat: place.lat,
    lon: place.lon,
    color: place.atm ? COLORS.atm : COLORS.merchant,
    pixelSize: place.atm ? 8 : 7,
    title: place.name,
    details,
    properties: {
      btcMapId: place.id,
      category: place.category,
      address: place.address || null,
      website: place.website || null,
      openingHours: place.openingHours || null,
      verifiedAt: place.verifiedAt || null,
    },
  };
}

/**
 * Request box for the current view: the view rectangle padded on every side,
 * or null when the view is wider than the merchant limit or crosses the
 * antimeridian (the user is asked to zoom in).
 * @param {?{south:number, west:number, north:number, east:number}} view Degrees.
 * @returns {?{south:number, west:number, north:number, east:number}}
 */
export function merchantRequestBox(view) {
  if (!view) return null;
  const { south, west, north, east } = view;
  if (![south, west, north, east].every(Number.isFinite)) return null;
  const height = north - south;
  const width = east - west;
  if (height <= 0 || width <= 0) return null;
  if (height > MERCHANT_VIEWPORT_MAX_DEGREES || width > MERCHANT_VIEWPORT_MAX_DEGREES) return null;
  const padLat = Math.min(height * MERCHANT_VIEWPORT_PAD_RATIO, (MERCHANT_VIEWPORT_MAX_DEGREES - height) / 2);
  const padLon = Math.min(width * MERCHANT_VIEWPORT_PAD_RATIO, (MERCHANT_VIEWPORT_MAX_DEGREES - width) / 2);
  return {
    south: Math.max(-90, south - padLat),
    north: Math.min(90, north + padLat),
    west: Math.max(-180, west - padLon),
    east: Math.min(180, east + padLon),
  };
}

/**
 * Whether `inner` lies entirely inside `outer`.
 * @returns {boolean}
 */
export function boxContains(outer, inner) {
  return Boolean(outer && inner)
    && inner.south >= outer.south && inner.north <= outer.north
    && inner.west >= outer.west && inner.east <= outer.east;
}

function viewRectangleDegrees(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  return {
    south: Cesium.Math.toDegrees(rectangle.south),
    west: Cesium.Math.toDegrees(rectangle.west),
    north: Cesium.Math.toDegrees(rectangle.north),
    east: Cesium.Math.toDegrees(rectangle.east),
  };
}

/**
 * Create one Bitcoin point layer.
 * @param {object} config
 * @param {string} config.id
 * @param {string} config.name
 * @param {string} config.icon
 * @param {string} config.source
 * @param {'global'|'viewport'} config.mode Global layers load one snapshot;
 *   viewport layers reload on camera moveEnd.
 * @param {function(object): Array<object>} config.toRecords Payload → render records.
 * @param {function(object): string} config.summary Payload → stats label.
 * @param {number} [config.refreshInterval] Global layers: manager refresh period.
 * @param {boolean} [config.groundClamp] Lift points onto the resolved ground floor.
 * @param {object} [deps] Test seams.
 * @returns {object} Data layer implementing the manager contract.
 */
export function createBitcoinPointLayer(config, {
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = (...args) => globalThis.fetch(...args),
  screenSpaceEventHandlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  const {
    id,
    name,
    icon,
    source,
    mode,
    toRecords,
    summary,
    refreshInterval = 0,
    groundClamp = false,
  } = config;
  const selectedOverlayId = `${id}-selected`;
  const endpoint = `/api/bitcoin/${config.route}`;

  const state = {
    viewer: null,
    points: null,
    /** @type {Map<string, {record: object, point: object}>} pick id → rendered record */
    rendered: new Map(),
    enabled: false,
    loading: false,
    abort: null,
    error: null,
    stale: false,
    status: 'idle',
    statusLabel: '',
    lastUpdate: null,
    fetchedAt: null,
    requestedBox: null,
    requestedComplete: false,
    selectedId: null,
    moveEndRemove: null,
    preRenderRemove: null,
    clickHandler: null,
    debounceTimer: null,
    lastCullAt: 0,
    lastCullPose: null,
  };

  const pickId = (recordId) => `${id}:${recordId}`;

  function requestRender(reason) {
    governorRequestRender(`${id}-${reason}`);
  }

  function clearSelection({ notify = true } = {}) {
    if (!state.selectedId) return;
    const entry = state.rendered.get(state.selectedId);
    if (entry) {
      entry.point.color = Cesium.Color.fromCssColorString(entry.record.color);
      entry.point.pixelSize = entry.record.pixelSize;
    }
    state.selectedId = null;
    overlayHost.clearSource(selectedOverlayId);
    if (notify) clearSelectedEntityContextForLayer(id);
    removeEntityContextsForLayer(id);
    requestRender('deselect');
  }

  function select(key) {
    const entry = state.rendered.get(key);
    if (!entry) return false;
    if (state.selectedId && state.selectedId !== key) clearSelection();
    state.selectedId = key;
    entry.point.color = Cesium.Color.fromCssColorString(COLORS.selected);
    entry.point.pixelSize = entry.record.pixelSize + 4;
    overlayHost.setEntries(selectedOverlayId, [{
      id: key,
      position: entry.point.position,
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER,
      title: entry.record.title,
      details: entry.record.details,
      accent: entry.record.color,
      interactive: false,
      anchorRadiusPx: 9,
      minAnchorGapPx: 11,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    }], SELECTED_OVERLAY_OPTIONS);
    // Selection context lets voice ("what is this?") read the clicked point.
    const carrier = { id: key };
    registerEntityContext(carrier, {
      id: key,
      layerId: id,
      layerName: name,
      source,
      label: entry.record.title,
      latitude: entry.record.lat,
      longitude: entry.record.lon,
      properties: entry.record.properties,
    });
    selectEntityContext(carrier);
    requestRender('select');
    return true;
  }

  function pointHeight(record) {
    if (!groundClamp) return 0;
    return floorAltitudeM(null, cachedGroundFloor(record.lat, record.lon)) ?? 0;
  }

  function render(records) {
    const keepSelected = state.selectedId;
    clearSelection({ notify: false });
    state.points.removeAll();
    state.rendered.clear();
    for (const record of records) {
      const key = pickId(record.id);
      if (state.rendered.has(key)) continue;
      const point = state.points.add({
        id: key,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, pointHeight(record)),
        pixelSize: record.pixelSize,
        color: Cesium.Color.fromCssColorString(record.color),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.2, 2.0e7, 0.6),
        // The Cesium globe is hidden (3D tiles are the planet), so nothing
        // writes far-side depth: points draw on top and the horizon pass
        // below hides the ones behind the Earth.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      state.rendered.set(key, { record, point });
    }
    state.lastCullPose = null;
    cullBehindHorizon(true);
    if (keepSelected && state.rendered.has(keepSelected)) select(keepSelected);
    else if (keepSelected) clearSelectedEntityContextForLayer(id);
    requestRender('render');
  }

  function cullBehindHorizon(force = false) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled || !state.rendered.size) return;
    const now = Date.now();
    if (!force && now - state.lastCullAt < HORIZON_CULL_INTERVAL_MS) return;
    state.lastCullAt = now;
    const camera = viewer.camera;
    const p = camera.positionWC;
    const pose = `${Math.round(p.x / 50)}:${Math.round(p.y / 50)}:${Math.round(p.z / 50)}`;
    if (!force && pose === state.lastCullPose) return;
    state.lastCullPose = pose;
    const occluder = horizonOccluder(camera);
    for (const { point } of state.rendered.values()) {
      const visible = occluder.isPointVisible(point.position) === true;
      if (point.show !== visible) point.show = visible;
    }
  }

  async function fetchPayload(url, abort) {
    const response = await fetchImpl(url, { signal: abort.signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* non-JSON error body */
    }
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return body;
  }

  async function loadGlobal({ force = false } = {}) {
    if (!state.enabled || !state.viewer) return;
    if (!force && state.rendered.size && state.lastUpdate
      && Date.now() - state.lastUpdate < Math.max(60_000, refreshInterval / 2)) return;
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.loading = true;
    try {
      const payload = await fetchPayload(endpoint, abort);
      if (abort.signal.aborted || !state.enabled) return;
      render(toRecords(payload));
      state.error = null;
      state.stale = payload?.stale === true;
      state.fetchedAt = Number(payload?.fetchedAt) || null;
      state.lastUpdate = Date.now();
      state.status = state.stale ? 'stale' : 'ready';
      state.statusLabel = summary(payload);
    } catch (error) {
      if (error?.name === 'AbortError' || abort.signal.aborted) return;
      state.error = error?.message || 'unavailable';
      state.status = state.rendered.size ? 'stale' : 'unavailable';
    } finally {
      if (state.abort === abort) {
        state.abort = null;
        state.loading = false;
      }
    }
  }

  async function loadViewport() {
    if (!state.enabled || !state.viewer) return;
    const view = viewRectangleDegrees(state.viewer);
    const box = merchantRequestBox(view);
    if (!box) {
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      state.requestedBox = null;
      state.requestedComplete = false;
      if (state.rendered.size) {
        clearSelection();
        state.points.removeAll();
        state.rendered.clear();
        requestRender('zoom-out');
      }
      state.error = null;
      state.status = 'zoom-in';
      state.statusLabel = `zoom in to load (≤${MERCHANT_VIEWPORT_MAX_DEGREES}° view)`;
      return;
    }
    // Zooming in within a complete earlier answer needs no new request.
    if (state.requestedComplete && boxContains(state.requestedBox, view)) return;
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.loading = true;
    try {
      const query = new URLSearchParams(
        Object.entries(box).map(([key, value]) => [key, value.toFixed(5)]),
      );
      const payload = await fetchPayload(`${endpoint}?${query}`, abort);
      if (abort.signal.aborted || !state.enabled) return;
      const records = toRecords(payload);
      if (groundClamp && records.length) {
        await resolveGroundFloorCellsBounded(records.map((record) => ({ lat: record.lat, lon: record.lon })));
        if (abort.signal.aborted || !state.enabled) return;
      }
      render(records);
      state.requestedBox = box;
      state.requestedComplete = payload?.truncated !== true;
      state.error = null;
      state.stale = payload?.stale === true;
      state.fetchedAt = Number(payload?.fetchedAt) || null;
      state.lastUpdate = Date.now();
      state.status = records.length ? (state.stale ? 'stale' : 'ready') : 'empty';
      state.statusLabel = summary(payload);
    } catch (error) {
      if (error?.name === 'AbortError' || abort.signal.aborted) return;
      state.error = error?.message || 'unavailable';
      state.status = state.rendered.size ? 'stale' : 'unavailable';
    } finally {
      if (state.abort === abort) {
        state.abort = null;
        state.loading = false;
      }
    }
  }

  function scheduleViewportLoad() {
    if (!state.enabled) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      loadViewport();
    }, MERCHANT_REQUEST_DEBOUNCE_MS);
  }

  function onMoveEnd() {
    if (!state.enabled) return;
    cullBehindHorizon(true);
    if (mode === 'viewport') scheduleViewportLoad();
  }

  function installClickHandler(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
    state.clickHandler.setInputAction((click) => {
      if (!state.enabled) return;
      const picked = viewer.scene.pick(click.position);
      const key = picked?.collection === state.points && typeof picked.id === 'string'
        ? picked.id
        : null;
      if (key && state.rendered.has(key)) {
        if (key !== state.selectedId) select(key);
        return;
      }
      if (state.selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  return {
    id,
    name,
    icon,
    source,
    updateInterval: 0,
    ...(mode === 'global' ? { refreshInterval } : { statsRefreshInterval: 1000 }),

    init(viewer) {
      state.viewer = viewer;
      state.points = new Cesium.PointPrimitiveCollection({
        // Opaque colors + opaque outline → a single opaque pass.
        blendOption: Cesium.BlendOption.OPAQUE,
      });
      state.points.show = false;
      viewer.scene.primitives.add(state.points);
    },

    enable() {
      state.enabled = true;
      state.points.show = true;
      overlayHost.setVisible(selectedOverlayId, true);
      registerPickOwner(id, (picked) => state.rendered.has(picked));
      installClickHandler(state.viewer);
      state.moveEndRemove = state.viewer.camera.moveEnd.addEventListener(onMoveEnd);
      state.preRenderRemove = state.viewer.scene.preRender.addEventListener(() => cullBehindHorizon());
      cullBehindHorizon(true);
      requestRender('enable');
      // The manager calls update() right after enable(); it owns the first load.
    },

    disable() {
      state.enabled = false;
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
      state.abort?.abort();
      state.abort = null;
      state.loading = false;
      clearSelection();
      unregisterPickOwner(id);
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      state.preRenderRemove?.();
      state.preRenderRemove = null;
      state.clickHandler?.destroy();
      state.clickHandler = null;
      overlayHost.setVisible(selectedOverlayId, false);
      if (state.points) state.points.show = false;
      if (mode === 'viewport') {
        // Viewport data is only valid for the view it was fetched for.
        state.points?.removeAll();
        state.rendered.clear();
        state.requestedBox = null;
        state.requestedComplete = false;
      }
      state.status = 'idle';
      requestRender('disable');
    },

    update() {
      return mode === 'viewport' ? loadViewport() : loadGlobal();
    },

    destroy(viewer) {
      this.disable();
      overlayHost.clearSource(selectedOverlayId);
      if (state.points) {
        (viewer || state.viewer)?.scene?.primitives?.remove(state.points);
      }
      state.points = null;
      state.rendered.clear();
      state.viewer = null;
    },

    getStats() {
      return {
        count: state.rendered.size,
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

export const bitcoinLightningLayer = createBitcoinPointLayer({
  id: BITCOIN_LIGHTNING_LAYER_ID,
  name: 'Lightning Nodes',
  icon: '⚡',
  source: 'mempool.space',
  route: 'lightning',
  mode: 'global',
  refreshInterval: 60 * 60_000,
  toRecords: (payload) => (Array.isArray(payload?.locations) ? payload.locations : []).map(lightningRecord),
  summary: (payload) => `${Number(payload?.nodeCount || 0).toLocaleString('en-US')} nodes · ${(payload?.locations?.length || 0).toLocaleString('en-US')} locations`,
});

export const bitcoinNodesLayer = createBitcoinPointLayer({
  id: BITCOIN_NODES_LAYER_ID,
  name: 'Bitcoin Full Nodes',
  icon: '₿',
  source: 'Bitnodes',
  route: 'nodes',
  mode: 'global',
  refreshInterval: 6 * 60 * 60_000,
  toRecords: (payload) => (Array.isArray(payload?.locations) ? payload.locations : []).map(nodeRecord),
  summary: (payload) => {
    const total = Number(payload?.totalNodes);
    const located = (payload?.locations?.length || 0).toLocaleString('en-US');
    return Number.isFinite(total)
      ? `${located} locations · ${total.toLocaleString('en-US')} nodes`
      : `${located} locations`;
  },
});

export const bitcoinMerchantsLayer = createBitcoinPointLayer({
  id: BITCOIN_MERCHANTS_LAYER_ID,
  name: 'Bitcoin Merchants',
  icon: '🏪',
  source: 'BTC Map',
  route: 'merchants',
  mode: 'viewport',
  groundClamp: true,
  toRecords: (payload) => (Array.isArray(payload?.places) ? payload.places : []).map(merchantRecord),
  summary: (payload) => {
    const shown = payload?.places?.length || 0;
    return payload?.truncated
      ? `nearest ${shown} of ${Number(payload.total).toLocaleString('en-US')} in view · zoom in for all`
      : `${shown} places in view`;
  },
});

export default [bitcoinLightningLayer, bitcoinNodesLayer, bitcoinMerchantsLayer];
