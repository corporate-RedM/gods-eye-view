/**
 * The evidence model for CCTV Watch, put together: describer readings become
 * observations, observations change per-camera conditions, conditions and
 * official reports form incidents, and the readings behind an incident are
 * saved as evidence for seven days.
 *
 * Nothing here decides what to look at; it only records what was seen, so
 * the same rules hold whatever the sweep, focus or reports send in.
 */
import { createConditionTracker } from './conditions.js';
import { createIncidentBook } from './incidents.js';
import { readingObservations } from './observations.js';

/** Condition changes that make a reading part of an incident's evidence. */
const EVIDENCE_CHANGES = new Set([
  'opened',
  'upgraded',
  'changed',
  'persisted',
  'conflict',
  'ruled_out',
  'ended',
  'late',
]);
/** Retention for incidents, conditions and saved evidence. */
const RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * @param {object} options
 * @param {object} options.events - loadWatchEvents result.
 * @param {object} options.thresholds - loadWatchThresholds result.
 * @param {object} options.store - createEvidenceStore instance.
 * @param {(cameraId: string) => object|null} [options.cameraById]
 * @param {(cameraId: string) => object|null} [options.profileOf]
 */
export function createEvidenceModel({
  events,
  thresholds,
  store,
  cameraById = () => null,
  profileOf = () => null,
  now = Date.now,
} = {}) {
  const conditions = createConditionTracker({ events });
  // Two catalog ids for the same stream are one view, not two witnesses.
  const sameView = (a, b) => {
    if (a === b) return true;
    const first = cameraById(a);
    const second = cameraById(b);
    return Boolean(first?.url && first.url === second?.url);
  };
  const book = createIncidentBook({
    events,
    conditionById: (id) => conditions.get(id),
    cameraById,
    profileOf,
    sameView,
    cameraConfidenceCap: thresholds.cameraConfidenceCap,
    now,
  });
  const totals = {
    readings: 0,
    observations: 0,
    changes: 0,
    evidence: 0,
    verified: 0,
    withdrawn: 0,
    unverified: 0,
    dropped: 0,
  };
  /** Contexts that count against some claims (thresholds config). */
  const contexts = thresholds.supportAgainst ?? [];
  /** `${cameraId}:${context}` -> when that context was last seen there. */
  const contextSeenAt = new Map();

  /**
   * Supporting evidence against a claim: a work zone in view explains drums,
   * crews and stopped work vehicles. It never rejects the claim.
   */
  function supportFor(observation) {
    const against = [];
    for (const { context, types, withinMs } of contexts) {
      const seen = contextSeenAt.get(`${observation.cameraId}:${context}`);
      if (
        types.has(observation.type) &&
        seen !== undefined &&
        Math.abs(observation.at - seen) <= withinMs
      ) {
        const label = events.observations.get(context)?.label ?? context;
        against.push(`${label.toLowerCase()} in view`);
      }
    }
    return against;
  }

  function withSupport(observations, extra = {}) {
    for (const observation of observations) {
      if (
        observation.result === 'present' &&
        contexts.some((entry) => entry.context === observation.type)
      )
        contextSeenAt.set(
          `${observation.cameraId}:${observation.type}`,
          observation.at,
        );
    }
    return observations.map((observation) => {
      if (observation.result !== 'present') return observation;
      const against = supportFor(observation);
      if (!against.length && !Object.keys(extra).length) return observation;
      return { ...observation, support: { ...extra, against } };
    });
  }
  /** cameraId -> times of its recent readings, to say how much footage a look covered. */
  const readingTimes = new Map();
  const READING_MEMORY_MS = 3 * 60 * 60_000;

  function noteReading(cameraId, at) {
    const times = readingTimes.get(cameraId) || [];
    times.push(at);
    while (times.length && times[0] < at - READING_MEMORY_MS) times.shift();
    readingTimes.set(cameraId, times);
  }

  /** A report-triggered look at one camera ended: record what it found. */
  function recordReportLook(session) {
    const at = now();
    const reportId = String(session.ref || '').split('@')[0];
    if (!reportId) return;
    const from = session.startedAt;
    const readings = (readingTimes.get(session.cameraId) || []).filter(
      (time) => time >= from && time <= at,
    ).length;
    const seen = conditions
      .all()
      .filter(
        (condition) =>
          condition.cameraId === session.cameraId &&
          condition.confidence !== 'ruled_out' &&
          (condition.lastPresentAt ?? condition.firstSeenAt) >= from &&
          condition.firstSeenAt <= at,
      );
    book.recordInspection(reportId, {
      cameraId: session.cameraId,
      from,
      to: at,
      readings,
      conditions: seen,
    });
  }

  function applyChanges(changes, record = null) {
    const touched = book.applyConditionChanges(changes);
    totals.changes += changes.length;
    if (!record) return touched;
    for (const { condition, change } of changes) {
      if (!EVIDENCE_CHANGES.has(change)) continue;
      const incidentId = book.incidentOfCondition(condition.id);
      if (!incidentId) continue;
      store.saveReading(incidentId, record);
      totals.evidence += 1;
    }
    return touched;
  }

  return {
    /**
     * One describer reading from triage.
     * @param {object} record - Reading record (with readingId, jpegs and, for clips, segments).
     * @returns {string[]} Ids of incidents that changed.
     */
    onReading(record) {
      noteReading(record.cameraId, record.analyzedAt ?? now());
      // Claims waiting for their narrow question are left out until it answers.
      const observations = withSupport(
        readingObservations(record, {
          events,
          thresholds,
          skipTypes: record.pendingVerification ?? [],
        }),
      );
      if (!observations.length) return [];
      totals.readings += 1;
      totals.observations += observations.length;
      return applyChanges(conditions.apply(observations), record);
    },

    /**
     * A held claim's narrow question answered, or not. Only an answer that
     * the thing is not there withdraws the claim (the same frame, so never
     * contrary evidence). Anything short of an answer (unclear, a movement
     * question one frame could not settle, a failed or dropped check) leaves
     * the claim as it was read, marked unverified and held at possible
     * (BK, 2026-10-08: unverified observations stay available as possible).
     * A present answer makes an unclear reading present. Measurements are
     * recorded but not yet weighed: they have not been validated.
     */
    onVerification({ record, type, arm, verdict, dropped, error }) {
      const item = record.reading?.observations?.find(
        (entry) => entry.type === type,
      );
      if (verdict) totals.verified += 1;
      else totals.dropped += 1;
      if (verdict?.result === 'absent') {
        totals.withdrawn += 1;
        return [];
      }
      if (!item) return [];
      const answered = verdict?.result === 'present';
      let unverified = null;
      if (!answered) {
        if (verdict?.asked === false) unverified = verdict.reason;
        else if (verdict) unverified = 'the check could not settle it';
        else if (dropped) unverified = `not checked: ${dropped}`;
        else unverified = error ? 'the check failed' : 'not checked';
        totals.unverified += 1;
      }
      const single = {
        ...record,
        reading: {
          ...record.reading,
          observations: [
            { ...item, result: answered ? 'present' : item.result },
          ],
        },
        checkedTypes: [],
        pendingVerification: [],
      };
      const observations = withSupport(
        readingObservations(single, { events, thresholds }),
        {
          verification: verdict
            ? {
                arm,
                answer: verdict.answer,
                confidence: verdict.confidence,
                reason: verdict.reason,
              }
            : null,
          measured: verdict?.facts ?? null,
          ...(unverified ? { unverified } : {}),
        },
      );
      if (!observations.length) return [];
      return applyChanges(conditions.apply(observations), record);
    },

    /** A report watcher change: new, updated or cleared. */
    onReport(change) {
      return book.applyReportChange(change);
    },

    /**
     * Focused monitoring on a camera ended. A look started by a report also
     * records what the footage showed, "reported event not visible in
     * inspected footage" included; that is never counted against the report.
     */
    onFocusEnd(session) {
      const touched = applyChanges(
        conditions.focusEnded(session.cameraId, session.startedAt),
      );
      if (session.trigger === 'report') recordReportLook(session);
      return touched;
    },

    /**
     * Mark conditions quiet when nothing decisive arrives; silence never ends one.
     * @param {(cameraId: string) => string} reasonFor - Why a camera has no fresh reading.
     */
    tick(reasonFor) {
      return applyChanges(conditions.tick(now(), reasonFor));
    },

    /** Whether a camera has a condition still open, so its frames need reading. */
    needsFollowUp: (cameraId) => conditions.hasOpen(cameraId),

    list: (options) => book.list(options),
    get: (incidentId) => book.get(incidentId),
    evidenceFor: (incidentId) => store.evidenceFor(incidentId),
    setVerdict: (incidentId, value) => book.setVerdict(incidentId, value),
    link: (a, b) => book.link(a, b),
    unlink: (a, b) => book.unlink(a, b),
    merge(intoId, fromId) {
      const merged = book.merge(intoId, fromId);
      if (merged) store.merged(intoId, fromId);
      return merged;
    },

    /** Save incident metadata with its evidence; forget what is past retention. */
    maintain({ prune = false } = {}) {
      const at = now();
      if (prune) {
        conditions.forget(at - RETENTION_MS);
        book.forget(at - RETENTION_MS);
        store.prune();
      }
      return store.saveIncidents(book.list({ since: 0, at }).incidents);
    },

    stats() {
      const { incidents } = book.list({ since: 0 });
      const byState = {};
      for (const incident of incidents)
        byState[incident.state] = (byState[incident.state] || 0) + 1;
      return {
        ...totals,
        incidents: incidents.length,
        byState,
        evidenceStore: store.stats(),
      };
    },
  };
}
