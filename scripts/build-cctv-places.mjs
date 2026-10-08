// Build the nearest-city gazetteer for CCTV camera labels.
//
// Downloads GeoNames cities1000 (every populated place with 1,000+ people,
// CC BY 4.0) and keeps only the regions whose camera packs carry a road,
// region or country instead of a city: Ontario, British Columbia, Texas,
// Delaware, Wisconsin, Louisiana, Nevada, Minnesota, Iowa, Finland, New South
// Wales and Estonia. Neighbourhood sections
// (PPLX) and historical/abandoned places are dropped so a label names the
// city a viewer would search for. Requires the `unzip` command.
//
// The same download also gives CCTV Watch's coverage areas their cities:
// every place of at least 100,000 people in the countries above, any region
// (California included, though its cameras carry their own place names).
// `--areas-only` writes just that list and leaves the label gazetteer as is.
//
//   node scripts/build-cctv-places.mjs [--areas-only]
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_URL = 'https://download.geonames.org/export/dump/cities1000.zip';
const OUT_FILE = path.join(ROOT, 'src/data/local_data/cctv_places/places.json');
const AREA_FILE = path.join(
  ROOT,
  'src/data/local_data/cctv_places/area_cities.json',
);
const AREA_MIN_POPULATION = 100_000;
const AREAS_ONLY = process.argv.includes('--areas-only');

/** Country code → admin1 codes to keep (null keeps the whole country). */
const REGIONS = {
  CA: ['08', '02'], // Ontario, British Columbia
  // Texas, Delaware, and the state 511 live-video packs.
  US: ['TX', 'DE', 'WI', 'LA', 'NV', 'MN', 'IA'],
  FI: null,
  AU: ['02'], // New South Wales
  EE: null,
};
const SKIP_FEATURE_CODES = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'cctv-places-'));
try {
  const zipPath = path.join(tmp, 'cities1000.zip');
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok)
    throw new Error(`GeoNames download failed: HTTP ${resp.status}`);
  await writeFile(zipPath, Buffer.from(await resp.arrayBuffer()));
  const text = execFileSync('unzip', ['-p', zipPath, 'cities1000.txt'], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });

  const places = [];
  const areaCities = [];
  for (const line of text.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 15) continue;
    const [, name, , , lat, lon, featureClass, featureCode, country] = cols;
    const admin1 = cols[10];
    const population = Number(cols[14]);
    if (!(country in REGIONS)) continue;
    if (featureClass !== 'P' || SKIP_FEATURE_CODES.has(featureCode)) continue;
    const place = [
      name,
      Number(Number(lat).toFixed(4)),
      Number(Number(lon).toFixed(4)),
      Number.isFinite(population) ? population : 0,
    ];
    if (place[3] >= AREA_MIN_POPULATION) areaCities.push(place);
    if (REGIONS[country] && !REGIONS[country].includes(admin1)) continue;
    places.push(place);
  }
  places.sort((a, b) => b[3] - a[3]);
  areaCities.sort((a, b) => b[3] - a[3]);

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  const header = {
    source: 'GeoNames cities1000 (https://www.geonames.org/), CC BY 4.0',
    generatedAt: new Date().toISOString().slice(0, 10),
    fields: ['name', 'lat', 'lon', 'population'],
  };
  if (!AREAS_ONLY) {
    await writeFile(OUT_FILE, `${JSON.stringify({ ...header, places })}\n`);
    console.log(
      `Wrote ${places.length} places to ${path.relative(ROOT, OUT_FILE)}`,
    );
  }
  await writeFile(
    AREA_FILE,
    `${JSON.stringify({ ...header, places: areaCities })}\n`,
  );
  console.log(
    `Wrote ${areaCities.length} cities to ${path.relative(ROOT, AREA_FILE)}`,
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
