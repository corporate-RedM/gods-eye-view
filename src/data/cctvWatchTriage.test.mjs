// CCTV Watch triage: a single still never asserts motion, screener misses are
// audited, and a changed view is re-profiled instead of read as an anomaly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadWatchEvents,
  loadWatchThresholds,
} from '../../server/providers/cctv/watch/events.js';
import {
  createTriage,
  enforceEvidenceRules,
  motionSuspects,
} from '../../server/providers/cctv/watch/triage.js';
import { createProfileStore } from '../../server/providers/cctv/watch/profiles.js';

const events = loadWatchEvents(
  JSON.parse(
    readFileSync(
      new URL('../../config/cctv_watch_events.json', import.meta.url),
      'utf8',
    ),
  ),
);
const thresholds = loadWatchThresholds({
  version: 1,
  screen: { default: 0.1 },
  novelty: { review: 0.35, learnMax: 0.25, warmupSamples: 20 },
});

const reading = (observations) => ({
  ok: true,
  visibility: 'good',
  visibilityIssues: [],
  observations,
  summary: '',
});
const item = (type, result = 'present', confidence = 0.9) => ({
  type,
  result,
  confidence,
  detail: '',
});

test('a single still can never make stopped traffic present', () => {
  const result = enforceEvidenceRules(
    reading([item('traffic_stopped'), item('smoke')]),
    'still',
    events.observations,
  );
  assert.deepEqual(
    result.observations.map((o) => [o.type, o.result, o.enforced ?? null]),
    [
      ['traffic_stopped', 'unclear', 'needs-motion'],
      ['smoke', 'present', null],
    ],
  );
  assert.deepEqual(motionSuspects(result, events.observations), [
    'traffic_stopped',
  ]);
});

test('two stills a minute apart may settle traffic, but an altercation needs a clip', () => {
  const pair = enforceEvidenceRules(
    reading([item('traffic_stopped'), item('physical_altercation')]),
    'pair',
    events.observations,
  );
  assert.equal(pair.observations[0].result, 'present');
  assert.equal(pair.observations[1].result, 'unclear');
  const clip = enforceEvidenceRules(
    reading([item('physical_altercation')]),
    'clip',
    events.observations,
  );
  assert.equal(clip.observations[0].result, 'present');
});

test('an unreadable reading passes through untouched', () => {
  const bad = { ok: false, observations: [] };
  assert.equal(enforceEvidenceRules(bad, 'still', events.observations), bad);
  assert.deepEqual(motionSuspects(bad, events.observations), []);
});

function fakeDetector(screenScores) {
  const calls = { screen: [], describe: [], baseline: [], neutral: null };
  return {
    calls,
    screen: async ({ frames, neutral }) => {
      calls.screen.push(frames.length);
      calls.neutral = neutral;
      return {
        results: frames.map((frame, index) => ({
          id: String(index),
          ...screenScores(frame, index),
        })),
      };
    },
    describe: async (request) => {
      calls.describe.push(request);
      return {
        result:
          request.mode === 'profile'
            ? { ok: true, scene: 'highway', roadVisible: true }
            : reading([]),
        queuedMs: 0,
        runMs: 1,
        batchSize: 1,
        outputTokens: 5,
      };
    },
    count: async () => ({ results: [] }),
    baseline: async (request) => {
      calls.baseline.push(request);
      return {};
    },
  };
}

function inlineQueue() {
  const pushed = [];
  return {
    pushed,
    push(job) {
      pushed.push(job);
      Promise.resolve(job.run()).then((result) =>
        job.onResult?.(result, { waitMs: 0 }),
      );
    },
  };
}

const frame = (cameraId, extra = {}) => ({
  cameraId,
  camera: { id: cameraId, name: cameraId, lon: -90 },
  origin: 'sweep',
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  fetchedAt: Date.parse('2026-10-07T18:00:00Z'),
  captureTime: null,
  captureSource: 'unknown',
  hash: 'h',
  ...extra,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const FETCHED_AT = Date.parse('2026-10-07T18:00:00Z');

test('a frame over threshold goes to the describer as a sweep reading', async () => {
  const detector = fakeDetector(() => ({
    scores: { damaged_vehicles: 0.4 },
    novelty: 0.1,
    baselineSamples: 30,
  }));
  const queue = inlineQueue();
  const readings = [];
  const triage = createTriage({
    events,
    thresholds,
    detector,
    queue,
    profiles: createProfileStore(),
    onReading: (r) => readings.push(r),
    random: () => 1,
    screenFlushMs: 0,
    now: () => FETCHED_AT + 2500,
  });
  triage.submit(frame('cam-1'));
  await settle();
  const still = detector.calls.describe.find((call) => call.mode === 'still');
  assert.ok(still, 'a still reading was requested');
  assert.equal(
    queue.pushed.find((job) => job.payload.mode === 'still').class,
    'sweep',
  );
  assert.equal(
    readings[0].fetchedAt,
    FETCHED_AT,
    'readings carry their fetch time',
  );
  assert.equal(
    readings[0].analyzedAt,
    FETCHED_AT + 2500,
    'and their analysis time',
  );
  assert.equal(readings[0].captureTime, null);
  assert.equal(
    readings[0].captureSource,
    'unknown',
    'an unknown capture time says so',
  );
  assert.deepEqual(
    detector.calls.neutral,
    events.screening.neutral,
    'screening is measured against the ordinary scenes in the config',
  );
  assert.ok(detector.calls.neutral.length >= 3);
});

test('a camera with an open condition is read again without a screening hit, but not every frame', async () => {
  const detector = fakeDetector(() => ({
    scores: {},
    novelty: 0.1,
    baselineSamples: 30,
  }));
  const readings = [];
  const triage = createTriage({
    events,
    thresholds,
    detector,
    queue: inlineQueue(),
    profiles: createProfileStore(),
    onReading: (r) => readings.push(r),
    followUp: (cameraId) => cameraId === 'cam-1',
    followUpEveryMs: 120_000,
    random: () => 1,
    screenFlushMs: 0,
  });
  for (const [cameraId, offset] of [
    ['cam-1', 0],
    ['cam-1', 30_000],
    ['cam-2', 30_000],
    ['cam-1', 130_000],
  ]) {
    triage.submit(frame(cameraId, { fetchedAt: FETCHED_AT + offset }));
    await settle();
  }
  const stills = readings.filter((r) => r.mode === 'still');
  assert.deepEqual(
    stills.map((r) => [r.cameraId, r.fetchedAt - FETCHED_AT]),
    [
      ['cam-1', 0],
      ['cam-1', 130_000],
    ],
  );
  assert.ok(
    stills.every((r) => r.readingId),
    'every reading has an id',
  );
  assert.equal(triage.stats().followUps, 2);
});

test('frames the screener passed as normal are sometimes audited, ungated', async () => {
  const detector = fakeDetector(() => ({
    scores: {},
    novelty: 0.05,
    baselineSamples: 30,
  }));
  const queue = inlineQueue();
  const profiles = createProfileStore();
  // A profiled highway camera: people types are gated out of normal readings.
  for (const part of ['day', 'night'])
    profiles.addSample(
      'cam-1',
      {
        ok: true,
        scene: 'highway',
        roadVisible: true,
        pedestrianAreaVisible: false,
        peopleScale: 'none',
      },
      { part },
    );
  const triage = createTriage({
    events,
    thresholds,
    detector,
    queue,
    profiles,
    random: () => 0,
    auditRate: 0.5,
    screenFlushMs: 0,
  });
  triage.submit(frame('cam-1'));
  await settle();
  const audit = queue.pushed.find((job) => job.class === 'audit');
  assert.ok(audit, 'an audit was queued');
  const asked = detector.calls.describe
    .find((call) => call.mode === 'still')
    .vocabulary.map((v) => v.id);
  assert.ok(asked.includes('physical_altercation'), 'audits ignore gating');
});

test('an unprofiled camera gets one profile request per ten minutes, not one per frame', async () => {
  const detector = fakeDetector(() => ({
    scores: {},
    novelty: 0.05,
    baselineSamples: 30,
  }));
  // A profile reading that never lands keeps the camera unprofiled.
  detector.describe = async (request) => {
    detector.calls.describe.push(request);
    return { result: { ok: false }, queuedMs: 0, runMs: 1 };
  };
  const triage = createTriage({
    events,
    thresholds,
    detector,
    queue: inlineQueue(),
    profiles: createProfileStore(),
    random: () => 1,
    screenFlushMs: 0,
  });
  for (let i = 0; i < 4; i += 1) {
    triage.submit(frame('cam-1', { fetchedAt: FETCHED_AT + i * 60_000 }));
    await settle();
  }
  const profiles = detector.calls.describe.filter((c) => c.mode === 'profile');
  assert.equal(profiles.length, 1);
  triage.submit(frame('cam-1', { fetchedAt: FETCHED_AT + 11 * 60_000 }));
  await settle();
  assert.equal(
    detector.calls.describe.filter((c) => c.mode === 'profile').length,
    2,
  );
});

test('every reading reaches the detector at one priority', async () => {
  const detector = fakeDetector(() => ({
    scores: { damaged_vehicles: 0.4 },
    novelty: 0.1,
    baselineSamples: 30,
  }));
  const triage = createTriage({
    events,
    thresholds,
    detector,
    queue: inlineQueue(),
    profiles: createProfileStore(),
    random: () => 1,
    screenFlushMs: 0,
  });
  triage.submit(frame('cam-1'));
  await settle();
  const priorities = new Set(detector.calls.describe.map((c) => c.priority));
  assert.deepEqual([...priorities], [5]);
});

test('a sustained jump in novelty re-profiles the camera and resets its baseline', async () => {
  const detector = fakeDetector(() => ({
    scores: {},
    novelty: 0.8,
    baselineSamples: 40,
  }));
  const profiles = createProfileStore();
  profiles.addSample(
    'cam-1',
    { ok: true, scene: 'highway', roadVisible: true },
    { part: 'day' },
  );
  profiles.addSample(
    'cam-1',
    { ok: true, scene: 'highway', roadVisible: true },
    { part: 'night' },
  );
  const triage = createTriage({
    events,
    thresholds,
    detector,
    queue: inlineQueue(),
    profiles,
    random: () => 1,
    screenFlushMs: 0,
  });
  for (let i = 0; i < 3; i += 1) {
    triage.submit(
      frame('cam-1', {
        fetchedAt: Date.parse('2026-10-07T18:00:00Z') + i * 60_000,
      }),
    );
    await settle();
  }
  assert.equal(detector.calls.baseline.length, 1);
  assert.equal(detector.calls.baseline[0].action, 'reset');
  // The frame that tripped the change was profiled at once, into a fresh
  // profile: the two samples of the old view are gone.
  assert.equal(profiles.summary('cam-1').samples, 1);
});

const verifying = loadWatchThresholds({
  version: 1,
  screen: { default: 0.1 },
  novelty: { review: 0.35, learnMax: 0.25, warmupSamples: 20 },
  verification: {
    same: ['people_on_roadway'],
    closer: ['vehicle_off_road', 'traffic_stopped'],
  },
});

/** A describer that reports the same observations, and a verify that agrees. */
function claimingDetector(observations, screenScores) {
  const detector = fakeDetector(screenScores);
  detector.calls.verify = [];
  detector.describe = async (request) => {
    detector.calls.describe.push(request);
    return {
      result:
        request.mode === 'profile'
          ? { ok: true, scene: 'highway', roadVisible: true }
          : reading(observations),
      queuedMs: 0,
      runMs: 1,
      batchSize: 1,
      outputTokens: 5,
    };
  };
  detector.verify = async (request) => {
    detector.calls.verify.push(request);
    return {
      result: { result: 'present', answer: 'yes', confidence: 0.9, reason: '' },
    };
  };
  return detector;
}

test('a claim the measured policy checks is held for its narrow question; the rest count at once', async () => {
  const detector = claimingDetector(
    [
      { ...item('people_on_roadway'), box: [100, 200, 300, 400] },
      item('damaged_vehicles'),
    ],
    () => ({
      scores: { people_on_roadway: 0.4 },
      novelty: 0.1,
      baselineSamples: 30,
    }),
  );
  const queue = inlineQueue();
  const readings = [];
  const verdicts = [];
  const triage = createTriage({
    events,
    thresholds: verifying,
    detector,
    queue,
    profiles: createProfileStore(),
    onReading: (r) => readings.push(r),
    onVerification: (v) => verdicts.push(v),
    random: () => 1,
    screenFlushMs: 0,
  });
  triage.submit(frame('cam-1'));
  await settle();
  const still = readings.find((r) => r.mode === 'still');
  assert.deepEqual(
    still.pendingVerification,
    ['people_on_roadway'],
    'a type without a measured benefit is not asked again',
  );
  const job = queue.pushed.find((pushed) => pushed.kind === 'verify');
  assert.equal(
    job.key,
    'verify:cam-1:people_on_roadway',
    'one pending check per camera and type',
  );
  const [asked] = detector.calls.verify;
  assert.equal(asked.closer, false);
  assert.deepEqual(asked.box, [100, 200, 300, 400]);
  assert.deepEqual(
    asked.frames.map((f) => f.offsetSec),
    [0],
  );
  assert.equal(
    asked.frames[0].jpeg,
    still.jpegs[0],
    'asked on the frame the claim was made on',
  );
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].record, still);
  assert.equal(verdicts[0].arm, 'same');
  assert.equal(verdicts[0].verdict.result, 'present');
});

test("a still's motion claim waits for the camera's next fresh frames, or until its wait is up", async () => {
  let clock = FETCHED_AT;
  // Only this frame looks like stopped traffic to the screener.
  const suspect = Buffer.from([0xff, 0xd8, 0x01, 0xd9]);
  const detector = claimingDetector([item('traffic_stopped')], (f) => ({
    scores: f.jpeg === suspect ? { traffic_stopped: 0.4 } : {},
    novelty: 0.1,
    baselineSamples: 30,
  }));
  const readings = [];
  const triage = createTriage({
    events,
    thresholds: verifying,
    detector,
    queue: inlineQueue(),
    profiles: createProfileStore(),
    onReading: (r) => readings.push(r),
    random: () => 1,
    screenFlushMs: 0,
    now: () => clock,
  });
  triage.submit(frame('cam-1', { jpeg: suspect }));
  await settle();
  const still = readings.find((r) => r.mode === 'still');
  assert.deepEqual(
    still.reading.observations.map((o) => o.result),
    ['unclear'],
    'a single still never asserts stopped traffic',
  );
  assert.deepEqual(still.pendingVerification, ['traffic_stopped']);
  assert.equal(triage.stats().claimsAwaitingFrames, 1);
  // Another camera's frame is no part of this camera's sequence.
  triage.submit(frame('cam-2', { fetchedAt: FETCHED_AT + 30_000 }));
  triage.submit(frame('cam-1', { fetchedAt: FETCHED_AT + 60_000 }));
  await settle();
  assert.equal(
    detector.calls.verify.length,
    0,
    'one newer frame is not yet a sequence',
  );
  triage.submit(frame('cam-1', { fetchedAt: FETCHED_AT + 120_000 }));
  await settle();
  const [asked] = detector.calls.verify;
  assert.equal(asked.closer, true);
  assert.deepEqual(
    asked.frames.map((f) => f.offsetSec),
    [0, 60, 120],
  );
  assert.equal(triage.stats().claimsAwaitingFrames, 0);

  // A camera with no newer frame is asked on the one it has once the wait is up.
  triage.submit(frame('cam-3', { jpeg: suspect }));
  await settle();
  assert.equal(triage.stats().claimsAwaitingFrames, 1);
  clock = FETCHED_AT + 5 * 60_000;
  triage.submit(frame('cam-2', { fetchedAt: clock }));
  await settle();
  assert.equal(detector.calls.verify.length, 2);
  assert.deepEqual(
    detector.calls.verify[1].frames.map((f) => f.offsetSec),
    [0],
  );
  assert.equal(triage.stats().claimsAwaitingFrames, 0);
});

test("a clip's claim is checked on the clip's own frames, the last one first", async () => {
  const detector = claimingDetector(
    [{ ...item('vehicle_off_road'), box: [10, 20, 30, 40] }],
    () => ({ scores: {}, novelty: 0.1, baselineSamples: 30 }),
  );
  const readings = [];
  const triage = createTriage({
    events,
    thresholds: verifying,
    detector,
    queue: inlineQueue(),
    profiles: createProfileStore(),
    onReading: (r) => readings.push(r),
    random: () => 1,
    screenFlushMs: 0,
  });
  triage.describeClip({
    cameraId: 'cam-1',
    camera: { id: 'cam-1', name: 'cam-1', lon: -90 },
    origin: 'focus',
    fetchedAt: FETCHED_AT + 9000,
    frames: [0, 4, 8].map((offsetSec) => ({
      jpeg: Buffer.from([0xff, 0xd8, offsetSec, 0xd9]),
      offsetSec,
      captureTime: FETCHED_AT + offsetSec * 1000,
      captureSource: 'segment',
    })),
  });
  await settle();
  const clip = readings.find((r) => r.mode === 'clip');
  assert.deepEqual(clip.pendingVerification, ['vehicle_off_road']);
  const [asked] = detector.calls.verify;
  assert.equal(asked.closer, true);
  assert.deepEqual(asked.box, [10, 20, 30, 40]);
  assert.deepEqual(
    asked.frames.map((f) => f.offsetSec),
    [0, -4, -8],
    'the box is drawn on the last frame, so that frame leads',
  );
  assert.equal(asked.frames[0].jpeg, clip.jpegs[2]);
  assert.equal(
    triage.stats().claimsAwaitingFrames,
    0,
    'a clip never waits for frames',
  );
});
