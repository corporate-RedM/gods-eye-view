/**
 * CCTV Watch event definitions: validation of config/cctv_watch_events.json
 * and config/cctv_watch_thresholds.json, and the rules for which observation
 * types a camera is checked for.
 *
 * Gating follows what a camera can show, but never permanently: unknown
 * profile fields allow a type, and audits and patrol samples ignore gating so
 * a camera first judged unsuitable keeps a way back in.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const EVIDENCE_KINDS = Object.freeze(['still', 'motion', 'clip']);
export const SCENE_REQUIREMENTS = Object.freeze([
  'any',
  'road',
  'pedestrian',
  'people',
]);
export const URGENCY = Object.freeze({ low: 1, medium: 2, high: 3 });
export const SUPPORT_WEIGHTS = Object.freeze({
  strong: 1,
  moderate: 0.5,
  weak: 0.25,
});
export const REPORT_ROLES = Object.freeze(['evidence', 'context']);
export const PERSISTENCE = Object.freeze(['lasting', 'transient']);
export const CAMERA_CONFIDENCE_CAPS = Object.freeze(['possible', 'likely']);
export const VERIFY_RESULTS = Object.freeze(['present', 'absent', 'unclear']);

/** Suitability below this share of profile samples gates a type out. */
export const SUITABILITY_MIN = 0.3;

function fail(message) {
  throw new Error(`cctv_watch_events.json: ${message}`);
}

function supportTerms(item) {
  if (item.observation) return [item.observation];
  if (item.report) return [`report:${item.report}`];
  if (Array.isArray(item.allOf)) return item.allOf;
  return [];
}

/**
 * Validate and index the event definitions.
 * @param {object} json - Parsed config/cctv_watch_events.json.
 * @returns {{groups:object, observations:Map<string,object>, causes:Map<string,object>, reports:Map<string,object>, links:object}}
 */
export function loadWatchEvents(json) {
  if (!json || json.version !== 1) fail('version must be 1');
  const groups = json.groups || {};
  const observations = new Map();
  for (const [id, spec] of Object.entries(json.observations || {})) {
    if (!groups[spec.group]) fail(`${id}: unknown group ${spec.group}`);
    if (!EVIDENCE_KINDS.includes(spec.evidence))
      fail(`${id}: evidence must be one of ${EVIDENCE_KINDS.join(', ')}`);
    if (!SCENE_REQUIREMENTS.includes(spec.scene))
      fail(`${id}: scene must be one of ${SCENE_REQUIREMENTS.join(', ')}`);
    if (!URGENCY[spec.urgency]) fail(`${id}: unknown urgency ${spec.urgency}`);
    if (typeof spec.describe !== 'string' || !spec.describe)
      fail(`${id}: describe text is required`);
    if (
      spec.persistence !== undefined &&
      !PERSISTENCE.includes(spec.persistence)
    )
      fail(`${id}: persistence must be lasting or transient`);
    observations.set(id, {
      id,
      label: spec.label || id,
      group: spec.group,
      evidence: spec.evidence,
      scene: spec.scene,
      urgency: spec.urgency,
      condition: spec.condition !== false,
      persistence:
        spec.persistence ??
        (spec.evidence === 'still' ? 'lasting' : 'transient'),
      ends: Array.isArray(spec.ends) ? spec.ends : [],
      measure: spec.measure || null,
      phrases: Array.isArray(spec.phrases) ? spec.phrases : [],
      describe: spec.describe,
    });
  }
  for (const spec of observations.values())
    for (const ended of spec.ends)
      if (!observations.has(ended))
        fail(`${spec.id}: ends unknown observation ${ended}`);

  const reports = new Map();
  for (const [id, spec] of Object.entries(json.reports || {})) {
    if (!REPORT_ROLES.includes(spec.role))
      fail(`report ${id}: role must be evidence or context`);
    const agrees = Array.isArray(spec.agrees) ? spec.agrees : [];
    for (const type of agrees)
      if (!observations.has(type))
        fail(`report ${id}: agrees with unknown observation ${type}`);
    if (agrees.length && spec.role !== 'evidence')
      fail(`report ${id}: only evidence reports can agree with observations`);
    if (spec.urgency !== undefined && !URGENCY[spec.urgency])
      fail(`report ${id}: unknown urgency ${spec.urgency}`);
    reports.set(id, {
      id,
      label: spec.label || id,
      ...spec,
      urgency: spec.urgency || 'low',
      agrees,
    });
  }

  const known = (term) => {
    if (term.startsWith('report:')) return reports.has(term.slice(7));
    if (term.startsWith('context:') || term.startsWith('profile:')) return true;
    return observations.has(term);
  };
  const causes = new Map();
  for (const [id, spec] of Object.entries(json.causes || {})) {
    if (!groups[spec.group]) fail(`cause ${id}: unknown group ${spec.group}`);
    if (!URGENCY[spec.urgency])
      fail(`cause ${id}: unknown urgency ${spec.urgency}`);
    const support = Array.isArray(spec.support) ? spec.support : [];
    if (!support.length) fail(`cause ${id}: needs at least one support rule`);
    const neverAlone = Array.isArray(spec.neverAlone) ? spec.neverAlone : [];
    for (const item of support) {
      if (!SUPPORT_WEIGHTS[item.weight])
        fail(`cause ${id}: support weight must be strong, moderate or weak`);
      const terms = supportTerms(item);
      if (!terms.length) fail(`cause ${id}: empty support rule`);
      for (const term of terms)
        if (!known(term)) fail(`cause ${id}: unknown support term ${term}`);
      // A type listed as never establishing the cause on its own may only
      // appear inside an allOf combination.
      if (terms.length === 1 && neverAlone.includes(terms[0]))
        fail(`cause ${id}: ${terms[0]} is listed in neverAlone`);
    }
    causes.set(id, {
      id,
      label: spec.label || id,
      group: spec.group,
      urgency: spec.urgency,
      support,
      neverAlone,
      alternatives: Array.isArray(spec.alternatives) ? spec.alternatives : [],
    });
  }

  // Narrow questions that check one claim with closer evidence. Every answer
  // maps to present, absent or unclear, so a verifier cannot invent a type.
  // Each wording matches the images it goes with: `question` with a close-up
  // (plus `sequenceNote` only when other frames are supplied), `sceneQuestion`
  // with the whole frame alone. A question about movement (`needsFrames`) is
  // asked only with several frames, so it has no single-frame wording.
  const verify = new Map();
  for (const [id, spec] of Object.entries(json.verify || {})) {
    if (!observations.has(id)) fail(`verify ${id}: unknown observation`);
    if (typeof spec.question !== 'string' || !spec.question)
      fail(`verify ${id}: question is required`);
    if (typeof spec.sequence !== 'boolean')
      fail(`verify ${id}: sequence must be true or false`);
    const needsFrames = spec.needsFrames ?? false;
    if (typeof needsFrames !== 'boolean')
      fail(`verify ${id}: needsFrames must be true or false`);
    if (needsFrames && !spec.sequence)
      fail(`verify ${id}: a question that needs frames must use the sequence`);
    if (
      !needsFrames &&
      (typeof spec.sceneQuestion !== 'string' || !spec.sceneQuestion)
    )
      fail(
        `verify ${id}: sceneQuestion is required unless the question needs frames`,
      );
    if (
      spec.sequenceNote !== undefined &&
      (typeof spec.sequenceNote !== 'string' || !spec.sequence)
    )
      fail(
        `verify ${id}: sequenceNote must be text, on a question that uses the sequence`,
      );
    const answers = Object.entries(spec.answers || {});
    for (const [answer, result] of answers)
      if (!VERIFY_RESULTS.includes(result))
        fail(
          `verify ${id}: answer ${answer} must map to present, absent or unclear`,
        );
    const results = new Set(answers.map(([, result]) => result));
    if (!VERIFY_RESULTS.every((result) => results.has(result)))
      fail(`verify ${id}: answers must include present, absent and unclear`);
    verify.set(id, {
      question: spec.question,
      ...(spec.sequenceNote ? { sequenceNote: spec.sequenceNote } : {}),
      ...(needsFrames ? {} : { sceneQuestion: spec.sceneQuestion }),
      needsFrames,
      sequence: spec.sequence,
      answers: Object.fromEntries(answers),
    });
  }
  const neutral = json.screening?.neutral ?? [];
  if (
    !Array.isArray(neutral) ||
    neutral.some((phrase) => typeof phrase !== 'string' || !phrase)
  )
    fail('screening.neutral must be a list of phrases');
  return {
    groups,
    observations,
    causes,
    reports,
    links: json.links || {},
    verify,
    screening: { neutral },
  };
}

/**
 * Validate the threshold file and expose lookups with defaults.
 * @param {object} json - Parsed config/cctv_watch_thresholds.json.
 */
export function loadWatchThresholds(json) {
  if (!json || json.version !== 1)
    throw new Error('cctv_watch_thresholds.json: version must be 1');
  const table = (name) => json[name] || {};
  const lookup = (name) => (type) => {
    const values = table(name);
    const value = values[type] ?? values.default;
    return Number.isFinite(value) ? value : null;
  };
  const single = table('singleSourceConfirm');
  const cap = json.cameraConfidenceCap ?? null;
  if (cap !== null && !CAMERA_CONFIDENCE_CAPS.includes(cap))
    throw new Error(
      'cctv_watch_thresholds.json: cameraConfidenceCap must be possible or likely',
    );
  const verification = new Map();
  for (const arm of ['same', 'closer']) {
    const types = json.verification?.[arm] ?? [];
    if (!Array.isArray(types) || types.some((type) => typeof type !== 'string'))
      throw new Error(
        `cctv_watch_thresholds.json: verification.${arm} must be a list of types`,
      );
    for (const type of types) verification.set(type, arm);
  }
  const supportAgainst = [];
  for (const [context, entry] of Object.entries(
    json.supportAgainst?.contexts ?? {},
  )) {
    const types = entry?.types;
    if (
      !Array.isArray(types) ||
      types.some((type) => typeof type !== 'string') ||
      !(entry.withinMinutes > 0)
    )
      throw new Error(
        `cctv_watch_thresholds.json: supportAgainst.contexts.${context} needs types and withinMinutes`,
      );
    supportAgainst.push({
      context,
      types: new Set(types),
      withinMs: entry.withinMinutes * 60_000,
    });
  }
  return {
    status: json.status || 'provisional',
    screen: lookup('screen'),
    likely: lookup('likely'),
    /** How a claim of this type is checked: 'same' scene, 'closer' look, or null. */
    verification: (type) => verification.get(type) ?? null,
    /** Highest confidence camera evidence may reach without BK, or null. */
    cameraConfidenceCap: cap,
    /**
     * Contexts that count against claims of some types when seen at the same
     * camera: [{context, types, withinMs}]. Supporting evidence only.
     */
    supportAgainst,
    /** Confidence needed to confirm from one source, or null when not allowed. */
    singleSourceConfirm: (type) =>
      Number.isFinite(single[type]) ? single[type] : null,
    novelty: {
      review: json.novelty?.review ?? 0.35,
      learnMax: json.novelty?.learnMax ?? 0.25,
      warmupSamples: json.novelty?.warmupSamples ?? 20,
    },
  };
}

/** Read and validate both config files from a repo root. */
export function readWatchDefinitions(root) {
  const read = (name) =>
    JSON.parse(readFileSync(path.join(root, 'config', name), 'utf8'));
  return {
    events: loadWatchEvents(read('cctv_watch_events.json')),
    thresholds: loadWatchThresholds(read('cctv_watch_thresholds.json')),
  };
}

/**
 * Whether a camera profile allows a scene requirement. Unknown means allowed.
 * @param {string} scene - Observation scene requirement.
 * @param {object|null} profile - Summary from profiles.js.
 */
export function profileAllows(scene, profile) {
  if (scene === 'any' || !profile) return true;
  const share = (value) => (Number.isFinite(value) ? value : 1);
  if (scene === 'road') return share(profile.roadVisible) >= SUITABILITY_MIN;
  if (scene === 'pedestrian')
    return (
      share(profile.pedestrianAreaVisible) >= SUITABILITY_MIN ||
      share(profile.peopleUsable) >= SUITABILITY_MIN
    );
  if (scene === 'people') return share(profile.peopleUsable) >= SUITABILITY_MIN;
  return true;
}

/**
 * Observation types to check on one camera.
 * @param {object} events - loadWatchEvents result.
 * @param {object|null} profile - Camera profile summary.
 * @param {object} [options]
 * @param {boolean} [options.ungated=false] - Audits and patrol check everything.
 * @returns {object[]} Observation specs.
 */
export function applicableObservations(
  events,
  profile,
  { ungated = false } = {},
) {
  return [...events.observations.values()].filter(
    (spec) => ungated || profileAllows(spec.scene, profile),
  );
}

/** Ordinary-scene phrases each type's screening score is measured against. */
export function screeningNeutral(events) {
  return events.screening?.neutral ?? [];
}

/** Phrase sets for the screener: every observation that has phrases. */
export function screeningPrompts(events) {
  return [...events.observations.values()]
    .filter((spec) => spec.phrases.length)
    .map((spec) => ({ id: spec.id, phrases: spec.phrases }));
}

/**
 * Vocabulary for one describer reading. A single still cannot settle motion,
 * but motion types stay in the list so the describer can mark them unclear,
 * which is what sends a camera to video.
 * @param {object[]} specs - Observation specs (applicableObservations).
 */
export function readingVocabulary(specs) {
  return specs.map((spec) => ({
    id: spec.id,
    describe: spec.describe,
    evidence: spec.evidence,
  }));
}

/**
 * Screener scores that clear their thresholds, limited to what this camera
 * is checked for, highest first.
 * @param {Object<string, number>} scores - Screener output for one frame.
 * @param {object[]} specs - Applicable observation specs.
 * @param {object} thresholds - loadWatchThresholds result.
 * @returns {{type:string, score:number}[]}
 */
export function screenCandidates(scores, specs, thresholds) {
  const candidates = [];
  for (const spec of specs) {
    const score = scores?.[spec.id];
    const threshold = thresholds.screen(spec.id);
    if (Number.isFinite(score) && threshold !== null && score >= threshold)
      candidates.push({ type: spec.id, score });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

/** Whether an observation type can only be settled by motion. */
export function needsMotion(spec) {
  return spec?.evidence === 'motion' || spec?.evidence === 'clip';
}
