import * as Cesium from 'cesium';
import { CCTV_FOCUS_RESULT } from './policy.js';

export function createNavigation({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Whether a camera record matches the panel's feed filter. 'live' is video
   * that has not fallen back to its still image (the panel's isVideo);
   * 'snapshot' is everything else; any other value matches every record.
   * @param {Object} record CCTV camera runtime record.
   * @param {string} [feed] 'live', 'snapshot', or anything else for all.
   * @returns {boolean}
   */

  function recordMatchesFeed(record, feed) {
    if (feed !== 'live' && feed !== 'snapshot') return true;
    const live =
      parts.model.isVideoFeedType(record.camera.feedType) &&
      record.projection?.mode !== 'image';
    return feed === 'live' ? live : !live;
  }

  /**
   * Finds the camera closest to the Cesium viewer's current position.
   * @param {string} [feed] Optional feed filter (see recordMatchesFeed).
   * @returns {string|null} Camera ID of the nearest camera, or null.
   */

  function nearestCameraIdToViewer(feed) {
    const carto = layerState._viewer?.camera?.positionCartographic;
    if (!carto || !layerState._records.length) return null;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);

    let best = null;
    for (const record of layerState._records) {
      if (!recordMatchesFeed(record, feed)) continue;
      const distKm = parts.model.haversineKm(
        lat,
        lon,
        record.camera.lat,
        record.camera.lon,
      );
      if (!best || distKm < best.distKm) {
        best = { id: record.camera.id, distKm };
      }
    }
    return best?.id || null;
  }

  /**
   * Flies the Cesium viewer camera to frame the specified CCTV camera,
   * looking along its heading from above.
   * @param {Cesium.Viewer|null} viewer Cesium viewer that owns the camera.
   * @param {Object|null} record CCTV camera runtime record.
   * @param {number} [duration=2.2] - Flight duration in seconds.
   * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
   */

  function focusCctvRecord(viewer, record, duration = 2.2) {
    if (!viewer || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    if (
      typeof document !== 'undefined' &&
      document.body?.classList.contains('cockpit-mode')
    ) {
      console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    }
    if (viewer.trackedEntity) {
      console.debug(
        '[Data:CCTV] focus ignored while a tracked entity owns the camera',
      );
      return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
    }
    const { camera } = record;
    const range = Math.max(280, camera.rangeM * 1.18);
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        record.position,
        Math.max(40, camera.rangeM * 0.36),
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          parts.model.toRad(camera.headingDeg),
          parts.model.toRad(-22),
          range,
        ),
        duration: Math.max(0.2, duration || 0),
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      },
    );
    return CCTV_FOCUS_RESULT.FOCUSED;
  }

  function focusCamera(cameraId, duration = 2.2) {
    return focusCctvRecord(
      layerState._viewer,
      layerState._recordById.get(cameraId),
      duration,
    );
  }

  /**
   * Advances to the next camera if auto-hop is enabled and the hop interval
   * has elapsed. If the viewer has panned to a new region since the last hop,
   * snaps to the nearest camera instead of cycling sequentially.
   * @param {number} nowMs - Current timestamp in milliseconds.
   */

  function maybeAutoHop(nowMs) {
    if (
      !layerState._autoHop ||
      layerState._autoHopSuspended ||
      !layerState._enabled ||
      layerState._records.length < 2
    )
      return;
    if (nowMs - layerState._lastHopAt < layerState._autoHopSec * 1000) return;

    const viewKey = parts.model.currentViewContext();
    const viewChanged = viewKey !== layerState._lastViewContext;
    layerState._lastViewContext = viewKey;

    if (viewChanged) {
      const nearest = nearestCameraIdToViewer();
      if (nearest && nearest !== layerState._activeCameraId) {
        // Use setActiveCamera so the full activation path runs (obstruction
        // probe, projection runtime, geometry rewrite) — previously bypassed
        // with a bare assignment
        parts.selection.setActiveCamera(nearest);
        layerState._lastHopAt = nowMs;
        return;
      }
    }

    const nextIdx = cctvCycleIndex(
      layerState._records.findIndex(
        (record) => record.camera.id === layerState._activeCameraId,
      ),
      1,
      layerState._records.length,
    );
    parts.selection.setActiveCamera(layerState._records[nextIdx].camera.id);
    layerState._lastHopAt = nowMs;
  }

  /**
   * Resolves a catalog cycle target, including the explicit no-selection state.
   * NEXT from null selects the first record; PREV selects the last.
   * @param {number} currentIdx
   * @param {number} step
   * @param {number} count
   * @returns {number}
   */

  function cctvCycleIndex(currentIdx, step, count) {
    const total = Number.isFinite(count) ? Math.floor(count) : 0;
    if (total <= 0) return -1;
    const delta = Number.isFinite(step) ? Math.trunc(step) : 1;
    if (!Number.isFinite(currentIdx) || currentIdx < 0) {
      return delta < 0 ? total - 1 : 0;
    }
    return (((Math.floor(currentIdx) + delta) % total) + total) % total;
  }

  /**
   * Like cctvCycleIndex, but only lands on records matching the feed filter.
   * Walks the catalog in its usual order from the current position, so NEXT
   * from a camera outside the filter reaches the next matching one after it.
   * @param {Object[]} records Catalog records in cycle order.
   * @param {number} currentIdx Active record index, or -1 for none.
   * @param {number} step Positions to move among matching records.
   * @param {string} feed 'live' or 'snapshot' (see recordMatchesFeed).
   * @returns {number} Index of the target record, or -1 when none matches.
   */

  function cctvCycleMatchingIndex(records, currentIdx, step, feed) {
    const total = records.length;
    const delta = Number.isFinite(step) ? Math.trunc(step) : 1;
    const direction = delta < 0 ? -1 : 1;
    let remaining = Math.max(1, Math.abs(delta));
    let idx =
      Number.isFinite(currentIdx) && currentIdx >= 0 && currentIdx < total
        ? Math.floor(currentIdx)
        : direction > 0
          ? -1
          : total;
    // Bounded so an empty filter result ends instead of looping; a step
    // larger than the matching set wraps around it, as cctvCycleIndex does.
    const maxVisits = total * remaining;
    for (let visited = 0; visited < maxVisits; visited += 1) {
      idx = (idx + direction + total) % total;
      if (!recordMatchesFeed(records[idx], feed)) continue;
      remaining -= 1;
      if (remaining === 0) return idx;
    }
    return -1;
  }
  return {
    recordMatchesFeed,
    nearestCameraIdToViewer,
    focusCctvRecord,
    focusCamera,
    maybeAutoHop,
    cctvCycleIndex,
    cctvCycleMatchingIndex,
  };
}
