/**
 * Where on Earth a point is, in plain English: the continent (or ocean), the
 * country, the state or province, and the city — so the globe can always say
 * where the camera is looking.
 *
 * Data: the bundled Natural Earth packs (public domain) —
 * `local_data/natural_earth/countries.json` (with each country's continent),
 * `states_provinces.json`, `marine.json` (oceans and seas) and
 * `populated_places.json` (English city names), all built by
 * `scripts/build-admin-packs.mjs` or the regions curation (provenance in the
 * folder's README). Everything answers offline: no geocoder, no key, no rate
 * limit, so the readout can follow the camera while it moves.
 *
 * PURE data module — no Cesium, node-testable. Packs load once on the first
 * `ready()` (never at module import) through `loadBundledJson`; a failed load
 * is retried later rather than cached (`createRetryableLoader`). Lookups after
 * that are synchronous and well under a millisecond: every polygon part keeps
 * a bounding box, states are decoded per country on first use, and cities sit
 * in a coarse grid.
 *
 * @module data/placeLocator
 */

import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';

const PACKS = {
  countries: {
    url: new URL('./local_data/natural_earth/countries.json', import.meta.url),
    importJson: () =>
      import('./local_data/natural_earth/countries.json', {
        with: { type: 'json' },
      }),
  },
  states: {
    url: new URL(
      './local_data/natural_earth/states_provinces.json',
      import.meta.url,
    ),
    importJson: () =>
      import('./local_data/natural_earth/states_provinces.json', {
        with: { type: 'json' },
      }),
  },
  marine: {
    url: new URL('./local_data/natural_earth/marine.json', import.meta.url),
    importJson: () =>
      import('./local_data/natural_earth/marine.json', {
        with: { type: 'json' },
      }),
  },
  places: {
    url: new URL(
      './local_data/natural_earth/populated_places.json',
      import.meta.url,
    ),
    importJson: () =>
      import('./local_data/natural_earth/populated_places.json', {
        with: { type: 'json' },
      }),
  },
};

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Longitude folded into [-180, 180). */
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Short English names for the few countries Natural Earth names formally.
 * Everything else already reads the way a child would say it.
 */
const COUNTRY_DISPLAY_NAMES = Object.freeze({
  'United States of America': 'United States',
  'United Republic of Tanzania': 'Tanzania',
  'Republic of Serbia': 'Serbia',
  eSwatini: 'Eswatini',
  'Federated States of Micronesia': 'Micronesia',
  Vatican: 'Vatican City',
  'Hong Kong S.A.R.': 'Hong Kong',
  'Macao S.A.R': 'Macau',
});

/**
 * Countries with no continent in Natural Earth (CONTINENT "Seven seas"):
 * remote islands, named by the ocean they sit in instead.
 */
const ISLAND_OCEANS = Object.freeze({
  MDV: 'Indian Ocean',
  MUS: 'Indian Ocean',
  SYC: 'Indian Ocean',
  IOT: 'Indian Ocean',
  HMD: 'Indian Ocean',
  ATF: 'Indian Ocean',
  SHN: 'Atlantic Ocean',
  SGS: 'Atlantic Ocean',
  CLP: 'Pacific Ocean',
});

/**
 * Natural Earth gives a whole country one continent. These three cross into
 * another one, and a camera over Siberia, Istanbul's European shore or Sinai
 * should say so.
 */
function continentAt(country, lat, lon) {
  const continent = country?.continent || null;
  if (country?.iso === 'RUS')
    return lon >= 60 || lon < -168 ? 'Asia' : continent;
  // East Thrace: Turkey's European side, west of the Bosporus.
  if (country?.iso === 'TUR')
    return lon < 29.05 && lat > 40.6 ? 'Europe' : continent;
  // Sinai: Egypt's Asian side, east of the Suez Canal.
  if (country?.iso === 'EGY' && lon > 32.4 && lat < 31.4 && lat > 27.6)
    return 'Asia';
  return continent;
}

/**
 * Natural Earth's admin-1 `type_en`, tidied into one plain English word or
 * phrase ("Lansdele" is Danish, "Oblast'" Russian; some carry a second form
 * after "|").
 */
const REGION_TYPE_FIXES = Object.freeze({
  Lansdele: 'Region',
  Préfecture: 'Prefecture',
  Departamento: 'Department',
  "Oblast'": 'Region',
  'Captial District': 'Capital District',
  Commissiary: 'Commissary',
  'Automonous Region': 'Autonomous Region',
  Governarate: 'Governorate',
  'Autonomous region': 'Autonomous Region',
  'Metropolitan department': 'Department',
  'Overseas department': 'Department',
});

/**
 * States whose English name differs from Natural Earth's only by accents, so
 * the pack carries no separate English form.
 */
const REGION_DISPLAY_NAMES = Object.freeze({
  Québec: 'Quebec',
  Zürich: 'Zurich',
});

/** @param {string|null} type @returns {string} */
export function regionTypeLabel(type) {
  const first = String(type || '')
    .split('|')[0]
    .replace(/\s*\((?:wales|city|royal)\)\s*$/i, '')
    .trim();
  if (!first || first === 'null') return 'Region';
  return REGION_TYPE_FIXES[first] || first;
}

// ── geometry ────────────────────────────────────────────────────────────

/**
 * Decode one delta-encoded ring (integers in 10^-decimals degrees, first
 * vertex absolute) into a flat [lon, lat, lon, lat, …] array.
 */
function decodeFlatRing(encoded, decimals) {
  const factor = 10 ** decimals;
  const out = new Float64Array(encoded.length - (encoded.length % 2));
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    out[i] = x / factor;
    out[i + 1] = y / factor;
  }
  return out;
}

/** A plain [[lon, lat], …] ring as a flat array. */
function flattenRing(ring) {
  const out = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    out[i * 2] = ring[i][0];
    out[i * 2 + 1] = ring[i][1];
  }
  return out;
}

function flatBox(flat) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i];
    const y = flat[i + 1];
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  }
  return [west, south, east, north];
}

/** Even-odd test against a flat ring. */
function flatRingContains(flat, lat, lon) {
  let inside = false;
  const n = flat.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = flat[i];
    const yi = flat[i + 1];
    const xj = flat[j];
    const yj = flat[j + 1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Spherical-excess area of a flat ring, km² (ranks overlapping seas). */
function flatRingAreaKm2(flat) {
  const n = flat.length / 2;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const lon1 = flat[i * 2];
    const lat1 = flat[i * 2 + 1];
    const k = ((i + 1) % n) * 2;
    sum +=
      toRad(flat[k] - lon1) *
      (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(flat[k + 1])));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/**
 * Packed polygons ([outer, ...holes][], delta-encoded) as parts with boxes.
 * @returns {Array<{outer: Float64Array, holes: Float64Array[], box: number[]}>}
 */
function decodeParts(polygons, decimals) {
  return (polygons || []).map(([outer, ...holes]) => {
    const flat = decodeFlatRing(outer, decimals);
    return {
      outer: flat,
      holes: holes.map((hole) => decodeFlatRing(hole, decimals)),
      box: flatBox(flat),
    };
  });
}

function partsContain(parts, lat, lon) {
  for (const part of parts) {
    const [west, south, east, north] = part.box;
    if (lat < south || lat > north || lon < west || lon > east) continue;
    if (!flatRingContains(part.outer, lat, lon)) continue;
    if (!part.holes.some((hole) => flatRingContains(hole, lat, lon)))
      return true;
  }
  return false;
}

function unionBox(parts) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const { box } of parts) {
    if (box[0] < west) west = box[0];
    if (box[1] < south) south = box[1];
    if (box[2] > east) east = box[2];
    if (box[3] > north) north = box[3];
  }
  return [west, south, east, north];
}

const inBox = (box, lat, lon) =>
  lat >= box[1] && lat <= box[3] && lon >= box[0] && lon <= box[2];

// ── cities ──────────────────────────────────────────────────────────────

/** Grid cell size for the city index, degrees. */
const CITY_CELL_DEG = 2;

/** Cities further than this are not worth naming as "nearest". */
export const NEAREST_CITY_MAX_KM = 300;

/**
 * How far a city's name reaches from its centre, growing with population:
 * a camera on Austin's outskirts is in Austin, one 60 km out is near it.
 * Same curve as the CCTV camera labels (server/providers/cctv/places.js).
 * @param {number} population
 * @returns {number} km
 */
export function cityReachKm(population) {
  return Math.max(3, Math.min(40, 3 * Math.cbrt(population / 10000)));
}

function cellKey(lat, lon) {
  return `${Math.floor(lat / CITY_CELL_DEG)}:${Math.floor(wrapLon(lon) / CITY_CELL_DEG)}`;
}

function buildCityIndex(pack) {
  const fields = pack?.meta?.fields || [];
  const at = (name) => fields.indexOf(name);
  const columns = {
    name: at('name'),
    lat: at('lat'),
    lon: at('lon'),
    population: at('population'),
    iso2: at('iso2'),
    kind: at('kind'),
  };
  const cells = new Map();
  for (const row of pack?.places || []) {
    const city = {
      name: row[columns.name],
      lat: row[columns.lat],
      lon: row[columns.lon],
      population: Number(row[columns.population]) || 0,
      iso2: row[columns.iso2] || null,
      kind: Number(row[columns.kind]) || 0,
    };
    if (!city.name || !Number.isFinite(city.lat) || !Number.isFinite(city.lon))
      continue;
    city.reachKm = cityReachKm(city.population);
    const key = cellKey(city.lat, city.lon);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(city);
  }
  return cells;
}

/** Every indexed city within `radiusKm` cells of the point (coarse). */
function nearbyCities(cells, lat, lon, radiusKm) {
  const latSpan = Math.ceil(radiusKm / 111 / CITY_CELL_DEG) + 1;
  const cosLat = Math.max(0.05, Math.cos(toRad(lat)));
  const lonSpan = Math.min(
    Math.ceil(180 / CITY_CELL_DEG),
    Math.ceil(radiusKm / (111 * cosLat) / CITY_CELL_DEG) + 1,
  );
  const row0 = Math.floor(lat / CITY_CELL_DEG);
  const col0 = Math.floor(wrapLon(lon) / CITY_CELL_DEG);
  const cols = 360 / CITY_CELL_DEG;
  const out = [];
  const seen = new Set();
  for (let r = row0 - latSpan; r <= row0 + latSpan; r++) {
    for (let c = col0 - lonSpan; c <= col0 + lonSpan; c++) {
      const col = ((((c + cols / 2) % cols) + cols) % cols) - cols / 2;
      const key = `${r}:${col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = cells.get(key);
      if (list) out.push(...list);
    }
  }
  return out;
}

/**
 * The city a point is in, or the nearest one.
 *
 * Inside the reach of several places, the one the point is relatively
 * closest to wins (distance as a share of reach), so a big city claims more
 * ground than a small one, yet Yokohama still reads as Yokohama rather than
 * Tokyo. Outside every reach the nearest place (by distance past its reach)
 * is named as "near". Places in the point's own country are preferred, so a
 * border town is not named after the bigger city across the border.
 *
 * @returns {{name: string, distanceKm: number, within: boolean, population: number, capital: boolean}|null}
 */
function findCity(cells, lat, lon, iso2) {
  const candidates = nearbyCities(cells, lat, lon, NEAREST_CITY_MAX_KM);
  const scored = [];
  for (const city of candidates) {
    const distanceKm = haversineKm(lat, lon, city.lat, city.lon);
    if (distanceKm > NEAREST_CITY_MAX_KM) continue;
    scored.push({ city, distanceKm });
  }
  if (!scored.length) return null;
  const sameCountry = iso2
    ? scored.filter(({ city }) => city.iso2 === iso2)
    : [];
  const pool = sameCountry.length ? sameCountry : scored;
  let best = null;
  for (const item of pool) {
    if (item.distanceKm > item.city.reachKm) continue;
    if (
      !best ||
      item.distanceKm / item.city.reachKm < best.distanceKm / best.city.reachKm
    )
      best = item;
  }
  const within = Boolean(best);
  if (!best) {
    for (const item of pool) {
      const past = item.distanceKm - item.city.reachKm;
      if (!best || past < best.distanceKm - best.city.reachKm) best = item;
    }
  }
  return {
    name: best.city.name,
    distanceKm: best.distanceKm,
    within,
    population: best.city.population,
    capital: best.city.kind === 2,
  };
}

// ── packs ───────────────────────────────────────────────────────────────

function indexCountries(pack) {
  const decimals = pack?.meta?.decimals ?? 3;
  return (pack?.features || []).map((feature) => {
    const parts = decodeParts(feature.polygons, feature.d ?? decimals);
    return {
      name: COUNTRY_DISPLAY_NAMES[feature.name] || feature.name,
      sourceName: feature.name,
      country: feature.country,
      iso: feature.iso,
      iso2: feature.iso2 && feature.iso2 !== '-99' ? feature.iso2 : null,
      type: feature.type,
      continent: feature.continent || null,
      parts,
      box: unionBox(parts),
    };
  });
}

function indexStates(pack) {
  const decimals = pack?.meta?.decimals ?? 3;
  const byCountry = new Map();
  for (const feature of pack?.features || []) {
    const name = feature.nameEn || feature.name;
    const entry = {
      name: REGION_DISPLAY_NAMES[name] || name,
      type: regionTypeLabel(feature.type),
      iso2: feature.iso2 || null,
      label: feature.label || null,
      feature,
      decimals: feature.d ?? decimals,
      parts: null,
      box: null,
    };
    const key = feature.country;
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key).push(entry);
  }
  return byCountry;
}

function stateGeometry(entry) {
  if (!entry.parts) {
    entry.parts = decodeParts(entry.feature.polygons, entry.decimals);
    entry.box = unionBox(entry.parts);
    entry.feature = null;
  }
  return entry;
}

function indexMarine(pack) {
  return (pack?.features || []).map((feature) => {
    const parts = (feature.polygons || []).map((ring) => {
      const flat = flattenRing(ring);
      return { outer: flat, holes: [], box: flatBox(flat) };
    });
    return {
      name: feature.name,
      kind: String(feature.featurecla || ''),
      parts,
      box: unionBox(parts),
      areaKm2: parts.reduce(
        (sum, part) => sum + flatRingAreaKm2(part.outer),
        0,
      ),
    };
  });
}

/**
 * @typedef {object} PlaceFix
 * @property {number} lat
 * @property {number} lon
 * @property {?string} continent - "North America", or null over open water.
 * @property {?string} ocean - The ocean under the point (water, or the ocean an
 *   island nation sits in), else null.
 * @property {?string} water - The most specific named sea, gulf, bay or strait
 *   under the point, else null.
 * @property {?{name: string, iso2: ?string, iso3: string}} country
 * @property {?{name: string, type: string}} part - A constituent country of the
 *   United Kingdom (England, Scotland, Wales, Northern Ireland), else null.
 * @property {?{name: string, type: string}} region - State, province, county…
 * @property {?{name: string, distanceKm: number, within: boolean, population: number, capital: boolean}} city
 */

/**
 * Create a locator over the bundled packs.
 * @param {object} [options]
 * @param {(name: keyof PACKS) => Promise<object>} [options.loadPack] - Test seam.
 */
export function createPlaceLocator({
  loadPack = (name) => loadBundledJson(PACKS[name].url, PACKS[name].importJson),
} = {}) {
  let countries = null;
  let states = null;
  let marine = null;
  let cities = null;

  const loadAll = createRetryableLoader(async () => {
    const [countryPack, statePack, marinePack, placePack] = await Promise.all([
      loadPack('countries'),
      loadPack('states'),
      loadPack('marine'),
      loadPack('places'),
    ]);
    countries = indexCountries(countryPack);
    states = indexStates(statePack);
    marine = indexMarine(marinePack);
    cities = buildCityIndex(placePack);
    return true;
  });

  function findCountry(lat, lon) {
    let country = null;
    let part = null;
    for (const entry of countries) {
      if (!inBox(entry.box, lat, lon)) continue;
      if (!partsContain(entry.parts, lat, lon)) continue;
      if (entry.type === 'Constituent country') part ??= entry;
      else country ??= entry;
      if (country && (part || country.iso2 !== 'GB')) break;
    }
    return { country, part };
  }

  function findRegion(country, lat, lon) {
    const list = states.get(country.sourceName) || states.get(country.country);
    if (!list?.length) return null;
    let nearest = null;
    let nearestKm = Infinity;
    for (const entry of list) {
      stateGeometry(entry);
      if (inBox(entry.box, lat, lon) && partsContain(entry.parts, lat, lon))
        return entry;
      // Simplified coastlines leave slivers of the country outside every
      // state: fall back to the closest state label within reach.
      if (entry.label) {
        const km = haversineKm(lat, lon, entry.label[1], entry.label[0]);
        if (km < nearestKm) {
          nearestKm = km;
          nearest = entry;
        }
      }
    }
    return nearestKm <= 150 ? nearest : null;
  }

  function findWater(lat, lon) {
    let ocean = null;
    let water = null;
    for (const entry of marine) {
      if (!inBox(entry.box, lat, lon)) continue;
      if (!partsContain(entry.parts, lat, lon)) continue;
      if (entry.kind === 'ocean') {
        if (!ocean || entry.areaKm2 < ocean.areaKm2) ocean = entry;
      } else if (!water || entry.areaKm2 < water.areaKm2) {
        water = entry;
      }
    }
    return { ocean: ocean?.name || null, water: water?.name || null };
  }

  return {
    /** Load every pack once; resolves when lookups are ready. */
    ready: () => loadAll(),
    /** Whether `locate` can answer yet. */
    isReady: () => Boolean(countries && states && marine && cities),
    /**
     * Describe a point. Returns null until `ready()` has resolved.
     * @param {number} lat
     * @param {number} lon
     * @returns {?PlaceFix}
     */
    locate(lat, lon) {
      if (!countries || !Number.isFinite(lat) || !Number.isFinite(lon))
        return null;
      const y = Math.max(-90, Math.min(90, lat));
      const x = wrapLon(lon);
      const { country, part } = findCountry(y, x);
      const water = country ? { ocean: null, water: null } : findWater(y, x);
      const region = country ? findRegion(country, y, x) : null;
      const city = findCity(cities, y, x, country?.iso2 || null);
      return {
        lat: y,
        lon: x,
        continent: country ? continentAt(country, y, x) : null,
        ocean: country ? ISLAND_OCEANS[country.iso] || null : water.ocean,
        water: water.water,
        country: country
          ? { name: country.name, iso2: country.iso2, iso3: country.iso }
          : null,
        part: part ? { name: part.name, type: 'Nation' } : null,
        region: region ? { name: region.name, type: region.type } : null,
        city,
      };
    },
  };
}

/** The application's shared locator; packs load on its first `ready()`. */
export const placeLocator = createPlaceLocator();
