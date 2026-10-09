import * as Cesium from 'cesium';
import { placeLocator } from '../data/placeLocator.js';
import { cameraPlaceLine, whereAmILevels } from './whereAmIModel.js';

/**
 * @module ui/whereAmI
 * @description The "Where am I" card at the top of the globe: the place under
 * the centre of the screen in plain English — continent (or ocean), country,
 * state, city — and, while a CCTV camera is open, that camera's name and
 * place (BK, 2026-10-08: "so clear that a child could know where they are").
 *
 * It follows the camera while it moves (at most every UPDATE_INTERVAL_MS) and
 * once more when it settles; it never moves the camera or takes the pointer.
 * The OFF choice is a per-browser convenience kept in localStorage.
 */

/** Refresh at most this often while the view moves. */
const UPDATE_INTERVAL_MS = 150;
/** Gap kept between the card and the loading chips stacked below it. */
const CHIP_GAP_PX = 8;
const STORAGE_KEY = 'gev.whereAmI.enabled';

/**
 * "Tallinn · Harju County · Estonia · Europe" for a camera; just its city
 * until the place packs have loaded (asked for here on first use).
 * @param {{city?: string, lat: number, lon: number}} camera
 * @param {ReturnType<import('../data/placeLocator.js').createPlaceLocator>} [locator]
 * @returns {string}
 */
export function describeCameraPlace(camera, locator = placeLocator) {
  if (!camera) return '';
  if (!locator.isReady()) locator.ready().catch(() => {});
  return cameraPlaceLine(camera, locator.locate(camera.lat, camera.lon));
}

function readEnabled(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeEnabled(storage, enabled) {
  try {
    storage?.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* private window or blocked storage: the choice lasts this page only */
  }
}

/**
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {HTMLElement} options.root - `#where-am-i`.
 * @param {HTMLButtonElement} [options.toggle] - ON/OFF button.
 * @param {{subscribe: function(function(object)): function}} [options.cctv] -
 *   CCTV layer port; its active camera fills the camera row.
 * @param {ReturnType<import('../data/placeLocator.js').createPlaceLocator>} [options.locator]
 * @param {Storage} [options.storage]
 */
export function createWhereAmI({
  viewer,
  root,
  toggle = null,
  cctv = null,
  locator = placeLocator,
  storage = globalThis.localStorage,
}) {
  if (!viewer?.scene || !viewer.camera || !root) return { destroy() {} };
  const doc = root.ownerDocument;
  const levelsEl = root.querySelector('[data-where-levels]');
  const cameraEl = root.querySelector('[data-where-camera]');
  const cameraNameEl = root.querySelector('[data-where-camera-name]');
  const cameraPlaceEl = root.querySelector('[data-where-camera-place]');
  const screenCenter = new Cesium.Cartesian2();
  const scratch = new Cesium.Cartographic();
  let enabled = readEnabled(storage);
  let destroyed = false;
  let timer = null;
  let lastRunAt = 0;
  let levelsSignature = '';
  let cameraSignature = '';
  let offsetPx = -1;
  let activeCamera = null;

  /** The ground point at the centre of the screen, else under the camera. */
  function viewTarget() {
    const canvas = viewer.scene.canvas;
    const altitudeM = viewer.camera.positionCartographic?.height ?? 0;
    screenCenter.x = (canvas?.clientWidth || 0) / 2;
    screenCenter.y = (canvas?.clientHeight || 0) / 2;
    const hit = viewer.camera.pickEllipsoid(
      screenCenter,
      viewer.scene.globe?.ellipsoid,
    );
    const place = hit
      ? Cesium.Cartographic.fromCartesian(hit, undefined, scratch)
      : viewer.camera.positionCartographic;
    if (!place) return null;
    return {
      lat: Cesium.Math.toDegrees(place.latitude),
      lon: Cesium.Math.toDegrees(place.longitude),
      altitudeM,
    };
  }

  function renderLevels(levels) {
    const signature = levels
      .map(({ caption, value }) => `${caption}\u0000${value}`)
      .join('\u0001');
    if (signature === levelsSignature) return;
    levelsSignature = signature;
    const nodes = [];
    levels.forEach(({ caption, value }, index) => {
      if (index) {
        const separator = doc.createElement('span');
        separator.className = 'where-am-i-separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '›';
        nodes.push(separator);
      }
      const level = doc.createElement('span');
      level.className = 'where-am-i-level';
      const captionEl = doc.createElement('span');
      captionEl.className = 'where-am-i-caption';
      captionEl.textContent = caption;
      const valueEl = doc.createElement('span');
      valueEl.className = 'where-am-i-value';
      valueEl.textContent = value;
      level.append(captionEl, valueEl);
      nodes.push(level);
    });
    levelsEl?.replaceChildren(...nodes);
    root.setAttribute(
      'aria-label',
      levels.length
        ? `You are looking at ${levels.map(({ value }) => value).join(', ')}`
        : 'Where you are looking',
    );
  }

  function renderCamera() {
    const camera = activeCamera;
    const name = camera?.name || '';
    const place = describeCameraPlace(camera, locator);
    const signature = `${name}\u0000${place}`;
    if (signature === cameraSignature) return;
    cameraSignature = signature;
    if (cameraEl) cameraEl.hidden = !camera;
    if (cameraNameEl) cameraNameEl.textContent = name;
    if (cameraPlaceEl) cameraPlaceEl.textContent = place;
  }

  /** Step the loading chips below the card by its current height. */
  function syncChipOffset() {
    const next = root.hidden ? 0 : root.offsetHeight + CHIP_GAP_PX;
    if (next === offsetPx) return;
    offsetPx = next;
    doc.documentElement.style.setProperty('--where-am-i-offset', `${next}px`);
  }

  function syncToggle() {
    if (!toggle) return;
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.classList.toggle('active', enabled);
  }

  function run() {
    timer = null;
    if (destroyed) return;
    lastRunAt = Date.now();
    if (enabled && !locator.isReady()) {
      locator.ready().then(schedule, () => {});
    }
    const shown = enabled && locator.isReady();
    root.hidden = !shown;
    if (shown) {
      const target = viewTarget();
      const fix = target ? locator.locate(target.lat, target.lon) : null;
      renderLevels(whereAmILevels(fix, { altitudeM: target?.altitudeM }));
      renderCamera();
    }
    syncChipOffset();
  }

  function schedule() {
    if (destroyed || timer) return;
    const wait = Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - lastRunAt));
    timer = setTimeout(run, wait);
  }

  function setEnabled(next) {
    enabled = next === true;
    writeEnabled(storage, enabled);
    syncToggle();
    schedule();
  }

  const onToggle = () => setEnabled(!enabled);
  toggle?.addEventListener('click', onToggle);
  const removePostRender = viewer.scene.postRender.addEventListener(schedule);
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(schedule);
  const unsubscribeCctv = cctv?.subscribe?.((state) => {
    const next = state?.enabled ? state.activeCamera || null : null;
    if (next === activeCamera) return;
    activeCamera = next;
    schedule();
  });
  syncToggle();
  schedule();

  return {
    /** Recompute now (tests, or after a jump the camera events miss). */
    refresh: run,
    isEnabled: () => enabled,
    setEnabled,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      timer = null;
      toggle?.removeEventListener('click', onToggle);
      removePostRender?.();
      removeMoveEnd?.();
      unsubscribeCctv?.();
      root.hidden = true;
      doc.documentElement.style.removeProperty('--where-am-i-offset');
    },
  };
}
