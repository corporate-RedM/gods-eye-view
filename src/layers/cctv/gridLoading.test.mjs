import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeometryQueue } from './geometryQueue.js';

test('initial placement drains every camera nearest first, survives view settling, and publishes real marker progress', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const records = Array.from({ length: 600 }, (_, i) => ({
    camera: { id: String(i), lat: (600 - i) / 100, lon: 0 },
  }));
  const state = {
    _records: records,
    _enabled: true,
    _billboards: { length: 0 },
    _viewer: {
      camera: { positionCartographic: { latitude: 0, longitude: 0 } },
      scene: { requestRender() {} },
    },
    _catalogueLoading: {
      active: true,
      phase: 'placing',
      loaded: 0,
      total: 600,
    },
  };
  const placed = [],
    notifications = [];
  const queue = createGeometryQueue({
    state,
    parts: {
      selection: { getActiveRecord: () => records[0] },
      model: { haversineKm: (_a, _b, lat) => lat },
      ground: { warmNearbyGround() {} },
      geometry: {
        updateRecordGeometry(record) {
          record.prepared = true;
        },
      },
      rendering: {
        placeCameraMarker(record) {
          assert.equal(record.prepared, true);
          placed.push(record.camera.id);
          state._billboards.length++;
        },
        refreshCoverageStyles() {},
      },
      cards: { refreshAmbientCards() {} },
      presentation: {
        notifyListeners() {
          notifications.push({ ...state._catalogueLoading });
        },
      },
    },
  });
  queue.startGeometryLoadQueue();
  assert.equal(state._geoLoadTotal, 600);
  t.mock.timers.tick(1);
  assert.ok(placed.length > 0 && placed.length < 600);
  assert.equal(placed[0], '599');
  const pending = state._geoQueue;
  queue.startGeometryLoadQueue();
  assert.equal(state._geoQueue, pending);
  for (let i = 0; i < 600 && state._geoLoading; i++) t.mock.timers.tick(100);
  assert.equal(new Set(placed).size, 600);
  assert.deepEqual(placed, records.map((r) => r.camera.id).reverse());
  assert.equal(state._catalogueLoading.loaded, 600);
  assert.equal(state._catalogueLoading.phase, 'ready');
  assert.ok(
    notifications.some((s) => s.active && s.loaded > 0 && s.loaded < 600),
  );
  assert.equal(notifications.at(-1).active, false);
});
