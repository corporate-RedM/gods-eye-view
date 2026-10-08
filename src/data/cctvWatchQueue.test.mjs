// CCTV Watch describer queue: shares keep every class moving, focus and the
// other classes each keep slots the other cannot take, and a camera never
// waits with an older frame than its newest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDescribeQueue } from '../../server/providers/cctv/watch/describeQueue.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const OPEN = { focusReserve: 0, otherReserve: 0 };

function harness(options = {}) {
  const started = [];
  const pending = [];
  let clock = 1_000_000;
  const queue = createDescribeQueue({
    run: (job) =>
      new Promise((resolve) => {
        started.push(job);
        pending.push(resolve);
      }),
    now: () => clock,
    ...options,
  });
  return {
    queue,
    started,
    /** Let dispatches reach `run`, then finish everything running. */
    async finishAll() {
      await tick();
      while (pending.length) pending.shift()();
      await tick();
    },
    advance(ms) {
      clock += ms;
    },
  };
}

test('focus work goes before more sweep work when slots are scarce', async () => {
  const h = harness({ inFlight: 1, ...OPEN });
  h.queue.push({ class: 'sweep', key: 's1', payload: 1 });
  h.queue.push({ class: 'focus', key: 'f1', payload: 2 });
  h.queue.push({ class: 'sweep', key: 's2', payload: 3 });
  for (let i = 0; i < 3; i += 1) await h.finishAll();
  assert.deepEqual(
    h.started.map((job) => job.key),
    ['s1', 'f1', 's2'],
    'the first sweep job had already started; then focus before the second sweep job',
  );
});

test('target shares keep sweep confirmations moving while focus is busy', async () => {
  const h = harness({
    inFlight: 1,
    ...OPEN,
    shares: { focus: 0.5, sweep: 0.3 },
    window: 10,
  });
  for (let i = 0; i < 10; i += 1)
    h.queue.push({ class: 'focus', key: `f${i}`, payload: i });
  for (let i = 0; i < 5; i += 1)
    h.queue.push({ class: 'sweep', key: `s${i}`, payload: i });
  for (let i = 0; i < 15; i += 1) await h.finishAll();
  const firstTen = h.started.slice(0, 10).map((job) => job.class);
  const sweepShare = firstTen.filter((name) => name === 'sweep').length / 10;
  assert.ok(
    sweepShare >= 0.3,
    `sweep got ${sweepShare} of the first ten dispatches`,
  );
});

test('a class with nothing to do leaves its share to the others', async () => {
  const h = harness({ inFlight: 1, ...OPEN });
  for (let i = 0; i < 4; i += 1)
    h.queue.push({ class: 'sweep', key: `s${i}`, payload: i });
  for (let i = 0; i < 4; i += 1) await h.finishAll();
  assert.equal(h.started.length, 4, 'sweep used the idle focus share');
});

test('two in-flight slots stay free for focus work', async () => {
  const h = harness({ inFlight: 4, focusReserve: 2, otherReserve: 0 });
  for (let i = 0; i < 6; i += 1)
    h.queue.push({ class: 'sweep', key: `s${i}`, payload: i });
  await tick();
  assert.equal(h.started.length, 2, 'sweep stops at inFlight - focusReserve');
  h.queue.push({ class: 'focus', key: 'f', payload: 'f' });
  await tick();
  assert.equal(
    h.started.at(-1).key,
    'f',
    'focus starts at once in a reserved slot',
  );
});

test('focus never takes the slots kept for the other classes', async () => {
  const h = harness({ inFlight: 4, focusReserve: 0, otherReserve: 2 });
  for (let i = 0; i < 6; i += 1)
    h.queue.push({ class: 'focus', key: `f${i}`, payload: i });
  await tick();
  assert.equal(h.started.length, 2, 'focus stops at inFlight - otherReserve');
  h.queue.push({ class: 'audit', key: 'a', payload: 'a' });
  await tick();
  assert.equal(h.started.at(-1).key, 'a', 'an audit still gets a slot');
});

test('a newer frame for the same camera replaces the pending one', async () => {
  const h = harness({ inFlight: 1, ...OPEN });
  h.queue.push({ class: 'sweep', key: 'busy', payload: 0 });
  const dropped = [];
  h.queue.push({
    class: 'sweep',
    key: 'cam-1',
    payload: 'old',
    onDrop: (why) => dropped.push(why),
  });
  h.queue.push({ class: 'sweep', key: 'cam-1', payload: 'new' });
  await h.finishAll();
  await h.finishAll();
  assert.equal(h.started[1].payload, 'new');
  assert.deepEqual(dropped, ['replaced']);
  assert.equal(h.queue.stats().classes.sweep.replaced, 1);
});

test('stale jobs expire instead of being read late', async () => {
  const h = harness({ inFlight: 1, ...OPEN, maxAgeMs: { sweep: 1000 } });
  h.queue.push({ class: 'sweep', key: 'busy', payload: 0 });
  const dropped = [];
  h.queue.push({
    class: 'sweep',
    key: 'late',
    payload: 1,
    onDrop: (why) => dropped.push(why),
  });
  await tick();
  h.advance(5000);
  await h.finishAll();
  assert.deepEqual(dropped, ['expired']);
  assert.equal(h.queue.stats().classes.sweep.expired, 1);
  assert.equal(h.started.length, 1, 'the expired job never ran');
});

test('shares follow describer time, not the number of dispatches', async () => {
  // A clip costs four times a still: equal shares of time mean about four
  // stills per clip, not one of each.
  const started = [];
  const queue = createDescribeQueue({
    run: async (job) => {
      started.push(job.class);
      return { runMs: job.kind === 'clip' ? 4000 : 1000, batchSize: 1 };
    },
    inFlight: 1,
    ...OPEN,
    shares: { focus: 0.5, sweep: 0.5 },
    window: 40,
  });
  // Enough of both that neither runs out inside the measured window.
  for (let i = 0; i < 30; i += 1)
    queue.push({ class: 'focus', kind: 'clip', key: `f${i}`, payload: i });
  for (let i = 0; i < 60; i += 1)
    queue.push({ class: 'sweep', kind: 'still', key: `s${i}`, payload: i });
  for (let i = 0; i < 120; i += 1) await tick();
  const window = started.slice(10, 40);
  const clips = window.filter((name) => name === 'focus').length;
  const stills = window.filter((name) => name === 'sweep').length;
  assert.equal(
    stills,
    clips * 4,
    `${stills} stills for ${clips} clips in the steady window`,
  );
  const { costMs, classes } = queue.stats();
  assert.equal(costMs.clip.ms, 4000, 'the clip estimate learned its cost');
  assert.equal(costMs.still.ms, 1000);
  assert.ok(classes.focus.describerMs > 0);
});

test('a job the detector reports no time for is charged its kind estimate', async () => {
  const queue = createDescribeQueue({
    run: async () => ({}),
    ...OPEN,
    costMs: { default: 500, verify: 300 },
  });
  queue.push({ class: 'sweep', kind: 'verify', key: 'v', payload: 1 });
  await tick();
  await tick();
  assert.equal(queue.stats().costMs.verify.ms, 300);
  assert.equal(queue.stats().costMs.verify.measured, 0);
});

test('a full class drops its oldest lowest-priority job, not the new one', () => {
  const h = harness({ inFlight: 1, ...OPEN, maxQueued: { audit: 2 } });
  h.queue.push({ class: 'focus', key: 'busy', payload: 0 });
  const dropped = [];
  h.queue.push({
    class: 'audit',
    key: 'a',
    priority: 6,
    payload: 'a',
    onDrop: () => dropped.push('a'),
  });
  h.queue.push({
    class: 'audit',
    key: 'b',
    priority: 5,
    payload: 'b',
    onDrop: () => dropped.push('b'),
  });
  h.queue.push({ class: 'audit', key: 'c', priority: 5, payload: 'c' });
  assert.deepEqual(dropped, ['a']);
});
