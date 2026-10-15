import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRidotPlayers,
  loadRhodeIslandVideo,
} from '../../server/providers/cctv/rhodeIslandVideo.js';
const html = `<a id="cam101" href="#"><img src="../img/travel/camimages/Road.jpg"></a><script>document.getElementById("cam101").addEventListener("click", function() {openVideoPopup2('https://cdn3.wowza.com/live/playlist.m3u8');});</script>`;
test('RIDOT joins only explicit live players to matching camera locations', async () => {
  assert.equal(
    parseRidotPlayers(html).get('/img/travel/camimages/Road.jpg'),
    'https://cdn3.wowza.com/live/playlist.m3u8',
  );
  const cameras = await loadRhodeIslandVideo({
    fetchImpl: async (url) => {
      if (url.endsWith('.php')) return new Response(html);
      if (url.endsWith('/markers'))
        return new Response(
          JSON.stringify({ ids: ['ridot-203', 'ridot-204'] }),
        );
      return new Response(
        JSON.stringify([
          {
            id: 'ridot-203',
            name: 'Road',
            lat: 41.78,
            lng: -71.42,
            feed_url: 'https://www.dot.ri.gov/img/travel/camimages/Road.jpg',
          },
          {
            id: 'ridot-204',
            lat: 41.78,
            lng: -71.42,
            feed_url: 'https://www.dot.ri.gov/img/travel/camimages/Still.jpg',
          },
        ]),
      );
    },
  });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].feedType, 'hls');
  assert.equal(cameras[0].id, 'osiris-ridot-video-ridot-203');
});
