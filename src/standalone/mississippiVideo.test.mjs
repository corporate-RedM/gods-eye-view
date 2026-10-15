import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMississippiVideo,
  mapMississippiViews,
} from '../../server/providers/cctv/mississippiVideo.js';
const site = {
  markerid: 'camsite_3',
  lat: 32.33787,
  lon: -90.09265,
  tooltip: 'Lakeland Dr',
};
const markup = (id) =>
  `switchImage('https://streamingjxn2.mdottraffic.com/thumbnail?application=rtplive&streamname=${id}.stream&size=352x240', '${id}', 'Road ${id}', '', this)`;
test('MDOT keeps every public view with original stream host and excludes arbitrary thumbnail hosts', () => {
  const cameras = mapMississippiViews(
    site,
    markup('010101') + markup('010102'),
  );
  assert.equal(cameras.length, 2);
  assert.equal(cameras[1].id, 'osiris-mississippi-video-010102');
  assert.equal(
    cameras[0].url,
    'https://streamingjxn2.mdottraffic.com/rtplive/010101.stream/playlist.m3u8',
  );
  assert.deepEqual(
    mapMississippiViews(
      site,
      markup('010101').replaceAll(
        'streamingjxn2.mdottraffic.com',
        'other.example',
      ),
    ),
    [],
  );
});
test('MDOT reports partial site failures without dropping successful views', async () => {
  const cameras = await loadMississippiVideo({
    fetchImpl: async (url, init) => {
      if (url.endsWith('LoadCameraData')) {
        assert.equal(init.method, 'POST');
        return new Response(
          JSON.stringify({ d: [site, { ...site, markerid: 'camsite_4' }] }),
        );
      }
      return url.endsWith('site=3')
        ? new Response(markup('010101') + markup('010102'))
        : new Response('', { status: 503 });
    },
  });
  assert.equal(cameras.length, 2);
  assert.equal(cameras.inventory.partial, true);
  assert.equal(cameras.inventory.failedBatches, 1);
});
