// CCTV Watch evidence store: incident frames kept seven days, motion
// evidence kept as the analyzed frames plus the untouched source segments,
// and only names the store writes can be served back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clipPlaylist,
  createEvidenceStore,
} from '../../server/providers/cctv/watch/evidenceStore.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T18:00:00Z');
const JPEG = (n) => Buffer.from([0xff, 0xd8, n, 0xff, 0xd9]);

const stillRecord = (overrides = {}) => ({
  readingId: 'us-mn-1-1791393374899-still',
  cameraId: 'us-mn-1',
  camera: { name: 'I-35W at 4th' },
  mode: 'still',
  origin: 'sweep',
  captureTime: NOW - 60_000,
  captureSource: 'last-modified',
  fetchedAt: NOW - 50_000,
  analyzedAt: NOW - 40_000,
  frames: [{ captureTime: NOW - 60_000, captureSource: 'last-modified' }],
  jpegs: [JPEG(1)],
  reading: { ok: true, visibility: 'good', observations: [] },
  ...overrides,
});

test('a still reading is saved once per incident, with its times', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cctv-evidence-'));
  const store = createEvidenceStore({ dir, now: () => NOW });
  store.saveReading('inc-abc-1', stillRecord());
  await store.saveReading('inc-abc-1', stillRecord());
  const [entry] = store.evidenceFor('inc-abc-1');
  assert.equal(store.evidenceFor('inc-abc-1').length, 1);
  assert.equal(entry.path, '2026-10-07/inc-abc-1/us-mn-1-1791393374899-still');
  const folder = path.join(dir, entry.path);
  assert.deepEqual(readdirSync(folder).sort(), ['frame-0.jpg', 'reading.json']);
  assert.deepEqual(readFileSync(path.join(folder, 'frame-0.jpg')), JPEG(1));
  const meta = JSON.parse(readFileSync(path.join(folder, 'reading.json')));
  assert.equal(meta.captureTime, NOW - 60_000);
  assert.equal(meta.fetchedAt, NOW - 50_000);
  assert.equal(meta.analyzedAt, NOW - 40_000);
  assert.equal(meta.frames[0].captureSource, 'last-modified');
});

test('a clip keeps the analyzed frames and the untouched source segments', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cctv-evidence-'));
  const store = createEvidenceStore({ dir, now: () => NOW });
  const init = {
    uri: 'https://cams.example/init.mp4',
    bytes: Buffer.from('init'),
  };
  await store.saveReading(
    'inc-abc-2',
    stillRecord({
      readingId: 'us-mn-1-clip',
      mode: 'clip',
      origin: 'focus',
      jpegs: [JPEG(1), JPEG(2)],
      frames: [
        {
          captureTime: NOW - 6000,
          captureSource: 'program-date-time',
          offsetSec: 0,
        },
        {
          captureTime: NOW - 5000,
          captureSource: 'program-date-time',
          offsetSec: 1,
        },
      ],
      segments: [
        {
          seq: 41,
          duration: 2,
          bytes: Buffer.from('seg41'),
          capturedAt: NOW - 7000,
          init,
        },
        {
          seq: 42,
          duration: 2,
          bytes: Buffer.from('seg42'),
          capturedAt: NOW - 5000,
          init,
        },
      ],
    }),
  );
  const [entry] = store.evidenceFor('inc-abc-2');
  const folder = path.join(dir, entry.path);
  assert.deepEqual(readdirSync(folder).sort(), [
    'clip.m3u8',
    'frame-0.jpg',
    'frame-1.jpg',
    'init.mp4',
    'reading.json',
    'seg-41.m4s',
    'seg-42.m4s',
  ]);
  assert.equal(readFileSync(path.join(folder, 'seg-42.m4s'), 'utf8'), 'seg42');
  const meta = JSON.parse(readFileSync(path.join(folder, 'reading.json')));
  assert.deepEqual(
    meta.frames.map((frame) => [frame.offsetSec, frame.captureTime]),
    [
      [0, NOW - 6000],
      [1, NOW - 5000],
    ],
  );
  assert.equal(JSON.stringify(meta).includes('cams.example'), false);
  const playlist = readFileSync(path.join(folder, 'clip.m3u8'), 'utf8');
  assert.match(playlist, /#EXT-X-MAP:URI="init.mp4"/);
  assert.match(playlist, /seg-41\.m4s\n.*\n.*\nseg-42\.m4s/);
  assert.match(playlist, /#EXT-X-ENDLIST/);
});

test('transport-stream segments play without an init segment', () => {
  const playlist = clipPlaylist(
    [
      { file: 'seg-7.ts', seq: 7, duration: 2.5, capturedAt: null },
      { file: 'seg-8.ts', seq: 8, duration: null, capturedAt: null },
    ],
    null,
  );
  assert.equal(playlist.includes('EXT-X-MAP'), false);
  assert.match(playlist, /#EXT-X-TARGETDURATION:3/);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:7/);
  assert.match(playlist, /#EXTINF:2\.500,\nseg-7\.ts/);
});

test('only names the store writes resolve', () => {
  const store = createEvidenceStore({ dir: '/srv/evidence' });
  assert.deepEqual(
    store.resolve('2026-10-07', 'inc-abc-1', 'cam-1-still', 'frame-0.jpg'),
    {
      file: '/srv/evidence/2026-10-07/inc-abc-1/cam-1-still/frame-0.jpg',
      contentType: 'image/jpeg',
    },
  );
  assert.equal(
    store.resolve('2026-10-07', 'inc-abc-1', 'cam-1', 'clip.m3u8').contentType,
    'application/vnd.apple.mpegurl',
  );
  for (const parts of [
    ['..', 'inc-abc-1', 'cam-1', 'frame-0.jpg'],
    ['2026-10-07', '../etc', 'cam-1', 'frame-0.jpg'],
    ['2026-10-07', 'inc-abc-1', '..', 'frame-0.jpg'],
    ['2026-10-07', 'inc-abc-1', 'cam-1', 'passwd'],
    ['2026-10-07', 'inc-abc-1', 'cam-1', '../reading.json'],
  ])
    assert.equal(store.resolve(...parts), null, parts.join('/'));
});

test('evidence and archived incidents older than seven days are pruned', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cctv-evidence-'));
  mkdirSync(path.join(dir, '2026-09-20', 'inc-old-1', 'r'), {
    recursive: true,
  });
  let clock = NOW;
  const store = createEvidenceStore({ dir, now: () => clock });
  await store.saveReading('inc-abc-3', stillRecord());
  await store.saveIncidents([
    { id: 'inc-abc-3', lastEvidenceAt: NOW - 60_000, headline: { text: 'x' } },
    { id: 'inc-abc-4', lastEvidenceAt: NOW, headline: { text: 'no evidence' } },
  ]);
  const saved = JSON.parse(readFileSync(path.join(dir, 'incidents.json')));
  assert.deepEqual(
    saved.incidents.map((view) => view.id),
    ['inc-abc-3'],
    'only incidents with saved evidence',
  );
  const reopened = createEvidenceStore({ dir, now: () => clock });
  const archive = await reopened.loadArchive();
  assert.equal(archive[0].archived, true);
  assert.equal(reopened.evidenceFor('inc-abc-3').length, 1);
  await reopened.prune();
  assert.deepEqual(readdirSync(dir).sort(), ['2026-10-07', 'incidents.json']);
  clock = NOW + 8 * DAY;
  await reopened.prune();
  assert.deepEqual(readdirSync(dir), ['incidents.json']);
  assert.deepEqual(reopened.archived(), []);
  assert.deepEqual(reopened.evidenceFor('inc-abc-3'), []);
});
