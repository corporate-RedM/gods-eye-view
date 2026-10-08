// CCTV Watch readings log: metadata only, frames saved only under
// evaluation capture, and nothing kept past seven days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReadingsLog } from '../../server/providers/cctv/watch/readingsLog.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T18:00:00Z');

test('readings are logged as metadata; frames are never serialized', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cctv-watch-log-'));
  const log = createReadingsLog({ dir, now: () => NOW });
  await log.write({
    kind: 'reading',
    cameraId: 'us-mn-1',
    camera: { name: 'I-35W at 4th', provider: 'MnDOT' },
    jpegs: [Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  });
  const [file] = readdirSync(dir);
  assert.equal(file, 'readings-2026-10-07.jsonl');
  const line = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  assert.equal(line.jpegs, undefined);
  assert.equal(line.camera, undefined);
  assert.equal(line.cameraName, 'I-35W at 4th');
  assert.equal(log.recent(1)[0].cameraId, 'us-mn-1');
});

test('evaluation capture saves the frames behind a reading, and only then', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cctv-watch-log-'));
  const evalDir = mkdtempSync(path.join(tmpdir(), 'cctv-watch-eval-'));
  const capture = createReadingsLog({ dir, evalDir, now: () => NOW });
  await capture.write({
    kind: 'reading',
    cameraId: 'us-mn-1',
    mode: 'still',
    fetchedAt: NOW,
    jpegs: [Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  });
  assert.equal(
    readdirSync(path.join(evalDir, 'frames', '2026-10-07')).length,
    1,
  );
  await capture.writeScreen({ cameraId: 'us-mn-1', scores: { smoke: 0.1 } });
  assert.ok(readdirSync(evalDir).includes('screens-2026-10-07.jsonl'));

  const off = createReadingsLog({
    dir: mkdtempSync(path.join(tmpdir(), 'x-')),
    now: () => NOW,
  });
  await off.writeScreen({ cameraId: 'us-mn-1' }, Buffer.from([1]));
  assert.equal(off.stats().frames, 0, 'capture off writes no imagery');
});

test('files older than seven days are pruned, newer ones kept', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cctv-watch-log-'));
  const evalDir = mkdtempSync(path.join(tmpdir(), 'cctv-watch-eval-'));
  writeFileSync(path.join(dir, 'readings-2026-09-20.jsonl'), '{}\n');
  writeFileSync(path.join(dir, 'readings-2026-10-05.jsonl'), '{}\n');
  mkdirSync(path.join(evalDir, 'frames', '2026-09-20'), { recursive: true });
  mkdirSync(path.join(evalDir, 'screens', '2026-10-06'), { recursive: true });
  writeFileSync(path.join(evalDir, 'screens-2026-09-21.jsonl'), '{}\n');
  mkdirSync(path.join(evalDir, 'ucf-crime'));
  const log = createReadingsLog({ dir, evalDir, now: () => NOW });
  await log.prune();
  assert.deepEqual(readdirSync(dir), ['readings-2026-10-05.jsonl']);
  assert.deepEqual(readdirSync(path.join(evalDir, 'frames')), []);
  assert.deepEqual(readdirSync(path.join(evalDir, 'screens')), ['2026-10-06']);
  assert.ok(
    readdirSync(evalDir).includes('ucf-crime'),
    'folders without a date are left alone',
  );
  assert.equal(
    readdirSync(evalDir).includes('screens-2026-09-21.jsonl'),
    false,
  );
  assert.ok(NOW - Date.parse('2026-09-30') > 7 * DAY);
});
