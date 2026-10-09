/**
 * AI Watch controls and notification feed (BK, 2026-10-08).
 *
 * - Off at startup. Watch starts only when BK presses Start AI Watch after
 *   choosing an area; reloading the app shows the server's real state and
 *   never starts or restores a run.
 * - Stop AI Watch stops it; the status reads Stopping until the server says
 *   the detector has exited and the GPU is free.
 * - Notifications sit in this panel, one per incident, marked unverified
 *   where no check settled them. They never move the view, open a camera or
 *   take focus; "View camera" calls `onViewCamera` (the CCTV dropdown's
 *   path), only on BK's click.
 * - The panel never stays in the way: it closes on Start, Stop, View camera,
 *   Esc, or a click anywhere outside it.
 * - Nothing here touches the map, the active camera or the app session, so
 *   starting or stopping leaves the view exactly where it was.
 */
import { englishPlaceName } from '../data/englishNames.js';
import {
  AI_WATCH_AREA_STORAGE_KEY,
  chosenAreaId,
  describeEntry,
  describeWatchStatus,
  mergeNotifications,
} from './aiWatchModel.js';

const API = '/api/cctv/watch';
const STATE_POLL_MS = 5000;
const FEED_POLL_MS = 10_000;

export function createAiWatchControls({
  document = globalThis.document,
  fetchJson = defaultFetchJson,
  onViewCamera = () => {},
  storage = safeStorage(),
  setInterval: every = globalThis.setInterval.bind(globalThis),
  clearInterval: stopEvery = globalThis.clearInterval.bind(globalThis),
  now = Date.now,
} = {}) {
  const el = (id) => document.getElementById(id);
  // The icon in the globe actions carries the status and the red badge; the
  // panel opens at the right edge, clear of the middle of the map.
  const toggle = el('ai-watch-toggle');
  if (!toggle) return { start() {}, destroy() {} };
  const statusText = el('ai-watch-status');
  const unreadBadge = el('ai-watch-unread');
  const panel = el('ai-watch-panel');
  const detail = el('ai-watch-detail');
  const startButton = el('ai-watch-start');
  const stopButton = el('ai-watch-stop');
  const pickers = {
    region: el('ai-watch-region'),
    city: el('ai-watch-city'),
    municipality: el('ai-watch-municipality'),
  };
  const feed = el('ai-watch-feed');

  let watch = null;
  let regions = [];
  let pending = null;
  let destroyed = false;
  const entries = new Map();
  const seen = new Map();
  /** Entries that were new when BK opened the panel: red dots until it closes. */
  const fresh = new Set();
  const timers = [];
  const listeners = [];
  const listen = (target, type, fn) => {
    target?.addEventListener(type, fn);
    listeners.push(() => target?.removeEventListener(type, fn));
  };

  function render() {
    const status = describeWatchStatus(
      pending ? { ...watch, state: pending } : watch,
    );
    toggle.dataset.state = status.state;
    panel.dataset.state = status.state;
    statusText.textContent = status.label;
    toggle.title = `${status.label}. ${status.detail}`;
    toggle.setAttribute('aria-label', status.label);
    detail.textContent = status.detail;
    startButton.hidden = !status.canStart && status.state !== 'unknown';
    startButton.disabled = !status.canStart || !currentArea();
    stopButton.hidden = !status.canStop && status.state !== 'stopping';
    stopButton.disabled = !status.canStop;
    stopButton.textContent = status.stopLabel;
    // The area is fixed while a run is on; stop to change it.
    const locked = !status.canStart;
    for (const picker of Object.values(pickers)) picker.disabled = locked;
  }

  function currentArea() {
    return chosenAreaId({
      region: pickers.region.value,
      city: pickers.city.value,
      municipality: pickers.municipality.value,
    });
  }

  function fillPicker(picker, items, anyLabel) {
    const keep = picker.value;
    picker.replaceChildren();
    const any = document.createElement('option');
    any.value = '';
    any.textContent = anyLabel;
    picker.append(any);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${englishPlaceName(item.label)} (${item.cameras})`;
      picker.append(option);
    }
    if (items.some((item) => item.id === keep)) picker.value = keep;
  }

  function refreshPickers() {
    fillPicker(pickers.region, regions, 'Choose a region');
    const region = regions.find((item) => item.id === pickers.region.value);
    fillPicker(pickers.city, region?.cities ?? [], 'Whole region');
    const city = region?.cities.find((item) => item.id === pickers.city.value);
    fillPicker(pickers.municipality, city?.municipalities ?? [], 'Whole city');
    render();
  }

  function restoreArea() {
    // A remembered choice only fills the pickers; it never starts anything.
    let stored = null;
    try {
      stored = storage?.getItem(AI_WATCH_AREA_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    const id = watch?.area?.id || stored;
    if (!id) return;
    for (const region of regions) {
      if (region.id === id) pickers.region.value = region.id;
      for (const city of region.cities) {
        if (city.id === id) {
          pickers.region.value = region.id;
          refreshPickers();
          pickers.city.value = city.id;
        }
        for (const municipality of city.municipalities)
          if (municipality.id === id) {
            pickers.region.value = region.id;
            refreshPickers();
            pickers.city.value = city.id;
            refreshPickers();
            pickers.municipality.value = municipality.id;
          }
      }
    }
    refreshPickers();
  }

  async function loadAreas() {
    try {
      regions = (await fetchJson(`${API}/areas`)).regions ?? [];
      refreshPickers();
      restoreArea();
    } catch {
      detail.textContent = 'The camera list is not available yet.';
    }
  }

  async function pollState() {
    try {
      // Keep a running Watch alive while this app is open; never start it.
      const running = ['starting', 'running'].includes(watch?.state);
      const response = await fetchJson(
        `${API}/state${running ? '?keepalive=1' : ''}`,
      );
      watch = response.watch;
      if (pending && watch?.state !== 'off' && pending !== 'stopping')
        pending = null;
      if (pending === 'stopping' && watch?.state !== 'running') pending = null;
    } catch {
      watch = null;
    }
    if (!destroyed) render();
  }

  async function pollFeed() {
    if (
      !['running', 'starting', 'stopping'].includes(watch?.state) &&
      panel.hidden
    )
      return;
    try {
      const response = await fetchJson(`${API}/notifications`);
      renderFeed(response.notifications ?? []);
    } catch {
      /* the next poll tries again */
    }
  }

  function renderFeed(incoming = []) {
    const { list, unread } = mergeNotifications(entries, incoming, seen);
    if (!panel.hidden) {
      // What was new when BK looked keeps its red dot until he closes it.
      for (const entry of list)
        if ((seen.get(entry.id) ?? -1) < (entry.revision ?? 0))
          fresh.add(entry.id);
      markSeen(list);
    }
    // Closed panel: a red count on the icon, like any app's notifications.
    unreadBadge.hidden = !panel.hidden || unread === 0;
    unreadBadge.textContent = unread > 99 ? '99+' : String(unread);
    feed.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'ai-watch-empty';
      empty.textContent = 'No observations.';
      feed.append(empty);
      return;
    }
    for (const entry of list) feed.append(feedItem(entry));
  }

  function feedItem(entry) {
    const item = document.createElement('li');
    item.className = 'ai-watch-entry';
    item.dataset.verification = entry.verification;
    if (fresh.has(entry.id)) item.dataset.unread = 'true';
    const title = document.createElement('strong');
    title.textContent = entry.title;
    const meta = document.createElement('span');
    meta.className = 'ai-watch-meta';
    meta.textContent = describeEntry(entry, now());
    item.append(title, meta);
    if (entry.cameraId) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'ai-watch-view';
      view.textContent = 'View camera';
      // The only path from a notification to a camera, and it is BK's click;
      // the panel gets out of the way of the camera he chose.
      view.addEventListener('click', () => {
        setPanel(false);
        onViewCamera(entry.cameraId);
      });
      item.append(view);
    }
    return item;
  }

  function markSeen(list) {
    for (const entry of list) seen.set(entry.id, entry.revision ?? 0);
  }

  function setPanel(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!regions.length) loadAreas();
      renderFeed();
      pollFeed();
    } else fresh.clear();
  }

  async function send(action, body) {
    pending = action === 'start' ? 'starting' : 'stopping';
    render();
    try {
      const response = await fetchJson(`${API}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      if (response.watch) watch = response.watch;
      if (response.ok === false && response.error) {
        pending = null;
        detail.textContent = response.error;
        return;
      }
    } catch (error) {
      pending = null;
      detail.textContent = error.message;
      return;
    }
    // Out of the way once it is started or stopped: the icon shows the state.
    setPanel(false);
    await pollState();
  }

  listen(toggle, 'click', () => setPanel(panel.hidden));
  // A click anywhere outside the panel (the map included) or Esc closes it.
  // The click still reaches whatever it landed on.
  listen(document, 'pointerdown', (event) => {
    if (panel.hidden) return;
    const target = event.target;
    if (panel.contains(target) || toggle.contains(target)) return;
    setPanel(false);
  });
  listen(document, 'keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setPanel(false);
  });
  listen(pickers.region, 'change', () => {
    pickers.city.value = '';
    pickers.municipality.value = '';
    refreshPickers();
  });
  listen(pickers.city, 'change', () => {
    pickers.municipality.value = '';
    refreshPickers();
  });
  listen(pickers.municipality, 'change', render);
  listen(startButton, 'click', () => {
    const area = currentArea();
    if (!area) return;
    try {
      storage?.setItem(AI_WATCH_AREA_STORAGE_KEY, area);
    } catch {
      /* storage unavailable */
    }
    send('start', { area });
  });
  listen(stopButton, 'click', () => send('stop'));

  return {
    start() {
      render();
      pollState();
      timers.push(
        every(pollState, STATE_POLL_MS),
        every(pollFeed, FEED_POLL_MS),
      );
    },
    destroy() {
      destroyed = true;
      for (const timer of timers.splice(0)) stopEvery(timer);
      for (const remove of listeners.splice(0)) remove();
    },
  };
}

async function defaultFetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !('ok' in body))
    throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
