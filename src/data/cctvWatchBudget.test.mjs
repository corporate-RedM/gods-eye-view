// CCTV Watch GPU budget (BK, 2026-10-08): every model call waits for budget
// and is charged the GPU time the detector reports, so over the window Watch
// keeps the GPU busy at most its share of the time and then sits idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetedDetector,
  createGpuBudget,
  gpuMsOf,
} from '../../server/providers/cctv/watch/gpuBudget.js';
import {
  buildAreas,
  isAreaId,
  metroCities,
} from '../../server/providers/cctv/watch/areas.js';
import { notificationsFrom } from '../../server/providers/cctv/watch/notifications.js';

/** A manual clock and timer list. */
function clock() {
  let at = 0;
  const timers = [];
  return {
    now: () => at,
    setTimer(fn, ms) {
      const timer = { fn, due: at + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    async advance(ms) {
      at += ms;
      for (const timer of timers.filter((t) => t.due <= at)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('once the window share is spent, calls wait until older work leaves it', async () => {
  const time = clock();
  const budget = createGpuBudget({ share: 0.2, windowMs: 60_000, ...time });
  const done = [];
  // Each call reports 6 s of GPU time: two fill the 12 s allowance.
  const call = (name) =>
    budget
      .run(1000, async () => ({ runMs: 6000 }), gpuMsOf)
      .then(() => done.push(name));
  call('a');
  await new Promise((resolve) => setImmediate(resolve));
  call('b');
  await new Promise((resolve) => setImmediate(resolve));
  call('c');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(done, ['a', 'b'], 'the third waits: 12 of 12 s used');
  assert.equal(budget.status().waiting, 1);
  await time.advance(59_000);
  assert.deepEqual(done, ['a', 'b']);
  await time.advance(1_100);
  assert.deepEqual(
    done,
    ['a', 'b', 'c'],
    'admitted as the first charge expires',
  );
  assert.equal(budget.status().share, 0.2);
});

test('a batch is charged its share, and stopping fails the waiting calls', async () => {
  assert.equal(gpuMsOf({ runMs: 1600, batchSize: 4 }), 400);
  assert.equal(gpuMsOf({ runMs: 0 }), 0, 'a question not asked costs nothing');
  const time = clock();
  const budget = createGpuBudget({ share: 0.1, windowMs: 10_000, ...time });
  const detector = budgetedDetector(
    {
      status: () => ({ state: 'ready' }),
      describe: async () => ({ runMs: 1000, batchSize: 1 }),
    },
    budget,
  );
  assert.equal(
    detector.status().state,
    'ready',
    'status passes straight through',
  );
  await detector.describe({ mode: 'clip' });
  assert.equal(
    Math.round(detector.estimates()['describe:clip']),
    1420,
    'the reservation follows what a clip reading really costs',
  );
  const waiting = detector.describe({ mode: 'clip' });
  budget.close();
  await assert.rejects(waiting, /Watch stopped/);
  await assert.rejects(() => detector.describe({}), /Watch stopped/);
});

test('cities within 30 km form one metro named after the largest; cameras group by region, city, municipality', () => {
  const places = [
    ['Minneapolis', 44.98, -93.26, 425000],
    ['Saint Paul', 44.94, -93.09, 303000],
    ['Reno', 39.53, -119.81, 264000],
  ];
  const metros = metroCities(places);
  assert.equal(
    metros.find((m) => m.name === 'Saint Paul').metro,
    'Minneapolis',
  );
  const camera = (id, provider, city, lat, lon) => ({
    id,
    provider,
    city,
    lat,
    lon,
  });
  const areas = buildAreas(
    [
      camera('a', '511 Minnesota (MnDOT)', 'Minneapolis', 44.98, -93.27),
      camera('b', '511 Minnesota (MnDOT)', 'Saint Paul', 44.95, -93.1),
      camera('c', '511 Minnesota (MnDOT)', 'Stillwater', 45.06, -92.81),
      camera('d', 'DelDOT', 'Wilmington (New Castle County)', 39.74, -75.55),
    ],
    places,
  );
  const minnesota = areas.regions.find(
    (region) => region.label === 'Minnesota',
  );
  const metro = minnesota.cities.find(
    (city) => city.label === 'Minneapolis area',
  );
  assert.equal(
    metro.cameras,
    3,
    'Stillwater is within 30 km of Saint Paul, so of its metro',
  );
  assert.deepEqual(metro.municipalities.map((m) => m.label).sort(), [
    'Minneapolis',
    'Saint Paul',
    'Stillwater',
  ]);
  const delaware = areas.regions.find((region) => region.label === 'Delaware');
  assert.equal(
    delaware.cities[0].label,
    'Wilmington',
    'no large city near: its own municipality',
  );
  assert.deepEqual([...areas.members(metro.id)].sort(), ['a', 'b', 'c']);
  assert.ok(isAreaId(metro.id));
  assert.ok(isAreaId(metro.municipalities[0].id));
  assert.equal(isAreaId('region:../../etc'), false);
  assert.equal(isAreaId({}), false);
});

test('the feed has one entry per camera incident and says when no check settled it', () => {
  const member = (sightings, support) => ({
    sightings,
    lastSeen: { result: 'present', support },
  });
  const incidents = [
    {
      id: 'inc-1',
      kind: 'camera',
      revision: 4,
      headline: { text: 'Vehicle off road' },
      conditions: [
        {
          type: 'vehicle_off_road',
          label: 'Vehicle off road',
          members: [member(3, { unverified: 'the check could not settle it' })],
        },
      ],
      confidence: 'possible',
      state: 'ongoing',
      cameras: ['cam-1'],
      location: { cameraId: 'cam-1' },
      firstSeenAt: 1000,
      lastEvidenceAt: 5000,
    },
    {
      id: 'inc-2',
      kind: 'camera',
      revision: 2,
      headline: { text: 'Debris on road' },
      conditions: [
        {
          type: 'debris_on_road',
          label: 'Debris on road',
          members: [
            member(1, { verification: { answer: 'objects_in_the_lanes' } }),
          ],
        },
      ],
      confidence: 'possible',
      state: 'ongoing',
      cameras: ['cam-2'],
      firstSeenAt: 2000,
      lastEvidenceAt: 3000,
    },
    { id: 'inc-3', kind: 'report', conditions: [], cameras: [] },
  ];
  const feed = notificationsFrom(incidents, (id) => ({
    name: `Camera ${id}`,
    city: 'Reno',
  }));
  assert.deepEqual(
    feed.map((entry) => entry.id),
    ['inc-1', 'inc-2'],
    'reports are not AI detections',
  );
  assert.equal(feed[0].verification, 'unverified');
  assert.equal(feed[0].sightings, 3, 'repeat sightings update one entry');
  assert.equal(feed[0].cameraName, 'Camera cam-1');
  assert.equal(feed[1].verification, 'checked');
  assert.equal(feed[1].confidence, 'possible');
});
