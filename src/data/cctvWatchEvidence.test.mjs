// CCTV Watch evidence model: observations, conditions and causes. Repeated
// frames never corroborate, silence never ends anything, a later clear scene
// ends a condition without ruling it out, and causes need real support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadWatchEvents,
  loadWatchThresholds,
} from '../../server/providers/cctv/watch/events.js';
import {
  modeCanShow,
  readingObservations,
  strengthOf,
} from '../../server/providers/cctv/watch/observations.js';
import { createConditionTracker } from '../../server/providers/cctv/watch/conditions.js';
import {
  evaluateCauses,
  headlineFor,
} from '../../server/providers/cctv/watch/causes.js';

const events = loadWatchEvents(
  JSON.parse(
    readFileSync(
      new URL('../../config/cctv_watch_events.json', import.meta.url),
      'utf8',
    ),
  ),
);
// Test thresholds: one type calibrated for single-source confirmation.
const thresholds = loadWatchThresholds({
  version: 1,
  likely: { default: 0.85 },
  screen: { default: 0.02 },
  singleSourceConfirm: { overturned_vehicle: 0.95 },
});

const MIN = 60_000;
const T = Date.UTC(2026, 9, 7, 18, 0, 0);

const present = (type, confidence = 0.9) => ({
  type,
  result: 'present',
  confidence,
  detail: '',
});
const unclear = (type, enforced = null) => ({
  type,
  result: 'unclear',
  confidence: 0.5,
  detail: '',
  ...(enforced ? { enforced } : {}),
});

function record(cameraId, mode, at, items, options = {}) {
  return {
    cameraId,
    mode,
    origin: mode === 'clip' ? 'focus' : 'sweep',
    captureTime: at,
    captureSource: 'last-modified',
    fetchedAt: at + 1000,
    analyzedAt: at + 5000,
    reading: {
      ok: true,
      visibility: options.visibility ?? 'good',
      visibilityIssues: [],
      observations: items,
    },
    checkedTypes: options.checked ?? [...events.observations.keys()],
    screen: options.screen ?? null,
  };
}

function tracker(options = {}) {
  const conditions = createConditionTracker({ events, ...options });
  const read = (...args) =>
    conditions.apply(
      readingObservations(record(...args), { events, thresholds }),
    );
  const only = (cameraId, type) =>
    conditions
      .all()
      .filter((item) => item.cameraId === cameraId && item.type === type);
  return { conditions, read, only };
}

test('unlisted types are absent only in good light and only where the evidence can show them', () => {
  const still = readingObservations(
    record('cam-1', 'still', T, [present('vehicle_fire')]),
    { events, thresholds },
  );
  const byType = new Map(still.map((item) => [item.type, item]));
  assert.equal(byType.get('vehicle_fire').result, 'present');
  assert.equal(byType.get('smoke').result, 'absent');
  assert.equal(byType.has('traffic_stopped'), false, 'a still shows no motion');
  assert.equal(byType.has('physical_altercation'), false, 'clip only');

  const dim = readingObservations(
    record('cam-1', 'still', T, [present('vehicle_fire')], {
      visibility: 'reduced',
    }),
    { events, thresholds },
  );
  assert.deepEqual(
    dim.map((item) => item.result),
    ['present'],
    'a dim frame says nothing about what it did not list',
  );

  const clip = readingObservations(record('cam-1', 'clip', T, []), {
    events,
    thresholds,
  });
  const clipTypes = new Set(clip.map((item) => item.type));
  assert.ok(clipTypes.has('physical_altercation'));
  assert.ok(clipTypes.has('traffic_stopped'));
  assert.equal(
    modeCanShow('pair', events.observations.get('physical_altercation')),
    false,
  );
});

test('strength follows the calibrated thresholds; one source confirms only calibrated types', () => {
  const strength = (type, confidence, visibility = 'good') =>
    strengthOf(present(type, confidence), visibility, thresholds);
  assert.equal(strength('overturned_vehicle', 0.97), 'confirmed');
  assert.equal(strength('overturned_vehicle', 0.97, 'reduced'), 'likely');
  assert.equal(strength('overturned_vehicle', 0.97, 'poor'), 'possible');
  assert.equal(strength('overturned_vehicle', 0.9), 'likely');
  assert.equal(
    strength('vehicle_fire', 0.99),
    'likely',
    'not calibrated for single-source confirmation',
  );
  assert.equal(strength('vehicle_fire', 0.6), 'possible');
  assert.equal(
    strengthOf(unclear('vehicle_fire'), 'good', thresholds),
    'unclear',
  );
});

test('repeated frames from one camera never raise confidence', () => {
  const { read, only } = tracker();
  for (let i = 0; i < 6; i += 1)
    read('cam-1', 'still', T + i * MIN, [present('vehicle_fire', 0.6)]);
  const [fire] = only('cam-1', 'vehicle_fire');
  assert.equal(fire.sightings, 6);
  assert.equal(fire.confidence, 'possible');
  const changes = read('cam-1', 'still', T + 7 * MIN, [
    present('vehicle_fire', 0.9),
  ]);
  assert.equal(changes[0].change, 'upgraded', 'a stronger single reading does');
  assert.equal(fire.confidence, 'likely');
});

test('silence never ends a condition', () => {
  const { conditions, read, only } = tracker({ quietAfterMs: 15 * MIN });
  read('cam-1', 'still', T, [present('overturned_vehicle')]);
  const quiet = conditions.tick(T + 40 * MIN, () => 'camera stale');
  const [overturned] = only('cam-1', 'overturned_vehicle');
  assert.equal(quiet.length, 1);
  assert.equal(overturned.state, 'no_recent_evidence');
  assert.equal(overturned.stateReason, 'camera stale');
  assert.equal(overturned.confidence, 'likely', 'confidence is untouched');
  assert.equal(overturned.endedAt, null);
  read('cam-1', 'still', T + 41 * MIN, [present('overturned_vehicle')]);
  assert.equal(overturned.state, 'ongoing', 'a fresh sighting brings it back');
});

test('a later clear scene ends a condition but does not rule it out', () => {
  const { read, only } = tracker();
  read('cam-1', 'still', T, [present('overturned_vehicle')]);
  read('cam-1', 'still', T + 10 * MIN, [present('road_clear')]);
  const [overturned] = only('cam-1', 'overturned_vehicle');
  assert.equal(overturned.state, 'ended');
  assert.equal(overturned.endedBy, 'road_clear');
  assert.equal(overturned.confidence, 'likely');
  assert.equal(overturned.ruledOut, null);
});

test('one absence does not end a condition; consecutive fresh absences do', () => {
  const { read, only } = tracker();
  read('cam-1', 'still', T, [present('vehicle_fire')]);
  read('cam-1', 'still', T + 5 * MIN, []);
  const [fire] = only('cam-1', 'vehicle_fire');
  assert.equal(fire.state, 'ongoing');
  assert.equal(fire.absentStreak, 1);
  read('cam-1', 'still', T + 6 * MIN, [present('vehicle_fire')]);
  assert.equal(fire.absentStreak, 0, 'a sighting resets the count');
  read('cam-1', 'still', T + 10 * MIN, []);
  read('cam-1', 'still', T + 15 * MIN, []);
  assert.equal(fire.state, 'ended');
  assert.equal(fire.confidence, 'likely');
});

test('absence in poor light says nothing', () => {
  const { read, only } = tracker();
  read('cam-1', 'still', T, [present('vehicle_fire')]);
  for (let i = 1; i <= 4; i += 1)
    read('cam-1', 'still', T + i * 5 * MIN, [], { visibility: 'poor' });
  const [fire] = only('cam-1', 'vehicle_fire');
  assert.equal(fire.state, 'ongoing');
  assert.equal(fire.absentStreak, 0);
});

test('a better look at the same moment rules a sighting out; an equal look only conflicts', () => {
  const { read, only } = tracker();
  read('cam-a', 'still', T, [present('vehicle_fire')]);
  const ruled = read('cam-a', 'clip', T + 40_000, []);
  const [fireA] = only('cam-a', 'vehicle_fire');
  assert.equal(ruled[0].change, 'ruled_out');
  assert.equal(fireA.confidence, 'ruled_out');
  assert.equal(fireA.state, 'ended');

  read('cam-b', 'still', T, [present('vehicle_fire')]);
  read('cam-b', 'still', T + MIN, []);
  const [fireB] = only('cam-b', 'vehicle_fire');
  assert.equal(fireB.confidence, 'inconclusive', 'stills that disagree');
  assert.equal(fireB.state, 'ongoing');
  read('cam-b', 'still', T + 2 * MIN, [present('vehicle_fire')]);
  assert.equal(
    fireB.confidence,
    'inconclusive',
    'another still settles nothing',
  );
  read('cam-b', 'clip', T + 3 * MIN, [present('vehicle_fire', 0.6)]);
  assert.equal(
    fireB.confidence,
    'possible',
    'the clip settles it, at the clip strength',
  );
});

test('a weaker look never overrides a better one', () => {
  const { read, only } = tracker();
  read('cam-1', 'clip', T, [present('vehicle_fire')]);
  read('cam-1', 'still', T + 30_000, []);
  const [fire] = only('cam-1', 'vehicle_fire');
  assert.equal(fire.confidence, 'likely');
  assert.equal(fire.conflict, null);
});

test('stopped traffic that starts moving has ended, not been ruled out', () => {
  const { read, only } = tracker();
  read('cam-1', 'clip', T, [present('traffic_stopped')]);
  read('cam-1', 'clip', T + 30_000, [present('traffic_flowing')]);
  const [stopped] = only('cam-1', 'traffic_stopped');
  assert.equal(stopped.state, 'ended');
  assert.equal(stopped.endedBy, 'traffic_flowing');
  assert.equal(stopped.confidence, 'likely');
});

test('a reading that lists both sides does not end anything', () => {
  const { read, only } = tracker();
  read('cam-1', 'clip', T, [present('traffic_stopped')]);
  read('cam-1', 'clip', T + 5 * MIN, [
    present('traffic_stopped'),
    present('traffic_flowing'),
  ]);
  assert.equal(only('cam-1', 'traffic_stopped')[0].state, 'ongoing');
});

test('a still never asserts motion: the clip decides, and an unsettled suspicion is inconclusive', () => {
  const { read, only } = tracker();
  // The still's "present" arrives already downgraded by the evidence rules.
  read('cam-1', 'still', T, [unclear('physical_altercation', 'needs-motion')]);
  assert.equal(only('cam-1', 'physical_altercation').length, 0);
  read('cam-1', 'clip', T + MIN, [unclear('physical_altercation')]);
  const [fight] = only('cam-1', 'physical_altercation');
  assert.equal(fight.confidence, 'inconclusive');

  read('cam-2', 'still', T, [unclear('physical_altercation', 'needs-motion')]);
  read('cam-2', 'clip', T + MIN, []);
  assert.equal(
    only('cam-2', 'physical_altercation').length,
    0,
    'a clip showing nothing answers it',
  );

  read('cam-3', 'still', T, [unclear('physical_altercation', 'needs-motion')]);
  read('cam-3', 'clip', T + MIN, [present('physical_altercation')]);
  assert.equal(only('cam-3', 'physical_altercation')[0].confidence, 'likely');

  read('cam-4', 'clip', T, [unclear('physical_altercation')]);
  assert.equal(
    only('cam-4', 'physical_altercation').length,
    0,
    'an unclear clip with no suspicion behind it opens nothing',
  );
});

test('focus that ends without a decisive reading says so', () => {
  const { conditions, read, only } = tracker();
  read('cam-1', 'still', T, [present('vehicle_fire')]);
  read('cam-1', 'clip', T + 2 * MIN, [unclear('vehicle_fire')], {
    visibility: 'poor',
  });
  conditions.focusEnded('cam-1', T + MIN);
  const [fire] = only('cam-1', 'vehicle_fire');
  assert.equal(fire.state, 'monitoring_ended');
  assert.equal(fire.confidence, 'likely');
});

test('a late reading of an older capture does not reopen an ended condition', () => {
  const { read, only } = tracker();
  read('cam-1', 'still', T, [present('vehicle_fire')]);
  read('cam-1', 'still', T + 5 * MIN, []);
  read('cam-1', 'still', T + 10 * MIN, []);
  const changes = read('cam-1', 'still', T + 2 * MIN, [
    present('vehicle_fire'),
  ]);
  assert.equal(changes[0].change, 'late');
  assert.equal(only('cam-1', 'vehicle_fire').length, 1);
});

const evidenceWith = (conditions, extra = {}) => ({
  conditions: new Map(
    Object.entries(conditions).map(([type, confidence]) => [
      type,
      { confidence, cameras: ['cam-1'] },
    ]),
  ),
  reports: [],
  areaReports: [],
  context: new Set(),
  profiles: [],
  ...extra,
});
const causeIds = (evidence) =>
  evaluateCauses(events, evidence).causes.map((cause) => cause.id);

test('a vehicle fire, people running, low visibility or stopped traffic alone support no cause', () => {
  assert.deepEqual(causeIds(evidenceWith({ vehicle_fire: 'confirmed' })), []);
  assert.deepEqual(causeIds(evidenceWith({ people_running: 'confirmed' })), []);
  assert.deepEqual(causeIds(evidenceWith({ low_visibility: 'confirmed' })), []);
  assert.deepEqual(
    causeIds(evidenceWith({ traffic_stopped: 'confirmed' })),
    [],
  );
  assert.deepEqual(causeIds(evidenceWith({ crowd: 'confirmed' })), []);
  assert.deepEqual(
    causeIds(evidenceWith({}, { areaReports: [{ kind: 'weather_warning' }] })),
    [],
    'a warning alone is context, not a cause',
  );
});

test('causes carry their own confidence from their support', () => {
  const crash = (evidence) =>
    evaluateCauses(events, evidence).causes.find(
      (cause) => cause.id === 'crash',
    );
  assert.equal(
    crash(evidenceWith({ overturned_vehicle: 'likely' })).confidence,
    'likely',
  );
  assert.equal(
    crash(evidenceWith({ debris_on_road: 'likely', traffic_stopped: 'likely' }))
      .confidence,
    'possible',
    'a moderate rule sits a step below its terms',
  );
  assert.equal(
    crash(
      evidenceWith(
        { overturned_vehicle: 'likely' },
        { reports: [{ kind: 'crash', official: true }] },
      ),
    ).confidence,
    'confirmed',
    'a camera and an official report corroborate each other',
  );
  assert.equal(
    crash(evidenceWith({ overturned_vehicle: 'inconclusive' })),
    undefined,
    'an inconclusive observation supports nothing',
  );
  const flood = evaluateCauses(
    events,
    evidenceWith(
      { water_on_road: 'likely' },
      { areaReports: [{ kind: 'weather_warning' }] },
    ),
  ).causes.find((cause) => cause.id === 'flood');
  assert.equal(flood.confidence, 'possible', 'a warning area is only context');
});

test('another explanation stays visible beside what was seen', () => {
  const { causes, explanations } = evaluateCauses(
    events,
    evidenceWith(
      { people_running: 'likely' },
      { context: new Set(['scheduled_event']) },
    ),
  );
  assert.deepEqual(causes, []);
  assert.deepEqual(explanations, [
    {
      cause: 'disturbance',
      observations: ['people_running'],
      label: 'scheduled event nearby',
    },
  ]);
});

test('the headline is the observed condition until a cause is likely', () => {
  const condition = (type, confidence) => ({
    type,
    label: events.observations.get(type).label,
    urgency: events.observations.get(type).urgency,
    persistence: events.observations.get(type).persistence,
    confidence,
  });
  const debris = [
    condition('traffic_stopped', 'likely'),
    condition('debris_on_road', 'likely'),
  ];
  const debrisCauses = evaluateCauses(
    events,
    evidenceWith({ debris_on_road: 'likely', traffic_stopped: 'likely' }),
  ).causes;
  assert.equal(
    headlineFor({ conditions: debris, reports: [], causes: debrisCauses }).text,
    'Debris on the road with traffic stopped',
  );
  const overturned = [condition('overturned_vehicle', 'likely')];
  assert.equal(
    headlineFor({
      conditions: overturned,
      reports: [],
      causes: evaluateCauses(
        events,
        evidenceWith({ overturned_vehicle: 'likely' }),
      ).causes,
    }).text,
    'Overturned vehicle — likely crash',
  );
  assert.equal(
    headlineFor({
      conditions: [
        condition('traffic_stopped', 'likely'),
        condition('vehicle_fire', 'possible'),
      ],
      reports: [],
      causes: [],
    }).text,
    'Vehicle fire with traffic stopped',
    'the more urgent condition leads',
  );
  assert.equal(
    headlineFor({
      conditions: [condition('vehicle_fire', 'ruled_out')],
      reports: [{ label: 'Crash reported' }],
      causes: [],
    }).text,
    'Crash reported',
  );
});
