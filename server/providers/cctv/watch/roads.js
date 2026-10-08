/**
 * Road and direction from camera names and report text, for checking whether
 * two nearby incidents could be the same one. A crash on I-94 eastbound and a
 * stopped queue on I-94 westbound are close together but not the same event.
 */

const ROUTE_PATTERNS = [
  // I-35W, I-494, I-41/94, IH 35
  /\b(?:I|IH)[-\s]?(\d{1,3})([EWNS]?)\b(?:\s*\/\s*(\d{1,3}))?/gi,
  // US 12, US-169, U.S. 101
  /\bU\.?S\.?[-\s]?(\d{1,3})\b/gi,
  // State routes: MN 24, SR-99, WIS 142, LA 1, NV-267, CA 1, Hwy 101, Route 66
  /\b(?:SR|MN|WIS|WI|LA|NV|IA|CA|DE|STH|SH|HWY|Highway|Route)[-\s]?(\d{1,4})\b/gi,
];

const DIRECTIONS = [
  [/\b(?:north\s*bound|northbound|NB|N\/B)\b/i, 'N'],
  [/\b(?:south\s*bound|southbound|SB|S\/B)\b/i, 'S'],
  [/\b(?:east\s*bound|eastbound|EB|E\/B)\b/i, 'E'],
  [/\b(?:west\s*bound|westbound|WB|W\/B)\b/i, 'W'],
  [/\b(?:both directions)\b/i, 'both'],
];

/**
 * Normalised route identifiers mentioned in text, in the order they appear,
 * e.g. ["I-94", "US-12"].
 * @param {string} text
 * @returns {string[]}
 */
export function parseRoutes(text) {
  const found = [];
  const value = String(text || '');
  for (const match of value.matchAll(ROUTE_PATTERNS[0])) {
    found.push([match.index, `I-${match[1]}${(match[2] || '').toUpperCase()}`]);
    if (match[3]) found.push([match.index + 0.5, `I-${match[3]}`]);
  }
  for (const match of value.matchAll(ROUTE_PATTERNS[1]))
    found.push([match.index, `US-${match[1]}`]);
  for (const match of value.matchAll(ROUTE_PATTERNS[2]))
    found.push([match.index, `ST-${match[1]}`]);
  found.sort((a, b) => a[0] - b[0]);
  return [...new Set(found.map(([, route]) => route))];
}

/**
 * Travel direction mentioned in text: N, S, E, W, "both", or null.
 * @param {string} text
 */
export function parseDirection(text) {
  const value = String(text || '');
  for (const [pattern, direction] of DIRECTIONS)
    if (pattern.test(value)) return direction;
  return null;
}

/** Route numbers without suffixes, so I-35W and I-35 share "I-35". */
function baseRoutes(routes) {
  return routes.map((route) => route.replace(/^(I-\d+)[EWNS]$/, '$1'));
}

/**
 * Whether two places can be on the same road and carriageway.
 * Unknown on either side is "unknown", never "same": missing data must not
 * turn into evidence of a link.
 * @param {{routes:string[], direction:string|null}} a
 * @param {{routes:string[], direction:string|null}} b
 * @returns {'same'|'different'|'unknown'}
 */
export function compareRoads(a, b) {
  if (!a?.routes?.length || !b?.routes?.length) return 'unknown';
  const routesA = baseRoutes(a.routes);
  const routesB = baseRoutes(b.routes);
  const shared = routesA.filter((route) => routesB.includes(route));
  if (!shared.length) return 'different';
  if (!a.direction || !b.direction) return 'unknown';
  // A direction belongs to the first road named: "I-94 EB @ Hwy 100" says
  // nothing about which way Hwy 100 traffic runs.
  if (!shared.includes(routesA[0]) || !shared.includes(routesB[0]))
    return 'unknown';
  if (a.direction === 'both' || b.direction === 'both') return 'same';
  return a.direction === b.direction ? 'same' : 'different';
}

/** Road description for a camera (from its name) or a report. */
export function roadOf(textParts) {
  const text = textParts.filter(Boolean).join(' ');
  return { routes: parseRoutes(text), direction: parseDirection(text) };
}
