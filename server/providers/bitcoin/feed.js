import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * One upstream snapshot with a memory + disk cache.
 *
 * - Fresh inside `ttlMs`; the disk copy survives dev-server restarts, so a
 *   restart never spends upstream quota (Bitnodes allows 10 calls/day/IP).
 * - Single-flight: concurrent requests share one upstream pass.
 * - Serve-stale: a failed refresh returns the last good snapshot marked stale.
 * - Failure cooldown: after a failure no new upstream attempt is made for
 *   `retryCooldownMs` (or the upstream's longer Retry-After), so a broken or
 *   rate-limited upstream is not hammered once per client request.
 *
 * @param {object} options
 * @param {string} options.name Log prefix and cache file stem.
 * @param {number} options.ttlMs Freshness window.
 * @param {number} options.retryCooldownMs Minimum wait after a failure.
 * @param {function(AbortSignal): Promise<object>} options.load Upstream fetch + normalize.
 * @param {string} [options.cacheDir]
 * @param {function(): number} [options.now]
 * @param {object} [options.fs] fs.promises-compatible seam for tests.
 * @returns {{get: function(): Promise<?{at:number, data:object, stale:boolean}>, status: function(): object}}
 */
export function createCachedFeed({
  name,
  ttlMs,
  retryCooldownMs,
  load,
  cacheDir = path.join(process.cwd(), '.gev-cache'),
  now = Date.now,
  fs = fsp,
}) {
  const cachePath = path.join(cacheDir, `${name}.json`);
  /** @type {?{at:number, data:object}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at:number, data:object}>} */
  let inflight = null;
  let cooldownUntil = 0;
  let lastError = null;

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && parsed?.data && typeof parsed.data === 'object') mem = parsed;
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn(`[${name}] cache write failed:`, err?.message || err);
    }
  }

  function refresh() {
    if (!inflight) {
      const pending = (async () => {
        try {
          const data = await load(AbortSignal.timeout(90_000));
          const entry = { at: now(), data };
          mem = entry;
          lastError = null;
          await writeDisk(entry);
          return entry;
        } catch (err) {
          const retryAfterMs = Number(err?.retryAfterMs);
          cooldownUntil = now() + Math.max(
            retryCooldownMs,
            Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
          );
          lastError = err?.message || String(err);
          console.warn(`[${name}] refresh failed (${lastError}) — serving cache if any`);
          return null;
        }
      })();
      inflight = pending;
      // Clear only after the assignment above: a load that fails without ever
      // awaiting settles synchronously, and clearing from inside it would be
      // overwritten by the settled promise, pinning every later refresh to it.
      pending.finally(() => {
        if (inflight === pending) inflight = null;
      });
    }
    return inflight;
  }

  return {
    async get() {
      await readDiskOnce();
      const entry = mem;
      if (entry && now() - entry.at < ttlMs) return { ...entry, stale: false };
      if (now() < cooldownUntil) return entry ? { ...entry, stale: true } : null;
      const fresh = await refresh();
      if (fresh) return { ...fresh, stale: false };
      return entry ? { ...entry, stale: true } : null;
    },
    status() {
      return {
        lastFetch: mem ? mem.at : null,
        ttlMs,
        cooldownUntil: cooldownUntil > now() ? cooldownUntil : null,
        lastError,
      };
    },
  };
}

/**
 * Fetch upstream JSON with an identifying User-Agent and a byte cap. A 429's
 * Retry-After (seconds) is attached as `retryAfterMs` for the feed cooldown.
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {number} maxBytes
 * @param {function(Response, number): Promise<object>} readJsonCapped
 * @returns {Promise<object>}
 */
export async function fetchUpstreamJson(url, signal, maxBytes, readJsonCapped) {
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'gods-eye-view (bitcoin layers; local proxy)',
    },
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  return readJsonCapped(response, maxBytes);
}
