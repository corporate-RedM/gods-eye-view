import fs from 'node:fs';
import path from 'node:path';

/**
 * Nearest-city labels for camera packs whose upstream "city" is not a city:
 * Ontario 511 and Tarktee repeat the intersection, TxDOT names the highway,
 * Fintraffic says "Finland", and DriveBC, NSW and DelDOT name a region or
 * county. Places come from GeoNames cities1000 (CC BY 4.0), prebuilt by
 * scripts/build-cctv-places.mjs, so cameras are searchable by city.
 */
const DEFAULT_PLACES_FILE = 'src/data/local_data/cctv_places/places.json';

/** Beyond this no place is close enough to name the camera after. */
const MAX_DISTANCE_KM = 75;

/**
 * 'replace': the upstream label becomes the city ("London").
 * 'prefix': the upstream region is kept beside the city
 * ("Vancouver (Lower Mainland)").
 */
const CITY_LABEL_MODE = {
  ontario: 'replace',
  txdot: 'replace',
  fintraffic: 'replace',
  tarktee: 'replace',
  drivebc: 'prefix',
  nsw: 'prefix',
  deldot: 'prefix',
};

let _cache = null;

function loadPlaces(sourceRoot) {
  const resolved = path.resolve(sourceRoot, DEFAULT_PLACES_FILE);
  if (_cache?.path === resolved) return _cache.places;
  let places = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (Array.isArray(parsed?.places)) places = parsed.places;
  } catch (err) {
    console.warn('[CCTV] place labels unavailable:', err?.message || err);
  }
  _cache = { path: resolved, places };
  return places;
}

/**
 * How far a place's name reaches, growing with population, so a camera on a
 * city's outskirts is named for the city rather than a hamlet beside it.
 * @param {number} population
 * @returns {number} Kilometres.
 */
function placeReachKm(population) {
  return Math.max(3, Math.min(40, 3 * Math.cbrt(population / 10000)));
}

/**
 * The largest place whose reach covers the camera, so a city's own districts
 * (GeoNames lists many as separate places: Länsi-Pakila, Pymble) read as the
 * city; otherwise the place whose reach the camera is closest to.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[string, number, number, number]>} places [name, lat, lon, population]
 * @returns {string} Place name, or '' when none is within MAX_DISTANCE_KM.
 */
export function nearestPlaceName(lat, lon, places) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let covering = '';
  let coveringPopulation = -1;
  let closest = '';
  let closestScore = Infinity;
  for (const [name, placeLat, placeLon, population] of places) {
    const dLat = placeLat - lat;
    if (Math.abs(dLat) > 1) continue;
    const dLon = (placeLon - lon) * cosLat;
    const km = 111.2 * Math.hypot(dLat, dLon);
    if (km > MAX_DISTANCE_KM) continue;
    const score = km / placeReachKm(population);
    if (score <= 1 && population > coveringPopulation) {
      coveringPopulation = population;
      covering = name;
    }
    if (score < closestScore) {
      closestScore = score;
      closest = name;
    }
  }
  return covering || closest;
}

/**
 * Relabel one pack's cameras with their nearest city.
 * @param {string} packName Pack name from catalog.js LIVE_PACKS.
 * @param {Array<object>} sources Normalized sources.
 * @param {string} sourceRoot Repository root.
 * @returns {Array<object>} Sources with `city` set to a searchable city label.
 */
export function labelPackCities(packName, sources, sourceRoot) {
  const mode = CITY_LABEL_MODE[packName];
  if (!mode || !sources.length) return sources;
  const places = loadPlaces(sourceRoot);
  if (!places.length) return sources;
  return sources.map((source) => {
    const place = nearestPlaceName(source.lat, source.lon, places);
    if (!place) return source;
    const region = String(source.city || '').trim();
    const city =
      mode === 'prefix' && region && region !== place
        ? `${place} (${region})`
        : place;
    return { ...source, city };
  });
}
