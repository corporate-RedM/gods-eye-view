/**
 * Freshness for CCTV Watch: when a picture was captured, whether a fetch
 * brought a new capture at all, and how often each camera really updates.
 *
 * A new capture is recognised by its exact bytes, never by how similar the
 * picture looks: a quiet scene re-captured is fresh, a frozen feed served again
 * is not. Cadence is learned from those byte changes for the same reason.
 */
import { createHash } from 'node:crypto';

export const CAPTURE_SOURCES = Object.freeze({
  PROGRAM_DATE_TIME: 'program-date-time',
  LAST_MODIFIED: 'last-modified',
  CAMERA_CLOCK: 'camera-clock',
  UNKNOWN: 'unknown',
});

/** Allowed skew between an upstream date and our own clock. */
const FUTURE_SKEW_MS = 2 * 60 * 1000;
/** An upstream date older than this is reported but not trusted as capture time. */
const MAX_PLAUSIBLE_AGE_MS = 24 * 60 * 60 * 1000;

/** SHA-1 of a frame's bytes; identity for "same picture served again". */
export function contentHash(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/**
 * Capture time from an HTTP Last-Modified header, when it is believable.
 * @param {string|null|undefined} value - Header value.
 * @param {number} fetchedAt - Epoch ms of the fetch.
 * @returns {{time:number, source:string}|null}
 */
export function captureTimeFromLastModified(value, fetchedAt) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  if (time > fetchedAt + FUTURE_SKEW_MS) return null;
  if (fetchedAt - time > MAX_PLAUSIBLE_AGE_MS) return null;
  return { time, source: CAPTURE_SOURCES.LAST_MODIFIED };
}

/**
 * Map media sequence numbers to EXT-X-PROGRAM-DATE-TIME values in a media
 * playlist. A date tag applies to the next segment, and later segments are
 * dated by adding the durations in between.
 * @param {string} text - Media playlist.
 * @returns {Map<number, number>} Media sequence to epoch ms.
 */
export function parseProgramDateTimes(text) {
  const dates = new Map();
  let seq = 0;
  let pending = null;
  let running = null;
  let duration = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = Number(line.slice(22));
      if (Number.isSafeInteger(value) && value >= 0) seq = value;
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const time = Date.parse(line.slice(25));
      pending = Number.isFinite(time) ? time : null;
    } else if (line.startsWith('#EXTINF:')) {
      const value = Number.parseFloat(line.slice(8));
      duration = Number.isFinite(value) && value > 0 ? value : null;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      running = null;
    } else if (line && !line.startsWith('#')) {
      const start = pending ?? running;
      if (start !== null) dates.set(seq, start);
      running =
        start !== null && duration !== null ? start + duration * 1000 : null;
      pending = null;
      duration = null;
      seq += 1;
    }
  }
  return dates;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-camera freshness state for the sweep.
 *
 * @param {object} [options]
 * @param {number} [options.initialIntervalMs=120000] - Poll interval before a cadence is known.
 * @param {number} [options.minIntervalMs=60000] - Fastest poll for one camera.
 * @param {number} [options.maxIntervalMs=300000] - Slowest poll for one camera.
 * @param {number} [options.frozenFactor=3] - Cadences without a new capture before "stale feed".
 * @param {number} [options.frozenMinMs=900000] - Never call a feed stale sooner than this.
 * @param {number} [options.intervalSamples=6] - Change intervals kept for the cadence median.
 */
export function createFreshnessTracker({
  initialIntervalMs = 120_000,
  minIntervalMs = 60_000,
  maxIntervalMs = 300_000,
  frozenFactor = 3,
  frozenMinMs = 15 * 60 * 1000,
  intervalSamples = 6,
} = {}) {
  /** @type {Map<string, object>} */
  const cameras = new Map();
  const clamp = (value) =>
    Math.max(minIntervalMs, Math.min(maxIntervalMs, Math.round(value)));

  const entryFor = (cameraId) => {
    let entry = cameras.get(cameraId);
    if (!entry) {
      entry = {
        hash: null,
        lastChangeAt: null,
        lastChangeCapture: null,
        lastFetchAt: null,
        intervals: [],
        fetches: 0,
        fresh: 0,
      };
      cameras.set(cameraId, entry);
    }
    return entry;
  };

  const cadenceOf = (entry) => median(entry.intervals);

  const staleAfterMs = (entry) => {
    const cadence = cadenceOf(entry);
    return Math.max(frozenMinMs, cadence ? cadence * frozenFactor : 0);
  };

  return {
    /**
     * Record one fetch of a camera's picture.
     * @param {string} cameraId
     * @param {object} fetch
     * @param {string} fetch.hash - contentHash of the bytes.
     * @param {number} fetch.fetchedAt - Epoch ms.
     * @param {{time:number, source:string}|null} [fetch.capture] - Upstream capture time, if known.
     * @returns {{fresh:boolean, reason:string, captureTime:number|null, captureSource:string, cadenceMs:number|null, stale:boolean}}
     */
    observe(cameraId, { hash, fetchedAt, capture = null }) {
      const entry = entryFor(cameraId);
      entry.fetches += 1;
      entry.lastFetchAt = fetchedAt;
      if (hash && hash === entry.hash) {
        return {
          fresh: false,
          reason: 'same-bytes',
          captureTime: entry.lastChangeCapture,
          captureSource: entry.lastChangeCapture
            ? entry.lastChangeSource
            : CAPTURE_SOURCES.UNKNOWN,
          cadenceMs: cadenceOf(entry),
          stale:
            fetchedAt - (entry.lastChangeAt ?? fetchedAt) > staleAfterMs(entry),
        };
      }
      const changeTime = capture?.time ?? fetchedAt;
      if (entry.lastChangeAt !== null) {
        const previous = entry.lastChangeCapture ?? entry.lastChangeAt;
        const interval = changeTime - previous;
        if (interval > 0) {
          entry.intervals.push(interval);
          if (entry.intervals.length > intervalSamples) entry.intervals.shift();
        }
      }
      entry.hash = hash;
      entry.lastChangeAt = fetchedAt;
      entry.lastChangeCapture = capture?.time ?? null;
      entry.lastChangeSource = capture?.source ?? CAPTURE_SOURCES.UNKNOWN;
      entry.fresh += 1;
      return {
        fresh: true,
        reason: 'new-bytes',
        captureTime: capture?.time ?? null,
        captureSource: capture?.source ?? CAPTURE_SOURCES.UNKNOWN,
        cadenceMs: cadenceOf(entry),
        stale: false,
      };
    },

    /**
     * When to fetch this camera next. After a new capture, wait one cadence;
     * after a repeat, check again at half a cadence so the next capture is
     * picked up soon after the agency publishes it.
     * @param {string} cameraId
     * @param {number} fetchedAt
     * @param {boolean} wasFresh
     * @returns {number} Epoch ms.
     */
    nextDue(cameraId, fetchedAt, wasFresh) {
      const entry = entryFor(cameraId);
      const cadence = cadenceOf(entry);
      if (!cadence) return fetchedAt + clamp(initialIntervalMs);
      return fetchedAt + clamp(wasFresh ? cadence : cadence / 2);
    },

    /** Whether a camera has gone without a new capture for too long. */
    isStale(cameraId, now) {
      const entry = cameras.get(cameraId);
      if (!entry || entry.lastChangeAt === null) return false;
      return now - entry.lastChangeAt > staleAfterMs(entry);
    },

    /** Snapshot of one camera's freshness. */
    state(cameraId) {
      const entry = cameras.get(cameraId);
      if (!entry) return null;
      return {
        lastChangeAt: entry.lastChangeAt,
        lastCaptureAt: entry.lastChangeCapture,
        captureSource: entry.lastChangeSource ?? CAPTURE_SOURCES.UNKNOWN,
        lastFetchAt: entry.lastFetchAt,
        cadenceMs: cadenceOf(entry),
        fetches: entry.fetches,
        freshCaptures: entry.fresh,
      };
    },

    /**
     * Coverage counted in fresh captures, separately from fetch attempts.
     * @param {number} now
     * @param {Iterable<string>} [cameraIds] - Restrict to these cameras.
     */
    coverage(now, cameraIds = cameras.keys()) {
      let tracked = 0;
      let fresh5 = 0;
      let fresh10 = 0;
      let stale = 0;
      let neverFresh = 0;
      for (const cameraId of cameraIds) {
        tracked += 1;
        const entry = cameras.get(cameraId);
        if (!entry || entry.lastChangeAt === null) {
          neverFresh += 1;
          continue;
        }
        const age = now - entry.lastChangeAt;
        if (age <= 5 * 60 * 1000) fresh5 += 1;
        if (age <= 10 * 60 * 1000) fresh10 += 1;
        if (age > staleAfterMs(entry)) stale += 1;
      }
      return { tracked, fresh5, fresh10, stale, neverFresh };
    },

    /** Forget cameras that left the catalog. */
    retain(cameraIds) {
      const keep = new Set(cameraIds);
      for (const cameraId of cameras.keys())
        if (!keep.has(cameraId)) cameras.delete(cameraId);
    },
  };
}
