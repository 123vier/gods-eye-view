/**
 * Pure upstream → client normalizers for the three Bitcoin layers.
 *
 * Every upstream geolocates by IP address, so coordinates are coarse (often a
 * datacenter or a country centroid) and many records share one point. The
 * Lightning feed is therefore collapsed to one record per distinct location;
 * the Bitnodes coordinate snapshot already arrives de-duplicated.
 */

/** Largest BTC Map viewport the merchants route accepts, in degrees per axis. */
export const MERCHANT_MAX_VIEWPORT_DEGREES = 10;
/** Hard ceiling on merchants returned for one viewport request. */
export const MERCHANT_MAX_RESULTS = 1000;
/** Nodes listed by name inside one Lightning location's card. */
export const LIGHTNING_TOP_NODES = 3;

function finiteLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function cleanText(value, max = 80) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * mempool.space `/api/v1/lightning/nodes/world` → one record per location.
 * Upstream rows are `[lon, lat, pubkey, alias, capacitySat, channels, countryNames, iso]`.
 * @param {object} payload Upstream JSON.
 * @returns {{nodeCount:number, locations:Array<object>}}
 */
export function normalizeLightningWorld(payload) {
  const rows = Array.isArray(payload?.nodes) ? payload.nodes : null;
  if (!rows) throw new Error('Lightning payload has no nodes array');
  const byLocation = new Map();
  let nodeCount = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const lon = Number(row[0]);
    const lat = Number(row[1]);
    const pubkey = typeof row[2] === 'string' ? row[2] : '';
    if (!finiteLatLon(lat, lon) || !/^[0-9a-f]{66}$/i.test(pubkey)) continue;
    nodeCount += 1;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    let location = byLocation.get(key);
    if (!location) {
      location = {
        id: key,
        lat,
        lon,
        country: cleanText(row[7], 2).toUpperCase(),
        nodeCount: 0,
        capacitySat: 0,
        channels: 0,
        top: [],
      };
      byLocation.set(key, location);
    }
    const node = {
      pubkey,
      alias: cleanText(row[3], 40),
      capacitySat: nonNegative(row[4]),
      channels: nonNegative(row[5]),
    };
    location.nodeCount += 1;
    location.capacitySat += node.capacitySat;
    location.channels += node.channels;
    location.top.push(node);
  }
  const locations = [...byLocation.values()];
  for (const location of locations) {
    location.top.sort((a, b) => b.capacitySat - a.capacitySat || a.pubkey.localeCompare(b.pubkey));
    location.top.length = Math.min(location.top.length, LIGHTNING_TOP_NODES);
  }
  locations.sort((a, b) => b.capacitySat - a.capacitySat || a.id.localeCompare(b.id));
  return { nodeCount, locations };
}

/**
 * Bitnodes `snapshots/latest/?field=coordinates` → distinct node locations.
 * Upstream pairs are `[lat, lon]`; the snapshot carries no per-node detail.
 * @param {object} payload Upstream JSON.
 * @returns {{totalNodes:?number, snapshotAt:?number, locations:Array<object>}}
 */
export function normalizeBitnodesCoordinates(payload) {
  const pairs = Array.isArray(payload?.coordinates) ? payload.coordinates : null;
  if (!pairs) throw new Error('Bitnodes payload has no coordinates array');
  const seen = new Set();
  const locations = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair)) continue;
    const lat = Number(pair[0]);
    const lon = Number(pair[1]);
    if (!finiteLatLon(lat, lon)) continue;
    const id = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    locations.push({ id, lat, lon });
  }
  const totalNodes = Number(payload.total_nodes);
  const snapshotAt = Number(payload.timestamp);
  return {
    totalNodes: Number.isFinite(totalNodes) ? totalNodes : null,
    snapshotAt: Number.isFinite(snapshotAt) ? snapshotAt * 1000 : null,
    locations,
  };
}

/** Icon names that do not read as a category on their own. */
const ICON_CATEGORIES = new Map([
  ['palette', 'art'],
  ['content_cut', 'hairdresser'],
  ['storefront', 'shop'],
  ['lunch_dining', 'fast food'],
  ['medical_services', 'medical'],
  ['group', 'community'],
]);

/**
 * BTC Map category from its Material icon name ("local_atm" → "atm").
 * @param {string} icon
 * @returns {string}
 */
export function merchantCategory(icon) {
  const name = cleanText(icon, 40).toLowerCase();
  if (!name || name === 'question_mark') return 'other';
  if (ICON_CATEGORIES.has(name)) return ICON_CATEGORIES.get(name);
  return name.replace(/^local_/, '').replaceAll('_', ' ');
}

/**
 * BTC Map `/v4/places` → active places with only the fields the card shows.
 * Rows carrying `deleted_at` are dropped even though the default field set
 * omits deleted places, so a changed upstream default cannot resurrect them.
 * @param {Array<object>} payload Upstream JSON.
 * @returns {Array<object>}
 */
export function normalizeBtcMapPlaces(payload) {
  if (!Array.isArray(payload)) throw new Error('BTC Map payload is not an array');
  const places = [];
  for (const row of payload) {
    if (!row || typeof row !== 'object' || row.deleted_at) continue;
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!finiteLatLon(lat, lon) || !Number.isInteger(row.id)) continue;
    const category = merchantCategory(row.icon);
    const website = cleanText(row.website, 200);
    places.push({
      id: row.id,
      lat,
      lon,
      name: cleanText(row.name) || 'Unnamed place',
      category,
      atm: category === 'atm',
      address: cleanText(row.address, 120),
      website: /^https?:\/\//i.test(website) ? website : '',
      openingHours: cleanText(row.opening_hours, 120),
      verifiedAt: cleanText(row.verified_at, 10),
    });
  }
  return places;
}

/**
 * Parse and bound a merchants viewport query.
 * @param {URLSearchParams} params
 * @returns {?{south:number, west:number, north:number, east:number}}
 */
export function parseMerchantBox(params) {
  const box = {};
  for (const key of ['south', 'west', 'north', 'east']) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    box[key] = value;
  }
  if (box.south < -90 || box.north > 90 || box.west < -180 || box.east > 180) return null;
  if (box.north <= box.south || box.east <= box.west) return null;
  // A little slack over the client's own limit absorbs its 5-decimal rounding.
  const limit = MERCHANT_MAX_VIEWPORT_DEGREES + 0.01;
  if (box.north - box.south > limit || box.east - box.west > limit) return null;
  return box;
}

/**
 * Places inside a viewport, nearest to its centre first, capped.
 * @param {Array<object>} places Normalized places.
 * @param {{south:number, west:number, north:number, east:number}} box
 * @param {number} [cap]
 * @returns {{total:number, truncated:boolean, places:Array<object>}}
 */
export function selectMerchantsInBox(places, box, cap = MERCHANT_MAX_RESULTS) {
  const inside = [];
  for (const place of places) {
    if (place.lat >= box.south && place.lat <= box.north
      && place.lon >= box.west && place.lon <= box.east) inside.push(place);
  }
  const midLat = (box.south + box.north) / 2;
  const midLon = (box.west + box.east) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const distance = (place) => ((place.lat - midLat) ** 2) + (((place.lon - midLon) * cosLat) ** 2);
  if (inside.length > cap) {
    inside.sort((a, b) => distance(a) - distance(b) || a.id - b.id);
  }
  return {
    total: inside.length,
    truncated: inside.length > cap,
    places: inside.slice(0, cap),
  };
}
