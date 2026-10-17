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
/** A camera outside every city reads "Near Ocala" within this distance. */
export const NEAR_CITY_KM = 60;

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

/** A provider "city" that is really a road: "A1 MILANO-NAPOLI", "I-95". */
const ROAD_LABEL =
  /^(?:[A-Z]{1,2}\d{1,3}|(?:I|US|SR|SH|HWY|Route)[- ]?\d{1,4})\b/;
/** A provider "city" that is only a country code: "PT", "USA". */
const CODE_LABEL = /^[A-Z]{2,3}$/;

/** First-level regions that are one city: Incheon, Tokyo, Taipei, Buenos Aires. */
const CITY_REGION_TYPE =
  /\b(?:city|metropolis|municipality|capital district|federal district)\b/i;

/** A name as compared: case, accents, Turkish ı and apostrophes aside. */
const nameKey = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/['’ʼ]/g, '')
    .trim()
    .toLowerCase();
const sameName = (a, b) => nameKey(a) === nameKey(b);
/** "Taichung City" is Taichung; "Ulsan (Nam-gu)" and "Near Bologna" name Ulsan and Bologna. */
const regionCore = (name) =>
  String(name || '')
    .replace(/\s+(?:Metropolitan City|Special Municipality|City|County)$/i, '')
    .trim();
const cityCore = (name) =>
  String(name || '')
    .replace(/^Near\s+/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();

/**
 * Where a camera is, as the camera search shows it: town, state or province,
 * country — "Queens, New York, United States", "Lisbon, Portugal".
 *
 * The provider's own town is kept when it names one ("Queens", "Tossa de
 * Mar"), since the bundled city list only knows larger places. A provider
 * label that names a whole state or country ("Florida", "Taiwan") or a road
 * gives way to the city the camera is in, or "Near <city>" when it is close
 * to one. State and country always come from where the camera sits on the
 * map, so they match the globe. The UK reads by nation ("England").
 *
 * @param {{city?: string}} camera - Public camera state.
 * @param {?import('../data/placeLocator.js').PlaceFix} fix - At the camera,
 *   located with `snapToLand`; null before the place packs load.
 * @param {{isAreaName?: (name: string, iso2?: ?string) => boolean}} [names] -
 *   The locator's country-or-state test.
 * @returns {{city: string, region: string, country: string, line: string}}
 */
export function cameraAddress(camera, fix, { isAreaName = () => false } = {}) {
  const label = String(camera?.city || '')
    .split(',')[0]
    .trim()
    .replace(/^in\s+/i, '');
  const near = fix?.city || null;
  const country = fix?.country?.name || '';
  let region = fix?.part?.name || regionPhrase(fix?.region);
  // "Incheon" for a camera in Incheon Metropolitan City names the city.
  const cityRegion =
    sameName(label, fix?.region?.name) &&
    CITY_REGION_TYPE.test(fix?.region?.type || '');
  const areaLabel =
    !label ||
    label === 'Global' ||
    CODE_LABEL.test(label) ||
    (!cityRegion &&
      ([fix?.region?.name, region, country].some((name) =>
        sameName(name, label),
      ) ||
        (isAreaName(label, fix?.country?.iso2 || null) &&
          !sameName(label, near?.name))));
  let city = '';
  if (!areaLabel && !ROAD_LABEL.test(label)) city = label;
  else if (near?.within) city = near.name;
  else if (near && near.distanceKm <= NEAR_CITY_KM) city = `Near ${near.name}`;
  // Off the mapped coast no state is found; a provider's state label fills in.
  if (
    !region &&
    areaLabel &&
    label &&
    label !== 'Global' &&
    !CODE_LABEL.test(label) &&
    !sameName(label, country)
  )
    region = label;
  const core = cityCore(city);
  if (
    sameName(region, country) ||
    sameName(region, core) ||
    sameName(regionCore(region), core)
  )
    region = '';
  if (sameName(city, country)) city = '';
  const line = [city, region, country].filter(Boolean).join(', ');
  return {
    city,
    region,
    country,
    line: line || (label !== 'Global' ? label : ''),
  };
}
