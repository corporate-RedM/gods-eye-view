import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvSource, createCctvLayer } from './index.js';
import { createLifecycle } from './lifecycle.js';
import { createNavigation } from './navigation.js';

test('the video-only catalogue keeps MJPEG, embeds and failed video streams in Live', () => {
  const navigation = createNavigation({
    state: { _liveOnly: true },
    parts: { model: { isVideoFeedType: (type) => type === 'hls' } },
  });
  for (const camera of [
    { feedType: 'hls' },
    { feedType: 'mjpeg' },
    { feedType: 'iframe', embedUrl: 'https://example.test/player' },
  ]) {
    const record = { camera, projection: { mode: 'image' }, liveFailed: true };
    assert.equal(navigation.recordMatchesFeed(record, 'live'), true);
    assert.equal(navigation.recordMatchesFeed(record, 'snapshot'), false);
  }
});

const camera = {
  id: 'pack/camera ?x',
  name: 'Camera & road',
  city: 'Austin',
  lat: 30.267,
  lon: -97.744,
  headingDeg: 45,
  fovDeg: 60,
  pitchDeg: -12,
};

test('catalogue collection publishes actual discovered counts before returning the complete snapshot', async () => {
  let calls = 0;
  const paths = [];
  const progress = [];
  const source = createCctvSource({
    fetchImpl: async (path) => {
      paths.push(path);
      if (path === '/api/cctv/sources')
        return Response.json({
          sources: [camera, { ...camera, id: 'second' }],
        });
      return Response.json(
        ++calls === 1
          ? {
              count: 1,
              coverage: { loading: true, snapshotReady: false },
            }
          : {
              count: 2,
              coverage: { loading: false, snapshotReady: true },
            },
      );
    },
  });
  const result = await source.getCatalog({
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(progress, [
    { discovered: 1, collecting: true },
    { discovered: 2, collecting: false },
  ]);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(paths, [
    '/api/cctv/sources?status=1',
    '/api/cctv/sources?status=1',
    '/api/cctv/sources',
  ]);
});

test('a warm memory catalogue publishes its real count immediately during a server refresh', async () => {
  const progress = [];
  const source = createCctvSource({
    fetchImpl: async (path) =>
      Response.json({
        ...(path.includes('?status=1') ? { count: 1 } : { sources: [camera] }),
        coverage: { loading: true, snapshotReady: true },
      }),
  });
  await source.getCatalog({ onProgress: (value) => progress.push(value) });
  assert.deepEqual(progress, [{ discovered: 1, collecting: false }]);
});

test('registration publishes actual record/map counts and cancellation stops the next batch', async () => {
  const noop = () => {};
  const empty = new Proxy({}, { get: () => noop });
  const state = {};
  const snapshots = [];
  const cameras = Array.from({ length: 5000 }, (_, i) => ({
    ...camera,
    id: `camera-${i}`,
    mountHeightM: 20,
  }));
  const lifecycle = createLifecycle({
    state,
    services: {
      sprites: empty,
      activation: empty,
      picking: empty,
      focus: empty,
      render: empty,
    },
    parts: {
      geometryQueue: empty,
      cards: empty,
      projection: empty,
      calibration: { loadCalibrationStore: () => new Map() },
      catalog: {
        loadCameraSources: async () => cameras,
        buildCatalogFromSources: (value) => value,
      },
      model: empty,
      ground: { resolveGroundPriors: async () => null },
      presentation: {
        notifyListeners() {
          const progress = state._catalogueLoading;
          if (progress?.phase !== 'registering') return;
          snapshots.push({ ...progress });
          assert.equal(progress.loaded, state._records.length);
          assert.equal(progress.loaded, state._recordById.size);
          if (progress.loaded > 0) state._sourceAbort.abort();
        },
      },
    },
    source: {},
  });
  await assert.rejects(
    lifecycle.methods.init({ scene: { primitives: { add: noop } } }),
    { name: 'AbortError' },
  );
  assert.equal(snapshots[0].loaded, 0);
  assert.equal(snapshots[1].total, cameras.length);
  assert.ok(snapshots[1].loaded > 0 && snapshots[1].loaded < cameras.length);
  assert.equal(state._records.length, snapshots[1].loaded);
  assert.equal(state._catalogueLoading.phase, 'cancelled');
  assert.equal(state._catalogueLoading.active, false);
});

test('camera catalog and health use fixed source routes and caller cancellation', async () => {
  const calls = [];
  const source = createCctvSource({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(
        JSON.stringify(
          path.includes('?status=1')
            ? { count: 0 }
            : path.endsWith('/sources')
              ? { sources: [] }
              : { cameras: [] },
        ),
      );
    },
  });
  const controller = new AbortController();
  await source.getCatalog({ signal: controller.signal });
  await source.getHealth({ signal: controller.signal });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/cctv/sources?status=1', '/api/cctv/sources', '/api/cctv/health'],
  );
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
  }
});

test('camera sources reject malformed snapshots and failures', async () => {
  for (const method of ['getCatalog', 'getHealth']) {
    const malformed = createCctvSource({
      fetchImpl: async () => new Response('{}'),
    });
    await assert.rejects(malformed[method](), /Malformed camera/);
    const denied = createCctvSource({
      fetchImpl: async () => new Response('', { status: 403 }),
    });
    await assert.rejects(denied[method](), /HTTP 403/);
  }
});

test('cancellation while reading a camera response body prevents publication', async () => {
  const controller = new AbortController();
  const source = createCctvSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { sources: [] };
      },
    }),
  });
  await assert.rejects(source.getCatalog({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('frame and media URLs preserve registered camera identity and encoded metadata', () => {
  const source = createCctvSource();
  const frame = new URL(source.getFrameUrl(camera), 'https://example.test');
  const media = new URL(source.getMediaUrl(camera), 'https://example.test');
  assert.equal(
    frame.pathname,
    '/api/cctv/frame/' + encodeURIComponent(camera.id),
  );
  assert.equal(
    media.pathname,
    '/api/cctv/media/' + encodeURIComponent(camera.id),
  );
  assert.equal(frame.searchParams.get('label'), camera.name);
  assert.equal(frame.searchParams.get('city'), camera.city);
  assert.equal(frame.searchParams.get('lat'), '30.267000');
  assert.equal(frame.searchParams.get('lon'), '-97.744000');
  assert.equal(frame.searchParams.get('heading'), '45');
  assert.equal(frame.searchParams.get('pitch'), '-12');
  assert.deepEqual([...media.searchParams.keys()], ['ts']);
});

test('camera construction is inert and destruction cancels a pending catalog and its visibility listener', async (t) => {
  const original = globalThis.document;
  const listeners = new Set();
  globalThis.document = {
    addEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.delete(handler);
    },
  };
  t.after(() => {
    globalThis.document = original;
  });
  const noop = () => {};
  const services = {
    overlays: {
      clearOverlaySource: noop,
      hitTestWorldOverlay: noop,
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
    },
    sprites: { registerSpriteCollection: noop },
    activation: {},
    locations: {},
    picking: { unregisterPickOwner: noop },
    terrain: {},
    ground: {},
    mesh: {},
    focus: {},
    render: { releaseContinuousRender: noop },
  };
  let resolveCatalog;
  let signal;
  const source = {
    ...createCctvSource(),
    getCatalog(options) {
      signal = options.signal;
      return new Promise((resolve) => {
        resolveCatalog = resolve;
      });
    },
  };
  const a = createCctvLayer({ services, source });
  const b = createCctvLayer({ services, source });
  assert.equal(listeners.size, 0);
  const viewer = {
    scene: { primitives: { add: (value) => value, remove: () => true } },
  };
  const initializing = a.init(viewer);
  assert.equal(listeners.size, 1);
  assert.equal(signal.aborted, false);
  a.destroy(viewer);
  assert.equal(listeners.size, 0);
  assert.equal(signal.aborted, true);
  resolveCatalog({ sources: [] });
  await assert.rejects(initializing, { name: 'AbortError' });
  assert.equal(a.getStats().count, 0);
  assert.equal(b.getStats().count, 0);
});

test('frames are read through the registered frame endpoint', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const requested = [];
  const source = createCctvSource({
    fetchImpl: async (url, init) => {
      requested.push({ url, cache: init.cache });
      return new Response(png, {
        headers: { 'Content-Type': 'Image/PNG; charset=binary' },
      });
    },
  });
  const frame = await source.getFrame(camera);
  assert.equal(frame.contentType, 'image/png');
  assert.deepEqual([...frame.bytes], [...png]);
  assert.equal(
    requested[0].url.split('?')[0],
    '/api/cctv/frame/pack%2Fcamera%20%3Fx',
  );
  assert.equal(requested[0].cache, 'no-store');
  const failing = createCctvSource({
    fetchImpl: async () => new Response(null, { status: 502 }),
  });
  await assert.rejects(failing.getFrame(camera), /Camera frame HTTP 502/);
});
