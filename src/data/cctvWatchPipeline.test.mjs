// CCTV Watch frame pipeline parts: keyframe decoding, camera choice, the
// detector child's environment and lifecycle, the sweep, and profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  ffmpegFrameArgs,
  fetchNewestSegments,
  splitJpegs,
} from '../../server/providers/cctv/watch/keyframes.js';
import {
  chooseCameras,
  facingScore,
} from '../../server/providers/cctv/watch/cameraChoice.js';
import {
  createDetectorClient,
  DetectorUnavailableError,
  detectorEnvironment,
} from '../../server/providers/cctv/watch/detectorClient.js';
import { createSweep } from '../../server/providers/cctv/watch/sweep.js';
import { createFreshnessTracker } from '../../server/providers/cctv/watch/freshness.js';
import {
  createProfileStore,
  dayPart,
  summariseProfile,
} from '../../server/providers/cctv/watch/profiles.js';

test('ffmpeg output splits into one buffer per JPEG', () => {
  const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0x00, 3, 0xff, 0xd9]);
  const b = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]);
  const frames = splitJpegs(
    Buffer.concat([a, b, Buffer.from([0xff, 0xd8, 7])]),
  );
  assert.equal(frames.length, 2, 'a truncated trailing frame is dropped');
  assert.deepEqual(frames[0], a);
  assert.deepEqual(frames[1], b);
});

test('ffmpeg decodes for analysis only: frames out, nothing re-encoded to video', () => {
  const sampled = ffmpegFrameArgs({ fps: 1, maxFrames: 6, maxEdge: 640 });
  assert.ok(sampled.includes("fps=1,scale='min(640,iw)':-2"));
  assert.deepEqual(sampled.slice(-7), [
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-q:v',
    '4',
    'pipe:1',
  ]);
  const keyframe = ffmpegFrameArgs({ fps: null, maxFrames: 6, maxEdge: 640 });
  assert.equal(keyframe[keyframe.indexOf('-frames:v') + 1], '1');
});

function hlsFetch(files) {
  const fetched = [];
  const impl = async (url) => {
    fetched.push(url);
    const body = files[url];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(
      typeof body === 'string' ? body : new Uint8Array(body),
      { status: 200 },
    );
  };
  return { impl, fetched };
}

test('newest segments are fetched with their program date-times', async () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:10',
    '#EXT-X-PROGRAM-DATE-TIME:2026-10-07T18:00:00.000Z',
    '#EXTINF:4.0,',
    'seg10.ts',
    '#EXTINF:4.0,',
    'seg11.ts',
  ].join('\n');
  const { impl, fetched } = hlsFetch({
    'https://cams.example/live/playlist.m3u8': playlist,
    'https://cams.example/live/seg11.ts': [0x47, 1, 2],
  });
  const result = await fetchNewestSegments(
    { url: 'https://cams.example/live/playlist.m3u8' },
    { fetchImpl: impl, maxSegments: 1 },
  );
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].seq, 11);
  assert.equal(
    result.segments[0].capturedAt,
    Date.parse('2026-10-07T18:00:04Z'),
  );
  assert.equal(result.newestSeq, 11);
  assert.equal(fetched.includes('https://cams.example/live/seg10.ts'), false);
  const none = await fetchNewestSegments(
    { url: 'https://cams.example/live/playlist.m3u8' },
    { fetchImpl: impl, sinceSeq: 11 },
  );
  assert.equal(
    none.segments.length,
    0,
    'nothing newer than what was already read',
  );
});

test('an fMP4 init segment is fetched once per camera', async () => {
  const playlist =
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg5.m4s\n';
  const { impl, fetched } = hlsFetch({
    'https://cams.example/a/chunklist.m3u8': playlist,
    'https://cams.example/a/init.mp4': [0, 0, 0, 1],
    'https://cams.example/a/seg5.m4s': [0, 0, 0, 2],
  });
  const initCache = new Map();
  const source = { url: 'https://cams.example/a/chunklist.m3u8' };
  await fetchNewestSegments(source, { fetchImpl: impl, initCache });
  await fetchNewestSegments(source, { fetchImpl: impl, initCache });
  assert.equal(fetched.filter((url) => url.endsWith('init.mp4')).length, 1);
});

test('an agency-linked camera ranks first; a trusted heading ranks facing over facing away', () => {
  const place = { lat: 43.03, lon: -87.96 };
  const cameras = [
    {
      id: 'away',
      lat: 43.029,
      lon: -87.96,
      headingDeg: 180,
      fovDeg: 60,
      headingConfidence: 'high',
      url: 'u1',
    },
    {
      id: 'facing',
      lat: 43.029,
      lon: -87.96,
      headingDeg: 0,
      fovDeg: 60,
      headingConfidence: 'high',
      url: 'u2',
    },
    { id: 'far', lat: 43.2, lon: -87.96, url: 'u3' },
    { id: 'linked', lat: 43.05, lon: -87.9, url: 'agency-linked' },
  ];
  const chosen = chooseCameras(place, cameras, {
    linkedUrls: ['agency-linked'],
    limit: 3,
  });
  assert.deepEqual(
    chosen.map((c) => c.cameraId),
    ['linked', 'facing', 'away'],
  );
  assert.equal(
    chosen.some((c) => c.cameraId === 'far'),
    false,
    'outside the radius',
  );
  const untrusted = facingScore(
    {
      lat: 43.029,
      lon: -87.96,
      headingDeg: 180,
      fovDeg: 60,
      headingConfidence: 'low',
    },
    place,
  );
  assert.ok(
    untrusted > 0.3 && untrusted < 0.5,
    'an untrusted heading stays near neutral',
  );
});

test('the detector child never sees provider keys and stays offline', () => {
  const env = detectorEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/bk',
    OPENAI_API_KEY: 'sk-secret',
    GOOGLE_MAPS_API_KEY: 'g-secret',
    ONTARIO_511_API_KEY: 'o-secret',
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GOOGLE_MAPS_API_KEY, undefined);
  assert.equal(env.ONTARIO_511_API_KEY, undefined);
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(env.PATH, '/usr/bin');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.pid = 4242;
  child.killed = [];
  child.kill = (signal) => {
    child.killed.push(signal);
    setImmediate(() => child.emit('exit', null, signal));
  };
  return child;
}

test('the detector is ready only when its health says so, and refuses work before', async () => {
  const children = [];
  let healthy = false;
  const timers = [];
  const client = createDetectorClient({
    root: '/repo',
    python: 'tools/cctv-detector/venv/bin/python',
    spawnImpl: (cmd, args, options) => {
      children.push({ cmd, args, options });
      return Object.assign(fakeChild(), {});
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ ready: healthy }), { status: 200 }),
    setTimer: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    clearTimer: () => {},
    log: { info() {}, warn() {} },
  });
  client.start();
  assert.equal(
    children[0].cmd,
    '/repo/tools/cctv-detector/venv/bin/python',
    'the repo venv, not a global python',
  );
  assert.deepEqual(children[0].args.slice(1), [
    '--port',
    '4191',
    '--max-batch',
    '8',
  ]);
  await assert.rejects(
    client.screen({ frames: [], prompts: [] }),
    DetectorUnavailableError,
  );
  await timers.shift()();
  assert.equal(client.status().state, 'loading');
  healthy = true;
  await timers.shift()();
  assert.equal(client.status().state, 'ready');
  client.stop();
  assert.equal(
    client.status().state === 'stopped' || client.status().pid !== null,
    true,
  );
});

test('the sweep passes on fresh captures only and respects per-host limits', async () => {
  let clock = 0;
  const frames = [];
  const fetchCount = new Map();
  const body = new Map([
    ['a1', Buffer.from('frame-a-1')],
    ['a2', Buffer.from('frame-a-1')],
    ['b1', Buffer.from('frame-b-1')],
  ]);
  const ticks = [];
  const sweep = createSweep({
    listCameras: async () => [
      {
        id: 'a1',
        snapshotUrl: 'https://host-a.example/a1.jpg',
        url: 'https://host-a.example/a1.m3u8',
      },
      {
        id: 'a2',
        snapshotUrl: 'https://host-a.example/a2.jpg',
        url: 'https://host-a.example/a2.m3u8',
      },
      {
        id: 'b1',
        snapshotUrl: 'https://host-b.example/b1.jpg',
        url: 'https://host-b.example/b1.m3u8',
      },
      {
        id: 'focused',
        snapshotUrl: 'https://host-b.example/f.jpg',
        url: 'https://host-b.example/f.m3u8',
      },
    ],
    fetchStill: async (source) => {
      fetchCount.set(source.id, (fetchCount.get(source.id) || 0) + 1);
      return {
        ok: true,
        body: body.get(source.id) || Buffer.from('x'),
        contentType: 'image/jpeg',
        lastModified: null,
      };
    },
    grabKeyframe: async () => null,
    freshness: createFreshnessTracker(),
    isFocused: (id) => id === 'focused',
    onFrame: (frame) => frames.push(frame.cameraId),
    hostConcurrency: 1,
    initialSpreadMs: 0,
    now: () => clock,
    setTimer: (fn) => {
      ticks.push(fn);
      return { unref() {} };
    },
    clearTimer: () => {},
    random: () => 0,
  });
  sweep.start();
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    ticks.shift()?.();
  }
  assert.equal(
    fetchCount.has('focused'),
    false,
    'a camera in focus is skipped',
  );
  assert.deepEqual(frames.sort(), ['a1', 'a2', 'b1']);
  clock += 10 * 60_000;
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    ticks.shift()?.();
  }
  assert.ok(fetchCount.get('a1') >= 2, 'fetched again after its interval');
  assert.deepEqual(
    frames.sort(),
    ['a1', 'a2', 'b1'],
    'the same bytes again are not a new frame',
  );
  assert.ok(sweep.stats().totals.repeats >= 1);
  sweep.stop();
});

function frozenStillSweep(
  staleStillVideo,
  { videoWorks = true, stillRecoversAt = null } = {},
) {
  let clock = 0;
  const frames = [];
  const ticks = [];
  let grabs = 0;
  const sweep = createSweep({
    listCameras: async () => [
      {
        id: 'cam',
        snapshotUrl: 'https://host.example/cam.jpg',
        url: 'https://host.example/cam.m3u8',
      },
    ],
    // The agency still never changes after the first capture, unless it
    // recovers at a set time.
    fetchStill: async () => ({
      ok: true,
      body: Buffer.from(
        stillRecoversAt !== null && clock >= stillRecoversAt
          ? `live-${clock}`
          : 'frozen',
      ),
      contentType: 'image/jpeg',
      lastModified: null,
    }),
    grabKeyframe: async () => {
      grabs += 1;
      if (!videoWorks) return null;
      return {
        jpeg: Buffer.from([0xff, 0xd8, grabs, 0xff, 0xd9]),
        segmentId: `seg-${grabs}`,
        captureTime: null,
        captureSource: 'unknown',
        bytes: 100,
        decodeMs: 12,
      };
    },
    freshness: createFreshnessTracker(),
    onFrame: (frame) => frames.push(frame.kind),
    staleStillVideo,
    initialSpreadMs: 0,
    now: () => clock,
    setTimer: (fn) => {
      ticks.push(fn);
      return { unref() {} };
    },
    clearTimer: () => {},
    random: () => 0,
  });
  const run = async (minutes) => {
    for (let i = 0; i < minutes * 4; i += 1) {
      clock += 15_000;
      await new Promise((resolve) => setImmediate(resolve));
      ticks.shift()?.();
    }
  };
  return { sweep, frames, run, grabs: () => grabs };
}

test('a camera whose still freezes is watched through its live video', async () => {
  const { sweep, frames, run, grabs } = frozenStillSweep(true);
  sweep.start();
  await run(20);
  assert.equal(frames[0], 'still', 'the first capture is fresh');
  assert.ok(grabs() >= 1, 'keyframes after the still froze');
  assert.ok(frames.includes('keyframe'));
  assert.equal(sweep.stats().totals.frozenStills, 1);
  assert.equal(sweep.stats().coverage.watchedByVideo, 1);
  assert.equal(
    sweep.stats().coverage.stale,
    0,
    'fresh video segments keep the camera covered',
  );
  const { totals, videoDecodeMsAvg } = sweep.stats();
  assert.equal(totals.fallbackFetches, grabs(), 'the fallback cost is counted');
  assert.equal(totals.fallbackBytes, 100 * grabs());
  assert.equal(videoDecodeMsAvg, 12);
  sweep.stop();
});

test('a frozen still whose video is unavailable stays stale', async () => {
  const { sweep, run, grabs } = frozenStillSweep(true, { videoWorks: false });
  sweep.start();
  await run(20);
  assert.ok(grabs() >= 1, 'the video was tried');
  assert.equal(sweep.stats().coverage.stale, 1);
  sweep.stop();
});

test('the camera goes back to its still once the still changes again', async () => {
  const { sweep, frames, run } = frozenStillSweep(true, {
    stillRecoversAt: 20 * 60_000,
  });
  sweep.start();
  await run(45);
  const firstKeyframe = frames.indexOf('keyframe');
  assert.ok(firstKeyframe > 0, 'video while the still was frozen');
  assert.equal(frames.at(-1), 'still', 'stills again after the recheck');
  assert.equal(sweep.stats().coverage.watchedByVideo, 0);
  assert.equal(sweep.stats().coverage.stale, 0);
  sweep.stop();
});

test('without the switch, a frozen still stays a stale camera', async () => {
  const { sweep, frames, run, grabs } = frozenStillSweep(false);
  sweep.start();
  await run(20);
  assert.equal(grabs(), 0);
  assert.deepEqual(frames, ['still']);
  assert.equal(sweep.stats().coverage.stale, 1);
  sweep.stop();
});

test('profiles are shares of samples, and a day part with no sample asks for one', () => {
  const store = createProfileStore();
  const at = Date.parse('2026-10-07T18:00:00Z');
  store.addSample(
    'cam',
    { ok: true, scene: 'highway', roadVisible: true, peopleScale: 'none' },
    { at, part: 'day' },
  );
  assert.equal(store.needsSample('cam', 'night', at), true);
  assert.equal(store.needsSample('cam', 'day', at), false);
  store.addSample(
    'cam',
    { ok: true, scene: 'street', roadVisible: true, peopleScale: 'usable' },
    { at, part: 'night' },
  );
  const summary = summariseProfile([
    {
      scene: 'highway',
      roadVisible: true,
      peopleScale: 'none',
      dayPart: 'day',
      at,
    },
    {
      scene: 'highway',
      roadVisible: true,
      peopleScale: 'usable',
      dayPart: 'night',
      at,
    },
  ]);
  assert.equal(
    summary.peopleUsable,
    0.5,
    'one dark or empty picture cannot exclude a camera',
  );
  assert.equal(summary.scene, 'highway');
  assert.equal(
    store.needsSample('cam', 'day', at + 4 * 24 * 60 * 60 * 1000),
    true,
    'profiles are refreshed',
  );
});

test('day and night follow the camera longitude, not the server clock', () => {
  const noonUtc = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(dayPart(noonUtc, 0), 'day');
  assert.equal(dayPart(noonUtc, -120), 'night', '04:00 local in the Pacific');
});
