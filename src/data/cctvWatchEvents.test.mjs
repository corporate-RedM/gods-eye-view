// CCTV Watch event definitions: the shipped config validates, causes never
// rest on a type marked "never alone", and gating follows what a camera shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applicableObservations,
  loadWatchEvents,
  loadWatchThresholds,
  needsMotion,
  profileAllows,
  readingVocabulary,
  screenCandidates,
  screeningPrompts,
} from '../../server/providers/cctv/watch/events.js';

const eventsJson = JSON.parse(
  readFileSync(
    new URL('../../config/cctv_watch_events.json', import.meta.url),
    'utf8',
  ),
);
const thresholdsJson = JSON.parse(
  readFileSync(
    new URL('../../config/cctv_watch_thresholds.json', import.meta.url),
    'utf8',
  ),
);

test('the shipped event config and thresholds validate', () => {
  const events = loadWatchEvents(eventsJson);
  assert.ok(events.observations.size >= 20);
  assert.ok(events.causes.has('crash'));
  const thresholds = loadWatchThresholds(thresholdsJson);
  assert.equal(thresholds.status, 'evaluation');
});

test('no type may confirm from a single source until it is measured', () => {
  const thresholds = loadWatchThresholds(thresholdsJson);
  for (const type of Object.keys(eventsJson.observations))
    assert.equal(thresholds.singleSourceConfirm(type), null, type);
});

test('verification follows its measured benefit per type', () => {
  const events = loadWatchEvents(eventsJson);
  const thresholds = loadWatchThresholds(thresholdsJson);
  assert.equal(thresholds.verification('people_on_roadway'), 'same');
  assert.equal(thresholds.verification('debris_on_road'), 'closer');
  assert.equal(
    thresholds.verification('emergency_response'),
    null,
    'a question that removed nothing costs GPU time for no benefit',
  );
  assert.equal(
    thresholds.verification('flames'),
    null,
    'the question lost true flames, so the reading stands',
  );
  for (const arm of ['same', 'closer'])
    for (const type of thresholdsJson.verification[arm])
      assert.ok(events.verify.has(type), `${type} has a question to ask`);
});

test('a context counted against claims is something seen, never a claim, and names real types', () => {
  const events = loadWatchEvents(eventsJson);
  const thresholds = loadWatchThresholds(thresholdsJson);
  assert.ok(thresholds.supportAgainst.length >= 1);
  for (const { context, types, withinMs } of thresholds.supportAgainst) {
    const spec = events.observations.get(context);
    assert.ok(spec, `${context} is an observation`);
    assert.equal(spec.condition, false, `${context} opens no condition`);
    for (const type of types)
      assert.ok(events.observations.has(type), `${context}: ${type}`);
    assert.ok(withinMs > 0);
  }
  assert.throws(
    () =>
      loadWatchThresholds({
        ...thresholdsJson,
        supportAgainst: { contexts: { work_zone: { types: ['smoke'] } } },
      }),
    /needs types and withinMinutes/,
  );
});

test('while detection is evaluated, no visual type reaches likely on its own', () => {
  const thresholds = loadWatchThresholds(thresholdsJson);
  for (const type of Object.keys(eventsJson.observations))
    assert.equal(thresholds.likely(type), null, type);
  assert.equal(thresholds.cameraConfidenceCap, 'possible');
  assert.throws(
    () =>
      loadWatchThresholds({ ...thresholdsJson, cameraConfidenceCap: 'sure' }),
    /cameraConfidenceCap must be possible or likely/,
  );
});

test('the overstated shortcuts BK ruled out stay out of the cause rules', () => {
  const events = loadWatchEvents(eventsJson);
  const solo = (cause) =>
    events.causes
      .get(cause)
      .support.filter((item) => item.observation || item.report)
      .map((item) => item.observation || `report:${item.report}`);
  assert.equal(solo('crash').includes('vehicle_fire'), false);
  assert.equal(solo('crash').includes('traffic_stopped'), false);
  assert.equal(solo('disturbance').includes('people_running'), false);
  assert.equal(solo('disturbance').includes('crowd'), false);
  assert.equal(solo('severe_weather').includes('low_visibility'), false);
  assert.ok(events.causes.get('crash').neverAlone.includes('vehicle_fire'));
});

test('a cause rule that lets a never-alone type stand alone is rejected', () => {
  const broken = structuredClone(eventsJson);
  broken.causes.crash.support.push({
    observation: 'vehicle_fire',
    weight: 'strong',
  });
  assert.throws(
    () => loadWatchEvents(broken),
    /vehicle_fire is listed in neverAlone/,
  );
});

test('malformed observations are rejected with the reason', () => {
  const broken = structuredClone(eventsJson);
  broken.observations.smoke.evidence = 'sound';
  assert.throws(() => loadWatchEvents(broken), /smoke: evidence must be/);
  const unknownEnd = structuredClone(eventsJson);
  unknownEnd.observations.road_clear.ends.push('nonsense');
  assert.throws(() => loadWatchEvents(unknownEnd), /ends unknown observation/);
});

test('persistence defaults by evidence; reports agree only with known observations', () => {
  const events = loadWatchEvents(eventsJson);
  const persistence = (type) => events.observations.get(type).persistence;
  assert.equal(persistence('vehicle_fire'), 'lasting');
  assert.equal(persistence('traffic_stopped'), 'transient');
  assert.equal(persistence('people_on_roadway'), 'transient', 'set explicitly');
  assert.ok(events.reports.get('crash').agrees.includes('damaged_vehicles'));
  assert.equal(events.reports.get('closure').role, 'context');
  const badPersistence = structuredClone(eventsJson);
  badPersistence.observations.smoke.persistence = 'forever';
  assert.throws(
    () => loadWatchEvents(badPersistence),
    /smoke: persistence must be/,
  );
  const badAgrees = structuredClone(eventsJson);
  badAgrees.reports.crash.agrees.push('nonsense');
  assert.throws(
    () => loadWatchEvents(badAgrees),
    /crash: agrees with unknown observation nonsense/,
  );
  const contextAgrees = structuredClone(eventsJson);
  contextAgrees.reports.weather_warning.agrees = ['whiteout'];
  assert.throws(
    () => loadWatchEvents(contextAgrees),
    /only evidence reports can agree/,
  );
});

test('screening phrases describe what is visible and come with ordinary-scene references', () => {
  const events = loadWatchEvents(eventsJson);
  assert.ok(
    events.screening.neutral.includes('an ordinary road with normal traffic'),
  );
  const interpretations = /crash|collision|accident|panic|after a rockslide/i;
  for (const spec of events.observations.values())
    for (const phrase of spec.phrases)
      assert.doesNotMatch(phrase, interpretations, `${spec.id}: ${phrase}`);
  const broken = structuredClone(eventsJson);
  broken.screening.neutral = ['an empty road', 7];
  assert.throws(() => loadWatchEvents(broken), /screening.neutral must be/);
});

test('verification questions map every answer to present, absent or unclear', () => {
  const events = loadWatchEvents(eventsJson);
  const overturned = events.verify.get('overturned_vehicle');
  assert.equal(overturned.answers.upright_on_its_wheels, 'absent');
  assert.equal(events.verify.get('smoke').sequence, true);
  assert.equal(
    events.observations.get('vehicle_stopped_on_shoulder').evidence,
    'motion',
    'a still can only suspect a stop',
  );
  const unknown = structuredClone(eventsJson);
  unknown.verify.nonsense = unknown.verify.smoke;
  assert.throws(() => loadWatchEvents(unknown), /verify nonsense: unknown/);
  const invented = structuredClone(eventsJson);
  invented.verify.smoke.answers.wildfire = 'crash';
  assert.throws(
    () => loadWatchEvents(invented),
    /answer wildfire must map to present, absent or unclear/,
  );
  const oneSided = structuredClone(eventsJson);
  oneSided.verify.crowd.answers = { a_gathered_crowd: 'present' };
  assert.throws(
    () => loadWatchEvents(oneSided),
    /must include present, absent and unclear/,
  );
});

test('each question matches the images it is asked with', () => {
  const events = loadWatchEvents(eventsJson);
  for (const [type, spec] of events.verify) {
    // Movement can only be judged across frames: those questions are never
    // asked of one frame, and every other question has a whole-frame wording.
    assert.equal(
      spec.needsFrames,
      needsMotion(events.observations.get(type)),
      `${type}: asked only with frames exactly when the type needs motion`,
    );
    if (spec.needsFrames) continue;
    assert.doesNotMatch(spec.sceneQuestion, /close-up/, `${type}: no close-up`);
    assert.doesNotMatch(
      spec.sceneQuestion,
      /frames|between|across the/i,
      `${type}: one frame, so no movement`,
    );
    assert.doesNotMatch(
      spec.question,
      /between frames|every frame|across the frames/i,
      `${type}: frame comparisons belong in the sequence note`,
    );
  }
  assert.match(
    events.verify.get('people_on_roadway').question,
    /lying on the ground/,
    'a person lying in the road is a person on the roadway',
  );
  assert.ok(events.verify.get('smoke').sequenceNote);
  const missing = structuredClone(eventsJson);
  delete missing.verify.crowd.sceneQuestion;
  assert.throws(
    () => loadWatchEvents(missing),
    /crowd: sceneQuestion is required/,
  );
  const stillMotion = structuredClone(eventsJson);
  stillMotion.verify.traffic_stopped.sequence = false;
  assert.throws(
    () => loadWatchEvents(stillMotion),
    /traffic_stopped: a question that needs frames must use the sequence/,
  );
});

test('altercations and running need video, stopped traffic needs motion', () => {
  const events = loadWatchEvents(eventsJson);
  assert.equal(
    events.observations.get('physical_altercation').evidence,
    'clip',
  );
  assert.equal(events.observations.get('people_running').evidence, 'clip');
  assert.equal(events.observations.get('traffic_stopped').evidence, 'motion');
  assert.equal(needsMotion(events.observations.get('traffic_stopped')), true);
  assert.equal(needsMotion(events.observations.get('smoke')), false);
});

test('unknown profile fields allow a type; low suitability gates it', () => {
  assert.equal(profileAllows('people', null), true);
  assert.equal(profileAllows('people', { peopleUsable: undefined }), true);
  assert.equal(profileAllows('people', { peopleUsable: 0.1 }), false);
  assert.equal(profileAllows('people', { peopleUsable: 0.5 }), true);
  assert.equal(profileAllows('road', { roadVisible: 0 }), false);
  assert.equal(profileAllows('any', { roadVisible: 0 }), true);
  assert.equal(
    profileAllows('pedestrian', {
      pedestrianAreaVisible: 0,
      peopleUsable: 0.4,
    }),
    true,
  );
});

test('highway cameras skip people types, but audits and patrol check everything', () => {
  const events = loadWatchEvents(eventsJson);
  const highway = { roadVisible: 1, pedestrianAreaVisible: 0, peopleUsable: 0 };
  const gated = applicableObservations(events, highway).map((spec) => spec.id);
  assert.equal(gated.includes('physical_altercation'), false);
  assert.equal(gated.includes('crowd'), false);
  assert.ok(gated.includes('damaged_vehicles'));
  const audit = applicableObservations(events, highway, { ungated: true }).map(
    (spec) => spec.id,
  );
  assert.ok(audit.includes('physical_altercation'));
});

test('screening phrases and reading vocabulary come from the config', () => {
  const events = loadWatchEvents(eventsJson);
  const prompts = screeningPrompts(events);
  assert.ok(prompts.find((p) => p.id === 'smoke').phrases.length > 0);
  assert.equal(
    prompts.some((p) => p.id === 'traffic_flowing'),
    false,
  );
  const vocabulary = readingVocabulary(applicableObservations(events, null));
  const stopped = vocabulary.find((v) => v.id === 'traffic_stopped');
  assert.equal(stopped.evidence, 'motion');
  assert.ok(stopped.describe.length > 0);
});

test('screen candidates are the gated scores above threshold, highest first', () => {
  const events = loadWatchEvents(eventsJson);
  const thresholds = loadWatchThresholds({
    version: 1,
    screen: { default: 0.05, smoke: 0.2 },
  });
  const highway = { roadVisible: 1, pedestrianAreaVisible: 0, peopleUsable: 0 };
  const specs = applicableObservations(events, highway);
  const candidates = screenCandidates(
    { smoke: 0.1, damaged_vehicles: 0.3, crowd: 0.9, debris_on_road: 0.06 },
    specs,
    thresholds,
  );
  assert.deepEqual(candidates, [
    { type: 'damaged_vehicles', score: 0.3 },
    { type: 'debris_on_road', score: 0.06 },
  ]);
});
