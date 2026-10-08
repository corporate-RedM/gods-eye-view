/**
 * Links between CCTV Watch incidents.
 *
 * Being close in place and time, with compatible kinds of evidence, only
 * nominates a candidate. A candidate shows as "possibly related" only after
 * checks that could rule it out, chiefly the road and travel direction parsed
 * from camera names and report text. Nothing here merges incidents: merging
 * needs clear identity (see incidents.js), and BK can link, unlink or merge
 * by hand. A warning area or a large earthquake groups the incidents inside
 * it without linking or merging them.
 */
import { bearingDeg, distanceKm } from './cameraChoice.js';
import { compareRoads } from './roads.js';

const DEFAULT_RULE = Object.freeze({ radiusKm: 1, windowMin: 60 });

/** Link rule for one group, from the events config. */
export function linkRuleFor(events, group) {
  return events.links?.[group] || { ...DEFAULT_RULE, compatible: [group] };
}

/**
 * The widest radius and time window among compatible group pairs, or null
 * when no pair is compatible.
 * @param {object} events
 * @param {string[]} groupsA
 * @param {string[]} groupsB
 * @returns {{radiusKm:number, windowMs:number}|null}
 */
export function linkWindow(events, groupsA, groupsB) {
  let radiusKm = -1;
  let windowMin = -1;
  for (const a of groupsA)
    for (const b of groupsB) {
      const ruleA = linkRuleFor(events, a);
      const ruleB = linkRuleFor(events, b);
      if (
        !(ruleA.compatible || []).includes(b) &&
        !(ruleB.compatible || []).includes(a)
      )
        continue;
      radiusKm = Math.max(radiusKm, ruleA.radiusKm, ruleB.radiusKm);
      windowMin = Math.max(windowMin, ruleA.windowMin, ruleB.windowMin);
    }
  return radiusKm < 0 ? null : { radiusKm, windowMs: windowMin * 60_000 };
}

/** Whether a place lies inside a camera's field of view, by its heading. */
function inView(camera, place) {
  const heading = Number(camera.headingDeg);
  if (!Number.isFinite(heading)) return null;
  const fov = Number.isFinite(Number(camera.fovDeg))
    ? Number(camera.fovDeg)
    : 60;
  const offset = Math.abs(
    ((bearingDeg(camera, place) - heading + 540) % 360) - 180,
  );
  return offset <= fov / 2 + 10;
}

function roadsBetween(a, b) {
  let verdict = 'unknown';
  let compared = 0;
  let different = 0;
  for (const placeA of a.places)
    for (const placeB of b.places) {
      const result = compareRoads(placeA.road, placeB.road);
      if (result === 'same') return 'same';
      if (result === 'unknown') continue;
      compared += 1;
      if (result === 'different') different += 1;
    }
  if (compared && different === compared) verdict = 'different';
  return verdict;
}

function span(incident, at) {
  return [incident.firstSeenAt, incident.resolvedAt ?? at];
}

/**
 * Check whether two incidents could be related.
 * @param {object} a - Incident summary: {id, groups, places:[{lat, lon, road, camera?}], firstSeenAt, resolvedAt, reportIds}.
 * @param {object} b - Same shape.
 * @param {{events:object, at:number}} context
 * @returns {null|{related:boolean, identity:string|null, distanceKm:number, gapMs:number, reasons:string[], against:string[]}}
 *   null when the pair is not even a candidate.
 */
export function checkLink(a, b, { events, at }) {
  const sharedReport = (a.reportIds || []).find((id) =>
    (b.reportIds || []).includes(id),
  );
  if (sharedReport)
    return {
      related: true,
      identity: 'report',
      distanceKm: 0,
      gapMs: 0,
      reasons: [`same report ${sharedReport}`],
      against: [],
    };
  const window = linkWindow(events, a.groups, b.groups);
  if (!window) return null;
  let nearest = Infinity;
  for (const placeA of a.places)
    for (const placeB of b.places)
      if (Number.isFinite(placeA.lat) && Number.isFinite(placeB.lat))
        nearest = Math.min(nearest, distanceKm(placeA, placeB));
  if (!(nearest <= window.radiusKm)) return null;
  const [startA, endA] = span(a, at);
  const [startB, endB] = span(b, at);
  const gapMs = Math.max(0, startB - endA, startA - endB);
  if (gapMs > window.windowMs) return null;

  const reasons = [
    nearest < 0.05 ? 'same place' : `${nearest.toFixed(1)} km apart`,
    gapMs === 0
      ? 'overlapping in time'
      : `${Math.round(gapMs / 60_000)} min apart`,
  ];
  const against = [];
  const roads = roadsBetween(a, b);
  if (roads === 'same') reasons.push('same road and direction');
  if (roads === 'different') against.push('different road or direction');
  // A trusted heading that points at the other incident supports the link.
  // Facing away is not held against it: a queue can stretch behind a camera.
  for (const [from, to] of [
    [a, b],
    [b, a],
  ])
    for (const place of from.places) {
      if (place.camera?.headingConfidence !== 'high') continue;
      if (to.places.some((other) => inView(place.camera, other) === true)) {
        reasons.push('camera faces the other location');
        break;
      }
    }
  return {
    related: against.length === 0,
    identity: null,
    distanceKm: Number(nearest.toFixed(3)),
    gapMs,
    reasons: [...new Set(reasons)],
    against,
  };
}

/** Ray-casting point-in-ring for GeoJSON [lon, lat] rings. */
export function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function inPolygon(point, rings) {
  if (!rings?.length || !pointInRing(point, rings[0])) return false;
  // Later rings are holes.
  return !rings.slice(1).some((hole) => pointInRing(point, hole));
}

/**
 * Whether an area covers a place.
 * @param {object} area - {geometry: GeoJSON Polygon|MultiPolygon} or {center:{lat, lon}, radiusKm}.
 * @param {{lat:number, lon:number}} place
 */
export function areaCovers(area, place) {
  if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lon))
    return false;
  const geometry = area.geometry;
  if (geometry?.type === 'Polygon')
    return inPolygon(place, geometry.coordinates);
  if (geometry?.type === 'MultiPolygon')
    return geometry.coordinates.some((rings) => inPolygon(place, rings));
  if (area.center && Number.isFinite(area.radiusKm))
    return distanceKm(area.center, place) <= area.radiusKm;
  return false;
}

/**
 * Areas (warnings, earthquakes) that cover any place of an incident. They
 * group incidents without linking or merging them.
 * @param {object[]} places
 * @param {object[]} areas - {id, kind, label, geometry|center+radiusKm}.
 */
export function areaContext(places, areas) {
  return areas
    .filter((area) => places.some((place) => areaCovers(area, place)))
    .map((area) => ({ id: area.id, kind: area.kind, label: area.label }));
}
