import { readResponseJsonCapped } from './common/http.js';
import { createCachedFeed, fetchUpstreamJson } from './bitcoin/feed.js';
import {
  normalizeBitnodesCoordinates,
  normalizeBtcMapPlaces,
  normalizeLightningChannels,
  normalizeLightningWorld,
  normalizeMeetups,
  parseMerchantBox,
  selectMerchantsInBox,
} from './bitcoin/normalize.js';

const HOUR_MS = 60 * 60_000;

const LIGHTNING_URL = 'https://mempool.space/api/v1/lightning/nodes/world';
const CHANNELS_URL = 'https://mempool.space/api/v1/lightning/channels-geo';
// bitnodes.io now redirects here; the public API allows 10 requests/day/IP.
const BITNODES_URL =
  'https://btcnodes.io/api/v1/snapshots/latest/?field=coordinates';
const MEETUPS_URL = 'https://portal.einundzwanzig.space/api/meetups';
const MEETUP_EVENTS_URL =
  'https://portal.einundzwanzig.space/api/meetup-events';
const BTCMAP_URL =
  'https://api.btcmap.org/v4/places?fields=id,lat,lon,name,icon,address,website,opening_hours,verified_at';

/**
 * Bitcoin network + economy proxy: three independent keyless feeds, each
 * cached in memory and under `.gev-cache/`.
 *
 * Routes:
 *   GET /api/bitcoin/lightning  → Lightning node locations (mempool.space, 1 h)
 *   GET /api/bitcoin/channels   → Lightning channels merged per location pair
 *                                 (mempool.space sample, 1 h)
 *   GET /api/bitcoin/nodes      → reachable full-node locations (Bitnodes, 24 h)
 *   GET /api/bitcoin/merchants?south=&west=&north=&east=
 *                               → BTC Map places inside a ≤10° viewport (24 h
 *                                 snapshot, filtered and capped server-side so
 *                                 the browser never holds the ~30k-place list)
 *   GET /api/bitcoin/meetups    → Einundzwanzig meetups with activity status
 *                                 (portal meetups + events, 24 h)
 *   GET /api/bitcoin/status     → per-feed cache status
 *
 * @returns {import('vite').Plugin}
 */
export function bitcoinProxy() {
  const feeds = {
    lightning: createCachedFeed({
      name: 'bitcoin-lightning',
      ttlMs: HOUR_MS,
      retryCooldownMs: 10 * 60_000,
      load: async (signal) =>
        normalizeLightningWorld(
          await fetchUpstreamJson(
            LIGHTNING_URL,
            signal,
            8 * 1024 * 1024,
            readResponseJsonCapped,
          ),
        ),
    }),
    channels: createCachedFeed({
      name: 'bitcoin-channels',
      ttlMs: HOUR_MS,
      retryCooldownMs: 10 * 60_000,
      load: async (signal) =>
        normalizeLightningChannels(
          await fetchUpstreamJson(
            CHANNELS_URL,
            signal,
            8 * 1024 * 1024,
            readResponseJsonCapped,
          ),
        ),
    }),
    nodes: createCachedFeed({
      name: 'bitcoin-nodes',
      ttlMs: 24 * HOUR_MS,
      // 10 calls/day: after a failure wait three hours before trying again.
      retryCooldownMs: 3 * HOUR_MS,
      load: async (signal) =>
        normalizeBitnodesCoordinates(
          await fetchUpstreamJson(
            BITNODES_URL,
            signal,
            2 * 1024 * 1024,
            readResponseJsonCapped,
          ),
        ),
    }),
    meetups: createCachedFeed({
      name: 'bitcoin-meetups',
      ttlMs: 24 * HOUR_MS,
      retryCooldownMs: 30 * 60_000,
      load: async (signal) => {
        const meetups = await fetchUpstreamJson(
          MEETUPS_URL,
          signal,
          4 * 1024 * 1024,
          readResponseJsonCapped,
        );
        // Status is optional: without the events feed the meetups still map.
        let events = null;
        try {
          events = await fetchUpstreamJson(
            MEETUP_EVENTS_URL,
            signal,
            24 * 1024 * 1024,
            readResponseJsonCapped,
          );
        } catch (err) {
          console.warn(
            '[bitcoin-meetups] events unavailable, status unknown:',
            err?.message || err,
          );
        }
        return normalizeMeetups(meetups, events, Date.now());
      },
    }),
    merchants: createCachedFeed({
      name: 'bitcoin-merchants',
      ttlMs: 24 * HOUR_MS,
      retryCooldownMs: 30 * 60_000,
      load: async (signal) => ({
        places: normalizeBtcMapPlaces(
          await fetchUpstreamJson(
            BTCMAP_URL,
            signal,
            40 * 1024 * 1024,
            readResponseJsonCapped,
          ),
        ),
      }),
    }),
  };

  const installMiddleware = (server) => {
    server.middlewares.use('/api/bitcoin', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method not allowed' });
          return;
        }
        const url = new URL(String(req.url || '/'), 'http://local');
        const route = url.pathname.replace(/\/+$/, '') || '/';

        if (route === '/status') {
          sendJson(
            200,
            Object.fromEntries(
              Object.entries(feeds).map(([key, feed]) => [key, feed.status()]),
            ),
          );
          return;
        }

        if (route === '/merchants') {
          const box = parseMerchantBox(url.searchParams);
          if (!box) {
            sendJson(400, {
              error: 'viewport must be a valid box of at most 10° per side',
            });
            return;
          }
          const entry = await feeds.merchants.get();
          if (!entry) {
            sendJson(502, {
              error: 'BTC Map unavailable and no cache available',
            });
            return;
          }
          sendJson(200, {
            fetchedAt: entry.at,
            stale: entry.stale,
            ...selectMerchantsInBox(entry.data.places, box),
          });
          return;
        }

        const feed =
          route === '/lightning'
            ? feeds.lightning
            : route === '/channels'
              ? feeds.channels
              : route === '/nodes'
                ? feeds.nodes
                : route === '/meetups'
                  ? feeds.meetups
                  : null;
        if (!feed) {
          sendJson(404, { error: 'unknown bitcoin route' });
          return;
        }
        const entry = await feed.get();
        if (!entry) {
          sendJson(502, {
            error: 'upstream unavailable and no cache available',
          });
          return;
        }
        sendJson(200, {
          fetchedAt: entry.at,
          stale: entry.stale,
          ...entry.data,
        });
      } catch (err) {
        console.warn('[bitcoin-proxy] error:', err?.message || err);
        sendJson(500, { error: 'bitcoin proxy error' });
      }
    });
  };

  return {
    name: 'bitcoin-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
