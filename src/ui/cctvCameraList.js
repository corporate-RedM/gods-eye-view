/** Populate the same complete picker without blocking the grid's final paint. */
export function populateCameraOptions(controls, cameras, signature) {
  clearTimeout(controls._cctvListTimer);
  controls._cctvListPending = cameras.length > 1000;
  let index = 0;
  // Build off-DOM so each batch does not relayout every previously added row.
  const options = document.createDocumentFragment?.();
  const suggestions = document.createDocumentFragment?.();
  const append = () => {
    if (controls.destroyed || signature !== controls._cctvListSignature) return;
    const end = controls._cctvListPending
      ? Math.min(index + 128, cameras.length)
      : cameras.length;
    while (index < end) {
      const camera = cameras[index++];
      const option = document.createElement('option');
      option.value = camera.id;
      const feedTag = camera.isVideo
        ? ' · LIVE'
        : camera.liveFailed
          ? ' · LIVE OFFLINE'
          : '';
      option.textContent = `${camera.city} · ${camera.name}${feedTag}`;
      (options || controls._cctvSelect).appendChild(option);
      let searchLabel = option.textContent;
      if (controls._cctvSearchIds.has(searchLabel))
        searchLabel = `${searchLabel} · ${camera.id}`;
      controls._cctvSearchIds.set(searchLabel, camera.id);
      if (controls._cctvSearchOptions) {
        const suggestion = document.createElement('option');
        suggestion.value = searchLabel;
        suggestion.label = `${searchLabel} · ${camera.id}`;
        (suggestions || controls._cctvSearchOptions).appendChild(suggestion);
      }
    }
    if (index < cameras.length) {
      controls._cctvListTimer = setTimeout(append, 0);
    } else {
      if (options) controls._cctvSelect.appendChild(options);
      if (suggestions) controls._cctvSearchOptions?.appendChild(suggestions);
      if (controls._cctvListPending) {
        controls._cctvListPending = false;
        controls._cctvListTimer = null;
        controls._renderCctvState(controls._cctvState);
      }
    }
  };
  append();
}
