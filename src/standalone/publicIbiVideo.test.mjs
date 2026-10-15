import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadIbiPublicVideo,
  mapIbiVideoRows,
  resolveIbiPublicStream,
  PUBLIC_IBI_SITES,
} from '../../server/providers/cctv/publicIbiVideo.js';
import {
  createHlsPuller,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';

const response = (value) => new Response(JSON.stringify(value));
const row = (id) => ({
  id,
  location: `Road ${id}`,
  latLng: { geography: { wellKnownText: 'POINT (-80 35)' } },
  images: [
    {
      id,
      videoUrl: `https://video.example/${id}/index.m3u8`,
      isVideoAuthRequired: true,
    },
  ],
});

test('511 inventory pages beyond 256 and keeps every video view without snapshots', async () => {
  const requests = [];
  const cameras = await loadIbiPublicVideo('fl', {
    fetchImpl: async (url) => {
      const { start, length } = JSON.parse(
        new URL(url).searchParams.get('query'),
      );
      requests.push(start);
      const data = Array.from(
        { length: Math.min(length, 357 - start) },
        (_, i) => row(start + i),
      );
      if (start === 0)
        data[0].images.push(
          { id: 'second', videoUrl: 'https://video.example/second.m3u8' },
          { id: 'still', imageUrl: '/map/Cctv/12' },
        );
      return response({ recordsTotal: 357, data });
    },
  });
  assert.equal(cameras.length, 358);
  assert.deepEqual(
    requests.sort((a, b) => a - b),
    [0, 100, 200, 300],
  );
  assert.equal(cameras.inventory.partial, false);
  assert.equal(cameras[0].sourceKind, 'ibi-public-video');
});

test('511 partial pages are reported and unavailable/invalid cameras are rejected', async () => {
  const cameras = await loadIbiPublicVideo('nc', {
    fetchImpl: async (url) => {
      const { start } = JSON.parse(new URL(url).searchParams.get('query'));
      return start
        ? new Response('', { status: 503 })
        : response({ recordsTotal: 101, data: [row(1)] });
    },
  });
  assert.equal(cameras.inventory.partial, true);
  assert.equal(cameras.inventory.failedBatches, 1);
  for (const field of ['disabled', 'blocked', 'videoDisabled']) {
    const raw = row(1);
    raw.images[0][field] = true;
    assert.deepEqual(mapIbiVideoRows('fl', [raw]), []);
  }
  const raw = row(1);
  raw.images[0].videoUrl = 'https://video.example/still.jpg';
  assert.deepEqual(mapIbiVideoRows('fl', [raw]), []);
});

test('511 signs on demand through the correct publisher gateway and retains browser headers', async () => {
  for (const key of ['fl', 'nc', 'pa']) {
    const source = mapIbiVideoRows(key, [row(1)])[0],
      calls = [];
    const resolved = await resolveIbiPublicStream(source, {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response(
          calls.length === 1
            ? { token: 'public-player-token', sourceId: 1 }
            : '?token=temporary',
        );
      },
    });
    assert.equal(calls[1].url, PUBLIC_IBI_SITES[key].gateway);
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(resolved.url, source.url + '?token=temporary');
    assert.equal(resolved.headers.Origin, PUBLIC_IBI_SITES[key].origin);
    assert.equal(source.url.includes('token'), false);
  }
});

test('511 accepts a direct signed URL but refuses an off-origin player response', async () => {
  const source = mapIbiVideoRows('ga', [row(1)])[0];
  const resolved = await resolveIbiPublicStream(source, {
    fetchImpl: async () => response(source.url + '?token=temporary'),
  });
  assert.equal(resolved.url, source.url + '?token=temporary');
  await assert.rejects(
    resolveIbiPublicStream(source, {
      fetchImpl: async () => response('https://other.example/video.m3u8'),
    }),
    /unexpected stream origin/,
  );
  await assert.rejects(
    resolveIbiPublicStream(source, { fetchImpl: async () => response({}) }),
    /authorization unavailable/,
  );
});

test('HLS resolves once per active session, forwards publisher headers, and refreshes after a failure', async () => {
  let resolves = 0,
    fail = false;
  const urls = [];
  const base = 'https://video.example/index.m3u8';
  const puller = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 10 },
    resolveSource: async () => ({
      url: base + '?token=' + ++resolves,
      headers: { Referer: 'https://public.example/' },
    }),
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.headers.Referer, 'https://public.example/');
      if (fail) {
        fail = false;
        return new Response('', { status: 401 });
      }
      return new Response(
        new URL(url).pathname.endsWith('.m3u8')
          ? '#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n'
          : 'segment',
      );
    },
  });
  try {
    const entry = await puller.ensure('one', base);
    await entry.polling;
    assert.equal(entry.segments.size, 2);
    assert.equal(resolves, 1);
    await puller.ensure('one', base, 'second-lease');
    assert.equal(resolves, 1);
    fail = true;
    const until = Date.now() + 1000;
    while (resolves < 2 && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(resolves, 2);
    assert.ok(urls.includes(base + '?token=2'));
    const playlist = await puller.buildPlaylist(entry, 'one');
    assert.ok(!playlist.includes('token='));
  } finally {
    await puller.shutdown();
  }
});

test('HLS cancels an in-flight token resolution when the last viewer leaves', async () => {
  let signal;
  const puller = createHlsPuller({
    resolveSource: (_, __, s) => {
      signal = s;
      return new Promise((_, reject) =>
        s.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    },
  });
  await puller.ensure('camera', 'https://video.example/index.m3u8');
  puller.release('camera', 'legacy');
  assert.equal(signal.aborted, true);
  await puller.shutdown();
  assert.equal(puller.stats().sessions, 0);
});
