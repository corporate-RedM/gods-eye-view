import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cityReachKm,
  createPlaceLocator,
  regionTypeLabel,
} from './placeLocator.js';

const locator = createPlaceLocator();
await locator.ready();

function where(lat, lon) {
  const fix = locator.locate(lat, lon);
  return {
    continent: fix.continent,
    ocean: fix.ocean,
    water: fix.water,
    country: fix.country?.name ?? null,
    part: fix.part?.name ?? null,
    region: fix.region?.name ?? null,
    city: fix.city ? `${fix.city.within ? 'in' : 'near'} ${fix.city.name}` : null,
  };
}

test('a city reads as continent, country, state and city', () => {
  assert.deepEqual(where(30.2672, -97.7431), {
    continent: 'North America',
    ocean: null,
    water: null,
    country: 'United States',
    part: null,
    region: 'Texas',
    city: 'in Austin',
  });
  assert.deepEqual(where(59.437, 24.7535), {
    continent: 'Europe',
    ocean: null,
    water: null,
    country: 'Estonia',
    part: null,
    region: 'Harju',
    city: 'in Tallinn',
  });
});

test('a point outside every city reach is near the closest one', () => {
  const fix = locator.locate(30.4394, -97.62);
  assert.equal(fix.city.name, 'Austin');
  assert.equal(fix.city.within, false);
  assert.ok(fix.city.distanceKm > 15 && fix.city.distanceKm < 30);
});

test('a big neighbour does not swallow a city inside its own reach', () => {
  assert.equal(where(35.444, 139.638).city, 'in Yokohama');
  assert.equal(where(35.68, 139.76).city, 'in Tokyo');
});

test('the United Kingdom names its nation too', () => {
  assert.deepEqual(where(51.5074, -0.1278), {
    continent: 'Europe',
    ocean: null,
    water: null,
    country: 'United Kingdom',
    part: 'England',
    region: 'Westminster',
    city: 'in London',
  });
  assert.equal(where(55.9533, -3.1883).part, 'Scotland');
});

test('countries that cross continents are split where they cross', () => {
  assert.equal(where(55.75, 37.62).continent, 'Europe'); // Moscow
  assert.equal(where(55.03, 82.92).continent, 'Asia'); // Novosibirsk
  assert.equal(where(41.01, 28.97).continent, 'Europe'); // Istanbul, west bank
  assert.equal(where(40.99, 29.1).continent, 'Asia'); // Istanbul, east bank
  assert.equal(where(29.5, 33.9).continent, 'Asia'); // Sinai
  assert.equal(where(30.04, 31.24).continent, 'Africa'); // Cairo
});

test('open water names the ocean or sea instead of a country', () => {
  assert.deepEqual(where(20, -150), {
    continent: null,
    ocean: 'North Pacific Ocean',
    water: null,
    country: null,
    part: null,
    region: null,
    city: null,
  });
  assert.equal(where(25, -90).water, 'Gulf of Mexico');
  assert.equal(where(0, 0).ocean, 'South Atlantic Ocean');
});

test('island nations with no continent name their ocean', () => {
  const fix = where(4.1755, 73.5093);
  assert.equal(fix.country, 'Maldives');
  assert.equal(fix.continent, null);
  assert.equal(fix.ocean, 'Indian Ocean');
});

test('short English country names replace formal ones', () => {
  assert.equal(where(-6.8, 39.28).country, 'Tanzania');
  assert.equal(where(44.8, 20.46).country, 'Serbia');
});

test('longitudes outside [-180, 180) wrap', () => {
  assert.equal(where(30.2672, -97.7431 + 360).city, 'in Austin');
});

test('admin-1 types read as plain English', () => {
  assert.equal(regionTypeLabel('Voivodeship|Province'), 'Voivodeship');
  assert.equal(regionTypeLabel('Lansdele'), 'Region');
  assert.equal(regionTypeLabel("Oblast'"), 'Region');
  assert.equal(regionTypeLabel('Unitary Authority (wales)'), 'Unitary Authority');
  assert.equal(regionTypeLabel(null), 'Region');
  assert.equal(regionTypeLabel('State'), 'State');
});

test('a city reach grows with population and stays bounded', () => {
  assert.equal(cityReachKm(0), 3);
  assert.ok(cityReachKm(1_000_000) > 13 && cityReachKm(1_000_000) < 15);
  assert.equal(cityReachKm(40_000_000), 40);
});

test('lookups wait for the packs and refuse bad coordinates', async () => {
  const loads = [];
  const pending = createPlaceLocator({
    loadPack: async (name) => {
      loads.push(name);
      return null;
    },
  });
  assert.equal(pending.isReady(), false);
  assert.equal(pending.locate(30, -97), null);
  await pending.ready();
  assert.deepEqual(loads.sort(), ['countries', 'marine', 'places', 'states']);
  assert.equal(locator.locate(Number.NaN, 0), null);
});
