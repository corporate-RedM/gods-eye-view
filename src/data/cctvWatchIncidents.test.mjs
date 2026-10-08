// CCTV Watch incidents and links: merging needs clear identity, proximity
// only suggests a link after road and direction checks, area context groups
// without merging, and nothing resolves until every member has ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadWatchEvents,
  loadWatchThresholds,
} from '../../server/providers/cctv/watch/events.js';
import { readingObservations } from '../../server/providers/cctv/watch/observations.js';
import { createConditionTracker } from '../../server/providers/cctv/watch/conditions.js';
import { createIncidentBook } from '../../server/providers/cctv/watch/incidents.js';
import {
  areaContext,
  checkLink,
  pointInRing,
} from '../../server/providers/cctv/watch/links.js';
import {
  compareRoads,
  parseDirection,
  parseRoutes,
  roadOf,
} from '../../server/providers/cctv/watch/roads.js';

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
  likely: { default: 0.85 },
  screen: { default: 0.02 },
  singleSourceConfirm: {},
});

const MIN = 60_000;
const T = Date.UTC(2026, 9, 7, 18, 0, 0);

// Two cameras 300 m apart on I-94, one eastbound and one westbound, and a
// third on US-12 about 1 km away.
const CAMERAS = {
  'cam-e': {
    id: 'cam-e',
    name: 'I-94 EB @ Moorland Rd',
    lat: 43.0389,
    lon: -88.1066,
    url: 'https://cams.example/e.m3u8',
  },
  'cam-w': {
    id: 'cam-w',
    name: 'I-94 WB @ Moorland Rd',
    lat: 43.0391,
    lon: -88.103,
    url: 'https://cams.example/w.m3u8',
  },
  'cam-e2': {
    id: 'cam-e2',
    name: 'I-94 EB @ Calhoun Rd',
    lat: 43.0395,
    lon: -88.1101,
    url: 'https://cams.example/e2.m3u8',
  },
  'cam-us12': {
    id: 'cam-us12',
    name: 'US 12 @ Main St',
    lat: 43.0478,
    lon: -88.1066,
    url: 'https://cams.example/us12.m3u8',
  },
};

function harness(options = {}) {
  let clock = T;
  const conditions = createConditionTracker({ events });
  const book = createIncidentBook({
    events,
    conditionById: (id) => conditions.get(id),
    cameraById: (id) => CAMERAS[id] || null,
    now: () => clock,
    ...options,
  });
  const read = (cameraId, mode, at, items, visibility = 'good') => {
    clock = Math.max(clock, at);
    const changes = conditions.apply(
      readingObservations(
        {
          cameraId,
          mode,
          origin: 'sweep',
          captureTime: at,
          captureSource: 'last-modified',
          fetchedAt: at + 1000,
          analyzedAt: at + 4000,
          reading: {
            ok: true,
            visibility,
            visibilityIssues: [],
            observations: items.map(([type, confidence = 0.9]) => ({
              type,
              result: 'present',
              confidence,
              detail: '',
            })),
          },
          checkedTypes: [...events.observations.keys()],
        },
        { events, thresholds },
      ),
    );
    return book.applyConditionChanges(changes);
  };
  const report = (type, fields, at = clock) => {
    clock = Math.max(clock, at);
    return book.applyReportChange({
      type,
      at,
      firstSeenAt: at,
      report: {
        id: 'us-wi:1',
        kind: 'crash',
        official: true,
        title: 'Crash on I-94 eastbound at Moorland Rd',
        road: 'I-94',
        direction: 'East',
        lat: 43.0389,
        lon: -88.1068,
        updatedAt: at,
        updatedKey: String(at),
        startedAt: at,
        cameraUrls: [],
        ...fields,
      },
    });
  };
  const incidents = () => book.list({ at: clock }).incidents;
  return {
    conditions,
    book,
    read,
    report,
    incidents,
    tick: (at) => {
      clock = at;
      return book.applyConditionChanges(conditions.tick(at));
    },
  };
}

test('route and direction parsing keeps the order roads are named in', () => {
  assert.deepEqual(parseRoutes('Hwy 100 @ I-94 EB'), ['ST-100', 'I-94']);
  assert.deepEqual(parseRoutes('I-41/94 North at WIS 142'), [
    'I-41',
    'I-94',
    'ST-142',
  ]);
  assert.deepEqual(parseRoutes('US 12/14 West'), ['US-12']);
  assert.equal(parseDirection('I-35W NB @ 46th St'), 'N');
  assert.equal(parseDirection('Lake Pontchartrain Cswy Southbound'), 'S');
  assert.equal(parseDirection('Main St'), null);
});

test('roads compare as same, different or unknown, never guessing a match', () => {
  const east = roadOf(['I-94 EB @ Moorland Rd']);
  const west = roadOf(['I-94 WB @ Moorland Rd']);
  const report = roadOf(['I-94', 'East', 'Crash on I-94 eastbound']);
  assert.equal(compareRoads(east, report), 'same');
  assert.equal(compareRoads(west, report), 'different');
  assert.equal(compareRoads(roadOf(['US 12 @ Main St']), report), 'different');
  assert.equal(compareRoads(roadOf(['I-94 @ Moorland']), report), 'unknown');
  assert.equal(compareRoads(roadOf(['Moorland Rd cam']), report), 'unknown');
  assert.equal(
    compareRoads(roadOf(['Hwy 100 NB @ I-94']), roadOf(['I-94 EB'])),
    'unknown',
    'the direction belongs to the first road named',
  );
});

test('the same camera view with an open condition merges; a new view does not', () => {
  const { read, incidents } = harness();
  read('cam-e', 'still', T, [['vehicle_fire']]);
  read('cam-e', 'still', T + 2 * MIN, [['vehicle_fire'], ['smoke']]);
  read('cam-e2', 'still', T + 2 * MIN, [['vehicle_fire']]);
  const list = incidents();
  assert.equal(list.length, 2, 'proximity alone never merges');
  const first = list.find((item) => item.cameras.includes('cam-e'));
  assert.deepEqual(first.conditions.map((item) => item.type).sort(), [
    'smoke',
    'vehicle_fire',
  ]);
  assert.equal(first.headline.text, 'Vehicle fire with smoke');
});

test('more frames from one camera never corroborate; a second view does', () => {
  const { read, incidents, book } = harness();
  for (let i = 0; i < 5; i += 1)
    read('cam-e', 'still', T + i * MIN, [['overturned_vehicle']]);
  const [alone] = incidents();
  assert.equal(alone.conditions[0].confidence, 'likely');
  assert.deepEqual(alone.conditions[0].corroboration, []);
  // A second camera with its own view, merged by hand once BK agrees.
  read('cam-e2', 'still', T + 6 * MIN, [['overturned_vehicle']]);
  const other = incidents().find((item) => item.cameras.includes('cam-e2'));
  assert.ok(book.merge(alone.id, other.id));
  const merged = book.get(alone.id);
  assert.equal(merged.conditions[0].confidence, 'confirmed');
  assert.deepEqual(merged.conditions[0].corroboration, ['second camera']);
});

test('the same report merges; a nearby camera incident only links after checks', () => {
  const { read, report, incidents, book } = harness();
  read('cam-e', 'still', T, [['damaged_vehicles']]);
  read('cam-w', 'still', T, [['traffic_stopped', 0.9]]);
  read('cam-w', 'clip', T + MIN, [['traffic_stopped']]);
  const reportIncident = report('new', {});
  assert.equal(
    report('updated', { updatedKey: 'later' }, T + 3 * MIN),
    reportIncident,
  );
  const list = incidents();
  assert.equal(list.length, 3, 'a report near a camera stays separate');
  const crashReport = list.find((item) => item.id === reportIncident);
  assert.equal(crashReport.kind, 'report');
  assert.equal(crashReport.reports.length, 1, 'same report id, one incident');
  const eastbound = list.find((item) => item.cameras.includes('cam-e'));
  const westbound = list.find((item) => item.cameras.includes('cam-w'));
  const linkTo = (incident, id) =>
    incident.links.find((link) => link.incidentId === id);
  assert.equal(linkTo(crashReport, eastbound.id)?.kind, 'possibly_related');
  assert.ok(
    linkTo(crashReport, eastbound.id).reasons.includes(
      'same road and direction',
    ),
  );
  assert.equal(
    linkTo(crashReport, westbound.id),
    undefined,
    'the other carriageway is ruled out',
  );
  // BK can link it anyway, and unlink a suggestion.
  assert.ok(book.link(crashReport.id, westbound.id));
  assert.equal(linkTo(book.get(crashReport.id), westbound.id)?.kind, 'linked');
  assert.ok(book.unlink(crashReport.id, eastbound.id));
  assert.equal(linkTo(book.get(crashReport.id), eastbound.id), undefined);
});

test('a report that names the camera itself is clear identity', () => {
  const { read, report, incidents } = harness();
  read('cam-e', 'still', T, [['damaged_vehicles', 0.7]]);
  report('new', { cameraUrls: [CAMERAS['cam-e'].url] });
  const list = incidents();
  assert.equal(list.length, 1);
  const [incident] = list;
  const damaged = incident.conditions[0];
  assert.equal(
    damaged.confidence,
    'likely',
    'a report raises a possible reading',
  );
  assert.deepEqual(damaged.corroboration, ['official report']);
  assert.equal(incident.headline.text, 'Damaged vehicles — confirmed crash');
});

test('while detection is unvalidated, only BK lifts camera evidence past possible', () => {
  const { read, report, incidents, book } = harness({
    cameraConfidenceCap: 'possible',
  });
  read('cam-e', 'still', T, [['damaged_vehicles', 0.7]]);
  read('cam-e2', 'still', T, [['vehicle_fire', 0.99]]);
  report('new', { cameraUrls: [CAMERAS['cam-e'].url] });
  const damaged = incidents().find((item) => item.cameras.includes('cam-e'));
  assert.equal(damaged.conditions[0].confidence, 'possible');
  assert.deepEqual(
    damaged.conditions[0].corroboration,
    ['official report'],
    'the report is still shown as agreeing',
  );
  book.setVerdict(damaged.id, 'real', T + MIN);
  assert.equal(book.get(damaged.id).conditions[0].confidence, 'likely');
});

test('silence never resolves an incident; every member must end', () => {
  const { read, report, incidents, tick } = harness();
  read('cam-e', 'still', T, [['debris_on_road']]);
  report('new', { cameraUrls: [CAMERAS['cam-e'].url], kind: 'hazard' });
  tick(T + 60 * MIN);
  let [incident] = incidents();
  assert.equal(incident.state, 'ongoing', 'the report is still listed');
  report('cleared', {}, T + 61 * MIN);
  [incident] = incidents();
  assert.equal(incident.state, 'no_recent_evidence');
  assert.notEqual(incident.state, 'resolved');
  read('cam-e', 'still', T + 70 * MIN, [['road_clear']]);
  [incident] = incidents();
  assert.equal(incident.state, 'resolved');
  assert.equal(
    incident.conditions[0].confidence,
    'confirmed',
    'resolving never rules out what was seen (the hazard report agreed)',
  );
});

test('a false-alarm verdict is BK’s verdict, not a ruling on the evidence', () => {
  const { read, incidents, book } = harness();
  read('cam-e', 'still', T, [['vehicle_fire']]);
  const [incident] = incidents();
  book.setVerdict(incident.id, 'false_alarm', T + MIN);
  const after = book.get(incident.id);
  assert.deepEqual(after.verdict, { value: 'false_alarm', at: T + MIN });
  assert.equal(after.conditions[0].confidence, 'likely');
  assert.equal(after.state, 'ongoing');
  // The same reading at the same camera later says it resembles that verdict.
  read('cam-e', 'still', T + 30 * MIN, [['road_clear']]);
  read('cam-e', 'still', T + 40 * MIN, [['vehicle_fire']]);
  const again = incidents().find((item) => item.id !== incident.id);
  assert.equal(again.similarToFalseAlarm.incidentId, incident.id);
  assert.throws(() => book.setVerdict(incident.id, 'maybe'), /unknown verdict/);
});

test('a real verdict corroborates like an independent source', () => {
  const { read, incidents, book } = harness();
  read('cam-e', 'still', T, [['vehicle_fire', 0.6]]);
  const [incident] = incidents();
  assert.equal(incident.conditions[0].confidence, 'possible');
  book.setVerdict(incident.id, 'real', T + MIN);
  const after = book.get(incident.id);
  assert.equal(after.conditions[0].confidence, 'likely');
  assert.deepEqual(after.conditions[0].corroboration, ['your verdict']);
});

test('stale, crowd-sourced and context reports open no incidents', () => {
  const { report, incidents } = harness();
  assert.equal(
    report('new', { id: 'old', updatedAt: T - 3 * 24 * 60 * MIN }),
    null,
  );
  assert.equal(report('new', { id: 'waze', official: false }), null);
  assert.equal(report('new', { id: 'shut', kind: 'closure' }), null);
  assert.equal(incidents().length, 0);
});

test('a warning area groups incidents without merging or linking them', () => {
  const { read, incidents, book } = harness();
  read('cam-e', 'still', T, [['water_on_road']]);
  read('cam-us12', 'still', T, [['water_on_road']]);
  book.setAreas([
    {
      id: 'nws-1',
      kind: 'weather_warning',
      label: 'Flash Flood Warning',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-88.2, 43.0],
            [-88.0, 43.0],
            [-88.0, 43.1],
            [-88.2, 43.1],
            [-88.2, 43.0],
          ],
        ],
      },
    },
  ]);
  const list = incidents();
  assert.equal(list.length, 2);
  for (const incident of list) {
    assert.deepEqual(incident.areas, [
      { id: 'nws-1', kind: 'weather_warning', label: 'Flash Flood Warning' },
    ]);
    const flood = incident.causes.find((cause) => cause.id === 'flood');
    assert.equal(
      flood.confidence,
      'possible',
      'a warning supports, never settles',
    );
  }
});

test('candidates need compatible evidence, nearness and overlapping time', () => {
  const place = (lat, lon, name) => ({ lat, lon, road: roadOf([name]) });
  const crash = {
    groups: ['crashes'],
    places: [place(43.0389, -88.1066, 'I-94 EB')],
    firstSeenAt: T,
    resolvedAt: null,
    reportIds: [],
  };
  const crowd = { ...crash, groups: ['crowds'] };
  assert.equal(checkLink(crash, crowd, { events, at: T }), null);
  const far = {
    ...crash,
    places: [place(43.2, -88.1066, 'I-94 EB')],
  };
  assert.equal(checkLink(crash, far, { events, at: T }), null);
  const earlier = {
    ...crash,
    firstSeenAt: T - 5 * 60 * MIN,
    resolvedAt: T - 4 * 60 * MIN,
  };
  assert.equal(checkLink(crash, earlier, { events, at: T }), null);
  const unknownRoad = {
    ...crash,
    places: [place(43.039, -88.1068, 'Moorland Rd')],
  };
  const check = checkLink(crash, unknownRoad, { events, at: T });
  assert.equal(check.related, true, 'unknown is not held against a link');
  assert.deepEqual(check.against, []);
});

test('area tests handle polygons with holes and radius areas', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  assert.equal(pointInRing({ lat: 5, lon: 5 }, square), true);
  assert.equal(pointInRing({ lat: 11, lon: 5 }, square), false);
  const holed = {
    id: 'a',
    kind: 'weather_warning',
    label: 'x',
    geometry: {
      type: 'Polygon',
      coordinates: [
        square,
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    },
  };
  assert.equal(areaContext([{ lat: 5, lon: 5 }], [holed]).length, 0);
  assert.equal(areaContext([{ lat: 2, lon: 2 }], [holed]).length, 1);
  const quake = {
    id: 'q',
    kind: 'earthquake',
    label: 'M5.1',
    center: { lat: 34, lon: -118 },
    radiusKm: 100,
  };
  assert.equal(areaContext([{ lat: 34.5, lon: -118 }], [quake]).length, 1);
  assert.equal(areaContext([{ lat: 36, lon: -118 }], [quake]).length, 0);
});
