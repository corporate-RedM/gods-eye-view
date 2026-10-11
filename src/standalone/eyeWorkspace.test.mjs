import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inRing,
  areaGeoJSON,
  recordsCSV,
  validArea,
  applyGraphics,
} from './eyeModel.js';
import { cameraToNative } from '../../server/standalone/eye-cameras.js';
import { eyeRoute } from '../../server/standalone/eye-api.js';
import { eyeTools } from './eyeTools.js';
import { composeCatalog } from '../tools/catalog.js';
import { allocateExtendedSourceCap } from '../../server/providers/cctv/cap.js';

test('additional camera packs never displace the native allocation', () => {
  const packs = [
    { name: 'native', sources: [{ id: 'n1' }, { id: 'n2' }] },
    { name: 'extra', sources: [{ id: 'e1' }, { id: 'e2' }, { id: 'n1' }] },
  ];
  const allocation = allocateExtendedSourceCap(packs, 2, ['extra'], 1);
  assert.deepEqual(
    allocation.sources.map((s) => s.id),
    ['n1', 'n2', 'e1'],
  );
  assert.equal(allocation.packs[0].kept, 2);
});

test('saved area queries respect concave polygons and the antimeridian', () => {
  const ring = [
    [179, -2],
    [-179, -2],
    [-179, 2],
    [179, 2],
  ];
  assert.equal(inRing(179.5, 0, ring), true);
  assert.equal(inRing(-179.5, 0, ring), true);
  assert.equal(inRing(0, 0, ring), false);
  assert.equal(inRing(179.5, 3, ring), false);
  assert.equal(inRing(NaN, 0, ring), false);
  assert.equal(
    inRing(2, 2, [
      [0, 0],
      [3, 0],
      [1, 1],
      [0, 3],
    ]),
    false,
  );
});
test('area exports close polygons without mutating saved geometry and escape CSV formulas', () => {
  const area = {
    name: 'Toronto',
    ring: [
      [-80, 43],
      [-79, 43],
      [-79, 44],
    ],
  };
  assert.ok(validArea(area));
  const result = areaGeoJSON(area, [{ name: 'Camera', lon: -79.5, lat: 43.5 }]);
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0].geometry.coordinates[0].length, 4);
  assert.equal(area.ring.length, 3);
  assert.match(
    recordsCSV([{ name: '=HYPERLINK("bad")' }]),
    /'=HYPERLINK\(""bad""\)/,
  );
  assert.equal(
    validArea({
      name: 'bad',
      ring: [
        [0, 0],
        [181, 1],
        [0, 1],
      ],
    }),
    false,
  );
});
test('camera adapters retain direct feeds, embedded players and operator links; reject invalid positions and unsafe URLs', () => {
  const raw = {
    id: '1',
    lat: 51,
    lng: 5,
    name: 'Bridge',
    source: 'RWS',
    stream_type: 'hls',
    stream_url: 'https://example.com/live.m3u8',
  };
  const c = cameraToNative(raw, 'nl');
  assert.equal(c.id, 'osiris-nl-1');
  assert.equal(c.feedType, 'hls');
  assert.equal(c.url, raw.stream_url);
  assert.equal(
    cameraToNative({ ...raw, stream_type: 'iframe' }, 'nl').feedType,
    'iframe',
  );
  const external = cameraToNative(
    {
      id: 'external',
      lat: 50,
      lng: 4,
      external_url: 'https://example.com/camera',
    },
    'nl',
  );
  assert.equal(external.feedType, 'external');
  assert.equal(external.externalUrl, 'https://example.com/camera');
  assert.equal(cameraToNative({ ...raw, lat: 100 }, 'nl'), null);
  assert.equal(
    cameraToNative({ ...raw, stream_url: 'file:///tmp/a' }, 'nl'),
    null,
  );
});
test('workspace route dispatch never interpolates arbitrary paths', () => {
  assert.equal(eyeRoute('/api/eye/osint/dns').module, 'osint/dns/route.js');
  assert.equal(eyeRoute('/api/eye/../../lib/oi/providers'), null);
  assert.equal(eyeRoute('/api/eye/oi/runs/abc/events'), null);
  assert.equal(eyeRoute('/api/eye/scanner'), null);
});
test('investigations share a validated tool catalogue and encode queries', async () => {
  let requested;
  const catalog = composeCatalog({
    tools: eyeTools,
    services: {
      app: {
        baseUrl: 'http://localhost:4173',
        fetch: async (url) => {
          requested = url;
          return Response.json({ result: 'record' });
        },
      },
    },
  });
  const result = await catalog.call('eye_investigate', {
    kind: 'sanctions',
    query: 'A & B',
  });
  assert.match(requested, /query=A%20%26%20B/);
  assert.equal(result.data.result, 'record');
  await assert.rejects(
    catalog.call('eye_investigate', { kind: 'scanner', query: 'example.com' }),
  );
});
test('graphics presets change local rendering without enabling imagery services', () => {
  let renders = 0;
  const viewer = {
    scene: {
      globe: {},
      postProcessStages: { fxaa: {} },
      requestRender: () => renders++,
    },
  };
  const tiles = {};
  applyGraphics(viewer, tiles, 'monitor');
  assert.equal(viewer.targetFrameRate, 30);
  assert.equal(tiles.maximumScreenSpaceError, 24);
  applyGraphics(viewer, tiles, 'high');
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(renders, 2);
});
