import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDriveTexasVideo,
  mapDriveTexasVideo,
  resolveDriveTexasStream,
} from '../../server/providers/cctv/driveTexasVideo.js';

const row = (i) => ({
  name: `TX_TEST_${i}`,
  description: `Road ${i}`,
  XY: 'POINT (-97 30)',
  active: 1,
  httpsurl: `https://s69.us-east-1.skyvdn.com/live/${i}/index.m3u8?token=expiring`,
});
const response = (rows, total = rows.length) =>
  new Response(
    JSON.stringify({
      success: true,
      data: {
        data: Object.fromEntries(
          Object.keys(rows[0] || { name: '' }).map((key) => [
            key,
            rows.map((r) => r[key]),
          ]),
        ),
        totals: { Records: total },
      },
    }),
  );
test('DriveTexas collects all pages, keeps stable URLs, and reports partial inventories', async () => {
  const starts = [];
  const cameras = await loadDriveTexasVideo({
    fetchImpl: async (url) => {
      const {
        query: { start, take },
      } = JSON.parse(new URL(url).searchParams.get('request'));
      starts.push(start);
      if (start === 1000) return new Response('', { status: 503 });
      return response(
        Array.from({ length: Math.min(take, 2002 - start) }, (_, i) =>
          row(start + i),
        ),
        2002,
      );
    },
  });
  assert.equal(cameras.length, 1002);
  assert.deepEqual(
    starts.sort((a, b) => a - b),
    [0, 1000, 2000],
  );
  assert.equal(cameras.inventory.partial, true);
  assert.equal(cameras.inventory.failedBatches, 1);
  assert.ok(cameras.every((c) => !c.url.includes('token=')));
  assert.equal(mapDriveTexasVideo({ ...row(0), active: 0 }), null);
  assert.equal(
    mapDriveTexasVideo({
      ...row(0),
      httpsurl: 'https://other.example/still.jpg',
    }),
    null,
  );
});
test('DriveTexas refreshes the selected camera only and refuses mismatched stream identities', async () => {
  const raw = row(2),
    source = mapDriveTexasVideo(raw);
  const value = await resolveDriveTexasStream(source, {
    fetchImpl: async (url) => {
      const { query } = JSON.parse(new URL(url).searchParams.get('request'));
      assert.equal(query.where[0][0].value, raw.name);
      assert.equal(query.take, 1);
      return response([raw]);
    },
  });
  assert.equal(value.url, raw.httpsurl);
  assert.equal(value.headers.Origin, 'https://drivetexas.org');
  await assert.rejects(
    resolveDriveTexasStream(source, {
      fetchImpl: async () => response([{ ...raw, httpsurl: row(3).httpsurl }]),
    }),
    /unexpected stream/,
  );
});
