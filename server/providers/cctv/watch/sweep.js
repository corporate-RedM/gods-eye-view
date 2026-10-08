/**
 * Baseline sweep for CCTV Watch: every live camera, at its own cadence, paced
 * per upstream host.
 *
 * The sweep never pauses for focused monitoring. A camera in focus is skipped
 * only because focus is already reading its live video. Only fresh captures
 * (new bytes) are passed on; a repeat of the same picture is counted as a
 * fetch, never as coverage.
 */
import { captureTimeFromLastModified, contentHash } from './freshness.js';

const BANDWIDTH_WINDOW_MS = 60_000;

function hostOf(source) {
  try {
    return new URL(source.snapshotUrl || source.url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * @param {object} options
 * @param {() => Promise<object[]>} options.listCameras - Live-video catalog sources.
 * @param {(source: object) => Promise<object|null>} options.fetchStill - Agency still fetch.
 * @param {(source: object) => Promise<object|null>} options.grabKeyframe - Live-video frame for cameras with no still.
 * @param {object} options.freshness - createFreshnessTracker() instance.
 * @param {(frame: object) => void} options.onFrame - Receives fresh frames only.
 */
export function createSweep({
  listCameras,
  fetchStill,
  grabKeyframe,
  freshness,
  onFrame,
  isFocused = () => false,
  concurrency = 24,
  hostConcurrency = 4,
  keyframeIntervalMs = 120_000,
  staleStillVideo = false,
  stillRecheckMs = 15 * 60_000,
  initialSpreadMs = 120_000,
  catalogRefreshMs = 15 * 60_000,
  tickMs = 250,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
  log = console,
} = {}) {
  /** @type {Map<string, object>} */
  const cameras = new Map();
  const hosts = new Map();
  const transfers = [];
  /** Transfers for frozen-still cameras read through their video instead. */
  const fallbackTransfers = [];
  let running = false;
  let timer = null;
  let inFlight = 0;
  let catalogAt = 0;
  let catalogLoading = false;
  let catalogError = null;
  const totals = {
    fetches: 0,
    fresh: 0,
    repeats: 0,
    failures: 0,
    bytes: 0,
    frozenStills: 0,
    // The cost of the frozen-still fallback, kept apart so it can be judged.
    fallbackFetches: 0,
    fallbackFresh: 0,
    fallbackBytes: 0,
    videoDecodes: 0,
    videoDecodeMs: 0,
  };
  /** Freshness key for a camera's live video: its own id when it has no still. */
  const videoKey = (camera) =>
    camera.source.snapshotUrl ? `${camera.id}#video` : camera.id;

  const hostState = (host) => {
    let state = hosts.get(host);
    if (!state) {
      state = {
        inFlight: 0,
        consecutiveFailures: 0,
        backoffUntil: 0,
        failures: 0,
        fetches: 0,
      };
      hosts.set(host, state);
    }
    return state;
  };

  async function refreshCatalog() {
    catalogLoading = true;
    try {
      const sources = await listCameras();
      const at = now();
      const seen = new Set();
      for (const source of sources) {
        seen.add(source.id);
        const existing = cameras.get(source.id);
        if (existing) {
          existing.source = source;
          existing.host = hostOf(source);
          continue;
        }
        cameras.set(source.id, {
          id: source.id,
          source,
          host: hostOf(source),
          // Spread first fetches so a cold start does not hit every host at once.
          nextDue: at + random() * initialSpreadMs,
          inFlight: false,
          failures: 0,
          lastError: null,
        });
      }
      for (const id of cameras.keys()) if (!seen.has(id)) cameras.delete(id);
      freshness.retain([...seen].flatMap((id) => [id, `${id}#video`]));
      catalogError = null;
    } catch (error) {
      catalogError = error.message;
      log.warn?.(`[CCTV Watch] camera list failed: ${error.message}`);
    } finally {
      catalogAt = now();
      catalogLoading = false;
    }
  }

  const pushWindow = (list, bytes, at) => {
    list.push([at, bytes]);
    while (list.length && list[0][0] < at - BANDWIDTH_WINDOW_MS) list.shift();
  };
  const recordBytes = (bytes, at, fallback = false) => {
    totals.bytes += bytes;
    pushWindow(transfers, bytes, at);
    if (!fallback) return;
    totals.fallbackBytes += bytes;
    pushWindow(fallbackTransfers, bytes, at);
  };
  const mbpsOf = (list, at) => {
    const windowBytes = list.reduce((sum, [, bytes]) => sum + bytes, 0);
    const span = Math.max(
      1,
      Math.min(BANDWIDTH_WINDOW_MS, at - (list[0]?.[0] ?? at)),
    );
    return Number(((windowBytes * 8) / (span / 1000) / 1e6).toFixed(2));
  };

  const fail = (camera, host, reason) => {
    const at = now();
    camera.failures += 1;
    camera.lastError = reason;
    camera.nextDue =
      at + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(camera.failures, 5));
    host.failures += 1;
    host.consecutiveFailures += 1;
    totals.failures += 1;
    if (host.consecutiveFailures >= 5) {
      const level = Math.min(host.consecutiveFailures - 5, 4);
      host.backoffUntil = at + 60_000 * 2 ** level;
    }
  };

  async function fetchCamera(camera) {
    const host = hostState(camera.host);
    camera.inFlight = true;
    inFlight += 1;
    host.inFlight += 1;
    host.fetches += 1;
    totals.fetches += 1;
    try {
      const { source } = camera;
      const videoInstead =
        staleStillVideo &&
        Boolean(source.url) &&
        camera.stillFrozen &&
        now() < camera.stillRecheckAt;
      if (source.snapshotUrl && !videoInstead) {
        const still = await fetchStill(source);
        const fetchedAt = now();
        if (!still?.ok) {
          fail(camera, host, 'still unavailable');
          return;
        }
        recordBytes(still.body.length, fetchedAt);
        const hash = contentHash(still.body);
        const seen = freshness.observe(camera.id, {
          hash,
          fetchedAt,
          capture: captureTimeFromLastModified(still.lastModified, fetchedAt),
        });
        camera.nextDue = freshness.nextDue(camera.id, fetchedAt, seen.fresh);
        camera.failures = 0;
        host.consecutiveFailures = 0;
        if (!seen.fresh) {
          totals.repeats += 1;
          if (
            staleStillVideo &&
            source.url &&
            (seen.stale || camera.stillFrozen)
          ) {
            // The agency still has stopped changing: watch this camera through
            // its live video and look at the still again later.
            if (!camera.stillFrozen) totals.frozenStills += 1;
            camera.stillFrozen = true;
            camera.stillRecheckAt = fetchedAt + stillRecheckMs;
            camera.nextDue = fetchedAt;
          }
          return;
        }
        camera.stillFrozen = false;
        totals.fresh += 1;
        onFrame({
          cameraId: camera.id,
          camera: source,
          origin: 'sweep',
          kind: 'still',
          jpeg: still.body,
          contentType: still.contentType,
          hash,
          fetchedAt,
          captureTime: seen.captureTime,
          captureSource: seen.captureSource,
          cadenceMs: seen.cadenceMs,
        });
        return;
      }
      if (videoInstead) totals.fallbackFetches += 1;
      const grabbed = await grabKeyframe(source);
      const fetchedAt = now();
      if (Number.isFinite(grabbed?.decodeMs)) {
        totals.videoDecodes += 1;
        totals.videoDecodeMs += grabbed.decodeMs;
      }
      if (!grabbed?.jpeg) {
        fail(camera, host, 'keyframe unavailable');
        return;
      }
      recordBytes(
        grabbed.bytes ?? grabbed.jpeg.length,
        fetchedAt,
        videoInstead,
      );
      // Video frames are identified by the segment they came from: the same
      // newest segment again is a repeat, not a new capture. A camera that
      // also has a still keeps its video freshness apart, so a frozen still
      // can never be counted fresh through a video segment or the reverse.
      const seen = freshness.observe(videoKey(camera), {
        hash: grabbed.segmentId,
        fetchedAt,
        capture: grabbed.captureTime
          ? { time: grabbed.captureTime, source: grabbed.captureSource }
          : null,
      });
      camera.nextDue = fetchedAt + keyframeIntervalMs;
      camera.failures = 0;
      host.consecutiveFailures = 0;
      if (!seen.fresh) {
        totals.repeats += 1;
        return;
      }
      totals.fresh += 1;
      if (videoInstead) totals.fallbackFresh += 1;
      onFrame({
        cameraId: camera.id,
        camera: source,
        origin: 'sweep',
        kind: 'keyframe',
        jpeg: grabbed.jpeg,
        contentType: 'image/jpeg',
        hash: grabbed.segmentId,
        fetchedAt,
        captureTime: seen.captureTime,
        captureSource: seen.captureSource,
        cadenceMs: null,
      });
    } catch (error) {
      fail(camera, host, error.message);
    } finally {
      camera.inFlight = false;
      inFlight -= 1;
      host.inFlight -= 1;
    }
  }

  /**
   * Fresh-capture coverage per camera, through whichever route last brought a
   * new capture (its still or its live video).
   */
  function coverage(at) {
    let fresh5 = 0;
    let fresh10 = 0;
    let stale = 0;
    let neverFresh = 0;
    let watchedByVideo = 0;
    for (const camera of cameras.values()) {
      const still = freshness.state(camera.id);
      const video = camera.source.snapshotUrl
        ? freshness.state(videoKey(camera))
        : null;
      const last = Math.max(
        still?.lastChangeAt ?? -Infinity,
        video?.lastChangeAt ?? -Infinity,
      );
      if (camera.stillFrozen) watchedByVideo += 1;
      if (!Number.isFinite(last)) {
        neverFresh += 1;
        continue;
      }
      if (at - last <= 5 * 60_000) fresh5 += 1;
      if (at - last <= 10 * 60_000) fresh10 += 1;
      if (camera.stillFrozen) {
        // A frozen still stays stale until its video brings fresh captures;
        // video that is unavailable or frozen too leaves it stale.
        const key = videoKey(camera);
        const videoFresh =
          freshness.state(key)?.lastChangeAt != null &&
          !freshness.isStale(key, at);
        if (!videoFresh) stale += 1;
      } else if (freshness.isStale(camera.id, at)) stale += 1;
    }
    return {
      tracked: cameras.size,
      fresh5,
      fresh10,
      stale,
      neverFresh,
      watchedByVideo,
    };
  }

  function tick() {
    if (!running) return;
    const at = now();
    if (!catalogLoading && at - catalogAt >= catalogRefreshMs) refreshCatalog();
    if (inFlight < concurrency) {
      const due = [];
      for (const camera of cameras.values())
        if (!camera.inFlight && camera.nextDue <= at && !isFocused(camera.id))
          due.push(camera);
      due.sort((a, b) => a.nextDue - b.nextDue);
      for (const camera of due) {
        if (inFlight >= concurrency) break;
        const host = hostState(camera.host);
        if (host.inFlight >= hostConcurrency || host.backoffUntil > at)
          continue;
        fetchCamera(camera);
      }
    }
    timer = setTimer(tick, tickMs);
    timer?.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      // Never loaded: the first tick reads the camera list whatever the clock says.
      catalogAt = Number.NEGATIVE_INFINITY;
      tick();
    },
    stop() {
      running = false;
      clearTimer(timer);
      timer = null;
    },
    /** Make a camera due now (for example, when focus on it ends). */
    poke(cameraId) {
      const camera = cameras.get(cameraId);
      if (camera) camera.nextDue = Math.min(camera.nextDue, now());
    },
    cameraIds: () => [...cameras.keys()],
    camera: (cameraId) => cameras.get(cameraId)?.source ?? null,
    /** Whether a camera's active feed has gone stale, and whether it is failing. */
    cameraState(cameraId) {
      const camera = cameras.get(cameraId);
      if (!camera) return null;
      const key = camera.stillFrozen ? videoKey(camera) : camera.id;
      return {
        stale:
          freshness.isStale(key, now()) ||
          freshness.state(key)?.lastChangeAt == null,
        failing: camera.failures > 0,
        lastError: camera.lastError,
      };
    },
    stats() {
      const at = now();
      return {
        running,
        cameras: cameras.size,
        inFlight,
        catalogAt,
        catalogError,
        totals: { ...totals },
        mbps: mbpsOf(transfers, at),
        fallbackMbps: mbpsOf(fallbackTransfers, at),
        videoDecodeMsAvg: totals.videoDecodes
          ? Math.round(totals.videoDecodeMs / totals.videoDecodes)
          : null,
        coverage: coverage(at),
        hosts: Object.fromEntries(
          [...hosts.entries()].map(([host, state]) => [
            host,
            {
              fetches: state.fetches,
              failures: state.failures,
              backingOff: state.backoffUntil > at,
            },
          ]),
        ),
      };
    },
  };
}
