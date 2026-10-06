import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlsPuller,
  fetchHlsBytes,
  parseHlsMedia,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';
const playlist =
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXTINF:2,\nc.ts\n';
const base = 'https://camera.example/live/list.m3u8';

test('playlist parser uses sequence, refuses escaping and unsupported references', () => {
  assert.deepEqual(
    parseHlsMedia(playlist, base).map((s) => s.seq),
    [12, 13, 14],
  );
  for (const bad of [
    playlist.replace('a.ts', 'https://evil.example/a.ts'),
    playlist.replace('a.ts', '//evil.example/a.ts'),
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n' + playlist,
    playlist.replace('12', '-1'),
    playlist.replace('2,', 'Infinity,'),
  ])
    assert.throws(() => parseHlsMedia(bad, base));
});

test('downloads reject redirect responses, oversized declared and chunked bodies', async () => {
  let init;
  await assert.rejects(
    fetchHlsBytes(base, {
      maxBytes: 5,
      fetchImpl: async (_url, options) => {
        init = options;
        return new Response('', {
          status: 302,
          headers: { Location: 'https://evil.example' },
        });
      },
    }),
  );
  assert.equal(init.redirect, 'error');
  await assert.rejects(
    fetchHlsBytes(base, {
      maxBytes: 5,
      fetchImpl: async () => new Response('abcdef'),
    }),
  );
  await assert.rejects(
    fetchHlsBytes(base, {
      maxBytes: 5,
      fetchImpl: async () =>
        new Response('a', { headers: { 'content-length': '100' } }),
    }),
  );
});

test('one session is reserved before await; disk-free cache and capacity remain bounded', async () => {
  const manager = createHlsPuller({
    limits: {
      ...HLS_LIMITS,
      sessions: 1,
      segmentBytes: 4,
      sessionBytes: 6,
      segments: 2,
      pollMs: 100000,
    },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? playlist : 'abc'),
  });
  const [a, b] = await Promise.all([
    manager.ensure('a', base),
    manager.ensure('a', base),
  ]);
  assert.equal(a, b);
  await assert.rejects(manager.ensure('b', base));
  assert.equal(await manager.waitReady(a), true);
  assert.deepEqual(manager.stats(), { sessions: 1, bytes: 6 });
  const text = await manager.buildPlaylist(a, 'a');
  assert.match(text, /seg_0\.ts\?session=/);
  assert.equal(manager.getSegment('a', 'stale-token', 0), null);
  assert.equal(manager.getSegment('a', a.token, 0).length, 3);
  manager.stop('a', 'stale-token');
  assert.equal(manager.stats().sessions, 1);
  manager.stop('a', a.token);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  await manager.shutdown();
});

test('shutdown cancels in-flight downloads and late responses cannot refill cache', async () => {
  let observed;
  const manager = createHlsPuller({
    fetchImpl: async (_url, { signal }) => {
      observed = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      );
    },
  });
  const entry = await manager.ensure('a', base);
  await manager.shutdown();
  assert.equal(observed.aborted, true);
  assert.equal(entry.stopping, true);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  await assert.rejects(manager.ensure('a', base));
});

test('idle cleanup stops all polling without a background sweep', async () => {
  let calls = 0;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, idleMs: 15, pollMs: 100000 },
    fetchImpl: async (url) => {
      calls++;
      return new Response(url.endsWith('.m3u8') ? playlist : 'abc');
    },
  });
  await manager.ensure('a', base);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  const stoppedCalls = calls;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, stoppedCalls);
  await manager.shutdown();
});

test('agency sequence rollback creates a monotonic local discontinuity', async () => {
  let current = playlist;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 5 },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? current : 'abc'),
  });
  const entry = await manager.ensure('a', base);
  await manager.waitReady(entry);
  const before = await manager.buildPlaylist(entry, 'a');
  assert.match(before, /seg_0\.ts/);
  current = playlist.replace('SEQUENCE:12', 'SEQUENCE:0');
  await new Promise((r) => setTimeout(r, 30));
  const after = await manager.buildPlaylist(entry, 'a');
  assert.match(
    after,
    /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/a\/seg_3\.ts/,
  );
  await manager.shutdown();
});

test('upstream discontinuity tags survive the media parser', () => {
  const parsed = parseHlsMedia(
    playlist.replace('a.ts', 'a.ts\n#EXT-X-DISCONTINUITY'),
    base,
  );
  assert.equal(parsed[0].discontinuity, false);
  assert.equal(parsed[1].discontinuity, true);
});

test('a reused agency sequence with changed segment URI cannot remain stale', async () => {
  let current = playlist;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 5 },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? current : 'abc'),
  });
  const entry = await manager.ensure('a', base);
  await manager.waitReady(entry);
  current = playlist.replaceAll('.ts', '.ts?generation=2');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(
    await manager.buildPlaylist(entry, 'a'),
    /#EXT-X-DISCONTINUITY\n#EXTINF:2\.000,\n\/api\/cctv\/media\/a\/seg_3\.ts/,
  );
  await manager.shutdown();
});

test('two consumers share downloads but release and abandoned expiry are independent', async () => {
  let downloads = 0;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 100000, leasesPerSession: 2 },
    fetchImpl: async (url) => {
      downloads++;
      return new Response(url.endsWith('.m3u8') ? playlist : 'abc');
    },
  });
  const [a, b] = await Promise.all([
    manager.ensure('camera', base, 'viewer-a'),
    manager.ensure('camera', base, 'viewer-b'),
  ]);
  assert.equal(a, b);
  await manager.waitReady(a);
  assert.equal(downloads, 4); // One manifest and three segments, not per consumer.
  assert.equal(a.leases.size, 2);
  await assert.rejects(manager.ensure('camera', base, 'viewer-c'));
  manager.release('camera', 'viewer-a');
  assert.equal(manager.stats().sessions, 1);
  assert.equal(manager.getSegment('camera', a.token, 0, 'viewer-a'), null);
  assert.equal(manager.getSegment('camera', a.token, 0, 'viewer-b').length, 3);
  assert.match(
    await manager.buildPlaylist(b, 'camera', 'viewer-b'),
    /lease=viewer-b/,
  );
  manager.release('camera', 'viewer-a'); // Duplicate/late release cannot stop B.
  assert.equal(b.controller.signal.aborted, false);
  manager.release('camera', 'viewer-b');
  assert.equal(b.controller.signal.aborted, true);
  assert.deepEqual(manager.stats(), { sessions: 0, bytes: 0 });
  await manager.shutdown();
});

const fmp4Playlist =
  '#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-MEDIA-SEQUENCE:40\n#EXT-X-MAP:URI="cam_init.mp4"\n#EXTINF:4,\ncam_seg40.mp4\n#EXTINF:4,\ncam_seg41.mp4\n#EXTINF:4,\ncam_seg42.m4s\n';

test('fMP4 playlists parse with their init segment; unsafe init references fail closed', () => {
  const parsed = parseHlsMedia(fmp4Playlist, base);
  assert.deepEqual(
    parsed.map((s) => s.seq),
    [40, 41, 42],
  );
  assert.ok(
    parsed.every((s) => s.map === 'https://camera.example/live/cam_init.mp4'),
  );
  assert.equal(parseHlsMedia(playlist, base)[0].map, null, 'TS has no init');
  for (const bad of [
    fmp4Playlist.replace(
      'URI="cam_init.mp4"',
      'URI="cam_init.mp4",BYTERANGE="720@0"',
    ),
    fmp4Playlist.replace('cam_init.mp4', 'https://evil.example/init.mp4'),
    fmp4Playlist.replace('cam_init.mp4', 'cam_init.ts'),
    fmp4Playlist.replace('#EXT-X-MAP:URI="cam_init.mp4"', '#EXT-X-MAP:'),
    fmp4Playlist.replace('cam_seg41.mp4', 'cam_seg41.ts'),
    fmp4Playlist.replace('cam_seg40.mp4', 'https://evil.example/seg.mp4'),
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n' + fmp4Playlist.slice(8),
  ])
    assert.throws(() => parseHlsMedia(bad, base), bad);
});

test('an fMP4 session serves its init once, budgets it, and restarts on a new init', async () => {
  let current = fmp4Playlist;
  const downloads = [];
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 5 },
    fetchImpl: async (url) => {
      downloads.push(url.split('/').pop());
      if (url.endsWith('.m3u8')) return new Response(current);
      return new Response(url.includes('init') ? 'INIT' : 'moof');
    },
  });
  const entry = await manager.ensure('ia', base, 'viewer');
  assert.equal(await manager.waitReady(entry), true);
  const text = await manager.buildPlaylist(entry, 'ia', 'viewer');
  assert.match(text, /#EXT-X-VERSION:7/);
  assert.match(
    text,
    /#EXT-X-MAP:URI="\/api\/cctv\/media\/ia\/init_0\.mp4\?session=[^"]+&lease=viewer"/,
  );
  assert.match(text, /\/api\/cctv\/media\/ia\/seg_0\.m4s\?session=/);
  assert.doesNotMatch(text, /\.ts\?/);
  assert.equal(
    manager.getInit('ia', entry.token, 0, 'viewer').toString(),
    'INIT',
  );
  assert.equal(manager.getInit('ia', 'stale', 0, 'viewer'), null);
  assert.equal(manager.getInit('ia', entry.token, 1, 'viewer'), null);
  assert.equal(
    downloads.filter((name) => name === 'cam_init.mp4').length,
    1,
    'the init is fetched once while it is unchanged',
  );
  // Init (4 bytes) plus three 4-byte segments.
  assert.deepEqual(manager.stats(), { sessions: 1, bytes: 16 });

  // An encoder restart publishes a new init: the cache restarts under it.
  current = fmp4Playlist.replace('cam_init.mp4', 'cam_init2.mp4');
  await new Promise((r) => setTimeout(r, 40));
  const after = await manager.buildPlaylist(entry, 'ia', 'viewer');
  assert.match(after, /init_1\.mp4/);
  assert.match(
    after,
    /#EXT-X-DISCONTINUITY\n#EXTINF:4\.000,\n[^\n]+seg_3\.m4s/,
  );
  assert.equal(manager.getInit('ia', entry.token, 0, 'viewer'), null);
  await manager.shutdown();
});

test('a playlist mixing init segments is refused by the puller', async () => {
  const mixed =
    '#EXTM3U\n#EXT-X-MAP:URI="a_init.mp4"\n#EXTINF:4,\na.mp4\n#EXT-X-MAP:URI="b_init.mp4"\n#EXTINF:4,\nb.mp4\n';
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, pollMs: 5, readyMs: 100 },
    fetchImpl: async (url) => new Response(url.endsWith('.m3u8') ? mixed : 'x'),
  });
  const entry = await manager.ensure('ia', base);
  assert.equal(await manager.waitReady(entry), false);
  await manager.shutdown();
});

test('an abandoned consumer expires while a renewed consumer keeps the session', async () => {
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, idleMs: 80, pollMs: 100000 },
    fetchImpl: async (url) =>
      new Response(url.endsWith('.m3u8') ? playlist : 'abc'),
  });
  const entry = await manager.ensure('camera', base, 'abandoned');
  await manager.ensure('camera', base, 'active');
  await new Promise((r) => setTimeout(r, 50));
  await manager.ensure('camera', base, 'active');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(entry.leases.has('abandoned'), false);
  assert.equal(entry.leases.has('active'), true);
  assert.equal(entry.controller.signal.aborted, false);
  await manager.shutdown();
});
