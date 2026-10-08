/**
 * Append-only log of CCTV Watch readings: metadata only, one JSON line per
 * reading, report change or focus session, kept 7 days. It is what the
 * quality and capacity measurements are computed from.
 *
 * Evaluation capture (CCTV_WATCH_EVAL_CAPTURE=1, off by default) also saves
 * the frames behind each describer reading under output/cctv-eval/ so they
 * can be labelled; nothing else writes imagery here.
 */
import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (epochMs) => new Date(epochMs).toISOString().slice(0, 10);
const safeName = (value) =>
  String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);

/**
 * @param {object} options
 * @param {string} options.dir - Log directory.
 * @param {string|null} [options.evalDir] - Frame capture directory; null keeps it off.
 */
export function createReadingsLog({
  dir,
  evalDir = null,
  retentionDays = 7,
  recentLimit = 300,
  now = Date.now,
  log = console,
} = {}) {
  const recent = [];
  let chain = Promise.resolve();
  let made = new Set();
  const totals = { written: 0, frames: 0, failed: 0 };

  const ensureDir = async (target) => {
    if (made.has(target)) return;
    await mkdir(target, { recursive: true });
    made.add(target);
  };

  async function persist(record, jpegs) {
    const at = record.at;
    if (evalDir && jpegs?.length) {
      const frameDir = path.join(evalDir, 'frames', dayKey(at));
      await ensureDir(frameDir);
      record.evalFrames = [];
      for (const [index, jpeg] of jpegs.entries()) {
        const name = `${safeName(record.cameraId)}-${record.fetchedAt ?? at}-${record.mode}-${index}.jpg`;
        await writeFile(path.join(frameDir, name), jpeg);
        record.evalFrames.push(path.join('frames', dayKey(at), name));
        totals.frames += 1;
      }
    }
    await ensureDir(dir);
    await appendFile(
      path.join(dir, `readings-${dayKey(at)}.jsonl`),
      `${JSON.stringify(record)}\n`,
    );
    totals.written += 1;
  }

  return {
    /**
     * Log one record. Buffers (`jpegs`) are never serialized; they are saved
     * as evaluation frames only when capture is on.
     */
    write(record) {
      // Frame and segment bytes never go into the log.
      const { jpegs, camera, segments, ...rest } = record;
      const entry = {
        at: now(),
        ...rest,
        ...(camera
          ? { cameraName: camera.name, provider: camera.provider }
          : {}),
        ...(segments?.length ? { segmentCount: segments.length } : {}),
      };
      recent.push(entry);
      if (recent.length > recentLimit) recent.shift();
      chain = chain
        .then(() => persist(entry, jpegs))
        .catch((error) => {
          totals.failed += 1;
          log.warn?.(
            `[CCTV Watch] readings log write failed: ${error.message}`,
          );
        });
      return chain;
    },

    /**
     * Evaluation capture only: log one screened frame's full scores, and save
     * the frame itself when it was sampled. Does nothing with capture off.
     * @param {object} record - Screen metadata (scores, novelty, times).
     * @param {Buffer|null} jpeg - The frame, when sampled for labelling.
     */
    writeScreen(record, jpeg = null) {
      if (!evalDir) return chain;
      const entry = { at: now(), ...record };
      chain = chain
        .then(async () => {
          const day = dayKey(entry.at);
          if (jpeg) {
            const frameDir = path.join(evalDir, 'screens', day);
            await ensureDir(frameDir);
            const name = `${safeName(entry.cameraId)}-${entry.fetchedAt ?? entry.at}.jpg`;
            await writeFile(path.join(frameDir, name), jpeg);
            entry.evalFrame = path.join('screens', day, name);
            totals.frames += 1;
          }
          await ensureDir(evalDir);
          await appendFile(
            path.join(evalDir, `screens-${day}.jsonl`),
            `${JSON.stringify(entry)}\n`,
          );
        })
        .catch((error) => {
          totals.failed += 1;
          log.warn?.(`[CCTV Watch] screen log write failed: ${error.message}`);
        });
      return chain;
    },

    /** Newest first. */
    recent(limit = 50) {
      return recent.slice(-limit).reverse();
    },

    /** Remove daily files older than the retention window. */
    async prune() {
      const cutoff = dayKey(now() - retentionDays * DAY_MS);
      const targets = [
        dir,
        ...(evalDir
          ? [
              evalDir,
              path.join(evalDir, 'frames'),
              path.join(evalDir, 'screens'),
            ]
          : []),
      ];
      for (const target of targets) {
        let names = [];
        try {
          names = await readdir(target);
        } catch {
          continue;
        }
        for (const name of names) {
          const day = /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
          if (day && day < cutoff)
            await rm(path.join(target, name), { recursive: true, force: true });
        }
      }
      made = new Set();
    },

    stats: () => ({ ...totals, evalCapture: Boolean(evalDir) }),
    flush: () => chain,
  };
}
