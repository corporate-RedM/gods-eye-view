/**
 * English display text for camera feeds whose upstream names are not in
 * English (BK, 2026-10-08: "All labels should be in english").
 *
 * - City of Tallinn and Transpordiamet (Tarktee) name cameras in Estonian:
 *   "Viru väljak (suund Mere pst ja Narva mnt)" reads "Viru Square (toward
 *   Mere Avenue and Narva Highway)".
 * - Fintraffic prefixes Finnish road codes: "vt4 Rovaniemi Revontuli 5"
 *   reads "Highway 4, Rovaniemi Revontuli 5".
 * - Warendorf names its one webcam in German.
 *
 * Proper names stay as they are (Pärnu, Õismäe, Jyväskylä are their English
 * names too); only the generic words around them — street types, "toward",
 * "intersection", "entrance" — are translated. Places with a different
 * English name (Montréal, Québec) get it.
 *
 * PURE — no DOM, no Cesium; the camera catalog and AI Watch call it at
 * display time, so the server's catalog keeps the upstream names.
 *
 * @module data/englishNames
 */

/** Packs whose camera names are Estonian, Finnish or German, by cityId. */
const ESTONIAN = /^(tallinn|estonia)$/;
const FINNISH = /^finland$/;
const GERMAN = /^warendorf$/;

/** Whole phrases first, so a word rule cannot split them. */
const ESTONIAN_PHRASES = [
  ['suund linnast välja', 'heading out of the city'],
  ['linnast välja', 'out of the city'],
  ['suund linna', 'toward the city'],
  ['enne tunnelit', 'before the tunnel'],
  ['ennem tunnelit', 'before the tunnel'],
  ['langetatav pollar', 'retractable bollard'],
  ['Teatri väljak', 'Theatre Square'],
  ['Vabaduse väljak', 'Freedom Square'],
  ['Raekoja plats', 'Town Hall Square'],
  ['Balti jaam', 'Baltic Station'],
  ['Baltijaam', 'Baltic Station'],
  ['Lennujaama tee', 'Airport Road'],
  ['Harku järve', 'Lake Harku'],
  ['Viru ring', 'Viru Circle'],
  ['Politsei park', 'Police Park'],
  ['Tammsaare park', 'Tammsaare Park'],
  ['Rõõmu kaubamaja', 'Rõõmu department store'],
  ['Draamateater', 'Drama Theatre'],
  ['P&R', 'Park & Ride'],
];

/** Single words; matched whole, case-insensitively. */
const ESTONIAN_WORDS = new Map([
  ['tn', 'Street'],
  ['tn.', 'Street'],
  ['tänav', 'Street'],
  ['pst', 'Avenue'],
  ['pst.', 'Avenue'],
  ['puiestee', 'Avenue'],
  ['mnt', 'Highway'],
  ['mnt.', 'Highway'],
  ['maantee', 'Highway'],
  ['tee', 'Road'],
  ['väljak', 'Square'],
  ['plats', 'Square'],
  ['trammitee', 'tramway'],
  ['viadukt', 'Viaduct'],
  ['ringristmik', 'roundabout'],
  ['ristmik', 'intersection'],
  ['suund', 'toward'],
  ['ja', 'and'],
  ['kesklinn', 'city center'],
  ['vanalinn', 'Old Town'],
  ['linna', 'into the city'],
  ['sadam', 'the port'],
  ['jaam', 'the station'],
  ['bussijaam', 'bus station'],
  ['sissepääs', 'entrance'],
  ['vaade', 'view'],
  ['ülevaade', 'overview'],
  ['tunnelis', 'in the tunnel'],
  ['raudteeülesõit', 'railway crossing'],
  ['pollar', 'bollard'],
  ['vasakpööre', 'left turn'],
  ['keskus', 'center'],
  ['lasnamäele', 'to Lasnamäe'],
  ['mustamäele', 'to Mustamäe'],
  ['õismäele', 'to Õismäe'],
  ['szolnokisse', 'to Szolnok'],
]);

/** Street-type abbreviations that end one street in a joined name. */
const ESTONIAN_STREET_END = /^(tn|pst|mnt|tee)\.?$/i;

/** Fintraffic road classes: valtatie, kantatie, seututie, yhdystie. */
const FINNISH_ROADS = [
  [/^vt\s*(\d+)\b\s*/i, 'Highway $1, '],
  [/^kt\s*(\d+)\b\s*/i, 'Main Road $1, '],
  [/^st\s*(\d+)\b\s*/i, 'Regional Road $1, '],
  [/^yt\s*(\d+)\b\s*/i, 'Road $1, '],
];

const FINNISH_PHRASES = [
  ['puomi l', 'west barrier'],
  ['ramppi l', 'west ramp'],
  ['puomi itä', 'east barrier'],
  ['Puomi Länsi', 'west barrier'],
  ['Ramppi Itä', 'east ramp'],
  ['Tre Rantatunneli', 'Tampere Ranta Tunnel'],
  ['Napapiiri', 'Arctic Circle'],
];

const FINNISH_WORDS = new Map([
  ['puomi', 'barrier'],
  ['ramppi', 'ramp'],
  ['silta', 'bridge'],
  ['itä', 'east'],
  ['länsi', 'west'],
  ['testi', 'test'],
  ['masto', 'mast'],
  ['tre', 'Tampere'],
]);

const GERMAN_PHRASES = [
  ['Historisches Rathaus', 'Historic Town Hall'],
  ['Marktplatz', 'Market Square'],
  ['Rathaus', 'Town Hall'],
];

/** Upstream place spellings with a different English name. */
const PLACE_NAMES = new Map([
  ['Montréal', 'Montreal'],
  ['Québec', 'Quebec City'],
]);

/** Upstream provider names, in English. */
const PROVIDER_NAMES = new Map([
  ['Transpordiamet (Tarktee)', 'Estonian Transport Administration (Tarktee)'],
  ['Transpordiamet', 'Estonian Transport Administration'],
  ['Stadt Warendorf', 'City of Warendorf'],
]);

const LETTER = '\\p{L}\\p{N}';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace `phrase` as a whole phrase (not inside a longer word). */
function replacePhrase(text, phrase, english) {
  const pattern = new RegExp(
    `(?<![${LETTER}])${escapeRegExp(phrase)}(?![${LETTER}])`,
    'giu',
  );
  return text.replace(pattern, english);
}

/**
 * Replace whole words found in `words` (keys are lower case). A word joined
 * to another by a hyphen is part of a name ("Länsi-Pakila") and stays.
 */
function replaceWords(text, words) {
  return text.replace(/[\p{L}][\p{L}\p{N}]*\.?/gu, (token, offset) => {
    if (text[offset - 1] === '-' || text[offset + token.length] === '-')
      return token;
    const exact = words.get(token.toLowerCase());
    if (exact) return exact;
    if (token.endsWith('.')) {
      const bare = words.get(token.slice(0, -1).toLowerCase());
      if (bare) return `${bare}.`;
    }
    return token;
  });
}

/** One space around joins and before brackets; no doubled spaces. */
function tidy(text) {
  return text
    .replace(/\s*–\s*/g, ' – ')
    .replace(/([^\s(])\(/g, '$1 (')
    .replace(/\)(?=[\p{L}\p{N}])/gu, ') ')
    .replace(/\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Split "Sõpruse pst-Endla tn" into "Sõpruse pst - Endla tn": a hyphen joins
 * two streets when the word before it is a street type, while compound names
 * ("Suur-Ameerika", "Vana-Kalamaja") keep theirs.
 */
function separateEstonianStreets(text) {
  return text
    .replace(/\s+-\s*|\s*-\s+/g, ' - ')
    .replace(/(\S+)-(?=\S)/g, (match, word) =>
      ESTONIAN_STREET_END.test(word) ? `${word} - ` : match,
    );
}

function capitalizeFirst(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function englishEstonian(name) {
  let text = separateEstonianStreets(tidy(name));
  for (const [phrase, english] of ESTONIAN_PHRASES)
    text = replacePhrase(text, phrase, english);
  return capitalizeFirst(tidy(replaceWords(text, ESTONIAN_WORDS)));
}

function englishFinnish(name) {
  let text = tidy(name);
  for (const [pattern, english] of FINNISH_ROADS) {
    if (pattern.test(text)) {
      text = text.replace(pattern, english);
      break;
    }
  }
  for (const [phrase, english] of FINNISH_PHRASES)
    text = replacePhrase(text, phrase, english);
  return tidy(replaceWords(text, FINNISH_WORDS)).replace(/,\s*$/, '');
}

function englishGerman(name) {
  let text = tidy(name);
  for (const [phrase, english] of GERMAN_PHRASES)
    text = replacePhrase(text, phrase, english);
  return text;
}

/**
 * A camera's name in English.
 * @param {string} name - Upstream camera name.
 * @param {string} [cityId] - The camera's pack id (catalog `cityId`).
 * @returns {string}
 */
export function englishCameraName(name, cityId = '') {
  const text = String(name ?? '').trim();
  if (!text) return text;
  const pack = String(cityId || '').toLowerCase();
  if (ESTONIAN.test(pack)) return englishEstonian(text);
  if (FINNISH.test(pack)) return englishFinnish(text);
  if (GERMAN.test(pack)) return englishGerman(text);
  return text;
}

/** Same limit as the server's CAMERA_CODE_MAX_CHARS. */
const CAMERA_CODE_MAX_CHARS = 28;

/**
 * The short "CAM-<code>" label for a translated camera, built from its
 * English name by the server's rule (cameraDisplayCode): upper case, cut to
 * 28 characters with an ellipsis.
 * @param {string} englishName
 * @returns {string}
 */
export function englishCameraCode(englishName) {
  const clean = String(englishName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (clean.length <= CAMERA_CODE_MAX_CHARS) return clean;
  return `${clean.slice(0, CAMERA_CODE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Camera id prefixes of the packs above (server/providers/cctv/sources.js). */
const PACK_BY_ID_PREFIX = [
  ['tln-', 'tallinn'],
  ['ee-tarktee-', 'estonia'],
  ['fi-', 'finland'],
  ['warendorf-', 'warendorf'],
];

/**
 * The pack a camera id belongs to, for callers that hold only the id and
 * name (AI Watch notifications); '' when the id says nothing.
 * @param {string} cameraId
 * @returns {string}
 */
export function cameraPackForId(cameraId) {
  const id = String(cameraId || '').toLowerCase();
  return PACK_BY_ID_PREFIX.find(([prefix]) => id.startsWith(prefix))?.[1] || '';
}

/**
 * A place's English name: "Montréal" → "Montreal"; anything else unchanged.
 * Works on a leading place inside a longer label ("Montréal (Ville-Marie)").
 * @param {string} name
 * @returns {string}
 */
export function englishPlaceName(name) {
  const text = String(name ?? '');
  for (const [local, english] of PLACE_NAMES) {
    if (text === local) return english;
    if (text.startsWith(`${local} `) || text.startsWith(`${local},`))
      return english + text.slice(local.length);
  }
  return text;
}

/**
 * A camera operator's name in English ("Stadt Warendorf" → "City of
 * Warendorf"); unknown names pass through.
 * @param {string} provider
 * @returns {string}
 */
export function englishProviderName(provider) {
  const text = String(provider ?? '');
  return PROVIDER_NAMES.get(text) || text;
}
