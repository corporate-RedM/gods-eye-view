import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadGlobalPublicVideo,
  loadTaiwanPublicVideo,
  mapPublicVideo,
  mapTaiwanVideo,
  mapTaiwanFreewayVideo,
  loadTaiwanFreewayVideo,
} from '../../server/providers/cctv/publicVideo.js';
import { createLiveCameraFilter } from '../../server/providers/cctv/fullCatalog.js';

const record = (id, feed_type = 'm3u8') => ({
  id,
  feed_type,
  feed_url: `https://publisher.example/${id}`,
  lat: 40,
  lng: -80,
  active: 1,
});
const response = (value) => new Response(JSON.stringify(value));

test('Taiwan freeway keeps the official multipart stream with its camera parameter', async () => {
  const raw = {
    CCTVID: 'CCTV-N1-S-0.000-M',
    PositionLon: 121.735695,
    PositionLat: 25.1229931,
    VideoStreamURL: 'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000',
  };
  const rows = await loadTaiwanFreewayVideo({
    fetchImpl: async () => response({ CCTVs: [raw] }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedType, 'mjpeg');
  assert.equal(rows[0].url, raw.VideoStreamURL);
  assert.equal(
    mapTaiwanFreewayVideo({
      ...raw,
      VideoStreamURL: 'https://cctvn.freeway.gov.tw/snapshot.jpg',
    }),
    null,
  );
});

test('global video hydration exceeds 256 and never sends more than 50 IDs', async () => {
  const ids = Array.from({ length: 357 }, (_, i) => `camera-${i}`);
  let requested = 0;
  const rows = await loadGlobalPublicVideo({
    fetchImpl: async (url, init) => {
      if (url.endsWith('/markers'))
        return response({
          ids: ['snapshot', ...ids],
          fts: [0, ...ids.map(() => 2)],
        });
      const batch = JSON.parse(init.body).ids;
      assert.ok(batch.length <= 50);
      assert.ok(!batch.includes('snapshot'));
      requested += batch.length;
      return response(batch.map((id) => record(id)));
    },
  });
  assert.equal(requested, 357);
  assert.equal(rows.length, 357);
  assert.equal(rows.inventory.partial, false);
});

test('partial provider batches are reported instead of claiming a complete inventory', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `c-${i}`);
  const rows = await loadGlobalPublicVideo({
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (url.endsWith('/markers'))
        return response({ ids, fts: ids.map(() => 2) });
      const batch = JSON.parse(init.body).ids;
      if (batch[0] === 'c-50') return new Response('', { status: 503 });
      return response([
        ...batch.map((id) => record(id)),
        record('unrequested'),
      ]);
    },
  });
  assert.equal(rows.length, 51);
  assert.equal(rows.inventory.failedBatches, 1);
  assert.equal(rows.inventory.partial, true);
});

test('transient global batch errors retry with Retry-After and do not lose cameras', async () => {
  let attempts = 0;
  const waits = [];
  const rows = await loadGlobalPublicVideo({
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async (url) => {
      if (url.endsWith('/markers'))
        return response({ ids: ['camera'], fts: [2] });
      if (++attempts === 1)
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '2' },
        });
      return response([record('camera')]);
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(rows.length, 1);
  assert.equal(rows.inventory.failedBatches, 0);
});

test('global provider access refusals are not retried', async () => {
  let attempts = 0;
  await assert.rejects(
    loadGlobalPublicVideo({
      sleep: async () => assert.fail('must not retry access refusals'),
      fetchImpl: async (url) => {
        if (url.endsWith('/markers'))
          return response({ ids: ['camera'], fts: [2] });
        attempts++;
        return new Response('', { status: 403 });
      },
    }),
    /Every OpenCCTV/,
  );
  assert.equal(attempts, 1);
});

test('reject stills, external links, inactive cameras and malformed video metadata', () => {
  for (const type of ['image', 'jpg', 'snapshot', 'external'])
    assert.equal(mapPublicVideo(record('bad', type)), null);
  assert.equal(mapPublicVideo({ ...record('off'), active: 0 }), null);
  assert.equal(mapPublicVideo({ ...record('bad'), lat: 91 }), null);
  assert.equal(
    mapPublicVideo({ ...record('bad'), feed_url: 'file:///tmp/cam' }),
    null,
  );
  for (const type of ['m3u8', 'hls', 'mjpeg', 'mp4', 'webm', 'iframe']) {
    const cam = mapPublicVideo(record('video', type));
    assert.ok(cam);
    assert.ok(cam.url || cam.embedUrl);
  }
});

test('new publisher video records retain existing dead-stream exclusions', async () => {
  const dead = mapPublicVideo(record('dead'));
  const unverified = mapPublicVideo(record('unverified', 'mjpeg'));
  const embed = mapPublicVideo(record('embed', 'iframe'));
  const filter = createLiveCameraFilter({
    getDeadStreams: async () => new Set([dead.url, embed.embedUrl]),
  });
  assert.deepEqual(await filter([dead, unverified, embed]), [unverified]);
});

test('Taiwan video uses multipart publisher URL and never constructs a snapshot URL', async () => {
  const raw = {
    id: 'CCTV-123',
    gisx: 121.4071,
    gisy: 25.0183,
    html: 'https://cctv-ss01.thb.gov.tw:443/T1-14K+565',
  };
  const rows = await loadTaiwanPublicVideo({
    fetchImpl: async () => response([raw]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedType, 'mjpeg');
  assert.equal(rows[0].url, 'https://cctv-ss01.thb.gov.tw/T1-14K+565');
  assert.equal(
    mapTaiwanVideo({ ...raw, html: 'https://other.example/camera' }),
    null,
  );
});

test('malformed and failed inventories fail visibly rather than becoming empty successes', async () => {
  await assert.rejects(
    loadGlobalPublicVideo({ fetchImpl: async () => response({ ids: [] }) }),
  );
  await assert.rejects(
    loadTaiwanPublicVideo({ fetchImpl: async () => response({}) }),
  );
});
