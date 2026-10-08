// CCTV Watch focused monitoring: manual first, scheduled events capped,
// patrol reserved, and an unchanged trigger never extends a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateFocusSlots,
  createFocus,
} from '../../server/providers/cctv/watch/focus.js';

const session = (id, trigger, cameraId = id, extra = {}) => ({
  id,
  trigger,
  cameraId,
  priority: 0,
  startedAt: 0,
  ...extra,
});

test('manual watches take slots before reports, observations and schedules', () => {
  const granted = allocateFocusSlots(
    [
      session('s1', 'schedule'),
      session('o1', 'observation'),
      session('m1', 'manual'),
      session('r1', 'report'),
    ],
    { slots: 2, patrolSlots: 0, scheduleShare: 0.25 },
  );
  assert.ok(granted.has('m1'));
  assert.equal(granted.size, 2);
  assert.equal(granted.has('s1'), false);
});

test('scheduled events never take more than their share', () => {
  const sessions = Array.from({ length: 10 }, (_, i) =>
    session(`s${i}`, 'schedule'),
  );
  const granted = allocateFocusSlots(sessions, {
    slots: 16,
    patrolSlots: 2,
    scheduleShare: 0.25,
  });
  assert.equal(granted.size, 4, '25% of 16 slots');
});

test('patrol keeps its reserved slots even when triggers fill the rest', () => {
  const sessions = [
    ...Array.from({ length: 20 }, (_, i) => session(`r${i}`, 'report')),
    session('p1', 'patrol'),
    session('p2', 'patrol'),
    session('p3', 'patrol'),
  ];
  const granted = allocateFocusSlots(sessions, {
    slots: 16,
    patrolSlots: 2,
    scheduleShare: 0.25,
  });
  assert.equal([...granted].filter((id) => id.startsWith('p')).length, 2);
  assert.equal([...granted].filter((id) => id.startsWith('r')).length, 14);
});

test('a second trigger on a watched camera rides along in the same slot', () => {
  const granted = allocateFocusSlots(
    [
      session('m1', 'manual', 'cam-1'),
      session('r1', 'report', 'cam-1'),
      session('o1', 'observation', 'cam-2'),
    ],
    { slots: 2, patrolSlots: 0, scheduleShare: 0.25 },
  );
  assert.deepEqual([...granted].sort(), ['m1', 'o1', 'r1']);
});

function focusHarness() {
  let clock = 1_000_000;
  const focus = createFocus({
    cameraById: (id) =>
      id === 'no-video'
        ? { id }
        : { id, url: `https://cams.example/${id}.m3u8` },
    fetchSegments: async () => ({
      segments: [],
      init: null,
      fetchedAt: clock,
      newestSeq: 0,
    }),
    decode: async () => [],
    onFrame: () => {},
    onClip: () => {},
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { focus, advance: (ms) => (clock += ms), now: () => clock };
}

test('the same report polled again does not extend monitoring', () => {
  const { focus, advance } = focusHarness();
  const first = focus.request({
    cameraId: 'cam-1',
    trigger: 'report',
    ref: 'us-wi:1@3/5/26, 2:58 PM',
  });
  advance(10 * 60_000);
  const again = focus.request({
    cameraId: 'cam-1',
    trigger: 'report',
    ref: 'us-wi:1@3/5/26, 2:58 PM',
  });
  assert.equal(again.id, first.id);
  assert.equal(again.endsAt, first.endsAt, 'no extension from a repeat');
  const updated = focus.request({
    cameraId: 'cam-1',
    trigger: 'report',
    ref: 'us-wi:1@3/5/26, 3:20 PM',
  });
  assert.notEqual(updated.id, first.id, 'a real update is a new trigger');
  assert.ok(updated.endsAt > first.endsAt);
});

function clipHarness({ trigger = 'report', spikeMinGapMs = 30_000 } = {}) {
  let clock = 1_000_000;
  let seq = 0;
  const clips = [];
  const timers = [];
  const focus = createFocus({
    cameraById: (id) => ({ id, url: `https://cams.example/${id}.m3u8` }),
    fetchSegments: async () => ({
      segments: [{ seq: ++seq, bytes: Buffer.from([1]), capturedAt: null }],
      init: null,
      fetchedAt: clock,
      newestSeq: seq,
    }),
    // Every poll decodes three fresh frames.
    decode: async () =>
      [0, 1, 2].map((i) => ({
        jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        offsetSec: i,
        captureTime: null,
        captureSource: 'unknown',
        seq,
      })),
    onFrame: () => {},
    onClip: (clip) => clips.push(clip),
    clipEveryMs: 90_000,
    spikeMinGapMs,
    pollMs: 2500,
    now: () => clock,
    setTimer: (fn) => {
      timers.push(fn);
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  const session = focus.request({ cameraId: 'cam-1', trigger });
  focus.start();
  const step = async (ms) => {
    clock += ms;
    timers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { focus, clips, step, session };
}

test('back-to-back screening spikes ask for one clip, not one per spike', async () => {
  const { focus, clips, step } = clipHarness();
  for (let i = 0; i < 4; i += 1) await step(2500);
  const first = clips.length;
  assert.equal(first, 1, 'the first clip once enough frames arrived');
  for (let i = 0; i < 6; i += 1) {
    focus.spike('cam-1');
    await step(2500);
  }
  assert.equal(clips.length, first, 'spikes within 30 s of the last clip wait');
  for (let i = 0; i < 6; i += 1) {
    focus.spike('cam-1');
    await step(2500);
  }
  assert.equal(clips.length, first + 1, 'one spike clip once 30 s passed');
});

test('a patrol sample is read once', async () => {
  const { clips, step } = clipHarness({ trigger: 'patrol' });
  for (let i = 0; i < 6; i += 1) await step(2500);
  assert.equal(clips.length, 1);
});

test('cameras without live video are refused, and sessions can be cancelled', () => {
  const { focus } = focusHarness();
  assert.equal(
    focus.request({ cameraId: 'no-video', trigger: 'manual' }),
    null,
  );
  const watched = focus.request({
    cameraId: 'cam-1',
    trigger: 'manual',
    durationMs: 60_000,
  });
  assert.equal(focus.sessions().length, 1);
  assert.equal(focus.cancel(watched.id), true);
  assert.equal(focus.sessions().length, 0);
  assert.throws(
    () => focus.request({ cameraId: 'cam-1', trigger: 'gossip' }),
    /unknown focus trigger/,
  );
});
