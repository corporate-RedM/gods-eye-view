import * as Cesium from 'cesium';

/** Bound expensive terrain work, never the inventory or searchable cameras. */
export function nearbyCameras(
  items,
  viewer,
  limit = 256,
  cameraOf = (item) => item,
) {
  if (items.length <= limit) return items;
  let carto = viewer?.camera?.positionCartographic;
  const canvas = viewer?.scene?.canvas;
  if (canvas && viewer.camera.pickEllipsoid) {
    const hit = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      Cesium.Ellipsoid.WGS84,
    );
    if (hit) carto = Cesium.Cartographic.fromCartesian(hit);
  }
  const lat = carto ? Cesium.Math.toDegrees(carto.latitude) : 0;
  const lon = carto ? Cesium.Math.toDegrees(carto.longitude) : 0;
  const cos = Math.cos((lat * Math.PI) / 180);
  return items
    .map((item) => {
      const c = cameraOf(item);
      const dx = (((c.lon - lon + 540) % 360) - 180) * cos;
      return { item, distance: dx * dx + (c.lat - lat) ** 2 };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((x) => x.item);
}
