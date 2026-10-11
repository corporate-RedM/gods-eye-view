/** Client-safe workspace models: no DOM, credentials or paid requests. */
export const GRAPHICS = Object.freeze({
  balanced: {
    label: 'Balanced',
    resolution: 1,
    terrainError: 2,
    tileError: 16,
    fps: 60,
  },
  high: {
    label: 'High detail',
    resolution: 1.25,
    terrainError: 1.25,
    tileError: 8,
    fps: 60,
  },
  monitor: {
    label: 'Monitoring',
    resolution: 1,
    terrainError: 3,
    tileError: 24,
    fps: 30,
  },
});
export function applyGraphics(viewer, tileset, id) {
  const preset = GRAPHICS[id] || GRAPHICS.balanced;
  viewer.resolutionScale = preset.resolution;
  viewer.targetFrameRate = preset.fps;
  viewer.scene.globe.maximumScreenSpaceError = preset.terrainError;
  if (tileset) tileset.maximumScreenSpaceError = preset.tileError;
  if (viewer.scene.postProcessStages.fxaa)
    viewer.scene.postProcessStages.fxaa.enabled = true;
  viewer.scene.requestRender();
  return preset;
}
export function inRing(lon, lat, ring) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || ring.length < 3)
    return false;
  // Unwrap the polygon and query around one vertex, including date-line areas.
  const x = (v) => ((v - ring[0][0] + 540) % 360) - 180;
  const px = x(lon);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i],
      [c, d] = ring[j];
    if (
      b > lat !== d > lat &&
      px < ((x(c) - x(a)) * (lat - b)) / (d - b) + x(a)
    )
      inside = !inside;
  }
  return inside;
}
export function areaGeoJSON(area, records = []) {
  const ring = area.ring.map((p) => [...p]);
  if (ring.length && String(ring[0]) !== String(ring.at(-1)))
    ring.push([...ring[0]]);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: area.name, savedAt: area.savedAt },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      ...records
        .filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat))
        .map((r) => ({
          type: 'Feature',
          properties: r,
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        })),
    ],
  };
}
export function recordsCSV(records) {
  const keys = [
    'kind',
    'id',
    'name',
    'provider',
    'lat',
    'lon',
    'published',
    'url',
  ];
  const quote = (v) =>
    '"' +
    String(v ?? '')
      .replace(/^[=+@\-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return [
    keys.join(','),
    ...records.map((r) => keys.map((k) => quote(r[k])).join(',')),
  ].join('\r\n');
}
export function validArea(a) {
  return (
    a &&
    typeof a.name === 'string' &&
    Array.isArray(a.ring) &&
    a.ring.length >= 3 &&
    a.ring.length <= 10000 &&
    a.ring.every(
      (p) =>
        Array.isArray(p) &&
        p.length >= 2 &&
        p.every(Number.isFinite) &&
        Math.abs(p[0]) <= 180 &&
        Math.abs(p[1]) <= 90,
    )
  );
}
