// CCTV Watch lifecycle (BK, 2026-10-08): off until Start, polls never start
// it, Start names an area and reads only its cameras, Stop drops queued work
// and reads "stopping" until the detector process has exited, and incidents
// stay available while Watch is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTOR_STATES } from '../../server/providers/cctv/watch/detectorClient.js';
import { createCctvWatch } from '../../server/providers/cctv/watch/index.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** A scratch root with the watch configs, so nothing writes into the repo. */
function scratchRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cctv-watch-lifecycle-'));
  mkdirSync(path.join(root, 'config'));
  for (const name of ['cctv_watch_events.json', 'cctv_watch_thresholds.json'])
    cpSync(path.join(REPO, 'config', name), path.join(root, 'config', name));
  return root;
}

const camera = (id, provider, city, lat, lon) => ({
  id,
  name: `${city} camera ${id}`,
  city,
  provider,
  lat,
  lon,
  feedType: 'hls',
  url: `https://video.example/${id}.m3u8`,
});
const SOURCES = [
  camera('mn-1', '511 Minnesota (MnDOT)', 'Minneapolis', 44.98, -93.27),
  camera('mn-2', '511 Minnesota (MnDOT)', 'Bloomington', 44.84, -93.3),
  camera('nv-1', 'NVroads (NDOT)', 'Reno', 39.53, -119.81),
];

/** A detector that is ready at once and takes a moment to exit. */
function fakeDetector(calls) {
  let state = DETECTOR_STATES.STOPPED;
  return () => ({
    start() {
      calls.push('start');
      state = DETECTOR_STATES.READY;
    },
    stop() {
      calls.push('stop');
      setTimeout(() => {
        state = DETECTOR_STATES.STOPPED;
      }, 30);
    },
    status: () => ({ state }),
    isReady: () => state === DETECTOR_STATES.READY,
    screen: async () => ({ results: [] }),
    describe: async () => ({ result: { ok: false } }),
    verify: async () => ({ result: null }),
    count: async () => ({ results: [] }),
    baseline: async () => ({}),
  });
}

function makeWatch(calls, fetched) {
  const root = scratchRoot();
  const watch = createCctvWatch({
    root,
    getSources: async () => SOURCES,
    fetchStill: async (source) => {
      fetched.add(source.id);
      return null;
    },
    env: { CCTV_WATCH_REPORTS: '0' },
    log: { info() {}, warn() {} },
    createDetector: fakeDetector(calls),
  });
  return { watch, root };
}

const until = async (check, ms = 2000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('Watch is off until Start; polling only keeps a running Watch alive', async () => {
  const calls = [];
  const { watch, root } = makeWatch(calls, new Set());
  try {
    assert.equal(watch.status().state, 'off');
    watch.touch();
    assert.equal(watch.status().state, 'off', 'a poll never starts Watch');
    assert.deepEqual(calls, []);
    const refused = await watch.start({});
    assert.equal(refused.ok, false, 'an area is required');
    assert.equal(watch.status().state, 'off');
  } finally {
    watch.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Start reads only the chosen area; Stop reads stopping until the detector exits', async () => {
  const calls = [];
  const fetched = new Set();
  const { watch, root } = makeWatch(calls, fetched);
  try {
    const { regions } = await watch.areas();
    const minnesota = regions.find((region) => region.label === 'Minnesota');
    assert.equal(minnesota.cameras, 2);
    const started = await watch.start({ area: minnesota.id });
    assert.equal(started.ok, true);
    assert.equal(watch.status().state, 'running');
    assert.equal(watch.status().area.cameras, 2);
    assert.equal(watch.status().gpuBudget.share, 0.2, 'the shared 20% budget');
    // The sweep's camera list is the area: Reno is never fetched or read.
    await until(() => watch.status().coverage?.analysed.cameras > 0);
    assert.equal(watch.status().coverage.analysed.cameras, 2);
    assert.ok(![...fetched].includes('nv-1'));
    watch.stop();
    assert.equal(
      watch.status().state,
      'stopping',
      'until the detector process has exited',
    );
    assert.equal(
      (await watch.start({ area: minnesota.id })).ok,
      false,
      'no restart while stopping',
    );
    await until(() => watch.status().state === 'off');
    assert.deepEqual(calls, ['start', 'stop']);
    assert.equal(watch.status().area, null);
    const feed = watch.notifications();
    assert.ok(Array.isArray(feed.notifications), 'the feed reads while off');
    assert.ok(Array.isArray(watch.incidents().incidents));
  } finally {
    watch.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
