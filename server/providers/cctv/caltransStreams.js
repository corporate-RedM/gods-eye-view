import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Caltrans publishes a Wowza stream link for most cameras, but many are dead:
 * wzmedia.dot.ca.gov answers 404 after ~8 s instead of a playlist (measured
 * 2026-10-05: 504 of 1,098 links). Liveness is checked in the background and
 * kept on disk so a restart drops known-dead links immediately; the camera
 * then stays a still-image camera instead of stalling on a dead stream.
 */
const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
const CACHE_PATH = path.join(CACHE_DIR, 'caltrans-streams.json');
/** Re-check every link (live and dead) this often so revived streams return. */
const RECHECK_MS = 6 * 60 * 60 * 1000;
/** Dead links take ~8-9 s to answer 404; live ones answer in under ~5 s. */
const PROBE_TIMEOUT_MS = 15000;
const PROBE_CONCURRENCY = 16;

/** @type {Map<string, {live: boolean, checkedAt: number}>|null} */
let health = null;
let probing = false;

async function readDiskOnce() {
  if (health) return;
  health = new Map();
  try {
    const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
    for (const [url, entry] of Object.entries(parsed || {})) {
      if (typeof entry?.live === 'boolean' && Number.isFinite(entry?.checkedAt))
        health.set(url, entry);
    }
  } catch {
    /* no disk cache yet */
  }
}

async function writeDisk() {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(
      CACHE_PATH,
      JSON.stringify(Object.fromEntries(health)),
      'utf8',
    );
  } catch (err) {
    console.warn(
      '[CCTV] Caltrans stream cache write failed:',
      err?.message || err,
    );
  }
}

/**
 * Probe one stream link.
 * @param {string} url Master playlist URL.
 * @returns {Promise<boolean|null>} true live, false dead (404/410), null when
 *   inconclusive (timeout, network error, other status) so it is retried later.
 */
async function probeStream(url) {
  try {
    const resp = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (resp.status === 404 || resp.status === 410) return false;
    if (!resp.ok) return null;
    return (await resp.text()).startsWith('#EXTM3U');
  } catch {
    return null;
  }
}

async function probeInBackground(urls) {
  probing = true;
  try {
    let next = 0;
    let dead = 0;
    await Promise.all(
      Array.from({ length: PROBE_CONCURRENCY }, async () => {
        while (next < urls.length) {
          const url = urls[next++];
          const live = await probeStream(url);
          if (live === null) continue;
          if (!live) dead += 1;
          health.set(url, { live, checkedAt: Date.now() });
        }
      }),
    );
    await writeDisk();
    console.log(
      `[CCTV] Checked ${urls.length} Caltrans stream links: ${dead} dead`,
    );
  } finally {
    probing = false;
  }
}

/**
 * Return the stream links known to be dead, and start a background check of
 * any link that is unknown or due for a re-check. Unknown links count as live
 * until checked; a failed stream still falls back to the camera's still image.
 *
 * @param {string[]} urls Stream links in the current Caltrans catalog.
 * @returns {Promise<Set<string>>} Known-dead links.
 */
export async function knownDeadCaltransStreams(urls) {
  await readDiskOnce();
  const now = Date.now();
  const due = urls.filter((url) => {
    const entry = health.get(url);
    return !entry || now - entry.checkedAt > RECHECK_MS;
  });
  if (due.length && !probing) void probeInBackground(due);
  return new Set(urls.filter((url) => health.get(url)?.live === false));
}
