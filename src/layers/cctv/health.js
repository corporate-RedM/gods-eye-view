import { HEALTH_SYNC_INTERVAL_MS, HEALTH_ENDPOINT } from './policy.js';

export function createHealth({ state: layerState, services, parts, source }) {
  /**
   * Fetches per-camera health status from the backend and updates _healthById.
   * Rate-limited to HEALTH_SYNC_INTERVAL_MS unless forced.
   * @param {boolean} [force=false] - Bypass the interval check.
   */

  async function syncHealthState(force = false) {
    const now = Date.now();
    if (!force && now - layerState._lastHealthSyncAt < HEALTH_SYNC_INTERVAL_MS)
      return;
    layerState._lastHealthSyncAt = now;

    try {
      const signal = layerState._sourceAbort?.signal;
      const data = await source.getHealth({ signal });
      signal?.throwIfAborted();
      const rows = Array.isArray(data?.cameras) ? data.cameras : [];
      const next = new Map();
      for (const row of rows) {
        const id = String(row?.id || '').trim();
        if (!id) continue;
        next.set(id, {
          status: String(row.status || '').toLowerCase() || 'unknown',
          sourceKind: String(
            row.sourceKind || row.feedType || '',
          ).toLowerCase(),
          label: String(row.label || row.provider || ''),
          message: String(row.message || ''),
          updatedAt: parts.model.safeNumber(row.updatedAt, now),
        });
      }
      const previous = layerState._healthById;
      layerState._healthById = next;
      // The cached public list must still reflect health changes for inactive
      // cameras, including a status disappearing from the health response.
      for (const id of new Set([...previous.keys(), ...next.keys()])) {
        if (JSON.stringify(previous.get(id)) === JSON.stringify(next.get(id)))
          continue;
        const index = layerState._publicCameraIndex?.get(id);
        const record = layerState._recordById?.get(id);
        if (
          index !== undefined &&
          record &&
          parts.presentation?.getPublicCameraState
        )
          layerState._publicCameras[index] =
            parts.presentation.getPublicCameraState(record);
      }
    } catch {
      // keep previous health map
    }
  }
  return { syncHealthState };
}
