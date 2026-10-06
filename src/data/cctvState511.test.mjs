import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CASTLE_ROCK_511_SITES } from '../../server/providers/cctv/constants.js';
import {
  dataTablesRowToSource,
  graphqlCameraToSource,
  loadCastleRock511Sources,
  parseWktPoint,
  pinnedHttpsUrl,
} from '../../server/providers/cctv/castleRock511.js';
import {
  STREAM_HEALTH_CHECK_VERSION as v,
  _resetStreamHealthForTest,
  knownDeadStreams,
  settleStreamHealthChecks,
} from '../../server/providers/cctv/streamHealth.js';

const site = (id) => CASTLE_ROCK_511_SITES.find((entry) => entry.id === id);

/** A /List/GetData/Cameras row carrying the fields the loader reads. */
function dataTablesRow(overrides = {}, image = {}) {
  return {
    id: 1,
    roadway: 'I-39/US 51',
    direction: 'Unknown',
    location: 'I-39/US 51 at County B',
    latLng: {
      geography: { wellKnownText: 'POINT (-89.518702 44.454149)' },
    },
    images: [
      {
        id: 937,
        imageUrl: '/map/Cctv/937',
        videoUrl: 'https://cctv1.dot.wi.gov/rtplive/CCTV-49-0011/playlist.m3u8',
        isVideoAuthRequired: false,
        videoDisabled: false,
        disabled: false,
        blocked: false,
        ...image,
      },
    ],
    ...overrides,
  };
}

test('pinned URLs and WKT points accept only what the loaders may fetch', () => {
  assert.equal(
    pinnedHttpsUrl('https://cctv1.dot.wi.gov/a.m3u8', ['dot.wi.gov']),
    'https://cctv1.dot.wi.gov/a.m3u8',
  );
  assert.equal(pinnedHttpsUrl('http://cctv1.dot.wi.gov/a', ['dot.wi.gov']), '');
  assert.equal(
    pinnedHttpsUrl('https://evil-dot.wi.gov.example/a', ['dot.wi.gov']),
    '',
  );
  assert.equal(pinnedHttpsUrl('https://u:p@dot.wi.gov/a', ['dot.wi.gov']), '');
  assert.deepEqual(parseWktPoint('POINT (-119.852401 39.484798)'), {
    lat: 39.484798,
    lon: -119.852401,
  });
  assert.equal(parseWktPoint('POINT (0 0)'), null);
  assert.equal(parseWktPoint('nonsense'), null);
});

test('a DataTables camera with an open stream becomes a live source with its still', () => {
  const source = dataTablesRowToSource(site('us-wi'), dataTablesRow());
  assert.equal(source.id, 'us-wi-1');
  assert.equal(source.cityId, 'us-wi');
  assert.equal(source.feedType, 'hls');
  assert.equal(
    source.url,
    'https://cctv1.dot.wi.gov/rtplive/CCTV-49-0011/playlist.m3u8',
  );
  assert.equal(source.snapshotUrl, 'https://511wi.gov/map/Cctv/937');
  assert.equal(source.name, 'I-39/US 51 at County B');
  assert.deepEqual([source.lat, source.lon], [44.454149, -89.518702]);

  // "N/A" locations fall back to the roadway.
  assert.equal(
    dataTablesRowToSource(site('us-wi'), dataTablesRow({ location: 'N/A' }))
      .name,
    'I-39/US 51',
  );
});

test('DataTables cameras without an open stream on the state host are skipped', () => {
  const wi = site('us-wi');
  for (const image of [
    { isVideoAuthRequired: true },
    { videoDisabled: true },
    { videoUrl: 'https://cctv1.dot.wi.gov/live/x/playlist.m3u8?token=abc' },
    { videoUrl: 'https://streams.example.com/x/playlist.m3u8' },
    { videoUrl: 'https://cctv1.dot.wi.gov/x/stream.mp4' },
    { videoUrl: null },
  ]) {
    assert.equal(
      dataTablesRowToSource(wi, dataTablesRow({}, image)),
      null,
      JSON.stringify(image),
    );
  }
  assert.equal(
    dataTablesRowToSource(wi, dataTablesRow({ latLng: null })),
    null,
    'no coordinates, no camera',
  );
});

test('a GraphQL camera keeps its first open HLS view and pinned snapshot', () => {
  const mn = site('us-mn');
  const feature = {
    __typename: 'Camera',
    active: true,
    uri: 'camera/507911',
    title: 'MN 13: I-35W SB @ T.H.13',
    features: [{ geometry: { coordinates: [-93.28898, 44.77502] } }],
    views: [
      {
        category: 'IMAGE',
        url: 'https://public.carsprogram.org/a',
        sources: [],
      },
      {
        category: 'VIDEO',
        url: 'https://public.carsprogram.org/cameras/MN/C608',
        sources: [
          {
            type: 'application/x-mpegURL',
            src: 'https://video.dot.state.mn.us/public/C608.stream/playlist.m3u8',
          },
        ],
      },
    ],
  };
  const source = graphqlCameraToSource(mn, feature);
  assert.equal(source.id, 'us-mn-507911');
  assert.equal(
    source.url,
    'https://video.dot.state.mn.us/public/C608.stream/playlist.m3u8',
  );
  assert.equal(
    source.snapshotUrl,
    'https://public.carsprogram.org/cameras/MN/C608',
  );
  assert.equal(
    source.headingConfidence,
    'high',
    'SB in the title is a bearing',
  );

  assert.equal(graphqlCameraToSource(mn, { ...feature, active: false }), null);
  assert.equal(
    graphqlCameraToSource(mn, {
      ...feature,
      views: [
        {
          category: 'VIDEO',
          sources: [{ src: 'https://elsewhere.example/x/playlist.m3u8' }],
        },
      ],
    }),
    null,
  );
});

test('stream health marks 404s dead, unreachable hosts dead after two strikes, and persists', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-stream-health-'));
  const file = path.join(dir, 'health.json');
  const previous = process.env.CCTV_STREAM_HEALTH_FILE;
  process.env.CCTV_STREAM_HEALTH_FILE = file;
  t.mock.method(console, 'log', () => {});
  _resetStreamHealthForTest();
  t.after(async () => {
    await settleStreamHealthChecks();
    _resetStreamHealthForTest();
    if (previous === undefined) delete process.env.CCTV_STREAM_HEALTH_FILE;
    else process.env.CCTV_STREAM_HEALTH_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const live = 'https://video.example.gov/live/playlist.m3u8';
  const fmp4 = 'https://video.example.gov/fmp4/playlist.m3u8';
  const gone = 'https://video.example.gov/gone/playlist.m3u8';
  const encrypted = 'https://video.example.gov/aes/playlist.m3u8';
  const refused = 'https://down.example.gov/x/playlist.m3u8';
  const master =
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=150000\nchunklist.m3u8\n';
  const media = {
    [live]:
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:4.0,\nmedia_7.ts\n',
    [fmp4]: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg_7.mp4\n',
    [encrypted]:
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4.0,\nmedia_7.ts\n',
  };
  const probed = [];
  const fetchImpl = async (url) => {
    probed.push(url);
    if (url in media) return new Response(master);
    const owner = Object.keys(media).find(
      (stream) => stream.replace('playlist.m3u8', 'chunklist.m3u8') === url,
    );
    if (owner) return new Response(media[owner]);
    if (url === gone) return new Response('', { status: 404 });
    throw new TypeError('fetch failed');
  };
  const urls = [live, fmp4, gone, encrypted, refused];

  assert.deepEqual(
    [...(await knownDeadStreams(urls, { fetchImpl }))],
    [],
    'unknown links count as live until checked',
  );
  await settleStreamHealthChecks();
  assert.deepEqual(
    [...(await knownDeadStreams(urls, { fetchImpl }))].sort(),
    [gone, encrypted].sort(),
    'a 404 is dead, an encrypted stream the proxy cannot serve is not live, fMP4 is live',
  );
  await settleStreamHealthChecks();
  assert.deepEqual(
    [...(await knownDeadStreams(urls, { fetchImpl }))].sort(),
    [gone, encrypted, refused].sort(),
    'a host that stays unreachable is dead on the second strike',
  );
  assert.equal(
    probed.filter((url) => url === live).length,
    1,
    'a fresh verdict is not re-probed',
  );

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved[live].live, true);
  assert.equal(saved[fmp4].live, true);
  assert.equal(saved[gone].live, false);

  // A restart reads the verdicts back without probing.
  _resetStreamHealthForTest();
  probed.length = 0;
  assert.deepEqual(
    [...(await knownDeadStreams(urls, { fetchImpl }))].sort(),
    [gone, encrypted, refused].sort(),
  );
  assert.deepEqual(probed, []);

  // A verdict from an older check version is re-checked: v2 had marked fMP4
  // streams unplayable before the proxy could serve them.
  fs.writeFileSync(
    file,
    JSON.stringify({
      [fmp4]: { live: false, checkedAt: Date.now(), v: v - 1 },
    }),
  );
  _resetStreamHealthForTest();
  probed.length = 0;
  await knownDeadStreams([fmp4], { fetchImpl });
  await settleStreamHealthChecks();
  assert.ok(probed.includes(fmp4));
  assert.deepEqual([...(await knownDeadStreams([fmp4], { fetchImpl }))], []);
});

test('a dead stream falls back to its still image, and a camera with no still is dropped', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-stream-health-'));
  const file = path.join(dir, 'health.json');
  const deadWithStill =
    'https://video2.iowadot.gov:8888/rtplive/a/playlist.m3u8';
  const deadNoStill = 'https://video2.iowadot.gov:8888/rtplive/b/playlist.m3u8';
  const live = 'https://video2.iowadot.gov:8888/rtplive/c/playlist.m3u8';
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({
      [deadWithStill]: { live: false, checkedAt: now, v },
      [deadNoStill]: { live: false, checkedAt: now, v },
      [live]: { live: true, checkedAt: now, v },
    }),
  );
  const previous = process.env.CCTV_STREAM_HEALTH_FILE;
  process.env.CCTV_STREAM_HEALTH_FILE = file;
  _resetStreamHealthForTest();
  t.mock.method(console, 'log', () => {});
  t.after(async () => {
    await settleStreamHealthChecks();
    _resetStreamHealthForTest();
    if (previous === undefined) delete process.env.CCTV_STREAM_HEALTH_FILE;
    else process.env.CCTV_STREAM_HEALTH_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const camera = (id, src, url) => ({
    __typename: 'Camera',
    active: true,
    uri: `camera/${id}`,
    title: `Camera ${id}`,
    features: [{ geometry: { coordinates: [-93.6 - id / 100, 41.6] } }],
    views: [{ category: 'VIDEO', url, sources: [{ src }] }],
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: {
        mapFeaturesQuery: {
          mapFeatures: [
            camera(1, deadWithStill, 'https://atmsqf.iowadot.gov/a.jpeg'),
            camera(2, deadNoStill, null),
            camera(3, live, 'https://atmsqf.iowadot.gov/c.jpeg'),
          ],
        },
      },
    }),
  );

  const sources = await loadCastleRock511Sources('us-ia');
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['us-ia-1', 'us-ia-3']);
  assert.equal(byId['us-ia-1'].feedType, 'image');
  assert.equal(byId['us-ia-1'].url, 'https://atmsqf.iowadot.gov/a.jpeg');
  assert.equal(byId['us-ia-3'].feedType, 'hls');
});
