// CCTV Watch outside reports: planned work is dropped, titles outrank icons,
// Waze is never official, and an unchanged report polled again is not news.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kindFromListRow,
  kindFromMapEvent,
  normalizeListEvent,
  normalizeMapEvent,
  parseSiteTime,
} from '../../server/providers/cctv/watch/reports/castleRock511.js';
import { createReportWatcher } from '../../server/providers/cctv/watch/reports/index.js';

const SITE = {
  id: 'us-wi',
  provider: '511 Wisconsin (WisDOT)',
  state: 'Wisconsin',
};

test('planned work is not an incident; special events are context', () => {
  assert.equal(
    kindFromListRow({
      layerName: 'Construction',
      type: 'Roadwork',
      eventSubType: 'roadwork',
    }),
    null,
  );
  assert.equal(
    kindFromListRow({
      layerName: 'Closures',
      type: 'Closures',
      eventSubType: 'bridgeconstruction',
    }),
    null,
  );
  assert.equal(
    kindFromListRow({
      layerName: 'Closures',
      type: 'Closures',
      eventSubType: 'closure',
    }),
    'closure',
  );
  assert.equal(
    kindFromListRow({
      layerName: 'Incidents',
      type: 'Incidents',
      eventSubType: 'trafficAdvisory',
      description: 'Crash involving a commercial vehicle on US-95',
    }),
    'crash',
  );
  assert.equal(
    kindFromListRow({
      layerName: 'SpecialEvents',
      type: 'Special Events',
      eventSubType: 'marathon',
    }),
    'special_event',
  );
});

test('standing restrictions and advisories are not events', () => {
  assert.equal(
    kindFromListRow({
      layerName: 'Incidents',
      type: 'Incidents',
      eventSubType: 'truckRestriction',
      description:
        'Truck Restrictions on LA-818 Southbound near Leyland Dr. Comments: High railroad grade crossing.',
    }),
    null,
  );
  assert.equal(
    kindFromListRow({
      layerName: 'Incidents',
      type: 'Incidents',
      eventSubType: 'incident',
      description:
        'Traffic advisory on NV-267 near California Nevada Border. Start time: 8/25/2023 12:16 PM.',
    }),
    null,
  );
  assert.equal(
    kindFromListRow({
      layerName: 'Incidents',
      type: 'Incidents',
      eventSubType: 'trafficAdvisory',
      description:
        'Disabled vehicle on Exit to Old Sauk Rd from US 12/14 West.',
    }),
    'incident',
    'a vehicle in trouble is kept whatever the subtype',
  );
});

test('the title the agency wrote outranks the map icon', () => {
  assert.equal(
    kindFromMapEvent({
      title: 'I-394 westbound: Traffic incident reported.',
      icon: '/images/tg_crash_routine.svg',
    }),
    'incident',
  );
  assert.equal(
    kindFromMapEvent({ title: 'I-35W southbound: Crash.', icon: '' }),
    'crash',
  );
  assert.equal(
    kindFromMapEvent({ title: 'MN 61', icon: '/images/tg_crash_routine.svg' }),
    'crash',
  );
  assert.equal(kindFromMapEvent({ title: 'I-94: Road construction.' }), null);
});

test('site wall-clock times convert through the site time zone', () => {
  // 2:58 PM Central Daylight Time is 19:58 UTC.
  assert.equal(
    parseSiteTime('10/7/26, 2:58 PM', 'America/Chicago'),
    Date.parse('2026-10-07T19:58:00Z'),
  );
  // Standard time in January: 2:58 PM CST is 20:58 UTC.
  assert.equal(
    parseSiteTime('1/7/26, 2:58 PM', 'America/Chicago'),
    Date.parse('2026-01-07T20:58:00Z'),
  );
  assert.equal(
    parseSiteTime('10/7/26, 12:05 AM', 'America/Los_Angeles'),
    Date.parse('2026-10-07T07:05:00Z'),
  );
  assert.equal(parseSiteTime('not a time', 'America/Chicago'), null);
});

test('list events take their own map position before a linked camera', () => {
  const row = {
    id: 788593,
    layerName: 'Incidents',
    type: 'Incidents',
    eventSubType: 'crash',
    description: 'Crash on <b>I-94</b> WB',
    roadwayName: 'I-94',
    direction: 'Westbound',
    lastUpdated: '10/7/26, 2:58 PM',
    cameras: [
      {
        latLng: { geography: { wellKnownText: 'POINT (-87.96 43.03)' } },
        images: [
          {
            videoUrl:
              'https://cctv1.dot.wi.gov/rtplive/CCTV-40-0102/playlist.m3u8',
          },
        ],
      },
    ],
  };
  const withMap = normalizeListEvent(
    row,
    SITE,
    'America/Chicago',
    new Map([['788593', { lat: 42.62, lon: -87.95 }]]),
  );
  assert.equal(withMap.locationFrom, 'event-map');
  assert.equal(withMap.lat, 42.62);
  assert.deepEqual(withMap.cameraUrls, [
    'https://cctv1.dot.wi.gov/rtplive/CCTV-40-0102/playlist.m3u8',
  ]);
  assert.equal(withMap.title, 'Crash on I-94 WB');
  assert.equal(withMap.updatedKey, '10/7/26, 2:58 PM');
  const withoutMap = normalizeListEvent(row, SITE, 'America/Chicago');
  assert.equal(withoutMap.locationFrom, 'linked-camera');
});

test('Waze-sourced events are cues, never official corroboration', () => {
  const event = {
    uri: 'event/WAZE-1',
    title: 'I-35: Crash.',
    isWazeEvent: true,
    lastUpdated: { timestamp: 1791358003319 },
    features: [{ geometry: { type: 'Point', coordinates: [-93.2, 44.9] } }],
  };
  const report = normalizeMapEvent(event, {
    id: 'us-mn',
    provider: 'MN511',
    state: 'Minnesota',
  });
  assert.equal(report.official, false);
  assert.equal(report.sourceKind, 'waze');
  assert.equal(report.lat, 44.9);
});

function watcherHarness(batches) {
  const changes = [];
  let call = 0;
  const watcher = createReportWatcher({
    sources: [async () => batches[Math.min(call++, batches.length - 1)]],
    onChange: (change) => changes.push(`${change.type}:${change.report.id}`),
    now: () => 1000 + call,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { watcher, changes };
}

const report = (id, updatedKey) => ({ id, updatedKey, kind: 'crash' });

test('an unchanged report polled again is not news; an update is', async () => {
  const { watcher, changes } = watcherHarness([
    { reports: [report('us-wi:1', 'a')], errors: {} },
    { reports: [report('us-wi:1', 'a')], errors: {} },
    { reports: [report('us-wi:1', 'b')], errors: {} },
  ]);
  await watcher.poll();
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(changes, ['new:us-wi:1', 'updated:us-wi:1']);
  assert.equal(watcher.stats().unchanged, 1);
});

test('a report is cleared only after it stays missing, and never because its site failed', async () => {
  const { watcher, changes } = watcherHarness([
    { reports: [report('us-wi:1', 'a'), report('us-mn:2', 'a')], errors: {} },
    { reports: [report('us-mn:2', 'a')], errors: { 'us-wi': 'HTTP 503' } },
    { reports: [report('us-mn:2', 'a')], errors: {} },
    { reports: [report('us-mn:2', 'a')], errors: {} },
  ]);
  for (let i = 0; i < 4; i += 1) await watcher.poll();
  assert.deepEqual(changes, ['new:us-wi:1', 'new:us-mn:2', 'cleared:us-wi:1']);
});
