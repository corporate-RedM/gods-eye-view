import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CctvControls } from './cctvControls.js';

function element() {
  const classes = new Set();
  return {
    dataset: {},
    src: '',
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    classList: {
      add(...values) {
        values.forEach((value) => classes.add(value));
      },
      remove(...values) {
        values.forEach((value) => classes.delete(value));
      },
      contains(value) {
        return classes.has(value);
      },
      toggle(value, enabled) {
        if (enabled) classes.add(value);
        else classes.delete(value);
      },
    },
  };
}
function fixture(t) {
  const prior = globalThis.Image;
  const requests = [];
  globalThis.Image = class {
    constructor() {
      requests.push(this);
    }
  };
  t.after(() => {
    globalThis.Image = prior;
  });
  const controls = new CctvControls({
    elements: { _cctvFrame: element(), _cctvFrameWrap: element() },
    cctv: {},
    actions: { isEnabled: () => true },
  });
  t.after(() => controls.destroy());
  return { controls, requests };
}

test('a late image completion cannot replace a newer camera preview', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const stale = requests[0].onload;
  controls._queueCctvFrame('second.jpg', 'b', true);
  assert.equal(requests[0].onload, null);
  requests[1].onload();
  stale();
  assert.equal(controls._cctvFrame.src, 'second.jpg');
  assert.equal(controls._cctvFrame.dataset.cameraId, 'b');
});

test('failed refresh preserves settled pixels, but changing cameras clears them', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  requests[1].onerror();
  assert.equal(controls._cctvFrame.src, 'first.jpg');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), true);
  controls._queueCctvFrame('other.jpg', 'b', true);
  assert.equal(controls._cctvFrame.src, '');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), false);
});

test('destroy invalidates image callbacks and releases each subscription once', (t) => {
  const { controls, requests } = fixture(t);
  let unsubscribed = 0;
  controls.cctv.subscribe = () => () => {
    unsubscribed++;
  };
  controls.connect();
  controls.connect();
  assert.equal(unsubscribed, 1);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const late = requests[0].onload;
  controls.destroy();
  controls.destroy();
  controls.connect();
  late();
  assert.equal(unsubscribed, 2);
  assert.equal(requests[0].onload, null);
  assert.equal(requests[0].onerror, null);
  assert.equal(controls._cctvFrame.src, '');
  controls._queueCctvFrame('late.jpg', 'b', true);
  assert.equal(requests.length, 1);
});

function calibrationFixture(t) {
  const { controls } = fixture(t);
  const prior = globalThis.document;
  const inputs = [];
  globalThis.document = {
    createElement() {
      const input = new EventTarget();
      Object.assign(input, {
        focus() {},
        select() {},
        remove() {
          this.parent.input = null;
        },
      });
      inputs.push(input);
      return input;
    },
  };
  t.after(() => {
    globalThis.document = prior;
  });
  const chip = {
    dataset: { calField: 'heading' },
    textContent: '',
    input: null,
    appendChild(input) {
      this.input = input;
      input.parent = this;
    },
    querySelector() {
      return this.input;
    },
  };
  const patches = [];
  controls.actions.setParams = (params) => patches.push(params);
  controls.actions.setPanelCollapsed = () => {};
  controls._cctvCalReadout = { querySelectorAll: () => [chip] };
  controls._cctvState = {
    enabled: true,
    activeCameraId: 'a',
    activeCamera: { id: 'a', headingDeg: 30, basePose: { headingDeg: 20 } },
  };
  const key = (name) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key: name });
  return { controls, chip, inputs, patches, key };
}

test('calibration commits against the captured camera base and releases its editor', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._cctvState.activeCamera.basePose.headingDeg = 60;
  inputs[0].dispatchEvent(key('Enter'));
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, [
    {
      selectedCameraId: 'a',
      calibration: { cameraId: 'a', patch: { headingDeg: 80 } },
    },
  ]);
  assert.equal(controls._calibrationEdit, null);
});

test('a camera switch cancels calibration before old blur can change the new camera', (t) => {
  const { controls, chip, inputs, patches } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._renderCctvState({
    enabled: true,
    activeCameraId: 'b',
    activeCamera: { id: 'b', headingDeg: 200, basePose: { headingDeg: 190 } },
  });
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  assert.equal(chip.input, null);
  assert.equal(chip.textContent, 'HDG 200.0°');
});

test('Escape claims calibration cancellation and disposal prevents late commits', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  const escape = key('Escape');
  inputs[0].dispatchEvent(escape);
  inputs[0].dispatchEvent(new Event('blur'));
  assert.equal(escape.defaultPrevented, true);
  controls._beginCctvCalValueEdit(chip);
  inputs[1].value = '120';
  controls.destroy();
  inputs[1].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
});

test('disposing during camera enable prevents the delayed focus and future clicks', async () => {
  const button = new EventTarget();
  let resolveEnable;
  let enables = 0;
  let focuses = 0;
  const controls = new CctvControls({
    elements: { _cctvPanel: {}, _cctvNextBtn: button },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      toggleEnabled() {
        enables++;
        return new Promise((resolve) => {
          resolveEnable = resolve;
        });
      },
      runExplicitFocus() {
        focuses++;
      },
    },
  });
  button.dispatchEvent(new Event('click'));
  controls.destroy();
  resolveEnable(true);
  await new Promise((resolve) => setImmediate(resolve));
  button.dispatchEvent(new Event('click'));
  assert.equal(enables, 1);
  assert.equal(focuses, 0);
});

function fakeListElement(options = []) {
  return {
    options,
    value: '',
    disabled: false,
    selectedIndex: -1,
    set innerHTML(_markup) {
      this.options.length = 0;
    },
    appendChild(option) {
      this.options.push(option);
    },
  };
}

test('the feed filter lists only live video or only snapshot cameras', (t) => {
  const priorDocument = globalThis.document;
  globalThis.document = { hidden: false, createElement: () => ({}) };
  t.after(() => {
    globalThis.document = priorDocument;
  });
  const filter = fakeListElement([
    { value: 'all', textContent: 'All feeds' },
    { value: 'live', textContent: 'Live video' },
    { value: 'snapshot', textContent: 'Snapshots' },
  ]);
  filter.value = 'all';
  const select = fakeListElement();
  const suggestions = fakeListElement();
  const controls = new CctvControls({
    elements: {
      _cctvSelect: select,
      _cctvSearchOptions: suggestions,
      _cctvFeedFilter: filter,
    },
    cctv: {},
    actions: { isEnabled: () => true, setPanelCollapsed() {} },
  });
  t.after(() => controls.destroy());
  const state = {
    enabled: true,
    activeCameraId: 'snap-1',
    cameras: [
      {
        id: 'live-1',
        city: 'Los Angeles',
        name: 'I-110 at 1st St',
        isVideo: true,
      },
      { id: 'snap-1', city: 'Austin', name: 'Congress at 5th', isVideo: false },
      {
        id: 'live-2',
        city: 'Wilmington',
        name: 'King St at 10th',
        isVideo: true,
      },
    ],
  };
  const listed = () => select.options.map((option) => option.value);
  const suggested = () => suggestions.options.map((option) => option.value);

  controls._renderCctvState(state);
  assert.deepEqual(listed(), ['live-1', 'snap-1', 'live-2']);
  assert.deepEqual(
    filter.options.map((option) => option.textContent),
    ['All feeds (3)', 'Live video (2)', 'Snapshots (1)'],
  );
  assert.equal(
    select.options[0].textContent,
    'Los Angeles · I-110 at 1st St · LIVE',
  );

  filter.value = 'live';
  controls._renderCctvState(state);
  assert.deepEqual(
    listed(),
    ['live-1', 'live-2'],
    'the dropdown lists live cameras only, even while a snapshot is active',
  );
  assert.deepEqual(suggested(), [
    'Los Angeles · I-110 at 1st St · LIVE',
    'Wilmington · King St at 10th · LIVE',
  ]);
  assert.equal(
    select.selectedIndex,
    -1,
    'the active snapshot camera is not shown as a live selection',
  );

  filter.value = 'snapshot';
  controls._renderCctvState({ ...state, activeCameraId: null });
  assert.deepEqual(listed(), ['snap-1']);
  assert.deepEqual(suggested(), ['Austin · Congress at 5th']);
  assert.deepEqual(
    filter.options.map((option) => option.textContent),
    ['All feeds (3)', 'Live video (2)', 'Snapshots (1)'],
    'counts are rewritten in place, not appended',
  );

  // A stream that falls back to its still image moves to Snapshots.
  controls._renderCctvState({
    ...state,
    activeCameraId: null,
    cameras: state.cameras.map((cam) =>
      cam.id === 'live-2' ? { ...cam, isVideo: false } : cam,
    ),
  });
  assert.deepEqual(listed(), ['snap-1', 'live-2']);
});

test('navigation follows the feed filter and switching to Live flies to a live camera', async (t) => {
  const filter = Object.assign(new EventTarget(), {
    value: 'all',
    disabled: false,
    options: [],
  });
  const nextBtn = new EventTarget();
  const nearestBtn = new EventTarget();
  const calls = [];
  const focused = [];
  const controls = new CctvControls({
    elements: {
      _cctvPanel: {},
      _cctvFeedFilter: filter,
      _cctvNextBtn: nextBtn,
      _cctvNearestBtn: nearestBtn,
    },
    cctv: {
      cycleCamera(step, options) {
        calls.push(['cycle', step, options.feed]);
        return 'live-2';
      },
      focusNearest(options) {
        calls.push(['nearest', options.feed]);
        return 'live-1';
      },
      focusCamera(cameraId) {
        focused.push(cameraId);
      },
    },
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      toggleEnabled: async () => true,
      runExplicitFocus(activate, focus) {
        const cameraId = activate();
        if (cameraId) focus(cameraId);
      },
    },
  });
  t.after(() => controls.destroy());
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  controls._cctvState = {
    activeCameraId: 'snap-1',
    activeCamera: { id: 'snap-1', isVideo: false },
    cameras: [],
  };
  filter.value = 'live';
  filter.dispatchEvent(new Event('change'));
  assert.deepEqual(calls, [['nearest', 'live']]);
  assert.deepEqual(
    focused,
    ['live-1'],
    'a snapshot on screen gives way to the nearest live camera',
  );

  controls._cctvState = {
    activeCameraId: 'live-1',
    activeCamera: { id: 'live-1', isVideo: true },
    cameras: [],
  };
  nextBtn.dispatchEvent(new Event('click'));
  await settle();
  nearestBtn.dispatchEvent(new Event('click'));
  await settle();
  assert.deepEqual(calls.slice(1), [
    ['cycle', 1, 'live'],
    ['nearest', 'live'],
  ]);

  calls.length = 0;
  filter.value = 'live';
  filter.dispatchEvent(new Event('change'));
  assert.deepEqual(calls, [], 'a live camera already on screen stays put');
});

test('the feed filter is remembered between visits and handed to the layer', (t) => {
  const priorStorage = globalThis.localStorage;
  const store = new Map([['gev:cctv-feed-filter:v1', 'snapshot']]);
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  t.after(() => {
    if (priorStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
  });
  const filter = Object.assign(new EventTarget(), {
    value: 'all',
    disabled: false,
    options: [],
  });
  const layerFilter = [];
  const controls = new CctvControls({
    elements: { _cctvPanel: {}, _cctvFeedFilter: filter },
    cctv: { setFeedFilter: (feed) => layerFilter.push(feed) },
    actions: { isEnabled: () => false, syncViewport() {} },
  });
  t.after(() => controls.destroy());

  assert.equal(filter.value, 'snapshot', 'the saved choice is restored');
  assert.deepEqual(layerFilter, ['snapshot']);

  filter.value = 'live';
  filter.dispatchEvent(new Event('change'));
  assert.equal(store.get('gev:cctv-feed-filter:v1'), 'live');
  assert.deepEqual(layerFilter, ['snapshot', 'live']);
});

test('a live stream that failed is labelled LIVE OFFLINE in the list and the badge', (t) => {
  const priorDocument = globalThis.document;
  globalThis.document = { hidden: false, createElement: () => ({}) };
  t.after(() => {
    globalThis.document = priorDocument;
  });
  const select = fakeListElement();
  const badge = { textContent: '', dataset: {} };
  const controls = new CctvControls({
    elements: { _cctvSelect: select, _cctvSourceBadge: badge },
    cctv: {},
    actions: { isEnabled: () => true, setPanelCollapsed() {} },
  });
  t.after(() => controls.destroy());
  const failed = {
    id: 'live-1',
    city: 'Los Angeles',
    name: 'I-110 at 1st St',
    isVideo: false,
    liveFailed: true,
  };
  controls._renderCctvState({
    enabled: true,
    activeCameraId: 'live-1',
    activeCamera: failed,
    cameras: [failed],
  });
  assert.equal(
    select.options[0].textContent,
    'Los Angeles · I-110 at 1st St · LIVE OFFLINE',
  );
  assert.equal(badge.textContent, 'LIVE · OFFLINE · STILL IMAGE');
  assert.equal(badge.dataset.frameState, 'offline');
});
