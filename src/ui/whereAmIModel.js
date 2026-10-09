/**
 * The words on the "Where am I" card, from a place fix (data/placeLocator.js):
 * the biggest place first — continent or ocean, country, state, city — each
 * with a plain caption, so anyone can read where the globe is pointed.
 *
 * Levels appear as the view gets close enough for them to mean something: a
 * whole-Earth view names the continent and country at its centre, a regional
 * view adds the state, a city view adds the city.
 *
 * PURE — no DOM, no Cesium.
 *
 * @module ui/whereAmIModel
 */

/** Below this camera height the state or province is named. */
export const REGION_MAX_ALTITUDE_M = 3_000_000;
/** Below this camera height the city is named. */
export const CITY_MAX_ALTITUDE_M = 600_000;

/** "12 km", "1,240 km"; never "0 km". */
export function formatKm(km) {
  const value = Math.max(1, Math.round(Number(km) || 0));
  return `${value.toLocaleString('en-US')} km`;
}

const same = (a, b) =>
  String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * @param {?import('../data/placeLocator.js').PlaceFix} fix
 * @param {{altitudeM?: number}} [view]
 * @returns {Array<{caption: string, value: string}>}
 */
export function whereAmILevels(fix, { altitudeM = 0 } = {}) {
  if (!fix) return [];
  const levels = [];
  const add = (caption, value) => {
    if (value && !levels.some((level) => same(level.value, value)))
      levels.push({ caption, value });
  };
  if (fix.continent) add('Continent', fix.continent);
  else if (fix.ocean) add('Ocean', fix.ocean);
  if (!fix.country && fix.water) add('Water', fix.water);
  if (fix.country) add('Country', fix.country.name);
  if (fix.part) add(fix.part.type, fix.part.name);
  const city = altitudeM <= CITY_MAX_ALTITUDE_M ? fix.city : null;
  if (
    fix.region &&
    altitudeM <= REGION_MAX_ALTITUDE_M &&
    !(city?.within && same(city.name, fix.region.name))
  )
    add(fix.region.type, fix.region.name);
  if (city) {
    if (city.within) add('City', city.name);
    else
      add(
        fix.country ? 'Near' : 'Nearest city',
        `${city.name} · ${formatKm(city.distanceKm)}`,
      );
  }
  if (!levels.length) add('Over', 'Open water');
  return levels;
}

/**
 * The region as it reads inside a sentence: "Harju County", but "Texas" and
 * "Kanagawa Prefecture" as they are.
 */
function regionPhrase(region) {
  if (!region?.name) return '';
  return region.type === 'County' && !/\bcounty\b/i.test(region.name)
    ? `${region.name} County`
    : region.name;
}

/**
 * One line naming where a camera is: "Tallinn · Harju County · Estonia ·
 * Europe".
 * @param {{city?: string}} camera - Public camera state; `city` may carry a
 *   region after a comma ("Tallinn, Estonia"), of which the city is kept.
 * @param {?import('../data/placeLocator.js').PlaceFix} fix - At the camera.
 * @returns {string}
 */
export function cameraPlaceLine(camera, fix) {
  const cityLabel = String(camera?.city || '')
    .split(',')[0]
    .trim();
  const parts = [];
  const add = (value) => {
    if (value && !parts.some((part) => same(part, value))) parts.push(value);
  };
  add(cityLabel && cityLabel !== 'Global' ? cityLabel : fix?.city?.name);
  add(regionPhrase(fix?.region));
  add(fix?.part?.name);
  add(fix?.country?.name);
  add(fix?.continent || fix?.ocean);
  return parts.join(' · ');
}
