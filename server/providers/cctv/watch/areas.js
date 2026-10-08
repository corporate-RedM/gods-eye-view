/**
 * Coverage areas for CCTV Watch. Every live-video camera belongs to one
 * region (the state its road agency serves), one city (the metro area of a
 * city of at least 100,000 people within 30 km, otherwise its own
 * municipality) and one municipality (the catalog's place label). BK picks
 * one area when starting Watch, and Watch reads only that area's cameras.
 *
 * Large cities within 30 km of each other form one metro named after the
 * largest (Saint Paul joins Minneapolis, Henderson joins Las Vegas), so a
 * camera between two of them is never split off into a sliver of an area.
 */
import fs from 'node:fs';
import path from 'node:path';

const AREA_CITIES_FILE = 'src/data/local_data/cctv_places/area_cities.json';

/** Road agencies by the state they serve. */
const REGIONS = [
  [/minnesota|mndot/i, 'Minnesota'],
  [/iowa/i, 'Iowa'],
  [/caltrans|california/i, 'California'],
  [/nvroads|ndot|nevada/i, 'Nevada'],
  [/wisconsin|wisdot/i, 'Wisconsin'],
  [/deldot|delaware/i, 'Delaware'],
  [/louisiana|dotd/i, 'Louisiana'],
];
/** A city large enough to give its name to the area around it. */
const CITY_MIN_POPULATION = 100_000;
/** How far a city's area reaches. */
const CITY_RADIUS_KM = 30;

const AREA_KINDS = ['region', 'city', 'municipality'];

export function slugOf(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The state a camera's agency serves, or the agency itself when unknown. */
export function regionOf(source) {
  const agency = String(source?.provider || source?.cityId || '');
  const match = REGIONS.find(([pattern]) => pattern.test(agency));
  return match ? match[1] : agency || 'Other';
}

/** The catalog's place label, without a county kept beside it. */
export function municipalityOf(source) {
  const label = String(source?.city || '').trim();
  return label.replace(/\s*\([^)]*\)\s*$/, '') || 'Unnamed place';
}

let cachedCities = null;

/** Cities of at least 100,000 people (scripts/build-cctv-places.mjs --areas-only). */
export function loadAreaCities(sourceRoot) {
  const file = path.resolve(sourceRoot, AREA_CITIES_FILE);
  if (cachedCities?.file === file) return cachedCities.cities;
  let cities = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.places)) cities = parsed.places;
  } catch {
    /* no metro grouping: every city is its own municipality */
  }
  cachedCities = { file, cities };
  return cities;
}

function kmBetween(lat, lon, otherLat, otherLon) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return 111.2 * Math.hypot(otherLat - lat, (otherLon - lon) * cosLat);
}

/**
 * Join large cities within 30 km of each other into metros, largest first.
 * @param {Array<[string, number, number, number]>} places [name, lat, lon, population]
 * @returns {Array<{name: string, lat: number, lon: number, metro: string, metroPopulation: number}>}
 */
export function metroCities(places) {
  const cities = places
    .filter((place) => place[3] >= CITY_MIN_POPULATION)
    .sort((a, b) => b[3] - a[3]);
  const joined = [];
  for (const [name, lat, lon, population] of cities) {
    const near = joined.find(
      (other) => kmBetween(lat, lon, other.lat, other.lon) <= CITY_RADIUS_KM,
    );
    joined.push({
      name,
      lat,
      lon,
      metro: near ? near.metro : name,
      metroPopulation: near ? near.metroPopulation : population,
    });
  }
  return joined;
}

/**
 * The metro of the largest metro city within 30 km of a camera.
 * @returns {string|null} The metro's name.
 */
export function metroNear(lat, lon, metros) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  for (const city of metros) {
    if (Math.abs(city.lat - lat) > 0.5) continue;
    if (kmBetween(lat, lon, city.lat, city.lon) > CITY_RADIUS_KM) continue;
    if (!best || city.metroPopulation > best.metroPopulation) best = city;
  }
  return best ? best.metro : null;
}

/**
 * Group cameras into regions, cities and municipalities.
 * @param {object[]} sources - Live-video camera sources.
 * @param {Array<[string, number, number, number]>} places - GeoNames places.
 * @returns {{regions: object[], members: (areaId: string) => Set<string>|null, areaOf: (cameraId: string) => object|null}}
 */
export function buildAreas(sources, places) {
  const metros = metroCities(places);
  const membersById = new Map();
  const labels = new Map();
  const byCamera = new Map();
  const add = (id, label, cameraId) => {
    if (!membersById.has(id)) membersById.set(id, new Set());
    membersById.get(id).add(cameraId);
    labels.set(id, label);
  };
  const tree = new Map();
  for (const source of sources) {
    if (!source?.id) continue;
    const region = regionOf(source);
    const municipality = municipalityOf(source);
    const metro = metroNear(source.lat, source.lon, metros);
    const city = metro ? `${metro} area` : municipality;
    const regionId = `region:${slugOf(region)}`;
    const cityId = `city:${slugOf(region)}/${slugOf(city)}`;
    const municipalityId = `municipality:${slugOf(region)}/${slugOf(city)}/${slugOf(municipality)}`;
    add(regionId, region, source.id);
    add(cityId, city, source.id);
    add(municipalityId, municipality, source.id);
    byCamera.set(source.id, {
      region: { id: regionId, label: region },
      city: { id: cityId, label: city },
      municipality: { id: municipalityId, label: municipality },
    });
    if (!tree.has(regionId)) tree.set(regionId, new Map());
    const regionCities = tree.get(regionId);
    if (!regionCities.has(cityId)) regionCities.set(cityId, new Set());
    regionCities.get(cityId).add(municipalityId);
  }
  const node = (id, children) => ({
    id,
    label: labels.get(id),
    cameras: membersById.get(id).size,
    ...(children ? { [children.key]: children.list } : {}),
  });
  const bySize = (a, b) =>
    b.cameras - a.cameras || a.label.localeCompare(b.label);
  const regions = [...tree].map(([regionId, regionCities]) =>
    node(regionId, {
      key: 'cities',
      list: [...regionCities]
        .map(([cityId, municipalities]) =>
          node(cityId, {
            key: 'municipalities',
            list: [...municipalities].map((id) => node(id)).sort(bySize),
          }),
        )
        .sort(bySize),
    }),
  );
  regions.sort(bySize);
  return {
    regions,
    members: (areaId) => membersById.get(areaId) ?? null,
    label: (areaId) => labels.get(areaId) ?? null,
    areaOf: (cameraId) => byCamera.get(cameraId) ?? null,
  };
}

/** Whether a string is shaped like an area id this module makes. */
export function isAreaId(value) {
  if (typeof value !== 'string' || value.length > 200) return false;
  const [kind, rest] = value.split(/:(.*)/s);
  return (
    AREA_KINDS.includes(kind) &&
    /^[a-z0-9-]+(\/[a-z0-9-]+){0,2}$/.test(rest || '')
  );
}
