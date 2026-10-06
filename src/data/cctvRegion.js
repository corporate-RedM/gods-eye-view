/**
 * Region labels for CCTV packs, so a camera's place reads unambiguously:
 * "London" alone could be England or Ontario. Keyed by the pack's cityId
 * (exact or prefix), as set in server/providers/cctv/sources.js.
 */
const REGION_BY_CITY_ID = [
  ['austin', 'Texas, USA'],
  ['ca-d', 'California, USA'],
  ['london', 'England, UK'],
  ['ontario', 'Ontario, Canada'],
  ['finland', 'Finland'],
  ['british-columbia', 'British Columbia, Canada'],
  ['tx-', 'Texas, USA'],
  ['tallinn', 'Estonia'],
  ['estonia', 'Estonia'],
  ['warendorf', 'Germany'],
  ['nsw', 'New South Wales, Australia'],
  ['calgary', 'Alberta, Canada'],
  ['deldot-', 'Delaware, USA'],
];

/** The pack's region for a camera, or '' when the pack is unknown. */
export function cameraRegion(camera) {
  const id = String(camera?.cityId || '').toLowerCase();
  const hit = REGION_BY_CITY_ID.find(
    ([key]) => id === key || id.startsWith(key),
  );
  return hit ? hit[1] : '';
}

/**
 * "City, Region" for display, without repeating a region the city already
 * names (e.g. "Finland" or "New South Wales").
 */
export function cameraPlace(camera) {
  const city = String(camera?.city || '').trim();
  const region = cameraRegion(camera);
  if (!region) return city;
  if (!city) return region;
  const first = region.split(',')[0].trim().toLowerCase();
  return city.toLowerCase() === first ? region : `${city}, ${region}`;
}
