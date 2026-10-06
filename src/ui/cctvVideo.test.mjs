import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvVideoSurface } from './cctvVideo.js';
test('second surface uses shared decoder, caps draws, clears switch and cancels teardown', () => {
  let callback;
  let draws = 0;
  let clears = 0;
  let cancelled = 0;
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage: () => draws++, clearRect: () => clears++ }),
  };
  let v = {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 1,
  };
  const surface = createCctvVideoSurface(canvas, () => v, {
    requestFrame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelFrame: () => cancelled++,
  });
  callback(0);
  callback(20);
  callback(80);
  assert.equal(draws, 1);
  assert.equal(canvas.width, 640);
  v = { ...v };
  callback(160);
  assert.equal(draws, 2);
  assert.equal(clears, 2);
  surface.stop();
  callback(200);
  assert.equal(cancelled, 1);
  assert.equal(draws, 2);
});

test('a raised width cap (maximized feed) paints at full source resolution', () => {
  let callback;
  let cap = 640;
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage() {}, clearRect() {} }),
  };
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 1,
  };
  createCctvVideoSurface(canvas, () => video, {
    requestFrame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelFrame() {},
    maxWidth: () => cap,
  });
  callback(0);
  assert.deepEqual([canvas.width, canvas.height], [640, 360]);
  cap = 1920;
  video.currentTime = 2;
  callback(100);
  assert.deepEqual(
    [canvas.width, canvas.height],
    [1280, 720],
    'never wider than the source',
  );
});
