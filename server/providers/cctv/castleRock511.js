import {
  CASTLE_ROCK_511_SITES,
  DEFAULT_CASTLE_ROCK_511_MAX_SOURCES,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';
import {
  fallbackHeadingFromId,
  isPlausibleLatLon,
  prioritizeSources,
  toFiniteNumber,
} from './normalize.js';
import { knownDeadStreams } from './streamHealth.js';
import { directionToHeading } from '../../../src/data/directionText.js';
import { readResponseJsonCapped } from '../common/http.js';

/**
 * Live-video cameras from state "511" traveler sites on the Castle Rock
 * platform (see CASTLE_ROCK_511_SITES). Both of the platform's list APIs are
 * the sites' own keyless public endpoints:
 *   - DataTables: GET /List/GetData/Cameras, paged 100 rows at a time with a
 *     fixed sort (unsorted paging repeats some rows and skips others).
 *   - GraphQL: POST /api/graphql MapFeatures over the state's bounding box at
 *     a zoom high enough that nothing clusters, asking each view for its HLS
 *     `sources` as well as its snapshot `url`.
 * Only cameras with an open (no auth, no token) HLS link on the state's own
 * stream hosts are kept; dead links fall back to the still image.
 */

const REQUEST_HEADERS = Object.freeze({
  Accept: 'application/json',
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
});
/** The DataTables endpoint returns at most 100 rows per request. */
const DATATABLES_PAGE_SIZE = 100;
const DATATABLES_MAX_PAGES = 60;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

const GRAPHQL_CAMERAS_QUERY = `query MapFeatures($input: MapFeaturesArgs!) {
  mapFeaturesQuery(input: $input) {
    mapFeatures {
      __typename
      title
      uri
      features { geometry }
      ... on Camera {
        active
        views(limit: 5) {
          category
          ... on CameraView { url sources { type src } }
        }
      }
    }
    error { message type }
  }
}`;

/**
 * An https URL on one of the allowed host suffixes, with no credentials, or ''.
 * @param {*} value Candidate URL.
 * @param {string[]} hostSuffixes Allowed hostnames (subdomains included).
 * @returns {string}
 */
export function pinnedHttpsUrl(value, hostSuffixes = []) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  const host = url.hostname.toLowerCase();
  const allowed = hostSuffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  return allowed ? url.href : '';
}

/** An open live-video link: HLS on a pinned host, no token in the URL. */
function openStreamUrl(value, site) {
  const url = pinnedHttpsUrl(value, site.streamHosts);
  if (!url || !/\.m3u8(?:\?|$)/i.test(url) || /[?&]token=/i.test(url))
    return '';
  return url;
}

/**
 * Parse a WKT "POINT (lon lat)".
 * @param {*} wkt
 * @returns {{lat: number, lon: number}|null}
 */
export function parseWktPoint(wkt) {
  const match = /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(
    String(wkt || ''),
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return isPlausibleLatLon(lat, lon) ? { lat, lon } : null;
}

/** Fields every Castle Rock camera shares (pose priors as for DelDOT). */
function cameraRecord(
  site,
  { id, name, lat, lon, heading, streamUrl, snapshotUrl },
) {
  const cameraId = `${site.id}-${id}`;
  const hasHeading = Number.isFinite(heading);
  return {
    id: cameraId,
    name,
    city: site.state,
    cityId: site.id,
    provider: site.provider,
    lat,
    lon,
    headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'high' : 'low',
    // Fabricated RAW PRIOR poses (same personalities as Austin/Caltrans); the
    // client ground-snap + manual calibration own the truth.
    pitchDeg: hasHeading ? -24 : -18,
    fovDeg: hasHeading ? 56 : 44,
    rangeM: hasHeading ? 210 : 145,
    mountHeightM: hasHeading ? 10 : 8,
    groundElevationM: site.groundElevationM,
    feedType: 'hls',
    url: streamUrl,
    snapshotUrl,
    sourceKind: `${site.pack}-open-data`,
    license: `Public ${site.provider} traffic camera`,
  };
}

/**
 * One DataTables camera row to a source, or null when it has no open stream.
 * @param {Object} site Entry from CASTLE_ROCK_511_SITES.
 * @param {Object} row `data[]` row from /List/GetData/Cameras.
 * @returns {Object|null}
 */
export function dataTablesRowToSource(site, row) {
  const id = String(row?.id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  const point = parseWktPoint(row?.latLng?.geography?.wellKnownText);
  if (!point) return null;
  for (const image of Array.isArray(row?.images) ? row.images : []) {
    if (
      image?.isVideoAuthRequired ||
      image?.videoDisabled ||
      image?.disabled ||
      image?.blocked
    )
      continue;
    const streamUrl = openStreamUrl(image?.videoUrl, site);
    if (!streamUrl) continue;
    const imagePath = String(image?.imageUrl || '');
    const snapshotUrl = /^\/map\/Cctv\/[A-Za-z0-9_-]+$/.test(imagePath)
      ? `${site.origin}${imagePath}`
      : '';
    const location = String(row?.location || '').trim();
    const roadway = String(row?.roadway || '').trim();
    const name =
      (location && location !== 'N/A' ? location : '') ||
      roadway ||
      `${site.state} camera ${id}`;
    let heading = directionToHeading(row?.direction, true);
    if (!Number.isFinite(heading))
      heading = directionToHeading(image?.description);
    return cameraRecord(site, {
      id,
      name,
      ...point,
      heading,
      streamUrl,
      snapshotUrl,
    });
  }
  return null;
}

/**
 * One GraphQL Camera feature to a source, or null when it has no open stream.
 * @param {Object} site Entry from CASTLE_ROCK_511_SITES.
 * @param {Object} feature `mapFeatures[]` entry.
 * @returns {Object|null}
 */
export function graphqlCameraToSource(site, feature) {
  if (feature?.__typename !== 'Camera' || feature.active === false) return null;
  const id = /^camera\/([A-Za-z0-9_-]{1,80})$/.exec(String(feature.uri || ''));
  if (!id) return null;
  const [lon, lat] = feature.features?.[0]?.geometry?.coordinates || [];
  const point = { lat: toFiniteNumber(lat), lon: toFiniteNumber(lon) };
  if (!isPlausibleLatLon(point.lat, point.lon)) return null;
  for (const view of Array.isArray(feature.views) ? feature.views : []) {
    const source = (Array.isArray(view?.sources) ? view.sources : []).find(
      (candidate) => openStreamUrl(candidate?.src, site),
    );
    if (!source) continue;
    const title = String(feature.title || '').trim();
    return cameraRecord(site, {
      id: id[1],
      name: title || `${site.state} camera ${id[1]}`,
      ...point,
      heading: directionToHeading(title),
      streamUrl: openStreamUrl(source.src, site),
      snapshotUrl: pinnedHttpsUrl(view.url, site.snapshotHosts),
    });
  }
  return null;
}

async function fetchJson(url, init = {}) {
  const resp = await fetch(url, {
    ...init,
    headers: { ...REQUEST_HEADERS, ...init.headers },
    signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return readResponseJsonCapped(resp, MAX_CATALOG_BYTES);
}

async function fetchDataTablesRows(site) {
  const rows = new Map();
  for (let page = 0; page < DATATABLES_MAX_PAGES; page += 1) {
    const query = encodeURIComponent(
      JSON.stringify({
        columns: [{ data: 'id', name: 'id' }],
        order: [{ column: 0, dir: 'asc' }],
        start: page * DATATABLES_PAGE_SIZE,
        length: DATATABLES_PAGE_SIZE,
        search: { value: '' },
      }),
    );
    const body = await fetchJson(
      `${site.origin}/List/GetData/Cameras?query=${query}&lang=en-US`,
    );
    const data = Array.isArray(body?.data) ? body.data : [];
    for (const row of data) rows.set(String(row?.id), row);
    const total = toFiniteNumber(body?.recordsTotal, 0);
    if (data.length < DATATABLES_PAGE_SIZE || rows.size >= total) break;
  }
  return [...rows.values()];
}

async function fetchGraphqlFeatures(site) {
  const body = await fetchJson(`${site.origin}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: GRAPHQL_CAMERAS_QUERY,
      variables: {
        input: {
          ...site.bbox,
          zoom: 15,
          layerSlugs: ['normalCameras'],
          nonClusterableUris: ['dashboard'],
        },
      },
    }),
  });
  const payload = body?.data?.mapFeaturesQuery;
  if (payload?.error) throw new Error(payload.error.message || 'GraphQL error');
  return Array.isArray(payload?.mapFeatures) ? payload.mapFeatures : [];
}

/**
 * Load one state's live-video cameras.
 * @param {string} siteId Site `id` from CASTLE_ROCK_511_SITES (e.g. 'us-wi').
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadCastleRock511Sources(siteId) {
  const site = CASTLE_ROCK_511_SITES.find((entry) => entry.id === siteId);
  if (!site) return [];
  try {
    const cameras =
      site.api === 'graphql'
        ? (await fetchGraphqlFeatures(site)).map((feature) =>
            graphqlCameraToSource(site, feature),
          )
        : (await fetchDataTablesRows(site)).map((row) =>
            dataTablesRowToSource(site, row),
          );
    const unique = [
      ...new Map(
        cameras.filter(Boolean).map((camera) => [camera.id, camera]),
      ).values(),
    ];
    // Dead links (streamHealth.js) fall back to the still image; a camera
    // with neither is left out.
    const dead = await knownDeadStreams(unique.map((camera) => camera.url));
    const usable = [];
    for (const camera of unique) {
      if (!dead.has(camera.url)) usable.push(camera);
      else if (camera.snapshotUrl)
        usable.push({ ...camera, feedType: 'image', url: camera.snapshotUrl });
    }
    const maxRaw = Number(
      process.env[`CCTV_${site.envKey}_MAX_SOURCES`] ||
        DEFAULT_CASTLE_ROCK_511_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(DEFAULT_CASTLE_ROCK_511_MAX_SOURCES, maxRaw))
      : DEFAULT_CASTLE_ROCK_511_MAX_SOURCES;
    const prioritized = prioritizeSources(usable, maxCount, site.anchors);
    const live = prioritized.filter((camera) => camera.feedType === 'hls');
    console.log(
      `[CCTV] Loaded ${site.provider} camera sources: ${unique.length} with live video, ${live.length} streaming (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      `[CCTV] ${site.provider} camera download error:`,
      error?.message || error,
    );
    return [];
  }
}
