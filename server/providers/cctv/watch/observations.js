/**
 * Observations for CCTV Watch: one describer reading's answer about one
 * observation type at one camera.
 *
 * Strength comes from the calibrated thresholds, never from repetition:
 * - unclear: the describer could not tell.
 * - possible: present, below the type's likely threshold or in poor light.
 * - likely: present at or above the type's threshold, with adequate visibility.
 * - confirmed: present at or above the type's single-source threshold in good
 *   visibility. Only types calibrated for it have that threshold.
 *
 * A type the reading was asked about but did not list is absent only when
 * the picture was clear and the reading's evidence could show it: a single
 * still says nothing about motion, and a dark frame says nothing at all.
 */

export const STRENGTH_RANK = Object.freeze({
  unclear: 0,
  possible: 1,
  likely: 2,
  confirmed: 3,
});

/** How much a reading can show: a clip beats a pair of stills beats one still. */
export const EVIDENCE_ORDER = Object.freeze({ still: 0, pair: 1, clip: 2 });

/** Visibility good enough for a "likely" reading. */
const ADEQUATE_VISIBILITY = new Set(['good', 'reduced']);

/**
 * Whether a reading of this mode can show an observation type either way.
 * @param {string} mode - still | pair | clip.
 * @param {{evidence:string}} spec - Observation spec.
 */
export function modeCanShow(mode, spec) {
  if (!(mode in EVIDENCE_ORDER)) return false;
  if (spec.evidence === 'clip') return mode === 'clip';
  if (spec.evidence === 'motion') return mode !== 'still';
  return true;
}

/**
 * Strength of one listed answer.
 * @param {{type:string, result:string, confidence:number}} item
 * @param {string} visibility - good | reduced | poor | unknown.
 * @param {object} thresholds - loadWatchThresholds result.
 */
export function strengthOf(item, visibility, thresholds) {
  if (item.result !== 'present') return 'unclear';
  const single = thresholds.singleSourceConfirm(item.type);
  if (single !== null && item.confidence >= single && visibility === 'good')
    return 'confirmed';
  const likely = thresholds.likely(item.type);
  if (
    likely !== null &&
    item.confidence >= likely &&
    ADEQUATE_VISIBILITY.has(visibility)
  )
    return 'likely';
  return 'possible';
}

/**
 * Turn one describer reading into observations.
 * @param {object} record - Reading record from triage.
 * @param {{events:object, thresholds:object, skipTypes?:Iterable<string>}} context
 *   skipTypes: claims held for verification, left out entirely.
 * @returns {object[]} Observations, listed answers first.
 */
export function readingObservations(
  record,
  { events, thresholds, skipTypes = [] },
) {
  const reading = record.reading;
  if (!reading?.ok || !(record.mode in EVIDENCE_ORDER)) return [];
  const skip = new Set(skipTypes);
  const base = {
    cameraId: record.cameraId,
    mode: record.mode,
    origin: record.origin,
    at: record.captureTime ?? record.fetchedAt,
    timeSource: record.captureTime ? record.captureSource : 'fetch-time',
    captureTime: record.captureTime ?? null,
    fetchedAt: record.fetchedAt,
    analyzedAt: record.analyzedAt,
    visibility: reading.visibility,
    visibilityIssues: reading.visibilityIssues || [],
    readingId: record.readingId ?? null,
  };
  const screened = new Set(
    (record.screen?.candidates || []).map((candidate) => candidate.type),
  );
  const listed = new Set();
  const out = [];
  for (const item of reading.observations) {
    const spec = events.observations.get(item.type);
    if (!spec) continue;
    listed.add(item.type);
    if (skip.has(item.type)) continue;
    out.push({
      ...base,
      type: item.type,
      result: item.result,
      confidence: item.confidence,
      strength: strengthOf(item, reading.visibility, thresholds),
      enforced: item.enforced ?? null,
      screened: screened.has(item.type),
      detail: item.detail || '',
      count: item.count ?? null,
      density: item.density ?? null,
    });
  }
  if (reading.visibility !== 'good') return out;
  for (const type of record.checkedTypes || []) {
    const spec = events.observations.get(type);
    if (listed.has(type) || !spec || !modeCanShow(record.mode, spec)) continue;
    out.push({
      ...base,
      type,
      result: 'absent',
      confidence: null,
      strength: null,
      enforced: null,
      screened: screened.has(type),
      detail: '',
      count: null,
      density: null,
    });
  }
  return out;
}
