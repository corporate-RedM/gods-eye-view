/**
 * Causes for CCTV Watch: explanations of what cameras and reports show,
 * offered only when the evidence supports them.
 *
 * A cause appears only when one of its support rules from config holds.
 * Observations in a cause's neverAlone list can support it only in
 * combination; the config loader refuses a rule that breaks that. Each cause
 * has its own confidence:
 * - a strong rule takes the weakest of its terms, a moderate rule one step
 *   below that, and a weak rule "possible";
 * - camera evidence at likely or above together with an official report
 *   corroborate each other, which confirms the cause.
 *
 * The headline names the observed condition. A cause is added to it only
 * once that cause is likely, and other explanations stay listed beside it.
 */
import { SUITABILITY_MIN } from './events.js';

export const LEVELS = Object.freeze(['possible', 'likely', 'confirmed']);
const LEVEL = Object.freeze({ possible: 0, likely: 1, confirmed: 2 });
const WEIGHT_STEP = Object.freeze({ strong: 0, moderate: 1 });

/** Profile terms usable in support rules, and the profile share behind each. */
const PROFILE_TERMS = Object.freeze({
  slope: 'slopeOrCliff',
  vegetation: 'vegetation',
});

/** Confidence order for headlines: established conditions lead. */
const HEADLINE_CONFIDENCE = Object.freeze({
  confirmed: 4,
  likely: 3,
  possible: 2,
  inconclusive: 1,
});
const URGENCY_ORDER = Object.freeze({ high: 3, medium: 2, low: 1 });

function ruleTerms(rule) {
  if (rule.observation) return [rule.observation];
  if (rule.report) return [`report:${rule.report}`];
  return rule.allOf;
}

const isObservationTerm = (term) => !term.includes(':');

/**
 * Confidence level of one support term, or -1 when it does not hold.
 * @param {string} term
 * @param {object} evidence - See evaluateCauses.
 * @param {number} [cameras] - Distinct cameras the observation must be seen on.
 */
function termLevel(term, evidence, cameras = 1) {
  if (term.startsWith('report:')) {
    const kind = term.slice(7);
    let level = -1;
    for (const report of evidence.reports || [])
      if (report.kind === kind)
        level = Math.max(level, report.official ? LEVEL.likely : 0);
    for (const report of evidence.areaReports || [])
      if (report.kind === kind) level = Math.max(level, 0);
    return level;
  }
  if (term.startsWith('context:'))
    return evidence.context?.has(term.slice(8)) ? 0 : -1;
  if (term.startsWith('profile:')) {
    const field = PROFILE_TERMS[term.slice(8)];
    return field &&
      (evidence.profiles || []).some(
        (profile) => (profile?.[field] ?? 0) >= SUITABILITY_MIN,
      )
      ? 0
      : -1;
  }
  const condition = evidence.conditions.get(term);
  const level = LEVEL[condition?.confidence];
  if (level === undefined) return -1;
  return (condition.cameras?.length ?? 0) >= cameras ? level : -1;
}

const officialMemberReport = (term, evidence) =>
  term.startsWith('report:') &&
  (evidence.reports || []).some(
    (report) => report.kind === term.slice(7) && report.official,
  );

/**
 * Causes supported by an incident's evidence.
 * @param {object} events - loadWatchEvents result.
 * @param {object} evidence
 * @param {Map<string, {confidence:string, cameras:string[]}>} evidence.conditions - Incident conditions by type.
 * @param {{kind:string, official:boolean}[]} [evidence.reports] - Evidence reports in the incident.
 * @param {{kind:string}[]} [evidence.areaReports] - Warnings whose area covers the incident.
 * @param {Set<string>} [evidence.context] - Context terms, such as scheduled_event.
 * @param {object[]} [evidence.profiles] - Profile summaries of the incident's cameras.
 * @returns {{causes:object[], explanations:object[]}}
 */
export function evaluateCauses(events, evidence) {
  const causes = [];
  for (const cause of events.causes.values()) {
    const satisfied = [];
    for (const rule of cause.support) {
      const terms = ruleTerms(rule);
      const levels = terms.map((term) =>
        termLevel(term, evidence, rule.observation ? (rule.cameras ?? 1) : 1),
      );
      if (levels.some((level) => level < 0)) continue;
      const weakest = Math.min(...levels);
      const level =
        rule.weight === 'weak'
          ? 0
          : Math.max(0, weakest - WEIGHT_STEP[rule.weight]);
      const cameraLevels = terms
        .map((term, index) => (isObservationTerm(term) ? levels[index] : null))
        .filter((value) => value !== null);
      satisfied.push({
        terms,
        weight: rule.weight,
        level,
        cameraLevel: cameraLevels.length ? Math.min(...cameraLevels) : null,
        official: terms.some((term) => officialMemberReport(term, evidence)),
      });
    }
    if (!satisfied.length) continue;
    let level = Math.max(...satisfied.map((item) => item.level));
    // Camera evidence and an official report are independent sources.
    const cameraLikely = satisfied.some(
      (item) => item.cameraLevel !== null && item.cameraLevel >= LEVEL.likely,
    );
    const officialLikely = satisfied.some(
      (item) => item.official && item.level >= LEVEL.likely,
    );
    if (cameraLikely && officialLikely) level = LEVEL.confirmed;
    causes.push({
      id: cause.id,
      label: cause.label,
      group: cause.group,
      urgency: cause.urgency,
      confidence: LEVELS[level],
      support: satisfied.map(({ terms, weight, level: ruleLevel }) => ({
        terms,
        weight,
        confidence: LEVELS[ruleLevel],
      })),
    });
  }
  causes.sort(
    (a, b) =>
      LEVEL[b.confidence] - LEVEL[a.confidence] ||
      URGENCY_ORDER[b.urgency] - URGENCY_ORDER[a.urgency],
  );

  // Other explanations for what was seen, such as a scheduled event beside
  // people running.
  const explanations = [];
  for (const cause of events.causes.values()) {
    if (!cause.alternatives.length) continue;
    const related = [
      ...cause.support.flatMap(ruleTerms),
      ...cause.neverAlone,
    ].filter(isObservationTerm);
    const seen = related.filter((type) => {
      const condition = evidence.conditions.get(type);
      return condition && LEVEL[condition.confidence] !== undefined;
    });
    if (!seen.length) continue;
    for (const alternative of cause.alternatives)
      if (evidence.context?.has(alternative.context))
        explanations.push({
          cause: cause.id,
          observations: [...new Set(seen)],
          label: alternative.label,
        });
  }
  return { causes, explanations };
}

/**
 * Headline for an incident: the observed condition first, a cause only once
 * it is likely. Established conditions lead, then the more urgent, then the
 * more certain; a lasting thing on the road leads its traffic effect.
 * @param {object} incident
 * @param {object[]} incident.conditions - Incident conditions: {type, label, urgency, confidence, persistence}.
 * @param {object[]} incident.reports - Evidence reports: {kind, label}.
 * @param {object[]} incident.causes - From evaluateCauses.
 * @returns {{text:string, condition:string|null, cause:string|null}}
 */
export function headlineFor({ conditions, reports, causes }) {
  const shown = conditions
    .filter((condition) => HEADLINE_CONFIDENCE[condition.confidence])
    .sort(
      (a, b) =>
        (HEADLINE_CONFIDENCE[b.confidence] >= HEADLINE_CONFIDENCE.possible) -
          (HEADLINE_CONFIDENCE[a.confidence] >= HEADLINE_CONFIDENCE.possible) ||
        URGENCY_ORDER[b.urgency] - URGENCY_ORDER[a.urgency] ||
        HEADLINE_CONFIDENCE[b.confidence] - HEADLINE_CONFIDENCE[a.confidence] ||
        (a.persistence === 'transient') - (b.persistence === 'transient'),
    );
  if (!shown.length)
    return {
      text: reports[0]?.label || 'No current evidence',
      condition: null,
      cause: null,
    };
  const [primary, secondary] = shown;
  let text = secondary
    ? `${primary.label} with ${secondary.label.toLowerCase()}`
    : primary.label;
  const cause = causes.find((item) => LEVEL[item.confidence] >= LEVEL.likely);
  if (cause) text = `${text} — ${cause.confidence} ${cause.label}`;
  return { text, condition: primary.type, cause: cause?.id ?? null };
}
