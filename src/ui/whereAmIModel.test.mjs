import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITY_MAX_ALTITUDE_M,
  REGION_MAX_ALTITUDE_M,
  cameraAddress,
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

const inUS = (region, city) => ({
  ...AUSTIN,
  region: { name: region, type: 'State' },
  city,
});
const line = (city, fix, names) => cameraAddress({ city }, fix, names).line;

test('a camera address keeps the provider town and adds state and country', () => {
  assert.equal(
    line(
      'Queens',
      inUS('New York', { name: 'New York City', distanceKm: 12, within: true }),
    ),
    'Queens, New York, United States',
  );
  assert.equal(
    line(
      'in Indianapolis',
      inUS('Indiana', { name: 'Indianapolis', distanceKm: 3, within: true }),
    ),
    'Indianapolis, Indiana, United States',
  );
});

test('a provider label naming a whole state gives way to the city or the nearest one', () => {
  const names = { isAreaName: (name) => name === 'Florida' };
  assert.equal(
    line(
      'Florida',
      inUS('Florida', { name: 'Miami', distanceKm: 4, within: true }),
      names,
    ),
    'Miami, Florida, United States',
  );
  assert.equal(
    line(
      'Florida',
      inUS('Florida', { name: 'Ocala', distanceKm: 25, within: false }),
      names,
    ),
    'Near Ocala, Florida, United States',
  );
  assert.equal(
    line(
      'Florida',
      inUS('Florida', { name: 'Ocala', distanceKm: 95, within: false }),
      names,
    ),
    'Florida, United States',
  );
});

test('a provider label that is only a country code is not a town', () => {
  const sines = {
    country: { name: 'Portugal', iso2: 'PT' },
    region: { name: 'Setúbal', type: 'District' },
    city: { name: 'Setúbal', distanceKm: 90, within: false },
  };
  assert.equal(line('PT', sines), 'Setúbal, Portugal');
  assert.equal(line('PT', { ...sines, region: null }), 'Portugal');
});

test('a road label reads as the city it passes, naming a same-name province once', () => {
  const fix = {
    country: { name: 'Italy', iso2: 'IT' },
    region: { name: 'Bologna', type: 'Province' },
    city: { name: 'Bologna', distanceKm: 20, within: false },
  };
  assert.equal(line('A1 MILANO-NAPOLI', fix), 'Near Bologna, Italy');
});

test('a camera address in the United Kingdom reads by nation', () => {
  const fix = {
    country: { name: 'United Kingdom', iso2: 'GB' },
    part: { name: 'England', type: 'Nation' },
    region: { name: 'Westminster', type: 'London Borough' },
    city: { name: 'London', distanceKm: 2, within: true },
  };
  assert.equal(
    line('London, England, UK', fix),
    'London, England, United Kingdom',
  );
});

test('a city that is its own region is named once', () => {
  const korea = (region, city) => ({
    country: { name: 'South Korea', iso2: 'KR' },
    region: { name: region, type: 'Metropolitan City' },
    city,
  });
  assert.equal(
    line(
      'Incheon',
      korea('Incheon', { name: 'Incheon', distanceKm: 30, within: false }),
      {
        isAreaName: () => true,
      },
    ),
    'Incheon, South Korea',
  );
  assert.equal(
    line(
      'Ulsan (Nam-gu)',
      korea('Ulsan', { name: 'Ulsan', distanceKm: 3, within: true }),
    ),
    'Ulsan (Nam-gu), South Korea',
  );
  const taichung = {
    country: { name: 'Taiwan', iso2: 'TW' },
    region: { name: 'Taichung City', type: 'Special Municipality' },
    city: { name: 'Taichung', distanceKm: 5, within: true },
  };
  assert.equal(
    line('Taiwan', taichung, { isAreaName: (name) => name === 'Taiwan' }),
    'Taichung, Taiwan',
  );
});

test('names that differ only by accents are said once, and the country always stays', () => {
  const brasov = {
    country: { name: 'Romania', iso2: 'RO' },
    region: { name: 'Brasov', type: 'County' },
    city: { name: 'Brașov', distanceKm: 2, within: true },
  };
  assert.equal(line('Brasov', brasov), 'Brașov, Romania');
  const mexicoCity = {
    country: { name: 'Mexico', iso2: 'MX' },
    region: { name: 'Mexico City', type: 'Federal District' },
    city: { name: 'Mexico City', distanceKm: 3, within: true },
  };
  assert.equal(line('Mexico City', mexicoCity), 'Mexico City, Mexico');
});

test('before the place packs load, the provider label stands alone', () => {
  assert.equal(line('Queens', null), 'Queens');
  assert.equal(line('Global', null), '');
  assert.deepEqual(cameraAddress({ city: 'Queens' }, null), {
    city: 'Queens',
    region: '',
    country: '',
    line: 'Queens',
  });
});
