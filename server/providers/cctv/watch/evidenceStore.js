/**
 * Evidence for CCTV Watch incidents, kept 7 days under output/cctv-evidence/.
 *
 * Only readings attached to an incident are saved. A still reading keeps its
 * frame. A clip reading, the evidence behind any motion conclusion, keeps the
 * frames the describer saw with their capture times and offsets, and the
 * untouched source video segments they were decoded from, with a small HLS
 * playlist so they can be played back. Nothing is re-encoded.
 *
 * Layout: <dir>/<YYYY-MM-DD>/<incident>/<reading>/
 *   frame-<n>.jpg, reading.json, and for clips: seg-<seq>.ts|m4s,
 *   init.mp4 (fragmented MP4 only), clip.m3u8
 * Incident metadata: <dir>/incidents.json, the latest view of every incident
 * with saved evidence, including incidents from earlier runs.
 */
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (epochMs) => new Date(epochMs).toISOString().slice(0, 10);
// A name never starts with a dot, so "." and ".." can never be one.
const safeName = (value) =>
  String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INCIDENT_PATTERN = /^inc-[a-z0-9]+-\d+$/;
const READING_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
const FILE_TYPES = [
  [/^frame-\d{1,2}\.jpg$/, 'image/jpeg'],
  [/^reading\.json$/, 'application/json'],
  [/^clip\.m3u8$/, 'application/vnd.apple.mpegurl'],
  [/^init\.mp4$/, 'video/mp4'],
  [/^seg-\d{1,12}\.ts$/, 'video/mp2t'],
  [/^seg-\d{1,12}\.m4s$/, 'video/iso.segment'],
];

/**
 * HLS playlist for saved source segments, in order, as one VOD clip.
 * @param {{file:string, duration:number|null, capturedAt:number|null}[]} segments
 * @param {string|null} initFile
 */
export function clipPlaylist(segments, initFile) {
  const durations = segments.map((segment) =>
    Number.isFinite(segment.duration) && segment.duration > 0
      ? segment.duration
      : 2,
  );
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
    `#EXT-X-MEDIA-SEQUENCE:${segments[0]?.seq ?? 0}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  if (initFile) lines.push(`#EXT-X-MAP:URI="${initFile}"`);
  segments.forEach((segment, index) => {
    if (Number.isFinite(segment.capturedAt))
      lines.push(
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.capturedAt).toISOString()}`,
      );
    lines.push(`#EXTINF:${durations[index].toFixed(3)},`, segment.file);
  });
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/**
 * @param {object} options
 * @param {string} options.dir - Evidence directory (output/cctv-evidence).
 */
export function createEvidenceStore({
  dir,
  retentionDays = 7,
  now = Date.now,
  log = console,
} = {}) {
  /** incidentId -> saved readings: {readingId, path, mode, at, files}. */
  const index = new Map();
  const saved = new Set();
  /** Incident views from earlier runs, by id. */
  let archive = new Map();
  let chain = Promise.resolve();
  const totals = { readings: 0, files: 0, bytes: 0, failed: 0 };

  async function write(target, bytes) {
    await writeFile(target, bytes);
    totals.files += 1;
    totals.bytes += bytes.length;
  }

  async function persist(incidentId, record) {
    const at = record.captureTime ?? record.fetchedAt ?? now();
    const day = dayKey(at);
    const readingId = safeName(record.readingId);
    const relative = path.join(day, incidentId, readingId);
    const target = path.join(dir, relative);
    await mkdir(target, { recursive: true });
    const frames = [];
    for (const [i, jpeg] of (record.jpegs || []).entries()) {
      const file = `frame-${i}.jpg`;
      await write(path.join(target, file), jpeg);
      const meta = record.frames?.[i] || {};
      frames.push({
        file,
        captureTime: meta.captureTime ?? null,
        captureSource: meta.captureSource ?? record.captureSource ?? 'unknown',
        offsetSec: meta.offsetSec ?? null,
        fetchedAt: meta.fetchedAt ?? record.fetchedAt ?? null,
      });
    }
    const segments = [];
    let initFile = null;
    if (record.mode === 'clip' && record.segments?.length) {
      // One init segment per playlist: keep the segments that share the newest.
      const newestInit = record.segments.at(-1).init?.uri ?? null;
      const usable = record.segments.filter(
        (segment) => (segment.init?.uri ?? null) === newestInit,
      );
      const init = usable.at(-1)?.init ?? null;
      if (init?.bytes) {
        initFile = 'init.mp4';
        await write(path.join(target, initFile), init.bytes);
      }
      for (const segment of usable) {
        const file = `seg-${segment.seq}.${init ? 'm4s' : 'ts'}`;
        await write(path.join(target, file), segment.bytes);
        segments.push({
          file,
          seq: segment.seq,
          duration: segment.duration ?? null,
          capturedAt: segment.capturedAt ?? null,
        });
      }
      if (segments.length)
        await writeFile(
          path.join(target, 'clip.m3u8'),
          clipPlaylist(segments, initFile),
        );
    }
    const meta = {
      readingId,
      incidentId,
      cameraId: record.cameraId,
      cameraName: record.camera?.name ?? null,
      mode: record.mode,
      origin: record.origin,
      captureTime: record.captureTime ?? null,
      captureSource: record.captureSource ?? 'unknown',
      fetchedAt: record.fetchedAt ?? null,
      analyzedAt: record.analyzedAt ?? null,
      frames,
      segments,
      initFile,
      reading: record.reading,
      screen: record.screen
        ? { top: record.screen.top, candidates: record.screen.candidates }
        : null,
    };
    await writeFile(
      path.join(target, 'reading.json'),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    totals.readings += 1;
    return {
      readingId,
      path: relative.split(path.sep).join('/'),
      mode: record.mode,
      at,
      files: [
        ...frames.map((frame) => frame.file),
        ...(segments.length ? ['clip.m3u8'] : []),
      ],
    };
  }

  return {
    /**
     * Save one reading's frames (and source segments, for clips) under an
     * incident. Each reading is saved once per incident.
     * @param {string} incidentId
     * @param {object} record - Reading record with jpegs, frames, segments, times.
     */
    saveReading(incidentId, record) {
      if (!record?.readingId || !INCIDENT_PATTERN.test(incidentId))
        return chain;
      const key = `${incidentId}:${record.readingId}`;
      if (saved.has(key)) return chain;
      saved.add(key);
      chain = chain
        .then(() => persist(incidentId, record))
        .then((entry) => {
          const list = index.get(incidentId) || [];
          list.push(entry);
          index.set(incidentId, list);
        })
        .catch((error) => {
          totals.failed += 1;
          log.warn?.(`[CCTV Watch] evidence save failed: ${error.message}`);
        });
      return chain;
    },

    /** Saved readings for an incident, oldest first. */
    evidenceFor: (incidentId) => index.get(incidentId) || [],

    /** Incidents merged by hand keep the evidence saved under either id. */
    merged(intoId, fromId) {
      const from = index.get(fromId);
      if (!from) return;
      index.set(intoId, [...(index.get(intoId) || []), ...from]);
      index.delete(fromId);
    },

    /**
     * Write the latest view of every incident with saved evidence, keeping
     * those from earlier runs.
     * @param {object[]} views - Public incident views.
     */
    saveIncidents(views) {
      chain = chain
        .then(async () => {
          const current = views
            .filter((view) => index.has(view.id))
            .map((view) => ({ ...view, evidence: index.get(view.id) }));
          const live = new Set(current.map((view) => view.id));
          const kept = [...archive.values()].filter(
            (view) => !live.has(view.id),
          );
          await mkdir(dir, { recursive: true });
          const file = path.join(dir, 'incidents.json');
          await writeFile(
            `${file}.tmp`,
            `${JSON.stringify({ savedAt: now(), incidents: [...kept, ...current] })}\n`,
          );
          await rename(`${file}.tmp`, file);
        })
        .catch((error) => {
          totals.failed += 1;
          log.warn?.(`[CCTV Watch] incident save failed: ${error.message}`);
        });
      return chain;
    },

    /** Load incidents saved by earlier runs; they are read-only history. */
    async loadArchive() {
      try {
        const saved = JSON.parse(
          await readFile(path.join(dir, 'incidents.json'), 'utf8'),
        );
        archive = new Map(
          (saved.incidents || []).map((view) => [
            view.id,
            { ...view, archived: true },
          ]),
        );
        for (const view of archive.values())
          if (Array.isArray(view.evidence) && !index.has(view.id))
            index.set(view.id, view.evidence);
      } catch {
        archive = new Map();
      }
      return [...archive.values()];
    },

    archived: () => [...archive.values()],

    /** Delete evidence days and archived incidents past the retention window. */
    prune() {
      chain = chain
        .then(async () => {
          const cutoff = now() - retentionDays * DAY_MS;
          let days = [];
          try {
            days = await readdir(dir);
          } catch {
            return;
          }
          for (const day of days)
            if (
              DAY_PATTERN.test(day) &&
              Date.parse(`${day}T23:59:59Z`) < cutoff
            )
              await rm(path.join(dir, day), { recursive: true, force: true });
          for (const [id, view] of archive)
            if ((view.lastEvidenceAt ?? 0) < cutoff) {
              archive.delete(id);
              index.delete(id);
            }
          for (const [id, list] of index) {
            const kept = list.filter((entry) => entry.at >= cutoff);
            if (kept.length) index.set(id, kept);
            else index.delete(id);
          }
        })
        .catch((error) => {
          totals.failed += 1;
          log.warn?.(`[CCTV Watch] evidence prune failed: ${error.message}`);
        });
      return chain;
    },

    /**
     * Resolve a requested evidence file, or null when any part is not a
     * name this store writes.
     * @returns {{file:string, contentType:string}|null}
     */
    resolve(day, incidentId, readingId, name) {
      if (
        !DAY_PATTERN.test(day) ||
        !INCIDENT_PATTERN.test(incidentId) ||
        !READING_PATTERN.test(readingId)
      )
        return null;
      const type = FILE_TYPES.find(([pattern]) => pattern.test(name));
      if (!type) return null;
      return {
        file: path.join(dir, day, incidentId, readingId, name),
        contentType: type[1],
      };
    },

    flush: () => chain,
    stats: () => ({ ...totals, incidents: index.size }),
  };
}
