import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  probeCameraStream,
  decodeVideoBytes,
  _resetStreamHealthForTest,
  knownDeadStreams,
  settleStreamHealthChecks,
} from '../../server/providers/cctv/streamHealth.js';
import { createCatalogPages } from '../../server/providers/cctv/catalogPages.js';
import { syncProjectionVideoTexture } from '../layers/cctv/projection.js';

test('hidden projection stops video uploads without stopping panel playback and restores on showing', () => {
  const writes = [];
  const video = { videoWidth: 1280, videoHeight: 720, paused: false };
  const canvas = {};
  const runtime = {
    video,
    canvas,
    planeMaterial: {
      set image(value) {
        writes.push(value);
      },
    },
  };
  syncProjectionVideoTexture(runtime, false);
  assert.deepEqual(writes, [canvas]);
  syncProjectionVideoTexture(runtime, true);
  assert.equal(writes.at(-1), video);
  assert.equal(video.width, 1280);
  const count = writes.length;
  syncProjectionVideoTexture(runtime, true);
  assert.equal(writes.length, count);
  video.videoWidth = 640;
  syncProjectionVideoTexture(runtime, true);
  assert.equal(video.width, 640);
  syncProjectionVideoTexture(runtime, false);
  assert.equal(writes.at(-1), canvas);
  assert.equal(video.paused, false);
});
import {
  filterCameraPickerRows,
  cameraPickerLabel,
} from '../ui/cctvCataloguePicker.js';

test('the full catalogue picker includes every row and finds the last camera without a result cap', () => {
  const cameras = Array.from({ length: 60000 }, (_, i) => ({
    id: `camera-${i}`,
    name: `Road ${i}`,
    city: 'Toronto',
    provider: 'Traffic service',
    feedType: 'hls',
  }));
  assert.equal(filterCameraPickerRows(cameras, '').length, 60000);
  assert.equal(filterCameraPickerRows(cameras, 'Toronto').length, 60000);
  assert.deepEqual(filterCameraPickerRows(cameras, 'camera-59999'), [
    cameras.at(-1),
  ]);
  const label = cameraPickerLabel(cameras.at(-1));
  assert.equal(label.name, 'Road 59999');
  assert.equal(
    cameraPickerLabel({ name: 'I-20 at Main — I-20 at Main' }).name,
    'I-20 at Main',
  );
  assert.equal(
    cameraPickerLabel({ name: 'I-20 — Eastbound' }).name,
    'I-20 — Eastbound',
  );
  assert.equal(
    label.details,
    'Toronto · Traffic service · HLS · Not checked yet',
  );
});

test('catalogue pages remain bounded and stable across provider refreshes', () => {
  let now = 0;
  const pages = createCatalogPages({ now: () => now });
  const sources = Array.from({ length: 1000 }, (_, id) => ({ id }));
  const first = pages(sources, new URLSearchParams('limit=99999'));
  assert.equal(first.sources.length, 256);
  const second = pages(
    [{ id: 'new' }],
    new URLSearchParams({
      snapshot: first.page.snapshot,
      offset: first.page.next,
    }),
  );
  assert.equal(second.sources[0].id, 256);
  assert.equal(second.page.total, 1000);
  now = 16 * 60 * 1000;
  assert.equal(
    pages(sources, new URLSearchParams({ snapshot: first.page.snapshot }))
      .expired,
    true,
  );
});

test('an HLS playlist is insufficient: a proxy-compatible segment must decode', async () => {
  const camera = { feedType: 'hls', url: 'https://hls.test/live.m3u8' };
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url);
    return new Response(
      url.endsWith('.ts')
        ? 'media'
        : '#EXTM3U\n#EXTINF:4,\none.ts\n#EXTINF:4,\ntwo.ts\n',
    );
  };
  const failed = await probeCameraStream(camera, {
    fetchImpl,
    decode: async () => false,
  });
  assert.equal(failed.status, 'unverified');
  const good = await probeCameraStream(camera, {
    fetchImpl,
    decode: async (bytes) => bytes.toString() === 'media',
  });
  assert.equal(good.live, true);
  assert.ok(paths.includes('https://hls.test/one.ts'));
  assert.ok(paths.includes('https://hls.test/two.ts'));
});

test('HLS cannot be marked available when an older startup segment fails', async () => {
  const result = await probeCameraStream(
    { feedType: 'hls', url: 'https://startup.test/live.m3u8' },
    {
      fetchImpl: async (url) =>
        new Response(
          url.endsWith('.m3u8')
            ? '#EXTM3U\n#EXTINF:4,\nold.ts\n#EXTINF:4,\nnew.ts\n'
            : 'media',
          { status: url.endsWith('old.ts') ? 403 : 200 },
        ),
      decode: async () => true,
    },
  );
  assert.equal(result.status, 'unavailable');
});

test('MJPEG requires multipart content and two decoded frames, not an image response', async () => {
  const camera = { feedType: 'mjpeg', url: 'https://mjpeg.test/video' };
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);
  const fetchImpl = async () =>
    new Response(Buffer.concat([jpeg, jpeg]), {
      headers: { 'content-type': 'multipart/x-mixed-replace; boundary=frame' },
    });
  assert.equal(
    (
      await probeCameraStream(camera, {
        fetchImpl,
        decode: async (bytes) => bytes.equals(jpeg),
      })
    ).live,
    true,
  );
  const single = await probeCameraStream(camera, {
    fetchImpl: async () =>
      new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
    decode: async () => true,
  });
  assert.equal(single.live, false);
});

test('embeds remain unverified, 403 is unavailable, and Retry-After prevents more requests', async () => {
  const camera = { feedType: 'iframe', embedUrl: 'https://embed.test/player' };
  assert.equal(
    (
      await probeCameraStream(camera, {
        fetchImpl: async () => new Response('<video></video>'),
      })
    ).status,
    'unverified',
  );
  assert.equal(
    (
      await probeCameraStream(camera, {
        fetchImpl: async () => new Response('', { status: 403 }),
      })
    ).status,
    'unavailable',
  );
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  };
  const limited = await probeCameraStream(camera, { fetchImpl });
  assert.ok(limited.retryAt >= Date.now() + 119000);
  await probeCameraStream(camera, { fetchImpl });
  assert.equal(calls, 1);
  _resetStreamHealthForTest();
});

test('actual decoder rejects arbitrary bytes and decodes an MPEG-TS video', async () => {
  assert.equal(await decodeVideoBytes(Buffer.from('not a video')), false);
  const fixture = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=32x32:r=5',
    '-t',
    '1',
    '-threads',
    '1',
    '-c:v',
    'mpeg2video',
    '-f',
    'mpegts',
    'pipe:1',
  ]);
  assert.equal(fixture.status, 0);
  assert.equal(await decodeVideoBytes(fixture.stdout), true);
  const still = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=32x32',
    '-frames:v',
    '1',
    '-threads',
    '1',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    'pipe:1',
  ]);
  assert.equal(still.status, 0);
  assert.equal(await decodeVideoBytes(still.stdout, { format: 'jpeg' }), true);
  assert.equal(await decodeVideoBytes(still.stdout, { format: 'mp4' }), false);
  assert.equal(await decodeVideoBytes(still.stdout, { format: 'webm' }), false);
  assert.equal(
    await decodeVideoBytes(still.stdout, { format: 'mpegts' }),
    false,
  );
});

test('a rate-limited host defers its remaining cameras without recording fictitious checks', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cctv-backoff-test-'));
  const previous = process.env.CCTV_STREAM_HEALTH_FILE;
  process.env.CCTV_STREAM_HEALTH_FILE = path.join(dir, 'health.json');
  _resetStreamHealthForTest();
  t.after(async () => {
    await settleStreamHealthChecks();
    _resetStreamHealthForTest();
    if (previous === undefined) delete process.env.CCTV_STREAM_HEALTH_FILE;
    else process.env.CCTV_STREAM_HEALTH_FILE = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  };
  const urls = Array.from(
    { length: 100 },
    (_, i) => `https://backoff.test/${i}.m3u8`,
  );
  await knownDeadStreams(urls, { fetchImpl });
  await settleStreamHealthChecks();
  assert.ok(calls > 0 && calls <= 2);
  const attempts = calls;
  await knownDeadStreams(urls, { fetchImpl });
  await settleStreamHealthChecks();
  assert.equal(calls, attempts);
  const verdicts = JSON.parse(
    await fs.readFile(process.env.CCTV_STREAM_HEALTH_FILE, 'utf8'),
  );
  assert.ok(Object.keys(verdicts).length <= 2);
});
