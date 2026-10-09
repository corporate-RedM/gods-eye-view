import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITY_MAX_ALTITUDE_M,
  REGION_MAX_ALTITUDE_M,
  cameraPlaceLine,
  formatKm,
  whereAmILevels,
} from './whereAmIModel.js';

const AUSTIN = {
  continent: 'North America',
  ocean: null,
  water: null,
  country: { name: 'United States', iso2: 'US', iso3: 'USA' },
  part: null,
  region: { name: 'Texas', type: 'State' },
  city: { name: 'Austin', distanceKm: 2, within: true, population: 1 },
};

const text = (levels) =>
  levels.map(({ caption, value }) => `${caption}: ${value}`);

test('a city view reads continent, country, state, city', () => {
  assert.deepEqual(text(whereAmILevels(AUSTIN, { altitudeM: 5000 })), [
    'Continent: North America',
    'Country: United States',
    'State: Texas',
    'City: Austin',
  ]);
});

test('levels drop away as the camera climbs', () => {
  assert.deepEqual(
    text(whereAmILevels(AUSTIN, { altitudeM: CITY_MAX_ALTITUDE_M + 1 })),
    ['Continent: North America', 'Country: United States', 'State: Texas'],
  );
  assert.deepEqual(
    text(whereAmILevels(AUSTIN, { altitudeM: REGION_MAX_ALTITUDE_M + 1 })),
    ['Continent: North America', 'Country: United States'],
  );
});

test('outside a city the nearest one is named with its distance', () => {
  const fix = {
    ...AUSTIN,
    city: { name: 'Austin', distanceKm: 22.4, within: false },
  };
  assert.equal(
    text(whereAmILevels(fix, { altitudeM: 1000 })).at(-1),
    'Near: Austin · 22 km',
  );
});

test('open water names the ocean and the nearest city', () => {
  const fix = {
    continent: null,
    ocean: 'North Pacific Ocean',
    water: null,
    country: null,
    part: null,
    region: null,
    city: { name: 'Hilo', distanceKm: 1240.4, within: false },
  };
  assert.deepEqual(text(whereAmILevels(fix, { altitudeM: 1000 })), [
    'Ocean: North Pacific Ocean',
    'Nearest city: Hilo · 1,240 km',
  ]);
  assert.deepEqual(
    text(whereAmILevels({ ...fix, ocean: null, city: null }, {})),
    ['Over: Open water'],
  );
});

test('a sea names itself when there is no country', () => {
  const fix = {
    continent: null,
    ocean: null,
    water: 'Gulf of Mexico',
    country: null,
    part: null,
    region: null,
    city: null,
  };
  assert.deepEqual(text(whereAmILevels(fix)), ['Water: Gulf of Mexico']);
});

test('repeated names are said once', () => {
  const moscow = {
    continent: 'Europe',
    country: { name: 'Russia' },
    part: null,
    region: { name: 'Moscow', type: 'Federal City' },
    city: { name: 'Moscow', distanceKm: 1, within: true },
  };
  assert.deepEqual(text(whereAmILevels(moscow)), [
    'Continent: Europe',
    'Country: Russia',
    'City: Moscow',
  ]);
  const antarctica = {
    continent: 'Antarctica',
    country: { name: 'Antarctica' },
    region: { name: 'Antarctica', type: 'Region' },
    city: null,
  };
  assert.deepEqual(text(whereAmILevels(antarctica)), ['Continent: Antarctica']);
});

test('the United Kingdom shows its nation', () => {
  const london = {
    continent: 'Europe',
    country: { name: 'United Kingdom' },
    part: { name: 'England', type: 'Nation' },
    region: { name: 'Westminster', type: 'London Borough' },
    city: { name: 'London', distanceKm: 1, within: true },
  };
  assert.deepEqual(text(whereAmILevels(london)), [
    'Continent: Europe',
    'Country: United Kingdom',
    'Nation: England',
    'London Borough: Westminster',
    'City: London',
  ]);
});

test('a camera reads as one line from its city to its continent', () => {
  const tallinn = {
    continent: 'Europe',
    country: { name: 'Estonia' },
    region: { name: 'Harju', type: 'County' },
    city: { name: 'Tallinn', distanceKm: 1, within: true },
  };
  assert.equal(
    cameraPlaceLine({ city: 'Tallinn, Estonia' }, tallinn),
    'Tallinn · Harju County · Estonia · Europe',
  );
  assert.equal(
    cameraPlaceLine({ city: 'Austin, Texas, USA' }, AUSTIN),
    'Austin · Texas · United States · North America',
  );
  assert.equal(
    cameraPlaceLine({ city: 'Global' }, AUSTIN),
    'Austin · Texas · United States · North America',
  );
  assert.equal(cameraPlaceLine({ city: 'Lisbon' }, null), 'Lisbon');
});

test('distances read in whole kilometres, never zero', () => {
  assert.equal(formatKm(0.2), '1 km');
  assert.equal(formatKm(12.6), '13 km');
  assert.equal(formatKm(12345), '12,345 km');
});
