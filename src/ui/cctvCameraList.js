import { createCameraCataloguePicker } from './cctvCataloguePicker.js';

/** Search every camera in memory; keep only a bounded result window in the DOM. */
export function populateCameraOptions(controls, cameras, signature) {
  clearTimeout(controls._cctvListTimer);
  controls._cctvListPending = false;
  controls._cctvPicker ||= createCameraCataloguePicker(controls);
  controls._cctvPicker?.setCameras(cameras);
  if (controls._cctvPicker) {
    // The native select is only the existing selection event adapter. Both
    // controls open the complete virtual list, including its final record.
    const camera = cameras.find(
      (camera) => camera.id === controls._cctvState?.activeCameraId,
    );
    if (camera) {
      const option = document.createElement('option');
      option.value = camera.id;
      option.textContent = `${camera.city} · ${camera.name}`;
      controls._cctvSelect.appendChild(option);
    }
    return;
  }
  const query = String(controls._cctvSearch?.value || '')
    .trim()
    .toLocaleLowerCase();
  const words = query.split(/\s+/);
  const activeId = controls._cctvState?.activeCameraId;
  const rows = [];
  let active;
  for (const camera of cameras) {
    if (camera.id === activeId) active = camera;
    const haystack =
      `${camera.city} ${camera.originalCity || ''} ${camera.name} ${camera.originalName || ''} ${camera.id} ${camera.provider || ''}`.toLocaleLowerCase();
    if (
      !query ||
      camera.id === controls._cctvSearchMatch ||
      words.every((word) => haystack.includes(word))
    )
      rows.push(camera);
  }
  if (active && !rows.includes(active)) rows.push(active);
  for (const camera of rows) {
    const option = document.createElement('option');
    option.value = camera.id;
    const feedTag = camera.liveFailed
      ? ' · UNAVAILABLE'
      : camera.isVideo
        ? ' · VIDEO'
        : '';
    option.textContent = `${camera.city} · ${camera.name}${feedTag}`;
    controls._cctvSelect.appendChild(option);
    const searchLabel = `${option.textContent} · ${camera.id}`;
    controls._cctvSearchIds.set(searchLabel, camera.id);
    if (controls._cctvSearchOptions) {
      const suggestion = document.createElement('option');
      suggestion.value = searchLabel;
      suggestion.label = `${searchLabel} · ${camera.id}`;
      controls._cctvSearchOptions.appendChild(suggestion);
    }
  }
}
