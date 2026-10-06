import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseHlsMedia, sameOriginHlsUrl } from './stream.js';

/**
 * Background liveness check for every live-video (HLS) camera link.
 *
 * Agencies publish stream links that are often dead: Caltrans' Wowza host
 * answers 404 after ~8 s (504 of 1,098 links on 2026-10-05), and some Nevada
 * hosts refuse connections outright. Each link is checked in the background and
 * the verdict kept on disk, so a restart drops known-dead links immediately.
 * Loaders then fall back to the camera's still image, or drop a camera that
 * has none, instead of offering a live feed that never plays.
 */
const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
/** CCTV_STREAM_HEALTH_FILE relocates the cache (tests use a temp file). */
const cachePath = () =>
  process.env.CCTV_STREAM_HEALTH_FILE ||
  path.join(CACHE_DIR, 'cctv-stream-health.json');
/** Earlier Caltrans-only cache; read once so its verdicts carry over. */
const LEGACY_CACHE_PATH = path.join(CACHE_DIR, 'caltrans-streams.json');
/** Re-check every link (live and dead) this often so revived streams return. */
const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Dead links take ~8-9 s to answer 404; live ones answer in under ~5 s. */
const PROBE_TIMEOUT_MS = 15000;
const PROBE_CONCURRENCY = 16;
/** Consecutive unreachable checks (refused, DNS, timeout) that mean dead. */
const UNREACHABLE_STRIKES = 2;
/**
 * Verdict version. v2 checks the media playlist with the proxy's own parser,
 * so a stream it cannot serve (fMP4, encrypted) counts as not live; v1 only
 * fetched the master playlist and passed Iowa's fMP4 streams.
 */
export const STREAM_HEALTH_CHECK_VERSION = 2;
const CHECK_VERSION = STREAM_HEALTH_CHECK_VERSION;
const PROBE_HEADERS = Object.freeze({
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
});

/** @type {Map<string, {live: boolean, checkedAt: number, failures?: number}>|null} */
let health = null;
/** Links waiting for a check, shared by every pack that loads concurrently. */
const pending = new Set();
let probing = false;

async function readEntries(file) {
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  return Object.entries(parsed || {}).filter(
    ([, entry]) =>
      typeof entry?.live === 'boolean' && Number.isFinite(entry?.checkedAt),
  );
}

async function readDiskOnce() {
  if (health) return;
  health = new Map();
  const files = process.env.CCTV_STREAM_HEALTH_FILE
    ? [cachePath()]
    : [cachePath(), LEGACY_CACHE_PATH];
  for (const file of files) {
    try {
      for (const [url, entry] of await readEntries(file))
        health.set(url, entry);
      return;
    } catch {
      /* no cache at this path */
    }
  }
}

async function writeDisk() {
  try {
    const file = cachePath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      JSON.stringify(Object.fromEntries(health)),
      'utf8',
    );
  } catch (err) {
    console.warn(
      '[CCTV] stream health cache write failed:',
      err?.message || err,
    );
  }
}

/**
 * Fetch one playlist: its text, false when gone (404/410), null when
 * unreachable or inconclusive (refused, DNS, timeout, other status).
 */
async function fetchPlaylist(url, fetchImpl) {
  try {
    const resp = await fetchImpl(url, {
      headers: PROBE_HEADERS,
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (resp.status === 404 || resp.status === 410) return false;
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Probe one stream link the way the server's HLS proxy will play it: the
 * master playlist, its first variant, and that media playlist through the
 * proxy's own parser (same-origin MPEG-TS only).
 * @param {string} url Master playlist URL.
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean|null>} true live; false dead or unplayable (gone,
 *   not a playlist, fMP4/encrypted, variant on another origin); null when
 *   unreachable or currently empty, so it is retried.
 */
async function probeStream(url, fetchImpl) {
  let text = await fetchPlaylist(url, fetchImpl);
  if (typeof text !== 'string') return text;
  if (!text.startsWith('#EXTM3U')) return false;
  let mediaUrl = url;
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    try {
      mediaUrl = sameOriginHlsUrl(variant, url);
    } catch {
      return false;
    }
    text = await fetchPlaylist(mediaUrl, fetchImpl);
    if (typeof text !== 'string') return text;
  }
  let segments;
  try {
    segments = parseHlsMedia(text, mediaUrl);
  } catch {
    return false;
  }
  return segments.length > 0 ? true : null;
}

/**
 * Record one probe verdict. An inconclusive result counts a strike; the link
 * is called dead after UNREACHABLE_STRIKES in a row and otherwise stays due so
 * the next catalog refresh tries again.
 */
function recordVerdict(url, live, now) {
  // A reset (tests) while a check is in flight discards its result.
  if (!health) return;
  if (live !== null) {
    health.set(url, { live, checkedAt: now, failures: 0, v: CHECK_VERSION });
    return;
  }
  const previous = health.get(url);
  const failures = (previous?.failures || 0) + 1;
  health.set(
    url,
    failures >= UNREACHABLE_STRIKES
      ? { live: false, checkedAt: now, failures, v: CHECK_VERSION }
      : {
          live: previous?.live ?? true,
          checkedAt: previous?.live === false ? previous.checkedAt : 0,
          failures,
          v: previous?.v,
        },
  );
}

async function drainPending(fetchImpl) {
  probing = true;
  let checked = 0;
  let dead = 0;
  try {
    await Promise.all(
      Array.from({ length: PROBE_CONCURRENCY }, async () => {
        for (;;) {
          const url = pending.values().next().value;
          if (url === undefined) return;
          pending.delete(url);
          const live = await probeStream(url, fetchImpl);
          recordVerdict(url, live, Date.now());
          checked += 1;
          if (health?.get(url)?.live === false) dead += 1;
        }
      }),
    );
    if (health) await writeDisk();
    console.log(`[CCTV] Checked ${checked} live stream links: ${dead} dead`);
  } finally {
    probing = false;
    // Links queued after the workers emptied the set start the next round.
    if (pending.size) void drainPending(fetchImpl);
  }
}

/**
 * Return the stream links known to be dead, and queue a background check of
 * any link that is unknown or due for a re-check. Unknown links count as live
 * until checked; a stream that fails in the browser still falls back to the
 * camera's still image.
 *
 * @param {string[]} urls Stream links in one pack's current catalog.
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @returns {Promise<Set<string>>} Known-dead links.
 */
export async function knownDeadStreams(urls, { fetchImpl = fetch } = {}) {
  await readDiskOnce();
  const now = Date.now();
  for (const url of urls) {
    const entry = health.get(url);
    // Verdicts from an older check are re-checked; until then they stand.
    if (
      !entry ||
      entry.v !== CHECK_VERSION ||
      now - entry.checkedAt > RECHECK_MS
    )
      pending.add(url);
  }
  if (pending.size && !probing) void drainPending(fetchImpl);
  return new Set(urls.filter((url) => health.get(url)?.live === false));
}

/** Wait for the background check to finish (tests and seeding scripts). */
export async function settleStreamHealthChecks() {
  while (probing || pending.size) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Forget in-memory verdicts so the next call re-reads the cache (tests). */
export function _resetStreamHealthForTest() {
  health = null;
  pending.clear();
}
