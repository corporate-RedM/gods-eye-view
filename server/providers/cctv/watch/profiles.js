/**
 * Camera capability profiles for CCTV Watch: what each camera's view can show.
 *
 * A profile is built from several describer samples taken at different times
 * of day and is never final: it is refreshed every few days, sooner when the
 * view changes (a pan-tilt-zoom camera repointed), and suitability is a share
 * of samples rather than a yes/no, so one dark or empty first picture cannot
 * exclude a camera.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PROFILE_REFRESH_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 8;

/**
 * Day part from local solar time, estimated from longitude, so a camera's
 * night baseline is not mixed with its daytime one.
 * @param {number} epochMs
 * @param {number} lon
 * @returns {'day'|'night'}
 */
export function dayPart(epochMs, lon) {
  const offsetHours = Number.isFinite(lon) ? lon / 15 : 0;
  const utcHours =
    new Date(epochMs).getUTCHours() + new Date(epochMs).getUTCMinutes() / 60;
  const local = (((utcHours + offsetHours) % 24) + 24) % 24;
  return local >= 6.5 && local < 19 ? 'day' : 'night';
}

/**
 * Summarise profile samples into shares and the most common scene.
 * @param {object[]} samples
 */
export function summariseProfile(samples) {
  if (!samples?.length) return null;
  const share = (key) =>
    samples.filter((sample) => sample[key]).length / samples.length;
  const scenes = new Map();
  for (const sample of samples)
    scenes.set(sample.scene, (scenes.get(sample.scene) || 0) + 1);
  const scene = [...scenes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    samples: samples.length,
    dayParts: [...new Set(samples.map((sample) => sample.dayPart))].sort(),
    scene,
    roadVisible: share('roadVisible'),
    pedestrianAreaVisible: share('pedestrianAreaVisible'),
    peopleUsable:
      samples.filter((sample) => sample.peopleScale === 'usable').length /
      samples.length,
    peopleTiny:
      samples.filter((sample) => sample.peopleScale === 'tiny').length /
      samples.length,
    slopeOrCliff: share('slopeOrCliffVisible'),
    vegetation: share('vegetationVisible'),
    clockOverlay: share('clockOverlay'),
    updatedAt: Math.max(...samples.map((sample) => sample.at)),
  };
}

/**
 * Profile store, persisted as JSON metadata (no imagery).
 * @param {object} [options]
 * @param {string|null} [options.file] - JSON path; null keeps profiles in memory.
 */
export function createProfileStore({
  file = null,
  now = Date.now,
  refreshMs = PROFILE_REFRESH_MS,
  log = console,
} = {}) {
  /** @type {Map<string, {samples:object[], reprofile:boolean}>} */
  const cameras = new Map();
  let dirty = false;

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      for (const [cameraId, entry] of Object.entries(saved.cameras || {}))
        cameras.set(cameraId, {
          samples: Array.isArray(entry.samples) ? entry.samples : [],
          reprofile: Boolean(entry.reprofile),
        });
    } catch (error) {
      if (error.code !== 'ENOENT')
        log.warn?.(`[CCTV Watch] could not read profiles: ${error.message}`);
    }
  }

  const entryFor = (cameraId) => {
    let entry = cameras.get(cameraId);
    if (!entry) {
      entry = { samples: [], reprofile: false };
      cameras.set(cameraId, entry);
    }
    return entry;
  };

  return {
    /** Profile summary, or null before any sample. */
    summary(cameraId) {
      return summariseProfile(cameras.get(cameraId)?.samples);
    },

    /**
     * Whether a camera needs a new profile sample now: none yet, none for
     * this day part, the newest is old, or the view changed.
     */
    needsSample(cameraId, part, at = now()) {
      const entry = cameras.get(cameraId);
      if (!entry?.samples.length || entry.reprofile) return true;
      if (!entry.samples.some((sample) => sample.dayPart === part)) return true;
      const newest = Math.max(...entry.samples.map((sample) => sample.at));
      return at - newest > refreshMs;
    },

    /** Add one describer profile result (detector `clean_profile` shape). */
    addSample(cameraId, result, { at = now(), part = 'day' } = {}) {
      if (!result?.ok) return;
      const entry = entryFor(cameraId);
      if (entry.reprofile) {
        // The view changed: start over rather than averaging two views.
        entry.samples = [];
        entry.reprofile = false;
      }
      entry.samples.push({
        at,
        dayPart: part,
        scene: result.scene,
        roadVisible: Boolean(result.roadVisible),
        pedestrianAreaVisible: Boolean(result.pedestrianAreaVisible),
        peopleScale: result.peopleScale,
        slopeOrCliffVisible: Boolean(result.slopeOrCliffVisible),
        vegetationVisible: Boolean(result.vegetationVisible),
        clockOverlay: Boolean(result.clockOverlay),
        confidence: result.confidence,
      });
      if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
      dirty = true;
    },

    /** The camera's view changed; the next sample starts a new profile. */
    flagViewChange(cameraId) {
      entryFor(cameraId).reprofile = true;
      dirty = true;
    },

    /** Persist when anything changed. Writes atomically. */
    save() {
      if (!file || !dirty) return;
      const payload = { version: 1, cameras: Object.fromEntries(cameras) };
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify(payload));
      renameSync(temporary, file);
      dirty = false;
    },

    size: () => cameras.size,
  };
}
