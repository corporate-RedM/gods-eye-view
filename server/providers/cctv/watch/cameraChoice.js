/**
 * Which live cameras should look at a place: a reported incident, a venue, or
 * an area BK asked to watch.
 *
 * Distance comes first. A camera whose recorded heading points at the place
 * ranks above one facing away, but only as far as that heading is trusted
 * (many catalog headings are estimates). A camera an agency itself linked to
 * the report ranks first of all. The profile's scene decides between views
 * built for people (streets, plazas) and views built for traffic.
 */

const EARTH_RADIUS_KM = 6371;
const HEADING_TRUST = Object.freeze({ high: 1, medium: 0.6, low: 0.25 });

export function distanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(from, to) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const y = Math.sin(toRad(to.lon - from.lon)) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) *
      Math.cos(toRad(to.lat)) *
      Math.cos(toRad(to.lon - from.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 1 when the place sits inside the camera's field of view, falling to 0 behind it. */
export function facingScore(camera, place) {
  const heading = Number(camera.headingDeg);
  if (!Number.isFinite(heading)) return 0.5;
  const fov = Number.isFinite(Number(camera.fovDeg))
    ? Number(camera.fovDeg)
    : 60;
  const offset = Math.abs(
    ((bearingDeg(camera, place) - heading + 540) % 360) - 180,
  );
  const inside =
    offset <= fov / 2 + 10 ? 1 : Math.max(0, 1 - (offset - fov / 2 - 10) / 90);
  const trust = HEADING_TRUST[camera.headingConfidence] ?? HEADING_TRUST.low;
  // An untrusted heading pulls the score back toward neutral.
  return 0.5 + (inside - 0.5) * trust;
}

/**
 * Rank cameras for a place.
 * @param {object} place - {lat, lon}
 * @param {object[]} cameras - Live catalog sources ({id, lat, lon, url, headingDeg, fovDeg, headingConfidence}).
 * @param {object} [options]
 * @param {number} [options.radiusKm=3]
 * @param {number} [options.limit=3]
 * @param {string[]} [options.linkedUrls] - Stream URLs an agency linked to the report.
 * @param {'people'|'traffic'|null} [options.prefer] - Which kind of view matters here.
 * @param {(cameraId: string) => object|null} [options.profileOf]
 * @returns {{cameraId:string, distanceKm:number, score:number, linked:boolean}[]}
 */
export function chooseCameras(
  place,
  cameras,
  {
    radiusKm = 3,
    limit = 3,
    linkedUrls = [],
    prefer = null,
    profileOf = () => null,
  } = {},
) {
  const linked = new Set(linkedUrls);
  const ranked = [];
  for (const camera of cameras) {
    const isLinked = Boolean(camera.url && linked.has(camera.url));
    if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lon)) {
      if (isLinked)
        ranked.push({
          cameraId: camera.id,
          distanceKm: null,
          score: 10,
          linked: true,
        });
      continue;
    }
    if (!Number.isFinite(camera.lat) || !Number.isFinite(camera.lon)) continue;
    const km = distanceKm(place, camera);
    if (km > radiusKm && !isLinked) continue;
    const closeness = 1 - Math.min(km, radiusKm) / radiusKm;
    let score = closeness + 0.6 * facingScore(camera, place);
    const profile = profileOf(camera.id);
    if (profile && prefer === 'people')
      score +=
        0.5 *
        Math.max(profile.peopleUsable ?? 0, profile.pedestrianAreaVisible ?? 0);
    if (profile && prefer === 'traffic')
      score += 0.3 * (profile.roadVisible ?? 0);
    if (isLinked) score += 10;
    ranked.push({
      cameraId: camera.id,
      distanceKm: Number(km.toFixed(3)),
      score,
      linked: isLinked,
    });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}
