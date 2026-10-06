# CCTV camera city labels

`places.json` holds the populated places used to label CCTV cameras with their
nearest city (`server/providers/cctv/places.js`), so cameras whose upstream
feed names only a road, region or country are searchable by city.

- **Source:** GeoNames `cities1000` (every populated place with 1,000+ people),
  <https://download.geonames.org/export/dump/>
- **License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
  attribution "GeoNames" (registered in `src/data/dataCredits.js`)
- **Extract:** Ontario, British Columbia, Texas, Delaware, Wisconsin,
  Louisiana, Nevada, Minnesota, Iowa, Finland, New South Wales and Estonia;
  neighbourhood sections (PPLX) and historical or abandoned places removed.
  Fields: name, lat, lon, population.
- **Rebuild:** `node scripts/build-cctv-places.mjs` (needs the `unzip` command)
