import * as Cesium from 'cesium';
import { createEsriPlaceLabelsImagery } from './imagery.js';

/**
 * @module maps/placeLabels
 * @description English borders and place names over the satellite globe
 * (BK, 2026-10-08: make it clear where on the globe you are; every label in
 * English). Esri's World Boundaries and Places reference layer draws country
 * and state borders and country, state, city and sea names, all in English,
 * above the imagery of the maps that carry no names of their own. The
 * Streets map already has English names and Google 3D hides the globe, so
 * neither gets it. Kept above draped weather and recent imagery so names stay
 * readable; never pickable. ON by default; the choice is a per-browser
 * convenience in localStorage.
 */

/** Map stacks whose imagery has no place names. */
export const PLACE_LABEL_STACKS = Object.freeze([
  'esri-imagery',
  'bing-aerial',
]);
const STORAGE_KEY = 'gev.placeLabels.enabled';

function readEnabled(storage) {
  try {
    return storage?.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {{getActiveId: function(): string, subscribe: function(function): function}} options.controller
 *   The map source controller; every settled switch re-syncs the layer.
 * @param {function(): Promise<object>} [options.createProvider]
 * @param {function(object): object} [options.createImageryLayer]
 * @param {function(string=): void} [options.requestRender]
 * @param {Storage} [options.storage]
 */
export function createPlaceLabels({
  viewer,
  controller,
  createProvider = createEsriPlaceLabelsImagery,
  createImageryLayer = (provider) => new Cesium.ImageryLayer(provider),
  requestRender = () => viewer?.scene?.requestRender?.(),
  storage = globalThis.localStorage,
}) {
  const layers = viewer?.imageryLayers;
  let enabled = readEnabled(storage);
  let layer = null;
  let providerPromise = null;
  let destroyed = false;
  const listeners = new Set();

  const wanted = () =>
    enabled &&
    !destroyed &&
    viewer?.scene?.globe?.show === true &&
    PLACE_LABEL_STACKS.includes(controller?.getActiveId?.());

  function provider() {
    providerPromise ??= Promise.resolve()
      .then(createProvider)
      .catch((error) => {
        providerPromise = null;
        throw error;
      });
    return providerPromise;
  }

  /** Names stay above any imagery draped after them. */
  function keepOnTop() {
    if (!layer || typeof layers?.raiseToTop !== 'function') return;
    if (!layers.contains?.(layer)) return;
    if (layers.indexOf(layer) !== layers.length - 1) layers.raiseToTop(layer);
  }

  function removeLayer() {
    if (!layer) return;
    layers?.remove(layer, true);
    layer = null;
    requestRender('place-labels');
  }

  async function sync() {
    if (destroyed) return;
    if (!wanted()) {
      removeLayer();
      return;
    }
    if (layer) {
      keepOnTop();
      return;
    }
    let labels;
    try {
      labels = await provider();
    } catch (error) {
      console.warn('[PlaceLabels] unavailable:', error?.message || error);
      return;
    }
    if (layer || !wanted()) return;
    layer = createImageryLayer(labels);
    layers?.add(layer);
    keepOnTop();
    requestRender('place-labels');
  }

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener(enabled);
      } catch (error) {
        console.warn('[PlaceLabels] listener failed:', error);
      }
    }
  }

  const removeAdded = layers?.layerAdded?.addEventListener?.(keepOnTop);
  const removeMoved = layers?.layerMoved?.addEventListener?.(keepOnTop);
  const unsubscribe = controller?.subscribe?.(() => void sync());
  void sync();

  return {
    isEnabled: () => enabled,
    /** Whether names are drawn on this map stack at all. */
    appliesTo: (stackId) => PLACE_LABEL_STACKS.includes(stackId),
    /** Whether the names layer is on the globe right now. */
    isShown: () => Boolean(layer),
    setEnabled(next) {
      enabled = next === true;
      try {
        storage?.setItem(STORAGE_KEY, enabled ? '1' : '0');
      } catch {
        /* blocked storage: the choice lasts this page only */
      }
      notify();
      return sync();
    },
    /** @param {function(boolean): void} listener @returns {function(): void} */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeAdded?.();
      removeMoved?.();
      unsubscribe?.();
      listeners.clear();
      removeLayer();
    },
  };
}
