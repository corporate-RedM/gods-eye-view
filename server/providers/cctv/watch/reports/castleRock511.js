/**
 * 511 traffic events from the Castle Rock sites the camera catalog already
 * uses (Wisconsin, Louisiana, Nevada, Minnesota, Iowa), read from the same
 * keyless site APIs the camera loader reads.
 *
 * Planned work (roadwork, construction, scheduled closures) is not an
 * incident and is dropped here. Special events are kept as context only.
 * Every report carries its upstream id and update time, so the same report
 * polled again is recognised as unchanged.
 */
import { CASTLE_ROCK_511_SITES } from '../../constants.js';

const REQUEST_HEADERS = Object.freeze({
  Accept: 'application/json',
  'User-Agent':
    'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
});
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/** Map layers that carry unplanned events on the GraphQL sites. */
const GRAPHQL_EVENT_LAYERS = Object.freeze(['incidents', 'closures']);

const GRAPHQL_EVENTS_QUERY = `query MapFeatures($input: MapFeaturesArgs!) {
  mapFeaturesQuery(input: $input) {
    mapFeatures {
      __typename
      title
      uri
      features { geometry }
      ... on Event {
        priority
        description
        icon
        verified
        isWazeEvent
        lastUpdated { timestamp timezone }
        beginTime { timestamp }
      }
    }
    error { message type }
  }
}`;

const PLANNED =
  /roadwork|construction|paving|maintenance|utility|marking|gasmain|bridgeconstruction|futureroadwork/i;
/** Standing notices describe the road, not an event: truck limits and advisories. */
const STANDING = /advisory|restriction/i;
const STANDING_TEXT =
  /^\s*(?:truck\s+)?restrictions?\b|^\s*traffic advisory\b/i;

/**
 * Report kind from a DataTables event row, or null for planned work.
 * @param {object} row
 * @returns {string|null}
 */
export function kindFromListRow(row) {
  const layer = String(row?.layerName || '');
  const type = String(row?.type || '');
  const sub = String(row?.eventSubType || '');
  const text = `${row?.description || ''}`;
  if (/special ?events?/i.test(`${layer} ${type}`)) return 'special_event';
  if (/construction|roadwork/i.test(`${layer} ${type}`)) return null;
  if (PLANNED.test(sub)) return null;
  if (/crash|accident|collision|rollover/i.test(`${sub} ${text}`))
    return 'crash';
  if (
    /debris|hazard|animal|spill|rock ?slide|landslide|mudslide/i.test(
      `${sub} ${text}`,
    )
  )
    return 'hazard';
  if (/flood|water over/i.test(`${sub} ${text}`)) return 'flood';
  if (/fire|smoke/i.test(`${sub} ${text}`)) return 'fire';
  if (/closure|closed/i.test(`${layer} ${type} ${sub}`)) return 'closure';
  // A standing notice is dropped unless its text names a vehicle in trouble;
  // crashes and hazards filed under an advisory subtype were kept above.
  if (
    (STANDING.test(`${type} ${sub}`) || STANDING_TEXT.test(text)) &&
    !/disabled|stalled/i.test(text)
  )
    return null;
  if (/incident|disabled|stalled/i.test(`${layer} ${type} ${sub}`))
    return 'incident';
  return null;
}

function kindFromText(text) {
  if (/construction|roadwork|maintenance/i.test(text)) return null;
  if (/crash|collision|rollover/i.test(text)) return 'crash';
  if (/debris|hazard|animal|spill|slide/i.test(text)) return 'hazard';
  if (/flood/i.test(text)) return 'flood';
  if (/fire|smoke/i.test(text)) return 'fire';
  if (/closed|closure/i.test(text)) return 'closure';
  if (/incident|stalled|disabled/i.test(text)) return 'incident';
  return undefined;
}

/**
 * Report kind from a GraphQL map Event, or null for planned work. The title
 * is what the agency wrote; the icon is only a fallback, because a generic
 * "Traffic incident reported" can carry a crash icon.
 */
export function kindFromMapEvent(event) {
  const fromTitle = kindFromText(String(event?.title || ''));
  if (fromTitle !== undefined) return fromTitle;
  const fromIcon = kindFromText(String(event?.icon || ''));
  return fromIcon !== undefined ? fromIcon : 'incident';
}

/**
 * Wall-clock text such as "3/5/26, 2:58 PM" in an IANA zone, to epoch ms.
 * @returns {number|null}
 */
export function parseSiteTime(text, timeZone) {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(
      String(text || '').trim(),
    );
  if (!match) return null;
  const [, month, day, yearText, hourText, minute, meridiem] = match;
  const year =
    yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  let hour = Number(hourText) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  const guess = Date.UTC(
    year,
    Number(month) - 1,
    Number(day),
    hour,
    Number(minute),
  );
  // Find the zone's offset at that moment and correct the guess by it.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(guess));
  const value = (type) =>
    Number(parts.find((part) => part.type === type)?.value);
  const shown = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
  );
  return guess - (shown - guess);
}

function pointFromWkt(wkt) {
  const match = /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(
    String(wkt || ''),
  );
  return match ? { lat: Number(match[2]), lon: Number(match[1]) } : null;
}

function firstCoordinate(geometry) {
  let coordinates = geometry?.coordinates;
  while (Array.isArray(coordinates?.[0])) coordinates = coordinates[0];
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lon, lat] = coordinates;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function plainText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize one DataTables event row.
 * @param {object} row
 * @param {object} site
 * @param {string} timeZone - IANA zone of the site's wall-clock times.
 * @param {Map<string, {lat:number, lon:number}>} [positions] - Event positions from the map icon feed.
 * @returns {object|null} Report, or null for planned work.
 */
export function normalizeListEvent(row, site, timeZone, positions = new Map()) {
  const kind = kindFromListRow(row);
  if (!kind || row?.id === undefined) return null;
  const cameras = Array.isArray(row.cameras) ? row.cameras : [];
  const cameraUrls = [];
  let cameraLocation = null;
  for (const camera of cameras) {
    cameraLocation ||= pointFromWkt(camera?.latLng?.geography?.wellKnownText);
    for (const image of camera?.images || [])
      if (image?.videoUrl && !image.disabled) cameraUrls.push(image.videoUrl);
  }
  // The event's own map position first; a linked camera's position is only
  // where the event is watched from.
  const eventLocation = positions.get(String(row.id)) || null;
  const location = eventLocation || cameraLocation;
  const locationFrom = eventLocation
    ? 'event-map'
    : cameraLocation
      ? 'linked-camera'
      : null;
  const updatedText = String(row.lastUpdated || '');
  return {
    id: `${site.id}:${row.id}`,
    source: site.provider,
    sourceKind: 'agency',
    official: true,
    kind,
    title: plainText(row.description).slice(0, 240),
    road: row.roadwayName || null,
    direction: row.direction || null,
    updatedKey: updatedText,
    updatedAt: parseSiteTime(updatedText, timeZone),
    startedAt: parseSiteTime(row.startDate, timeZone),
    fullClosure: Boolean(row.isFullClosure),
    lat: location?.lat ?? null,
    lon: location?.lon ?? null,
    locationFrom,
    cameraUrls: [...new Set(cameraUrls)],
    state: site.state,
  };
}

/** Normalize one GraphQL map Event. */
export function normalizeMapEvent(event, site) {
  const kind = kindFromMapEvent(event);
  if (!kind || !event?.uri) return null;
  const point = (event.features || [])
    .map((feature) => firstCoordinate(feature?.geometry))
    .find(Boolean);
  const updatedAt = Number(event.lastUpdated?.timestamp) || null;
  return {
    id: `${site.id}:${event.uri}`,
    source: site.provider,
    sourceKind: event.isWazeEvent ? 'waze' : 'agency',
    // Waze reports are crowd-sourced: useful cues, never official corroboration.
    official: !event.isWazeEvent,
    kind,
    title: plainText(event.title).slice(0, 240),
    road: null,
    direction: null,
    updatedKey: String(updatedAt ?? ''),
    updatedAt,
    startedAt: Number(event.beginTime?.timestamp) || null,
    fullClosure: false,
    lat: point?.lat ?? null,
    lon: point?.lon ?? null,
    locationFrom: point ? 'event-geometry' : null,
    cameraUrls: [],
    state: site.state,
    priority: Number.isFinite(event.priority) ? event.priority : null,
  };
}

async function readJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_BODY_BYTES) throw new Error('response too large');
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
  return JSON.parse(text);
}

/**
 * Event types worth reading on the list sites, with the map layer that
 * carries their positions. The list API filters by type server-side, so
 * planned roadwork (most rows) is never downloaded.
 */
const LIST_EVENT_TYPES = Object.freeze({
  Incidents: 'Incidents',
  Closures: 'Closures',
  'Special Events': 'SpecialEvents',
});

/** Event positions from a list site's map icon feeds, by row id. */
async function fetchListPositions(site, fetchImpl) {
  const positions = new Map();
  for (const layer of Object.values(LIST_EVENT_TYPES)) {
    try {
      const response = await fetchImpl(`${site.origin}/map/mapIcons/${layer}`, {
        headers: REQUEST_HEADERS,
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const body = await readJson(response);
      for (const item of body?.item2 || []) {
        const [lat, lon] = Array.isArray(item?.location) ? item.location : [];
        if (Number.isFinite(lat) && Number.isFinite(lon))
          positions.set(String(item.itemId), { lat, lon });
      }
    } catch {
      // Positions are a refinement; a report without one still counts.
    }
  }
  return positions;
}

async function fetchListEvents(site, fetchImpl) {
  const rows = [];
  for (const type of Object.keys(LIST_EVENT_TYPES)) {
    let seen = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = encodeURIComponent(
        JSON.stringify({
          columns: [{ data: 'type', name: 'type', search: { value: type } }],
          order: [],
          start: page * PAGE_SIZE,
          length: PAGE_SIZE,
          search: { value: '' },
        }),
      );
      const response = await fetchImpl(
        `${site.origin}/List/GetData/traffic?query=${query}&lang=en-US`,
        {
          headers: REQUEST_HEADERS,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      const data = Array.isArray(body?.data) ? body.data : [];
      rows.push(...data);
      seen += data.length;
      if (data.length < PAGE_SIZE || seen >= Number(body?.recordsFiltered || 0))
        break;
    }
  }
  return rows;
}

async function fetchMapEvents(site, fetchImpl) {
  const response = await fetchImpl(`${site.origin}/api/graphql`, {
    method: 'POST',
    headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: GRAPHQL_EVENTS_QUERY,
      variables: {
        input: {
          ...site.bbox,
          zoom: 15,
          layerSlugs: GRAPHQL_EVENT_LAYERS,
          nonClusterableUris: ['dashboard'],
        },
      },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await readJson(response);
  const payload = body?.data?.mapFeaturesQuery;
  if (payload?.error) throw new Error(payload.error.message || 'GraphQL error');
  return (payload?.mapFeatures || []).filter(
    (feature) => feature.__typename === 'Event',
  );
}

/** IANA zone for each site's wall-clock list times. */
const SITE_TIME_ZONES = Object.freeze({
  'us-wi': 'America/Chicago',
  'us-la': 'America/Chicago',
  'us-nv': 'America/Los_Angeles',
  'us-mn': 'America/Chicago',
  'us-ia': 'America/Chicago',
});

/**
 * Fetch and normalize current unplanned events from every Castle Rock site.
 * One failing site never hides the others.
 * @returns {Promise<{reports: object[], errors: Object<string, string>}>}
 */
export async function fetchCastleRockReports({
  fetchImpl = fetch,
  sites = CASTLE_ROCK_511_SITES,
} = {}) {
  const reports = [];
  const errors = {};
  await Promise.all(
    sites.map(async (site) => {
      try {
        if (site.api === 'graphql') {
          for (const event of await fetchMapEvents(site, fetchImpl)) {
            const report = normalizeMapEvent(event, site);
            if (report) reports.push(report);
          }
        } else {
          const zone = SITE_TIME_ZONES[site.id] || 'America/Chicago';
          const [rows, positions] = await Promise.all([
            fetchListEvents(site, fetchImpl),
            fetchListPositions(site, fetchImpl),
          ]);
          for (const row of rows) {
            const report = normalizeListEvent(row, site, zone, positions);
            if (report) reports.push(report);
          }
        }
      } catch (error) {
        errors[site.id] = error.message;
      }
    }),
  );
  return { reports, errors };
}
