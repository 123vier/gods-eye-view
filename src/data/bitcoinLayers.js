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
import { createBitcoinChannelsLayer } from './bitcoinChannels.js';

/**
 * Bitcoin network + economy layers: Lightning node locations (mempool.space;
 * channel arcs live in bitcoinChannels.js),
 * reachable full-node locations (Bitnodes) and places that accept bitcoin
 * (BTC Map). All three are served by the `/api/bitcoin/*` proxy
 * (server/providers/bitcoin.js), which owns the upstream caching.
 *
 * Built for modest hardware: each layer draws ONE batched collection — points
 * for merchants, billboards sharing a single icon texture for Lightning bolts
 * and full-node coins — keeps no per-point entities, and registers selection
 * context only for the point the user actually clicks. Merchants are fetched
 * per viewport and capped server-side, so the ~30k-place catalog never reaches
 * the browser.
 */

export const BITCOIN_LIGHTNING_LAYER_ID = 'bitcoin-lightning';
export const BITCOIN_NODES_LAYER_ID = 'bitcoin-nodes';
export const BITCOIN_MERCHANTS_LAYER_ID = 'bitcoin-merchants';
export const BITCOIN_MEETUPS_LAYER_ID = 'bitcoin-meetups';

/** Largest viewport (degrees per axis) for which merchants are requested. */
export const MERCHANT_VIEWPORT_MAX_DEGREES = 10;
const MERCHANT_REQUEST_DEBOUNCE_MS = 600;
/** Viewport padding per side, so short pans reuse the last response. */
const MERCHANT_VIEWPORT_PAD_RATIO = 0.2;
const HORIZON_CULL_INTERVAL_MS = 200;
const ICON_READY_POLL_MS = 100;
const ICON_READY_POLL_LIMIT = 20;

const COLORS = Object.freeze({
  // Main fill of the ⚡ emoji (Noto Color Emoji) shown in the layer menu.
  lightning: '#ffc927',
  node: '#f7931a',
  meetupRim: '#ff8a00',
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
 * Draw a marker icon once and return it as a data URL. A string image lets
 * the billboard atlas store ONE texture per icon for thousands of markers.
 * @param {number} width
 * @param {number} height
 * @param {function(CanvasRenderingContext2D): void} paint
 * @returns {string}
 */
function iconDataUrl(width, height, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d'));
  return canvas.toDataURL('image/png');
}

/** Lightning bolt outline in unit coordinates (x right, y down). */
const BOLT_POINTS = [
  [0.64, 0],
  [0.06, 0.58],
  [0.44, 0.58],
  [0.3, 1],
  [0.94, 0.38],
  [0.56, 0.38],
  [0.8, 0],
];

function boltIcon(fill, stroke) {
  const width = 40;
  const height = 64;
  const pad = 4;
  return iconDataUrl(width, height, (ctx) => {
    ctx.beginPath();
    BOLT_POINTS.forEach(([x, y], index) => {
      const px = pad + x * (width - 2 * pad);
      const py = pad + y * (height - 2 * pad);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
  });
}

/**
 * Bitcoin coin: a filled disc with a drawn ₿ (a bold B plus the two strokes
 * through its top and bottom). Drawn rather than typeset, because the ₿ glyph
 * (U+20BF) is missing from many system fonts and would render as a box.
 */
function coinIcon(disc, mark) {
  const size = 64;
  const c = size / 2;
  return iconDataUrl(size, size, (ctx) => {
    ctx.beginPath();
    ctx.arc(c, c, c - 3, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    ctx.fillStyle = mark;
    ctx.strokeStyle = mark;
    ctx.font = 'bold 40px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const capHalf = 14.5;
    ctx.fillText('B', c + 1, c + capHalf);
    ctx.lineWidth = 4;
    ctx.lineCap = 'butt';
    for (const x of [c - 5, c + 4]) {
      ctx.beginPath();
      ctx.moveTo(x, c - capHalf - 7);
      ctx.lineTo(x, c - capHalf + 3);
      ctx.moveTo(x, c + capHalf - 3);
      ctx.lineTo(x, c + capHalf + 7);
      ctx.stroke();
    }
  });
}

/**
 * Diamond "21" badge for Einundzwanzig meetups — angular, so it stands apart
 * from the round full-node coins.
 * @param {string} fill Fill colour.
 * @param {string} border Border colour.
 * @param {string} mark Text colour.
 * @param {number} [alpha=1] Whole-badge opacity (inactive meetups fade).
 */
function diamondBadgeIcon(fill, border, mark, { glow = null } = {}) {
  const size = 64;
  const c = size / 2;
  // Inset leaves room for the halo and the optional glow inside the canvas.
  const r = c - 9;
  return iconDataUrl(size, size, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(c, c - r);
    ctx.lineTo(c + r, c);
    ctx.lineTo(c, c + r);
    ctx.lineTo(c - r, c);
    ctx.closePath();
    ctx.lineJoin = 'round';
    // Dark halo under the coloured border keeps the edge crisp on any imagery.
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#111111';
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = border;
    if (glow) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = 8;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = mark;
    ctx.font = 'bold 22px Arial, Helvetica, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('21', c, c + 1);
  });
}

/** Normal + selected icon pairs, drawn on first use in the browser. */
export const LIGHTNING_MARKER_IMAGES = () => ({
  normal: boltIcon(COLORS.lightning, '#000000'),
  selected: boltIcon(COLORS.selected, COLORS.lightning),
});
export const MEETUP_MARKER_IMAGES = () => ({
  // Bright glowing orange rim so meetups stand out on any imagery.
  normal: diamondBadgeIcon('#ffffff', COLORS.meetupRim, COLORS.node, {
    glow: COLORS.meetupRim,
  }),
  // Dark slate inside the same orange rim: still findable, clearly not active.
  inactive: diamondBadgeIcon('#46505a', COLORS.meetupRim, '#f0f2f4'),
  selected: diamondBadgeIcon(COLORS.node, '#ffffff', '#ffffff', {
    glow: '#ffffff',
  }),
});
export const NODE_MARKER_IMAGES = () => ({
  normal: coinIcon(COLORS.node, '#ffffff'),
  selected: coinIcon(COLORS.selected, COLORS.node),
});

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
 * Bolt icon height for a Lightning location, following the point-size scale.
 * @param {number} capacitySat
 * @returns {number} Pixel height in [22, 42].
 */
export function boltHeight(capacitySat) {
  return 22 + (lightningPixelSize(capacitySat) - 4) * 2;
}

/**
 * Lightning location → render/card record.
 * @param {object} location Normalized proxy record.
 * @returns {object}
 */
export function lightningRecord(location) {
  const count = Number(location.nodeCount) || 0;
  const top = Array.isArray(location.top) ? location.top : [];
  const names = top.map(
    (node) => node.alias || `${String(node.pubkey).slice(0, 10)}…`,
  );
  const title =
    count === 1 ? names[0] || 'Lightning node' : `${count} Lightning nodes`;
  const summary = [
    formatBtc(location.capacitySat),
    `${Number(location.channels) || 0} channels`,
    location.country,
  ]
    .filter(Boolean)
    .join(' · ');
  const details = [summary];
  if (count > 1 && names.length) details.push(`Top: ${names.join(', ')}`);
  details.push('IP-geolocated · approximate');
  return {
    id: location.id,
    lat: location.lat,
    lon: location.lon,
    color: COLORS.lightning,
    pixelSize: lightningPixelSize(location.capacitySat),
    // Bolt height grows with capacity (16–30 px); the icon is 40×64.
    markerHeight: boltHeight(location.capacitySat),
    markerWidth: boltHeight(location.capacitySat) * 0.625,
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
    markerWidth: 13,
    markerHeight: 13,
    title: 'Bitcoin full node location',
    details: [
      'Reachable node(s) · IP-geolocated · approximate',
      'Tor nodes have no location and are not shown',
    ],
    properties: {},
  };
}

/**
 * BTC Map place → render/card record.
 * @param {object} place Normalized proxy record.
 * @returns {object}
 */
export function merchantRecord(place) {
  const category = place.atm ? 'Bitcoin ATM' : place.category || 'other';
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
 * Event time for a card, in the viewer's local time zone.
 * @param {number} epochMs
 * @param {string} [timeZone] Override for tests.
 * @returns {string} e.g. "2 Oct 2026, 18:00".
 */
export function formatEventTime(epochMs, timeZone) {
  return new Date(epochMs).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * Einundzwanzig meetup → render/card record.
 * @param {object} meetup Normalized proxy record.
 * @param {string} [timeZone] Override for tests.
 * @returns {object}
 */
export function meetupRecord(meetup, timeZone) {
  const place = [meetup.city, meetup.country].filter(Boolean).join(', ');
  const details = [];
  if (place) details.push(place);
  if (meetup.nextEvent) {
    details.push(
      `Next: ${formatEventTime(meetup.nextEvent.at, timeZone)}${meetup.nextEvent.venue ? ` · ${meetup.nextEvent.venue}` : ''}`,
    );
  } else if (meetup.lastEventAt) {
    details.push(
      `Last meetup: ${formatEventTime(meetup.lastEventAt, timeZone).split(',')[0]}`,
    );
  }
  if (meetup.active === true)
    details.push('Active · met or meets within 6 months');
  else if (meetup.active === false)
    details.push('Inactive · no meetup within 6 months');
  else details.push('Activity unknown');
  const inactive = meetup.active === false;
  return {
    id: String(meetup.id),
    lat: meetup.lat,
    lon: meetup.lon,
    color: COLORS.node,
    pixelSize: 6,
    markerKey: inactive ? 'inactive' : 'normal',
    markerWidth: inactive ? 27 : 32,
    markerHeight: inactive ? 27 : 32,
    title: meetup.name,
    details,
    properties: {
      city: meetup.city || null,
      country: meetup.country || null,
      active: meetup.active,
      lastEventAt: meetup.lastEventAt
        ? new Date(meetup.lastEventAt).toISOString()
        : null,
      nextEvent: meetup.nextEvent
        ? {
            at: new Date(meetup.nextEvent.at).toISOString(),
            venue: meetup.nextEvent.venue || null,
          }
        : null,
      links: meetup.links || {},
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
  if (
    height > MERCHANT_VIEWPORT_MAX_DEGREES ||
    width > MERCHANT_VIEWPORT_MAX_DEGREES
  )
    return null;
  const padLat = Math.min(
    height * MERCHANT_VIEWPORT_PAD_RATIO,
    (MERCHANT_VIEWPORT_MAX_DEGREES - height) / 2,
  );
  const padLon = Math.min(
    width * MERCHANT_VIEWPORT_PAD_RATIO,
    (MERCHANT_VIEWPORT_MAX_DEGREES - width) / 2,
  );
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
  return (
    Boolean(outer && inner) &&
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east
  );
}

function viewRectangleDegrees(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(
    viewer.scene.globe.ellipsoid,
  );
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
 * @param {function(): {normal: string, selected: string}} [config.markerImages]
 *   Draw records as billboards with these icons instead of plain points; a
 *   record's `markerKey` picks another icon from the set (default "normal").
 * @param {object} [deps] Test seams.
 * @returns {object} Data layer implementing the manager contract.
 */
export function createBitcoinPointLayer(
  config,
  {
    overlayHost = DEFAULT_OVERLAY_HOST,
    fetchImpl = (...args) => globalThis.fetch(...args),
    screenSpaceEventHandlerFactory = (canvas) =>
      new Cesium.ScreenSpaceEventHandler(canvas),
  } = {},
) {
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
    markerImages = null,
  } = config;
  const useIcons = typeof markerImages === 'function';
  /** @type {?{normal: string, selected: string}} Drawn at init (needs a DOM). */
  let images = null;
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
    iconTimer: null,
  };

  const pickId = (recordId) => `${id}:${recordId}`;

  function requestRender(reason) {
    governorRequestRender(`${id}-${reason}`);
  }

  function clearSelection({ notify = true } = {}) {
    if (!state.selectedId) return;
    const entry = state.rendered.get(state.selectedId);
    if (entry) styleMarker(entry, false);
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
    styleMarker(entry, true);
    overlayHost.setEntries(
      selectedOverlayId,
      [
        {
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
        },
      ],
      SELECTED_OVERLAY_OPTIONS,
    );
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

  /**
   * A billboard's new icon loads asynchronously on first use, and the render
   * governor idles a parked camera — without more frames the swapped marker
   * would stay blank until the next camera move. Request frames until the
   * texture is in (Billboard.ready) or a short limit passes.
   */
  function renderUntilIconReady(billboard) {
    clearInterval(state.iconTimer);
    let polls = 0;
    state.iconTimer = setInterval(() => {
      polls += 1;
      requestRender('icon');
      if (billboard.ready !== false || polls >= ICON_READY_POLL_LIMIT) {
        clearInterval(state.iconTimer);
        state.iconTimer = null;
      }
    }, ICON_READY_POLL_MS);
  }

  function styleMarker(entry, selected) {
    if (useIcons) {
      entry.point.image = selected
        ? images.selected
        : images[entry.record.markerKey || 'normal'];
      entry.point.scale = selected ? 1.5 : 1;
      renderUntilIconReady(entry.point);
      return;
    }
    entry.point.color = Cesium.Color.fromCssColorString(
      selected ? COLORS.selected : entry.record.color,
    );
    entry.point.pixelSize = entry.record.pixelSize + (selected ? 4 : 0);
  }

  function addMarker(key, record) {
    const common = {
      id: key,
      position: Cesium.Cartesian3.fromDegrees(
        record.lon,
        record.lat,
        pointHeight(record),
      ),
      scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.2, 2.0e7, 0.6),
      // The Cesium globe is hidden (3D tiles are the planet), so nothing
      // writes far-side depth: markers draw on top and the horizon pass
      // below hides the ones behind the Earth.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
    if (useIcons) {
      return state.points.add({
        ...common,
        image: images[record.markerKey || 'normal'],
        width: record.markerWidth,
        height: record.markerHeight,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      });
    }
    return state.points.add({
      ...common,
      pixelSize: record.pixelSize,
      color: Cesium.Color.fromCssColorString(record.color),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
    });
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
      state.rendered.set(key, { record, point: addMarker(key, record) });
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
    if (
      !force &&
      state.rendered.size &&
      state.lastUpdate &&
      Date.now() - state.lastUpdate < Math.max(60_000, refreshInterval / 2)
    )
      return;
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
    if (state.requestedComplete && boxContains(state.requestedBox, view))
      return;
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
        await resolveGroundFloorCellsBounded(
          records.map((record) => ({ lat: record.lat, lon: record.lon })),
        );
        if (abort.signal.aborted || !state.enabled) return;
      }
      render(records);
      state.requestedBox = box;
      state.requestedComplete = payload?.truncated !== true;
      state.error = null;
      state.stale = payload?.stale === true;
      state.fetchedAt = Number(payload?.fetchedAt) || null;
      state.lastUpdate = Date.now();
      state.status = records.length
        ? state.stale
          ? 'stale'
          : 'ready'
        : 'empty';
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
      const key =
        picked?.collection === state.points && typeof picked.id === 'string'
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
    ...(mode === 'global'
      ? { refreshInterval }
      : { statsRefreshInterval: 1000 }),

    init(viewer) {
      state.viewer = viewer;
      if (useIcons) {
        images = markerImages();
        // Icons have soft anti-aliased edges, so they blend translucently.
        state.points = new Cesium.BillboardCollection({
          blendOption: Cesium.BlendOption.TRANSLUCENT,
        });
      } else {
        state.points = new Cesium.PointPrimitiveCollection({
          // Opaque colors + opaque outline → a single opaque pass.
          blendOption: Cesium.BlendOption.OPAQUE,
        });
      }
      state.points.show = false;
      viewer.scene.primitives.add(state.points);
    },

    enable() {
      state.enabled = true;
      state.points.show = true;
      overlayHost.setVisible(selectedOverlayId, true);
      registerPickOwner(id, (picked) => state.rendered.has(picked));
      installClickHandler(state.viewer);
      state.moveEndRemove =
        state.viewer.camera.moveEnd.addEventListener(onMoveEnd);
      state.preRenderRemove = state.viewer.scene.preRender.addEventListener(
        () => cullBehindHorizon(),
      );
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
      clearInterval(state.iconTimer);
      state.iconTimer = null;
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

const LIGHTNING_LAYER_CONFIG = Object.freeze({
  id: BITCOIN_LIGHTNING_LAYER_ID,
  name: 'Lightning Nodes',
  icon: '⚡',
  source: 'mempool.space',
  route: 'lightning',
  mode: 'global',
  markerImages: LIGHTNING_MARKER_IMAGES,
  refreshInterval: 60 * 60_000,
  toRecords: (payload) =>
    (Array.isArray(payload?.locations) ? payload.locations : []).map(
      lightningRecord,
    ),
  summary: (payload) =>
    `${Number(payload?.nodeCount || 0).toLocaleString('en-US')} nodes · ${(payload?.locations?.length || 0).toLocaleString('en-US')} locations`,
});

const NODES_LAYER_CONFIG = Object.freeze({
  id: BITCOIN_NODES_LAYER_ID,
  name: 'Bitcoin Full Nodes',
  icon: '₿',
  source: 'Bitnodes',
  route: 'nodes',
  mode: 'global',
  markerImages: NODE_MARKER_IMAGES,
  refreshInterval: 6 * 60 * 60_000,
  toRecords: (payload) =>
    (Array.isArray(payload?.locations) ? payload.locations : []).map(
      nodeRecord,
    ),
  summary: (payload) => {
    const total = Number(payload?.totalNodes);
    const located = (payload?.locations?.length || 0).toLocaleString('en-US');
    return Number.isFinite(total)
      ? `${located} locations · ${total.toLocaleString('en-US')} nodes`
      : `${located} locations`;
  },
});

const MERCHANTS_LAYER_CONFIG = Object.freeze({
  id: BITCOIN_MERCHANTS_LAYER_ID,
  name: 'Bitcoin Merchants',
  icon: '🏪',
  source: 'BTC Map',
  route: 'merchants',
  mode: 'viewport',
  groundClamp: true,
  toRecords: (payload) =>
    (Array.isArray(payload?.places) ? payload.places : []).map(merchantRecord),
  summary: (payload) => {
    const shown = payload?.places?.length || 0;
    return payload?.truncated
      ? `nearest ${shown} of ${Number(payload.total).toLocaleString('en-US')} in view · zoom in for all`
      : `${shown} places in view`;
  },
});

const MEETUPS_LAYER_CONFIG = Object.freeze({
  id: BITCOIN_MEETUPS_LAYER_ID,
  name: 'Bitcoin Meetups',
  icon: '㉑',
  source: 'Einundzwanzig',
  route: 'meetups',
  mode: 'global',
  refreshInterval: 6 * 60 * 60_000,
  markerImages: MEETUP_MARKER_IMAGES,
  // Active meetups last, so they draw above faded inactive badges.
  toRecords: (payload) =>
    (Array.isArray(payload?.meetups) ? payload.meetups : [])
      .map((meetup) => meetupRecord(meetup))
      .sort(
        (a, b) =>
          (a.markerKey === 'inactive' ? 0 : 1) -
          (b.markerKey === 'inactive' ? 0 : 1),
      ),
  summary: (payload) => {
    const total = payload?.meetups?.length || 0;
    const active = Number(payload?.activeCount);
    return Number.isFinite(active)
      ? `${total} meetups · ${active} active`
      : `${total} meetups`;
  },
});

/** Fresh layer instances for one application catalog. */
export function createBitcoinLayers() {
  return [
    createBitcoinPointLayer(LIGHTNING_LAYER_CONFIG),
    createBitcoinChannelsLayer(),
    createBitcoinPointLayer(NODES_LAYER_CONFIG),
    createBitcoinPointLayer(MERCHANTS_LAYER_CONFIG),
    createBitcoinPointLayer(MEETUPS_LAYER_CONFIG),
  ];
}

export default createBitcoinLayers();
