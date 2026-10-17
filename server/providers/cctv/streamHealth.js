import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  fetchHlsBytes,
  HLS_LIMITS,
  parseHlsMedia,
  sameOriginHlsUrl,
} from './stream.js';
import { resolveIbiPublicStream } from './publicIbiVideo.js';
import { resolveDriveTexasStream } from './driveTexasVideo.js';

/**
 * Background playback checks. Only verdicts persist; candidates stay in memory.
 * A failed check describes current availability, never permanent removal.
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
const PROBE_CONCURRENCY = 8;
/** Consecutive unreachable checks (refused, DNS, timeout) that mean dead. */
const UNREACHABLE_STRIKES = 2;
/**
 * Verdict version. v2 checks the media playlist with the proxy's own parser,
 * so a stream it cannot serve (encrypted, byte ranges) counts as not live; v1
 * only fetched the master playlist. v3: the proxy now serves fMP4, so Iowa's
 * streams that v2 marked unplayable are re-checked.
 */
export const STREAM_HEALTH_CHECK_VERSION = 5;
const CHECK_VERSION = STREAM_HEALTH_CHECK_VERSION;
const PROBE_HEADERS = Object.freeze({
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
});

/** @type {Map<string, {live: boolean, checkedAt: number, failures?: number}>|null} */
let health = null;
/** Links waiting for a check, shared by every pack that loads concurrently. */
const pending = new Set();
const active = new Set();
const activeProbeHosts = new Map();
const probeHosts = new Map();
const candidates = new Map();
const hostRequests = new Map();
const hostBackoff = new Map();
let probing = false;
let probeController = new AbortController();
let rechecks;
let diskRead;
let diskWrite = Promise.resolve();

function retryAfter(value, now = Date.now()) {
  const seconds = Number(value);
  return value && Number.isFinite(seconds)
    ? now + Math.max(1, seconds) * 1000
    : Math.max(now + 60_000, Date.parse(value) || 0);
}

/** Decode actual video bytes in memory. ffmpeg has no network/file protocol access. */
export function decodeVideoBytes(bytes, { format = 'mpegts', signal } = {}) {
  const demuxer = {
    mpegts: 'mpegts',
    mp4: 'mov',
    webm: 'matroska',
    jpeg: 'image2pipe',
  }[format];
  if (!demuxer || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'pipe',
        '-threads',
        '1',
        '-f',
        demuxer,
        '-i',
        'pipe:0',
        '-map',
        '0:v:0',
        '-frames:v',
        '2',
        '-vf',
        'scale=32:32',
        '-filter_threads',
        '1',
        '-threads',
        '1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let length = 0;
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(length >= 32 * 32 * 3);
    });
    child.stdin.end(bytes);
  });
}

/** Every request, including public token resolution, shares host limits and backoff. */
async function pacedFetch(url, init, fetchImpl) {
  const host = new URL(url).host;
  while ((hostRequests.get(host) || 0) >= 2) {
    init?.signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if ((hostBackoff.get(host) || 0) > Date.now())
    throw Object.assign(new Error('Provider retry delay'), {
      retryAt: hostBackoff.get(host),
    });
  hostRequests.set(host, (hostRequests.get(host) || 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    hostRequests.set(host, Math.max(0, (hostRequests.get(host) || 1) - 1));
  };
  try {
    const response = await fetchImpl(url, { ...init, redirect: 'error' });
    if (response.status === 429 || response.status === 503) {
      const retryAt = retryAfter(response.headers.get('retry-after'));
      hostBackoff.set(host, retryAt);
      await response.body?.cancel();
      throw Object.assign(new Error(`HTTP ${response.status}`), { retryAt });
    }
    if ([401, 403, 404, 410].includes(response.status)) {
      await response.body?.cancel();
      throw Object.assign(new Error(`HTTP ${response.status}`), { dead: true });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      release();
      return response;
    }
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            release();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel() {
        try {
          await reader.cancel();
        } finally {
          release();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    release();
    throw error;
  }
}

/** One checker for all panel feed types; no playlist-only positive verdicts. */
export async function probeCameraStream(
  camera,
  { fetchImpl = fetch, decode = decodeVideoBytes, signal: parentSignal } = {},
) {
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const fetcher = (url, init = {}) =>
    pacedFetch(url, { ...init, signal: init.signal || signal }, fetchImpl);
  try {
    if (camera.feedType === 'iframe') {
      const response = await fetcher(camera.embedUrl || camera.url, { signal });
      await response.body?.cancel();
      return {
        live: null,
        status: 'unverified',
        reason:
          'Embedded page fetched; playback inside its player has not been confirmed',
      };
    }
    if (camera.feedType === 'hls') {
      const resolved =
        camera.sourceKind === 'drivetexas-public-video'
          ? await resolveDriveTexasStream(camera, {
              fetchImpl: fetcher,
              signal,
            })
          : await resolveIbiPublicStream(camera, {
              fetchImpl: fetcher,
              signal,
            });
      let url = resolved.url;
      const options = {
        fetchImpl: fetcher,
        signal,
        headers: resolved.headers,
        maxBytes: HLS_LIMITS.playlistBytes,
      };
      let text = (await fetchHlsBytes(url, options)).toString('utf8');
      if (text.includes('#EXT-X-STREAM-INF')) {
        const variant = text
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#'));
        url = sameOriginHlsUrl(variant, url);
        text = (await fetchHlsBytes(url, options)).toString('utf8');
      }
      let segments;
      try {
        segments = parseHlsMedia(text, url);
      } catch {
        return {
          live: false,
          status: 'unavailable',
          reason: 'Playlist format cannot be served by the panel proxy',
        };
      }
      // Match the panel proxy's oldest-first startup, not just the newest
      // segment: the proxy needs two segments before it can serve a playlist.
      if (segments.length < 2)
        throw new Error('Fewer than two media segments yet');
      if (new Set(segments.map((segment) => segment.map)).size > 1)
        return {
          live: false,
          status: 'unavailable',
          reason: 'Mixed HLS init segments cannot be served by the panel proxy',
        };
      const segment = segments[0];
      const mediaOptions = { ...options, maxBytes: HLS_LIMITS.segmentBytes };
      const init = segment.map
        ? await fetchHlsBytes(segment.map, mediaOptions)
        : Buffer.alloc(0);
      const media = await fetchHlsBytes(segment.uri, mediaOptions);
      await fetchHlsBytes(segments[1].uri, mediaOptions);
      const decoded = await decode(Buffer.concat([init, media]), {
        format: segment.map ? 'mp4' : 'mpegts',
        signal,
      });
      return {
        live: decoded ? true : null,
        status: decoded ? 'available' : 'unverified',
        reason: decoded
          ? 'Proxy-compatible media segment decoded'
          : 'Media bytes received but video decoding failed',
      };
    }
    const response = await fetcher(camera.url, {
      signal,
      headers: PROBE_HEADERS,
    });
    const type = response.headers.get('content-type') || '';
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing media body');
    const chunks = [];
    let size = 0,
      frames = 0;
    let tail = Buffer.alloc(0);
    try {
      if (
        camera.feedType !== 'mjpeg' &&
        /^(image\/|text\/|application\/(?:json|xml))/i.test(type)
      )
        return {
          live: false,
          status: 'unavailable',
          reason: 'Video endpoint returned an image or document',
        };
      if (
        camera.feedType === 'mjpeg' &&
        !/multipart\/x-mixed-replace/i.test(type)
      )
        return {
          live: false,
          status: 'unavailable',
          reason: 'MJPEG endpoint did not return a multipart stream',
        };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024) break;
        chunks.push(Buffer.from(value));
        if (camera.feedType === 'mjpeg') {
          tail = Buffer.concat([tail, value]);
          let end;
          while ((end = tail.indexOf(Buffer.from([0xff, 0xd9]))) >= 0) {
            const start = tail.indexOf(Buffer.from([0xff, 0xd8]));
            if (
              start >= 0 &&
              start < end &&
              (await decode(tail.subarray(start, end + 2), {
                format: 'jpeg',
                signal,
              }))
            )
              frames++;
            tail = tail.subarray(end + 2);
          }
          if (frames >= 2)
            return {
              live: true,
              status: 'available',
              reason:
                'Continuous multipart stream returned two decoded JPEG frames',
            };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (camera.feedType === 'mjpeg')
      throw new Error('Multipart stream ended before two frames');
    const decoded = await decode(Buffer.concat(chunks), {
      format: camera.feedType,
      signal,
    });
    return {
      live: decoded ? true : null,
      status: decoded ? 'available' : 'unverified',
      reason: decoded
        ? 'Video response decoded'
        : 'Response did not decode as video',
    };
  } catch (error) {
    return {
      live: error.dead ? false : null,
      status: error.dead ? 'unavailable' : 'unverified',
      reason: error.message,
      retryAt: error.retryAt,
      unreachable: !error.dead && !error.retryAt,
    };
  }
}

async function readEntries(file) {
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  return Object.entries(parsed || {}).filter(
    ([, entry]) =>
      (typeof entry?.live === 'boolean' || entry?.live === null) &&
      Number.isFinite(entry?.checkedAt),
  );
}

async function readDiskOnce() {
  if (diskRead) return diskRead;
  if (health) return;
  health = new Map();
  diskRead = (async () => {
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
  })();
  try {
    await diskRead;
  } finally {
    diskRead = null;
  }
}

async function writeDisk() {
  const value = JSON.stringify(Object.fromEntries(health || []));
  diskWrite = diskWrite.then(async () => {
    try {
      const file = cachePath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(`${file}.tmp`, value, 'utf8');
      await fsp.rename(`${file}.tmp`, file);
    } catch (err) {
      console.warn(
        '[CCTV] stream health cache write failed:',
        err?.message || err,
      );
    }
  });
  await diskWrite;
}

/**
 * Record one probe verdict. An inconclusive result counts a strike; the link
 * is called dead after UNREACHABLE_STRIKES in a row and otherwise stays due so
 * the next catalog refresh tries again.
 */
function recordVerdict(url, verdict, now) {
  // A reset (tests) while a check is in flight discards its result.
  if (!health) return;
  const { live } = verdict;
  if (live !== null || !verdict.unreachable) {
    health.set(url, {
      ...verdict,
      checkedAt: now,
      failures: 0,
      v: CHECK_VERSION,
    });
    return;
  }
  const previous = health.get(url);
  const failures = (previous?.failures || 0) + 1;
  health.set(
    url,
    failures >= UNREACHABLE_STRIKES
      ? {
          ...verdict,
          live: false,
          status: 'unavailable',
          checkedAt: now,
          failures,
          v: CHECK_VERSION,
        }
      : {
          ...verdict,
          live: null,
          checkedAt: previous?.live === false ? previous.checkedAt : 0,
          failures,
          v: CHECK_VERSION,
        },
  );
}

async function drainPending(fetchImpl, decode) {
  probing = true;
  const controller = probeController;
  let checked = 0;
  let dead = 0;
  try {
    await Promise.all(
      Array.from({ length: PROBE_CONCURRENCY }, async () => {
        for (;;) {
          if (controller.signal.aborted) return;
          if (!pending.size) return;
          // Waiting for a host slot is queue time, never a stream timeout or
          // an unreachable strike. Other hosts can progress in the meantime.
          let url, host;
          for (const candidate of pending) {
            const candidateHost = probeHosts.get(candidate);
            // Keep the candidate for the periodic recheck, but do not count a
            // host's backoff as another attempted/failed camera check.
            if (
              (hostBackoff.get(candidateHost) || 0) > Date.now() ||
              (health?.get(candidate)?.retryAt || 0) > Date.now()
            ) {
              pending.delete(candidate);
              continue;
            }
            if ((activeProbeHosts.get(candidateHost) || 0) < 2) {
              url = candidate;
              host = candidateHost;
              break;
            }
          }
          if (url === undefined) {
            if (!pending.size) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          pending.delete(url);
          active.add(url);
          activeProbeHosts.set(host, (activeProbeHosts.get(host) || 0) + 1);
          const verdict = await probeCameraStream(
            candidates.get(url) || { url, feedType: 'hls' },
            { fetchImpl, decode, signal: controller.signal },
          );
          if (!controller.signal.aborted)
            recordVerdict(url, verdict, Date.now());
          active.delete(url);
          activeProbeHosts.set(
            host,
            Math.max(0, (activeProbeHosts.get(host) || 1) - 1),
          );
          checked += 1;
          if (health?.get(url)?.live === false) dead += 1;
          if (checked % 100 === 0) {
            await writeDisk();
            console.log(
              `[CCTV] Playback checks: ${checked} finished in this round`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }),
    );
    if (health) await writeDisk();
    console.log(`[CCTV] Checked ${checked} live stream links: ${dead} dead`);
  } finally {
    probing = false;
    // Links queued after the workers emptied the set start the next round.
    if (pending.size && !controller.signal.aborted)
      void drainPending(fetchImpl, decode);
  }
}

/**
 * Return the stream links known to be dead, and queue a background check of
 * any link that is unknown or due for a re-check. Unknown is not a positive
 * playback verdict. Full catalogues retain unavailable candidates too.
 *
 * @param {string[]} urls Stream links in one pack's current catalog.
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @returns {Promise<Set<string>>} Known-dead links.
 */
export async function knownDeadStreams(
  urls,
  { fetchImpl = fetch, decode } = {},
) {
  if (probeController.signal.aborted) probeController = new AbortController();
  await readDiskOnce();
  const now = Date.now();
  for (const url of urls) {
    if (!probeHosts.has(url)) {
      try {
        probeHosts.set(url, new URL(url).host);
      } catch {
        continue;
      }
    }
    const entry = health.get(url);
    // Verdicts from an older check are re-checked; until then they stand.
    if (
      !active.has(url) &&
      (hostBackoff.get(probeHosts.get(url)) || 0) <= now &&
      (!entry?.retryAt || entry.retryAt <= now) &&
      (!entry ||
        (entry.retryAt && entry.retryAt <= now) ||
        entry.v !== CHECK_VERSION ||
        now - entry.checkedAt > RECHECK_MS)
    )
      pending.add(url);
  }
  if (pending.size && !probing) void drainPending(fetchImpl, decode);
  return new Set(urls.filter((url) => health.get(url)?.live === false));
}

/** Register video candidates in memory; verdicts never remove their records. */
export async function checkCameraStreams(sources, options = {}) {
  if (!rechecks) {
    rechecks = setInterval(() => {
      if (candidates.size) void knownDeadStreams([...candidates.keys()]);
    }, 60_000);
    rechecks.unref();
  }
  const urls = [];
  for (const camera of sources) {
    const url = camera.feedType === 'iframe' ? camera.embedUrl : camera.url;
    if (!url) continue;
    candidates.set(url, camera);
    urls.push(url);
  }
  await knownDeadStreams(urls, options);
}

export function streamVerdict(camera) {
  const entry = health?.get(
    camera.feedType === 'iframe' ? camera.embedUrl : camera.url,
  );
  if (!entry || entry.v !== CHECK_VERSION) return { status: 'unchecked' };
  return {
    status: entry.status || 'unverified',
    checkedAt: entry.checkedAt,
    reason: entry.reason || '',
    retryAt: entry.retryAt,
  };
}

export function streamVerificationSummary(sources) {
  const providers = {};
  for (const camera of sources) {
    const name = camera.pack || camera.provider || 'unknown';
    const counts = (providers[name] ||= {
      total: 0,
      available: 0,
      unavailable: 0,
      unverified: 0,
      unchecked: 0,
    });
    counts.total++;
    counts[streamVerdict(camera).status]++;
  }
  return { pending: pending.size, checking: active.size, providers };
}

/** Dev-server shutdown cancels old probes before a replacement server starts. */
export function stopStreamHealthChecks() {
  probeController.abort();
  pending.clear();
  candidates.clear();
  clearInterval(rechecks);
  rechecks = null;
}

/** Read existing dead verdicts without probing or changing the health cache. */
export async function getRecordedDeadStreams() {
  await readDiskOnce();
  return new Set(
    [...health].filter(([, entry]) => entry.live === false).map(([url]) => url),
  );
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
  candidates.clear();
  hostBackoff.clear();
}
