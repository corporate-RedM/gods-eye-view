// AI Watch controls (BK, 2026-10-08): off at startup and never started by
// the app itself, Start needs an area, Stop really stops, and notifications
// reach a camera only through BK's click on "View camera".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiWatchControls } from './aiWatch.js';
import {
  describeWatchStatus,
  mergeNotifications,
  verificationLabel,
} from './aiWatchModel.js';

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.title = '';
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn({ type });
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  contains(node) {
    return (
      node === this || this.children.some((child) => child.contains?.(node))
    );
  }
}

const IDS = [
  'ai-watch',
  'ai-watch-toggle',
  'ai-watch-status',
  'ai-watch-unread',
  'ai-watch-panel',
  'ai-watch-detail',
  'ai-watch-start',
  'ai-watch-stop',
  'ai-watch-region',
  'ai-watch-city',
  'ai-watch-municipality',
  'ai-watch-feed',
];

const REGIONS = [
  {
    id: 'region:nevada',
    label: 'Nevada',
    cameras: 3,
    cities: [
      {
        id: 'city:nevada/reno',
        label: 'Reno',
        cameras: 3,
        municipalities: [
          { id: 'municipality:nevada/reno/reno', label: 'Reno', cameras: 3 },
        ],
      },
    ],
  },
];

function setup(initialState = 'off') {
  const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement()]));
  elements['ai-watch-panel'].hidden = true;
  // The panel holds its feed, so a click on an entry is a click inside it.
  elements['ai-watch-panel'].append(elements['ai-watch-feed']);
  const document = new FakeElement('document');
  document.getElementById = (id) => elements[id] ?? null;
  document.createElement = (tag) => new FakeElement(tag);
  const calls = [];
  let state = initialState;
  const notifications = [
    {
      id: 'inc-1',
      revision: 1,
      title: 'Vehicle off road',
      verification: 'unverified',
      confidence: 'possible',
      state: 'ongoing',
      cameraId: 'cam-7',
      cameraName: 'I-80 at Mill St',
      sightings: 2,
      lastSeenAt: Date.now(),
    },
  ];
  const fetchJson = async (url, options = {}) => {
    calls.push([options.method ?? 'GET', url, options.body ?? null]);
    if (url.endsWith('/areas')) return { regions: REGIONS };
    if (url.includes('/notifications')) return { notifications };
    if (url.endsWith('/start')) {
      state = 'running';
      return { ok: true, watch: { state } };
    }
    if (url.endsWith('/stop')) {
      state = 'stopping';
      return { watch: { state } };
    }
    return { watch: { state, area: null } };
  };
  const dispatched = [];
  const controls = createAiWatchControls({
    document,
    fetchJson,
    onViewCamera: (cameraId) => dispatched.push(cameraId),
    storage: null,
    setInterval: () => 0,
    clearInterval: () => {},
  });
  return {
    elements,
    document,
    calls,
    dispatched,
    controls,
    setState: (next) => {
      state = next;
    },
  };
}

/** Deliver a document-level event the way the browser would. */
function fireOn(document, type, event) {
  for (const fn of document.listeners[type] || []) fn({ type, ...event });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the app never starts AI Watch: opening it only reads the status', async () => {
  const { elements, calls, controls } = setup();
  controls.start();
  await settle();
  assert.deepEqual(
    calls.map(([method, url]) => `${method} ${url}`),
    ['GET /api/cctv/watch/state'],
    'no keepalive and no start while it is off',
  );
  assert.equal(elements['ai-watch-status'].textContent, 'AI Watch: Off');
  assert.equal(elements['ai-watch-start'].disabled, true, 'no area chosen yet');
  controls.destroy();
});

test('Start needs an area and sends it; Stop sends stop and reads Stopping', async () => {
  const { elements, calls, controls, setState } = setup();
  controls.start();
  elements['ai-watch-toggle'].fire('click');
  await settle();
  elements['ai-watch-region'].value = 'region:nevada';
  elements['ai-watch-region'].fire('change');
  elements['ai-watch-city'].value = 'city:nevada/reno';
  elements['ai-watch-city'].fire('change');
  assert.equal(elements['ai-watch-start'].disabled, false);
  elements['ai-watch-start'].fire('click');
  await settle();
  const start = calls.find(([method]) => method === 'POST');
  assert.deepEqual(start, [
    'POST',
    '/api/cctv/watch/start',
    JSON.stringify({ area: 'city:nevada/reno' }),
  ]);
  assert.equal(elements['ai-watch-status'].textContent, 'AI Watch: Running');
  assert.equal(
    elements['ai-watch-region'].disabled,
    true,
    'area fixed while running',
  );
  elements['ai-watch-stop'].fire('click');
  await settle();
  assert.ok(
    calls.some(([method, url]) => method === 'POST' && url.endsWith('/stop')),
  );
  assert.equal(elements['ai-watch-status'].textContent, 'AI Watch: Stopping');
  assert.equal(elements['ai-watch-stop'].textContent, 'Stopping…');
  setState('off');
  controls.destroy();
});

test('new notifications show a red count on the icon, then a red dot in the list', async () => {
  const { elements, controls } = setup('running');
  controls.start();
  await settle();
  // The feed polls on a timer; run one poll with the panel closed.
  elements['ai-watch-toggle'].fire('click');
  elements['ai-watch-toggle'].fire('click');
  await settle();
  assert.equal(elements['ai-watch-unread'].hidden, false, 'badge shown');
  assert.equal(elements['ai-watch-unread'].textContent, '1');
  elements['ai-watch-toggle'].fire('click');
  await settle();
  assert.equal(
    elements['ai-watch-unread'].hidden,
    true,
    'opened: badge cleared',
  );
  assert.equal(elements['ai-watch-feed'].children[0].dataset.unread, 'true');
  controls.destroy();
});

test('a notification offers View camera and dispatches only on a click', async () => {
  const { elements, dispatched, controls } = setup('running');
  controls.start();
  await settle();
  elements['ai-watch-toggle'].fire('click');
  await settle();
  const entry = elements['ai-watch-feed'].children[0];
  assert.match(entry.children[1].textContent, /Possible · unverified/);
  assert.match(entry.children[1].textContent, /seen 2 times/);
  assert.equal(dispatched.length, 0, 'showing a notification never navigates');
  const view = entry.children[2];
  assert.equal(view.textContent, 'View camera');
  view.fire('click');
  assert.deepEqual(dispatched, ['cam-7'], 'only the click opens the camera');
  assert.equal(
    elements['ai-watch-panel'].hidden,
    true,
    'the panel closes for the camera BK chose',
  );
  controls.destroy();
});

test('the panel closes on a click outside it or Esc, and stays for clicks inside', async () => {
  const { elements, document, controls } = setup('running');
  controls.start();
  await settle();
  const panel = elements['ai-watch-panel'];
  elements['ai-watch-toggle'].fire('click');
  await settle();
  assert.equal(panel.hidden, false);
  fireOn(document, 'pointerdown', {
    target: elements['ai-watch-feed'].children[0],
  });
  assert.equal(panel.hidden, false, 'a click inside the panel keeps it open');
  fireOn(document, 'pointerdown', { target: new FakeElement('canvas') });
  assert.equal(panel.hidden, true, 'a click on the map closes it');
  elements['ai-watch-toggle'].fire('click');
  fireOn(document, 'keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true, 'Esc closes it');
  controls.destroy();
});

test('repeat sightings update one entry; new or changed entries count as unread', () => {
  const entries = new Map();
  const seen = new Map();
  let merged = mergeNotifications(
    entries,
    [{ id: 'a', revision: 1, lastSeenAt: 1 }],
    seen,
  );
  assert.equal(merged.unread, 1);
  seen.set('a', 1);
  merged = mergeNotifications(
    entries,
    [{ id: 'a', revision: 3, lastSeenAt: 5, sightings: 4 }],
    seen,
  );
  assert.equal(merged.list.length, 1, 'consolidated');
  assert.equal(merged.list[0].sightings, 4);
  assert.equal(merged.unread, 1, 'changed since last seen');
  assert.equal(
    verificationLabel({ verification: 'checked' }),
    'Possible · checked',
  );
  assert.equal(describeWatchStatus({ state: 'stopping' }).canStart, false);
  assert.equal(describeWatchStatus(null).label, 'AI Watch: Unknown');
});
