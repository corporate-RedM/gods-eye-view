// CCTV Watch evidence model and routes: readings become incidents with their
// evidence saved, an open condition asks for follow-up reads, and anything
// that changes incidents answers only this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  loadWatchEvents,
  loadWatchThresholds,
} from '../../server/providers/cctv/watch/events.js';
import { createEvidenceModel } from '../../server/providers/cctv/watch/evidenceModel.js';
import { handleWatchRoute } from '../../server/providers/cctv/watch/routes.js';

const events = loadWatchEvents(
  JSON.parse(
    readFileSync(
      new URL('../../config/cctv_watch_events.json', import.meta.url),
      'utf8',
    ),
  ),
);
const thresholdsJson = JSON.parse(
  readFileSync(
    new URL('../../config/cctv_watch_thresholds.json', import.meta.url),
    'utf8',
  ),
);
const thresholds = loadWatchThresholds(thresholdsJson);
const T = Date.UTC(2026, 9, 7, 18, 0, 0);
const MIN = 60_000;

function fakeStore() {
  const saved = [];
  return {
    saved,
    saveReading: (incidentId, record) =>
      saved.push({ incidentId, readingId: record.readingId }),
    evidenceFor: (incidentId) =>
      saved.filter((entry) => entry.incidentId === incidentId),
    merged: () => {},
    saveIncidents: async () => {},
    prune: async () => {},
    stats: () => ({ readings: saved.length }),
  };
}

const record = (cameraId, at, observations, readingId) => ({
  readingId,
  cameraId,
  mode: 'still',
  origin: 'sweep',
  captureTime: at,
  captureSource: 'last-modified',
  fetchedAt: at + 1000,
  analyzedAt: at + 3000,
  reading: { ok: true, visibility: 'good', visibilityIssues: [], observations },
  checkedTypes: [...events.observations.keys()],
  jpegs: [Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
});
const present = (type, confidence = 0.97) => ({
  type,
  result: 'present',
  confidence,
  detail: '',
});

test('a reading opens an incident, files its frames as evidence and asks for follow-up', () => {
  let clock = T;
  const store = fakeStore();
  const model = createEvidenceModel({
    events,
    thresholds,
    store,
    cameraById: (id) => ({
      id,
      name: 'I-94 EB @ Moorland Rd',
      lat: 43,
      lon: -88,
    }),
    now: () => clock,
  });
  model.onReading(record('cam-1', T, [present('vehicle_fire')], 'r1'));
  const { incidents } = model.list({ since: 0, at: T });
  assert.equal(incidents.length, 1);
  assert.equal(
    incidents[0].conditions[0].confidence,
    'possible',
    'while detection is evaluated, a camera alone stays possible',
  );
  assert.deepEqual(store.saved, [
    { incidentId: incidents[0].id, readingId: 'r1' },
  ]);
  assert.equal(model.needsFollowUp('cam-1'), true);
  assert.equal(model.needsFollowUp('cam-2'), false);
  // A reading with nothing about the open condition files nothing new.
  model.onReading(record('cam-2', T, [], 'r2'));
  assert.equal(store.saved.length, 1);
  clock = T + 40 * MIN;
  model.tick(() => 'camera stale or offline');
  assert.equal(
    model.get(incidents[0].id).state,
    'no_recent_evidence',
    'silence makes it quiet, never resolved',
  );
});

test('focus that ends without a decisive reading is recorded as such', () => {
  const model = createEvidenceModel({
    events,
    thresholds,
    store: fakeStore(),
    now: () => T + 5 * MIN,
  });
  model.onReading(record('cam-1', T, [present('overturned_vehicle')], 'r1'));
  model.onFocusEnd({ cameraId: 'cam-1', startedAt: T + MIN });
  const [incident] = model.list({ since: 0 }).incidents;
  assert.equal(incident.state, 'monitoring_ended');
});

test('a reported event not visible in the inspected footage is recorded as such, never as a miss', () => {
  let clock = T;
  const model = createEvidenceModel({
    events,
    thresholds,
    store: fakeStore(),
    now: () => clock,
  });
  const report = {
    id: 'us-mn:event/MSPCAD-1',
    kind: 'crash',
    official: true,
    title: 'I-494 eastbound: Crash.',
    lat: 44.86,
    lon: -93.3,
    updatedAt: T,
    updatedKey: 'k1',
    startedAt: T,
    cameraUrls: [],
  };
  model.onReport({ type: 'new', report, at: T, firstSeenAt: T });
  const [before] = model.list({ since: 0, at: T }).incidents;
  // The report's cameras are read during the look, and show nothing related.
  clock = T + 2 * MIN;
  model.onReading(record('cam-9', T + MIN, [], 'r1'));
  clock = T + 20 * MIN;
  model.onFocusEnd({
    cameraId: 'cam-9',
    trigger: 'report',
    ref: `${report.id}@k1`,
    startedAt: T,
  });
  // A second camera never returned footage at all.
  model.onFocusEnd({
    cameraId: 'cam-10',
    trigger: 'report',
    ref: `${report.id}@k1`,
    startedAt: T,
  });
  const after = model.get(before.id);
  assert.equal(
    after.visibility,
    'reported event not visible in inspected footage',
  );
  assert.deepEqual(
    after.inspections.map((look) => [look.cameraId, look.readings]),
    [
      ['cam-9', 1],
      ['cam-10', 0],
    ],
  );
  assert.equal(after.state, before.state, 'the report is still listed');
  assert.equal(after.confidence, before.confidence, 'nothing is ruled out');
});

test('a look that returned no footage says so', () => {
  const model = createEvidenceModel({
    events,
    thresholds,
    store: fakeStore(),
    now: () => T + 20 * MIN,
  });
  const report = {
    id: 'us-wi:9',
    kind: 'incident',
    official: true,
    title: 'I-41 North: right shoulder blocked.',
    lat: 44.3,
    lon: -88.4,
    updatedAt: T,
    updatedKey: 'k',
    startedAt: T,
    cameraUrls: [],
  };
  model.onReport({ type: 'new', report, at: T, firstSeenAt: T });
  model.onFocusEnd({
    cameraId: 'cam-1',
    trigger: 'report',
    ref: `${report.id}@k`,
    startedAt: T,
  });
  const [incident] = model.list({ since: 0 }).incidents;
  assert.equal(incident.visibility, 'cameras returned no footage');
});

test('a claim held for its question counts only once answered; withdrawn ones open nothing', () => {
  const model = createEvidenceModel({
    events,
    thresholds,
    store: fakeStore(),
    now: () => T,
  });
  const held = {
    ...record('cam-1', T, [present('people_on_roadway')], 'r1'),
    pendingVerification: ['people_on_roadway'],
  };
  model.onReading(held);
  assert.equal(model.list({ since: 0 }).incidents.length, 0, 'held');
  model.onVerification({
    record: held,
    type: 'people_on_roadway',
    arm: 'same',
    verdict: { result: 'absent', answer: 'on_a_sidewalk_or_crosswalk' },
  });
  assert.equal(model.list({ since: 0 }).incidents.length, 0, 'withdrawn');
  model.onVerification({
    record: held,
    type: 'people_on_roadway',
    arm: 'same',
    verdict: {
      result: 'present',
      answer: 'in_a_traffic_lane',
      confidence: 0.9,
      reason: 'person walking in the right lane',
      facts: { regionChange: 0.1, sceneChange: 0.05, brightFraction: 0 },
    },
  });
  const [incident] = model.list({ since: 0 }).incidents;
  const evidence = incident.conditions[0].members[0].evidence[0];
  assert.equal(evidence.support.verification.answer, 'in_a_traffic_lane');
  assert.deepEqual(evidence.support.measured.regionChange, 0.1);
  assert.equal(model.stats().withdrawn, 1);
});

test('a claim its check could not settle stays available as possible, marked unverified', () => {
  const open = loadWatchThresholds({
    version: 1,
    likely: { default: 0.85 },
    screen: { default: 0.02 },
  });
  const model = createEvidenceModel({
    events,
    thresholds: open,
    store: fakeStore(),
    now: () => T,
  });
  const held = (cameraId, readingId) => ({
    ...record(cameraId, T, [present('people_on_roadway', 0.97)], readingId),
    pendingVerification: ['people_on_roadway'],
  });
  const unclear = held('cam-1', 'r1');
  model.onReading(unclear);
  model.onVerification({
    record: unclear,
    type: 'people_on_roadway',
    arm: 'same',
    verdict: { result: 'unclear', answer: 'cannot_tell', confidence: 0 },
  });
  const dropped = held('cam-2', 'r2');
  model.onReading(dropped);
  model.onVerification({
    record: dropped,
    type: 'people_on_roadway',
    arm: 'same',
    verdict: null,
    dropped: 'replaced by a newer claim',
  });
  const byCamera = new Map(
    model
      .list({ since: 0 })
      .incidents.map((incident) => [incident.cameras[0], incident]),
  );
  for (const [cameraId, reason] of [
    ['cam-1', 'the check could not settle it'],
    ['cam-2', 'not checked: replaced by a newer claim'],
  ]) {
    const condition = byCamera.get(cameraId)?.conditions[0];
    assert.ok(condition, `${cameraId} is still available`);
    assert.equal(
      condition.confidence,
      'possible',
      'held at possible though the reading alone would reach likely',
    );
    assert.equal(condition.members[0].evidence[0].support.unverified, reason);
  }
  assert.equal(model.stats().unverified, 2);
  assert.equal(model.stats().withdrawn, 0);
});

test('a work zone in view is evidence against lookalike claims, never a rejection', () => {
  // Likely allowed here, so the hold-back is visible.
  const open = loadWatchThresholds({
    version: 1,
    likely: { default: 0.85 },
    screen: { default: 0.02 },
    supportAgainst: thresholdsJson.supportAgainst,
  });
  const model = createEvidenceModel({
    events,
    thresholds: open,
    store: fakeStore(),
    now: () => T,
  });
  model.onReading(
    record(
      'cam-1',
      T,
      [present('work_zone'), present('emergency_response', 0.97)],
      'r1',
    ),
  );
  model.onReading(
    record('cam-2', T, [present('emergency_response', 0.97)], 'r2'),
  );
  const byCamera = new Map(
    model
      .list({ since: 0 })
      .incidents.map((incident) => [incident.cameras[0], incident]),
  );
  const zone = byCamera.get('cam-1').conditions[0];
  assert.equal(zone.confidence, 'possible', 'held back, not rejected');
  assert.deepEqual(zone.members[0].evidence[0].support.against, [
    'work zone in view',
  ]);
  assert.equal(byCamera.get('cam-2').conditions[0].confidence, 'likely');
});

function fakeWatch() {
  const calls = [];
  return {
    calls,
    touch: () => calls.push('touch'),
    status: () => ({ state: 'running' }),
    recentReadings: () => [],
    currentReports: () => [],
    incidents: ({ since }) => ({
      revision: 3,
      since,
      incidents: [],
      removed: [],
    }),
    evidenceFile: () => null,
    setVerdict: (id, value) => {
      calls.push(['verdict', id, value]);
      return id === 'inc-a-1' ? id : null;
    },
    linkIncidents: (a, b) => {
      calls.push(['link', a, b]);
      return true;
    },
    unlinkIncidents: () => true,
    mergeIncidents: () => true,
    stop: () => {},
  };
}

function request(
  method,
  path,
  { body = null, remote = '127.0.0.1', origin } = {},
) {
  const text = body === null ? '' : JSON.stringify(body);
  const req = Readable.from(text ? [Buffer.from(text)] : []);
  req.method = method;
  req.socket = { remoteAddress: remote };
  req.headers = {
    host: '127.0.0.1:4173',
    ...(origin ? { origin } : {}),
    ...(text ? { 'content-type': 'application/json' } : {}),
  };
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
  return { req, res, url: new URL(`http://127.0.0.1:4173/api/cctv${path}`) };
}

const route = async (watch, method, path, options) => {
  const { req, res, url } = request(method, path, options);
  url.pathname = url.pathname.replace('/api/cctv', '');
  await handleWatchRoute(watch, req, res, url);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
};

test('incidents are readable; evidence names the store does not write are not found', async () => {
  const watch = fakeWatch();
  const listed = await route(watch, 'GET', '/watch/incidents?since=7');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.since, 7);
  const missing = await route(
    watch,
    'GET',
    '/watch/evidence/2026-10-07/inc-a-1/r1/..%2F..%2Fpasswd',
  );
  assert.equal(missing.status, 404);
});

test('verdicts and links answer only this machine, with an exact local origin', async () => {
  const watch = fakeWatch();
  const remote = await route(watch, 'POST', '/watch/incidents/verdict', {
    body: { incidentId: 'inc-a-1', value: 'real' },
    remote: '10.0.0.5',
    origin: 'http://127.0.0.1:4173',
  });
  assert.equal(remote.status, 403);
  const noOrigin = await route(watch, 'POST', '/watch/incidents/verdict', {
    body: { incidentId: 'inc-a-1', value: 'real' },
  });
  assert.equal(noOrigin.status, 403);
  const local = { origin: 'http://127.0.0.1:4173' };
  const verdict = await route(watch, 'POST', '/watch/incidents/verdict', {
    body: { incidentId: 'inc-a-1', value: 'false_alarm' },
    ...local,
  });
  assert.equal(verdict.status, 200);
  const invented = await route(watch, 'POST', '/watch/incidents/verdict', {
    body: { incidentId: 'inc-a-1', value: 'ruled_out' },
    ...local,
  });
  assert.equal(invented.status, 400, 'a verdict is real or false alarm only');
  const linked = await route(watch, 'POST', '/watch/incidents/link', {
    body: { a: 'inc-a-1', b: 'inc-b-2' },
    ...local,
  });
  assert.equal(linked.status, 200);
  assert.deepEqual(watch.calls.slice(-1), [['link', 'inc-a-1', 'inc-b-2']]);
});
