// CCTV Watch freshness: a re-served picture is never fresh coverage, cadence
// comes from byte changes, and frozen feeds are flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_SOURCES,
  captureTimeFromLastModified,
  contentHash,
  createFreshnessTracker,
  parseProgramDateTimes,
} from '../../server/providers/cctv/watch/freshness.js';

const MIN = 60 * 1000;

test('content hashes identify identical bytes, not similar pictures', () => {
  const a = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const b = Buffer.from([0xff, 0xd8, 1, 2, 4, 0xff, 0xd9]);
  assert.equal(contentHash(a), contentHash(Buffer.from(a)));
  assert.notEqual(contentHash(a), contentHash(b));
});

test('Last-Modified is a capture time only when it is believable', () => {
  const fetchedAt = Date.parse('2026-10-07T18:00:00Z');
  assert.deepEqual(
    captureTimeFromLastModified('Wed, 07 Oct 2026 17:58:30 GMT', fetchedAt),
    {
      time: Date.parse('2026-10-07T17:58:30Z'),
      source: CAPTURE_SOURCES.LAST_MODIFIED,
    },
  );
  assert.equal(
    captureTimeFromLastModified('Wed, 07 Oct 2026 18:30:00 GMT', fetchedAt),
    null,
    'a date in the future is not a capture time',
  );
  assert.equal(
    captureTimeFromLastModified('Mon, 05 Oct 2026 18:00:00 GMT', fetchedAt),
    null,
    'a two-day-old date is not trusted as the capture time',
  );
  assert.equal(captureTimeFromLastModified('not a date', fetchedAt), null);
  assert.equal(captureTimeFromLastModified(null, fetchedAt), null);
});

test('program date-times date each segment, carried forward by duration', () => {
  const dates = parseProgramDateTimes(
    [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:40',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-07T18:00:00.000Z',
      '#EXTINF:4.0,',
      'seg40.ts',
      '#EXTINF:4.0,',
      'seg41.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:4.0,',
      'seg42.ts',
      '#EXT-X-PROGRAM-DATE-TIME:2026-10-07T18:01:00.000Z',
      '#EXTINF:4.0,',
      'seg43.ts',
    ].join('\n'),
  );
  assert.equal(dates.get(40), Date.parse('2026-10-07T18:00:00Z'));
  assert.equal(dates.get(41), Date.parse('2026-10-07T18:00:04Z'));
  assert.equal(
    dates.has(42),
    false,
    'a discontinuity without a new date leaves the segment undated',
  );
  assert.equal(dates.get(43), Date.parse('2026-10-07T18:01:00Z'));
  assert.equal(parseProgramDateTimes('#EXTM3U\n#EXTINF:4,\nseg.ts').size, 0);
});

test('a byte-identical re-fetch is not fresh and does not count as coverage', () => {
  const tracker = createFreshnessTracker();
  const t0 = Date.parse('2026-10-07T18:00:00Z');
  const first = tracker.observe('cam-1', { hash: 'aaa', fetchedAt: t0 });
  assert.equal(first.fresh, true);
  const repeat = tracker.observe('cam-1', {
    hash: 'aaa',
    fetchedAt: t0 + 4 * MIN,
  });
  assert.equal(repeat.fresh, false);
  assert.equal(repeat.reason, 'same-bytes');
  // Coverage is measured from the last new capture, not the last fetch.
  assert.deepEqual(tracker.coverage(t0 + 6 * MIN), {
    tracked: 1,
    fresh5: 0,
    fresh10: 1,
    stale: 0,
    neverFresh: 0,
  });
});

test('cadence is learned from byte changes, however quiet the scene looks', () => {
  const tracker = createFreshnessTracker();
  const t0 = Date.parse('2026-10-07T18:00:00Z');
  // The agency publishes every 3 minutes. Each capture is a new file, even
  // when the scene looks unchanged; repeats in between are the same file.
  for (let i = 0; i < 5; i += 1) {
    tracker.observe('cam-1', {
      hash: `capture-${i}`,
      fetchedAt: t0 + i * 3 * MIN,
    });
    tracker.observe('cam-1', {
      hash: `capture-${i}`,
      fetchedAt: t0 + i * 3 * MIN + 90 * 1000,
    });
  }
  assert.equal(tracker.state('cam-1').cadenceMs, 3 * MIN);
  const fetchedAt = t0 + 12 * MIN;
  assert.equal(tracker.nextDue('cam-1', fetchedAt, true), fetchedAt + 3 * MIN);
  assert.equal(
    tracker.nextDue('cam-1', fetchedAt, false),
    fetchedAt + 90 * 1000,
    'after a repeat, look again at half a cadence',
  );
});

test('polling stays between one and five minutes', () => {
  const tracker = createFreshnessTracker();
  const t0 = 1_000_000;
  tracker.observe('fast', { hash: 'a', fetchedAt: t0 });
  assert.equal(
    tracker.nextDue('fast', t0, true),
    t0 + 2 * MIN,
    'unknown cadence',
  );
  tracker.observe('fast', { hash: 'b', fetchedAt: t0 + 10 * 1000 });
  assert.equal(tracker.nextDue('fast', t0, true), t0 + MIN);
  tracker.observe('slow', { hash: 'a', fetchedAt: t0 });
  tracker.observe('slow', { hash: 'b', fetchedAt: t0 + 20 * MIN });
  assert.equal(tracker.nextDue('slow', t0, true), t0 + 5 * MIN);
});

test('a feed with no new capture for three cadences is stale', () => {
  const tracker = createFreshnessTracker();
  const t0 = 0;
  for (let i = 0; i < 4; i += 1)
    tracker.observe('cam-1', { hash: `c${i}`, fetchedAt: t0 + i * 6 * MIN });
  const last = t0 + 18 * MIN;
  assert.equal(tracker.isStale('cam-1', last + 17 * MIN), false);
  assert.equal(
    tracker.isStale('cam-1', last + 19 * MIN),
    true,
    'three 6-minute cadences have passed with the same picture',
  );
  const repeat = tracker.observe('cam-1', {
    hash: 'c3',
    fetchedAt: last + 19 * MIN,
  });
  assert.equal(repeat.fresh, false);
  assert.equal(repeat.stale, true);
  assert.equal(tracker.coverage(last + 19 * MIN).stale, 1);
});

test('a camera is never stale sooner than fifteen minutes', () => {
  const tracker = createFreshnessTracker();
  tracker.observe('cam-1', { hash: 'a', fetchedAt: 0 });
  tracker.observe('cam-1', { hash: 'b', fetchedAt: MIN });
  assert.equal(tracker.isStale('cam-1', 14 * MIN), false);
  assert.equal(tracker.isStale('cam-1', 17 * MIN), true);
});

test('upstream capture times are kept with their source', () => {
  const tracker = createFreshnessTracker();
  const capture = {
    time: 5 * MIN,
    source: CAPTURE_SOURCES.LAST_MODIFIED,
  };
  const result = tracker.observe('cam-1', {
    hash: 'a',
    fetchedAt: 6 * MIN,
    capture,
  });
  assert.equal(result.captureTime, 5 * MIN);
  assert.equal(result.captureSource, CAPTURE_SOURCES.LAST_MODIFIED);
  const unknown = tracker.observe('cam-2', { hash: 'a', fetchedAt: 6 * MIN });
  assert.equal(unknown.captureTime, null);
  assert.equal(unknown.captureSource, CAPTURE_SOURCES.UNKNOWN);
});

test('cameras that leave the catalog are forgotten', () => {
  const tracker = createFreshnessTracker();
  tracker.observe('keep', { hash: 'a', fetchedAt: 0 });
  tracker.observe('drop', { hash: 'a', fetchedAt: 0 });
  tracker.retain(['keep']);
  assert.ok(tracker.state('keep'));
  assert.equal(tracker.state('drop'), null);
});
