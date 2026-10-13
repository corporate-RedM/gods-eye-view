import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFullCatalog,
  createLiveCameraFilter,
} from '../../server/providers/cctv/fullCatalog.js';
import {
  eyeCameraPacks,
  cameraToNative,
} from '../../server/standalone/eye-cameras.js';
import { osirisCameraRegions } from '../../integrations/osiris/app/api/cctv/route.js';
import { cctvProxy } from '../../server/providers/cctv.js';

test('live admission retains unverified video and excludes stills and website-only links', async () => {
  const filter = createLiveCameraFilter();
  const rows = [
    'image',
    'external',
    'mp4',
    'webm',
    'mjpeg',
    'hls',
    'iframe',
  ].map((feedType) => ({
    id: feedType,
    feedType,
    url: 'https://unavailable.invalid/feed',
    embedUrl: feedType === 'iframe' ? 'https://unavailable.invalid/player' : '',
  }));
  assert.deepEqual(
    (await filter(rows)).map((row) => row.id),
    ['mp4', 'webm', 'mjpeg', 'hls', 'iframe'],
  );
  assert.equal(filter.liveOnly, true);
});

test('recorded dead URLs are excluded across packs while unverified feeds survive', async () => {
  let dead = new Set(['https://camera.test/dead.m3u8']);
  const filter = createLiveCameraFilter({ getDeadStreams: async () => dead });
  let fail = false;
  const rows = [
    {
      id: 'native-dead',
      feedType: 'hls',
      url: 'https://camera.test/dead.m3u8',
    },
    {
      id: 'osiris-dead-alias',
      feedType: 'hls',
      url: 'https://camera.test/dead.m3u8',
    },
    {
      id: 'unverified',
      feedType: 'hls',
      url: 'https://camera.test/unknown.m3u8',
    },
    {
      id: 'unverified-embed',
      feedType: 'iframe',
      embedUrl: 'https://camera.test/player',
    },
  ];
  const catalog = createFullCatalog({
    sourceRoot: '.',
    ttl: 900000,
    packs: [
      {
        name: 'video',
        enabled: () => true,
        load: async () => {
          if (fail) throw new Error('offline');
          return rows;
        },
      },
      { name: 'other', enabled: () => true, load: async () => [] },
    ],
    normalize: (_pack, sources) => ({ sources }),
    decorate: (sources) => sources,
    filterSources: filter,
  });
  assert.deepEqual(
    (await catalog.ready()).map((camera) => camera.id),
    ['unverified', 'unverified-embed'],
  );
  dead = new Set([...dead, 'https://camera.test/unknown.m3u8']);
  fail = true;
  assert.deepEqual(
    (await catalog.ready()).map((camera) => camera.id),
    ['unverified-embed'],
    'stale pack records must also respect newly recorded dead verdicts',
  );
  assert.equal(catalog.coverage().deduplicated, 0);
});

test('a refresh removes an old video ID when the provider now lists it as a still', async () => {
  let rows = [
    { id: 'changed', feedType: 'hls' },
    { id: 'keep', feedType: 'mp4' },
  ];
  const catalog = createFullCatalog({
    sourceRoot: '.',
    ttl: 900000,
    packs: [{ name: 'native', enabled: () => true, load: async () => rows }],
    normalize: (_pack, sources) => ({ sources }),
    decorate: (sources) => sources,
    filterSources: createLiveCameraFilter(),
  });
  assert.equal((await catalog.ready()).length, 2);
  rows = [{ id: 'changed', feedType: 'image' }];
  rows.inventory = { partial: true };
  assert.deepEqual(
    (await catalog.ready()).map((camera) => camera.id),
    ['keep'],
  );
  rows = [{ id: 'keep', feedType: 'image' }];
  assert.deepEqual(await catalog.ready(), []);
});

test('collection status transfers counts without serializing partial camera records', async () => {
  let serialized = 0;
  const rows = [
    {
      id: 'live',
      get name() {
        serialized++;
        return 'Camera';
      },
      feedType: 'hls',
    },
  ];
  const sources = async () => rows;
  sources.coverage = () => ({
    mode: 'full',
    liveOnly: true,
    loading: true,
    snapshotReady: false,
    total: 1,
    packs: [{ pack: 'test', retained: 1 }],
  });
  let handler;
  cctvProxy({ getSources: sources }).configureServer({
    middlewares: {
      use(_path, callback) {
        handler = callback;
      },
    },
  });
  let body;
  await handler(
    { url: '/sources?status=1', method: 'GET' },
    {
      writeHead() {},
      end(value) {
        body = JSON.parse(value);
      },
    },
  );
  assert.equal(serialized, 0);
  assert.equal(body.count, 1);
  assert.equal(body.coverage.liveOnly, true);
  assert.equal(body.sources, undefined);
  assert.equal(body.coverage.packs, undefined);
  assert.ok(JSON.stringify(body).length < 250);
});

test('full catalogue stays in memory, deduplicates aliases and starts empty after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eye-full-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const native = Array.from({ length: 21001 }, (_, i) => ({
    id: `native-${i}`,
    lat: 43,
    lon: -79,
    url: `https://example.org/${i}.jpg`,
  }));
  let fail = false;
  const packs = [
    {
      name: 'native',
      enabled: () => true,
      load: async (options) => {
        assert.equal(options.fullCatalog, true);
        return native;
      },
    },
    {
      name: 'osiris-extra',
      enabled: () => true,
      load: async () => {
        if (fail) throw new Error('offline');
        return [
          { ...native[0], id: 'extra-alias' },
          {
            ...native[0],
            id: 'different-view',
            url: 'https://example.org/side.jpg',
          },
        ];
      },
    },
  ];
  const options = {
    sourceRoot: root,
    packs,
    normalize: (name, sources) => ({
      sources: sources.map((s) => ({ ...s, pack: name })),
    }),
    decorate: (s) => s,
    ttl: 60000,
  };
  const catalog = createFullCatalog(options);
  const all = await catalog.ready();
  assert.equal(all.length, 21002);
  assert.deepEqual(all.find((c) => c.id === 'native-0').aliases, [
    'extra-alias',
  ]);
  assert.equal(catalog.coverage().deduplicated, 1);
  assert.deepEqual(catalog.trimmedPacks(), []);
  fail = true;
  assert.equal(
    (await catalog.ready()).length,
    21002,
    'same-process cache survives a failed provider',
  );
  assert.deepEqual(
    await fs.readdir(root),
    [],
    'collection must never create a disk inventory',
  );
  // An old file must not restore any cameras, even when it is still present.
  await fs.mkdir(path.join(root, '.cache'));
  await fs.writeFile(
    path.join(root, '.cache/cctv-full-catalog.json'),
    JSON.stringify({
      packs: {
        'osiris-extra': { sources: [{ id: 'disk-only', lat: 1, lon: 1 }] },
      },
    }),
  );
  const restarted = createFullCatalog(options);
  assert.equal(restarted.coverage().total, 0);
  assert.equal(restarted.coverage().snapshotReady, false);
  assert.equal((await restarted.ready()).length, 21001);
  assert.equal(
    restarted.coverage().packs.find((p) => p.pack === 'osiris-extra').state,
    'unavailable',
  );
});
test('every Osiris region is registered and embedded/operator cameras survive normalization', () => {
  assert.deepEqual(
    eyeCameraPacks()
      .map((p) => p.name)
      .sort(),
    Object.keys(osirisCameraRegions)
      .map((p) => `osiris-${p}`)
      .sort(),
  );
  assert.ok(eyeCameraPacks().length > 50);
  const embed = cameraToNative(
    {
      id: 'e',
      lat: 52,
      lng: 4,
      stream_type: 'iframe',
      stream_url: 'https://www.youtube.com/embed/abc',
    },
    'test',
  );
  assert.equal(embed.feedType, 'iframe');
  assert.ok(embed.embedUrl);
  const external = cameraToNative(
    { id: 'x', lat: 52, lng: 4, external_url: 'https://example.org/camera' },
    'test',
  );
  assert.equal(external.feedType, 'external');
});
