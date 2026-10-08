/**
 * Conditions for CCTV Watch: what observations establish at one camera over
 * time ("vehicle fire", "traffic stopped"). Confidence and state are kept
 * apart.
 *
 * Confidence
 * - The strongest single present reading sets it. More frames from the same
 *   camera show that a condition persists; they never raise it.
 * - Contrary evidence from the same moment counts only for lasting
 *   conditions (a fire cannot vanish in a minute; stopped traffic can):
 *   - a better look (a clip after stills) that covers every sighting rules
 *     the condition out;
 *   - an equally good look makes the readings conflict, and the condition is
 *     inconclusive until a better look settles it;
 *   - a weaker look is ignored.
 * - A suspicion that a clip could not settle either way is inconclusive.
 *
 * State
 * - ongoing: a fresh reading shows it present.
 * - ended: readings later than the last sighting show it gone: an explicit
 *   "traffic flowing" or "road clear", or absent on consecutive readings in
 *   good visibility. Ending never rules out what was seen earlier.
 * - no_recent_evidence: nothing decisive for a while, with the reason.
 * - monitoring_ended: focused monitoring finished without a decisive reading.
 * Silence never ends anything.
 */
import { EVIDENCE_ORDER, STRENGTH_RANK } from './observations.js';

export const CONDITION_STATES = Object.freeze([
  'ongoing',
  'ended',
  'no_recent_evidence',
  'monitoring_ended',
]);

/** Contrary evidence within this long of a sighting is "the same moment". */
export const SAME_MOMENT_MS = 2 * 60_000;
/** A still's unsettled suspicion can be answered by a clip for this long. */
export const SUSPICION_MS = 15 * 60_000;

const STRENGTH_NAMES = Object.keys(STRENGTH_RANK);
/** Evidence kept per condition: the first sighting plus the latest ones. */
const EVIDENCE_KEPT = 12;

/**
 * @param {object} options
 * @param {object} options.events - loadWatchEvents result.
 * @param {number} [options.quietAfterMs] - Nothing decisive this long: "no recent evidence".
 * @param {number} [options.endAfterAbsent] - Consecutive absent readings that end a condition.
 */
export function createConditionTracker({
  events,
  quietAfterMs = 15 * 60_000,
  endAfterAbsent = 2,
  sameMomentMs = SAME_MOMENT_MS,
  suspicionMs = SUSPICION_MS,
} = {}) {
  /** Open (not ended) condition per camera:type. */
  const open = new Map();
  /** The most recently ended condition per camera:type, for late readings. */
  const lastEnded = new Map();
  /** Every condition by id, ended ones included, until forgotten. */
  const all = new Map();
  /** Unsettled suspicions per camera:type: {at, kind, reason}. */
  const suspicions = new Map();
  let sequence = 0;

  const keyOf = (cameraId, type) => `${cameraId}:${type}`;
  const kindOf = (observation) => EVIDENCE_ORDER[observation.mode] ?? 0;
  /**
   * Supporting evidence against a claim (a work zone in view, say) never
   * rejects it, and a claim whose check could not settle it stays available;
   * either way the claim cannot raise confidence above possible on its own.
   */
  const strengthRank = (observation) => {
    const rank = STRENGTH_RANK[observation.strength];
    const held =
      observation.support?.against?.length || observation.support?.unverified;
    return held ? Math.min(rank, STRENGTH_RANK.possible) : rank;
  };

  function confidenceOf(condition) {
    if (condition.ruledOut) return 'ruled_out';
    if (condition.conflict) return 'inconclusive';
    const best = Math.max(...condition.bestByKind.slice(condition.floorKind));
    return best >= STRENGTH_RANK.possible
      ? STRENGTH_NAMES[best]
      : 'inconclusive';
  }

  function summary(observation) {
    return {
      at: observation.at,
      timeSource: observation.timeSource,
      fetchedAt: observation.fetchedAt,
      analyzedAt: observation.analyzedAt,
      mode: observation.mode,
      origin: observation.origin,
      result: observation.result,
      strength: observation.strength,
      confidence: observation.confidence,
      visibility: observation.visibility,
      detail: observation.detail,
      count: observation.count,
      density: observation.density,
      readingId: observation.readingId,
      // The narrow question's answer and any supporting evidence, kept so
      // the card can show why a claim stands where it does.
      support: observation.support ?? null,
    };
  }

  function keepEvidence(condition, observation) {
    condition.evidence.push(summary(observation));
    if (condition.evidence.length > EVIDENCE_KEPT)
      condition.evidence.splice(1, 1);
  }

  function openCondition(observation) {
    const spec = events.observations.get(observation.type);
    const present = observation.result === 'present';
    const condition = {
      id: `cond-${++sequence}`,
      cameraId: observation.cameraId,
      type: observation.type,
      label: spec.label,
      group: spec.group,
      urgency: spec.urgency,
      persistence: spec.persistence,
      confidence: null,
      state: 'ongoing',
      stateReason: null,
      bestByKind: [-1, -1, -1],
      floorKind: 0,
      bestKind: present ? kindOf(observation) : -1,
      conflict: null,
      ruledOut: null,
      firstSeenAt: observation.at,
      lastPresentAt: present ? observation.at : null,
      lastDecisiveAt: present ? observation.at : null,
      lastLookAt: observation.at,
      lastUnclear: present ? null : summary(observation),
      endedAt: null,
      endedBy: null,
      absentStreak: 0,
      sightings: present ? 1 : 0,
      measure: null,
      evidence: [summary(observation)],
    };
    if (present) {
      condition.bestByKind[kindOf(observation)] = strengthRank(observation);
      if (spec.measure)
        condition.measure = {
          count: observation.count,
          density: observation.density,
          at: observation.at,
        };
    }
    condition.confidence = confidenceOf(condition);
    open.set(keyOf(condition.cameraId, condition.type), condition);
    all.set(condition.id, condition);
    return condition;
  }

  function end(condition, at, reason) {
    condition.state = 'ended';
    condition.stateReason = null;
    condition.endedAt = at;
    condition.endedBy = reason;
    const key = keyOf(condition.cameraId, condition.type);
    open.delete(key);
    lastEnded.set(key, condition);
  }

  function onPresent(observation, changes) {
    const key = keyOf(observation.cameraId, observation.type);
    suspicions.delete(key);
    const condition = open.get(key);
    if (!condition) {
      const ended = lastEnded.get(key);
      if (ended && observation.at <= ended.endedAt) {
        // An older capture that arrived late: it belongs to the ended
        // condition's record and changes nothing now.
        keepEvidence(ended, observation);
        changes.push({ condition: ended, change: 'late' });
        return;
      }
      changes.push({ condition: openCondition(observation), change: 'opened' });
      return;
    }
    const kind = kindOf(observation);
    const before = condition.confidence;
    condition.sightings += 1;
    condition.absentStreak = 0;
    condition.lastPresentAt = Math.max(
      condition.lastPresentAt ?? -Infinity,
      observation.at,
    );
    condition.lastDecisiveAt = Math.max(
      condition.lastDecisiveAt ?? -Infinity,
      observation.at,
    );
    condition.lastLookAt = Math.max(condition.lastLookAt, observation.at);
    condition.bestKind = Math.max(condition.bestKind, kind);
    condition.bestByKind[kind] = Math.max(
      condition.bestByKind[kind],
      strengthRank(observation),
    );
    if (condition.conflict && kind > condition.conflict.kind) {
      // A better look settles the conflict; from now on only looks at least
      // that good set the confidence.
      condition.conflict = null;
      condition.floorKind = kind;
    }
    const spec = events.observations.get(observation.type);
    if (spec.measure && observation.at >= (condition.measure?.at ?? -Infinity))
      condition.measure = {
        count: observation.count,
        density: observation.density,
        at: observation.at,
      };
    condition.state = 'ongoing';
    condition.stateReason = null;
    condition.confidence = confidenceOf(condition);
    keepEvidence(condition, observation);
    const raised =
      (STRENGTH_RANK[condition.confidence] ?? -1) >
      (STRENGTH_RANK[before] ?? -1);
    changes.push({
      condition,
      change:
        condition.confidence === before
          ? 'persisted'
          : raised
            ? 'upgraded'
            : 'changed',
    });
  }

  function onUnclear(observation, changes) {
    const key = keyOf(observation.cameraId, observation.type);
    const condition = open.get(key);
    if (condition) {
      condition.lastLookAt = Math.max(condition.lastLookAt, observation.at);
      condition.lastUnclear = summary(observation);
      keepEvidence(condition, observation);
      changes.push({ condition, change: 'unclear' });
      return;
    }
    const suspicion = suspicions.get(key);
    if (observation.mode === 'clip') {
      // The better look could not tell either: the suspicion stays on record
      // as inconclusive instead of being dropped.
      if (
        suspicion &&
        observation.at >= suspicion.at &&
        observation.at - suspicion.at <= suspicionMs
      ) {
        suspicions.delete(key);
        changes.push({
          condition: openCondition(observation),
          change: 'opened',
        });
      }
      return;
    }
    // A still that suspects something it cannot settle (motion, or a
    // screener hit the describer could not confirm) waits for a clip.
    if (observation.enforced || observation.screened)
      suspicions.set(key, {
        at: observation.at,
        kind: EVIDENCE_ORDER[observation.mode],
        reason: observation.enforced || 'unclear',
      });
  }

  function onContrary(condition, observation, { explicit }, changes) {
    const kind = kindOf(observation);
    const lasting = condition.persistence === 'lasting';
    const window = lasting ? sameMomentMs : 0;
    const lastPresent = condition.lastPresentAt;
    if (lastPresent === null) {
      // Opened inconclusive and never seen present: a decisive look that
      // finds nothing answers the suspicion.
      condition.lastDecisiveAt = observation.at;
      condition.lastLookAt = Math.max(condition.lastLookAt, observation.at);
      keepEvidence(condition, observation);
      end(condition, observation.at, explicit ? observation.type : 'absent');
      changes.push({ condition, change: 'ended' });
      return;
    }
    // Older than the latest sighting: says nothing about now.
    if (observation.at < lastPresent - window) return;
    condition.lastLookAt = Math.max(condition.lastLookAt, observation.at);
    if (lasting && observation.at - lastPresent <= window) {
      if (kind > condition.bestKind) {
        if (observation.at - condition.firstSeenAt <= window) {
          condition.ruledOut = {
            at: observation.at,
            by: explicit
              ? `${observation.type} on a better look at the same moment`
              : 'a better look at the same moment found nothing',
          };
          condition.confidence = confidenceOf(condition);
          keepEvidence(condition, observation);
          end(condition, observation.at, condition.ruledOut.by);
          changes.push({ condition, change: 'ruled_out' });
          return;
        }
        condition.conflict = { at: observation.at, kind };
      } else if (kind === condition.bestKind) {
        condition.conflict = { at: observation.at, kind };
      } else {
        return;
      }
      condition.confidence = confidenceOf(condition);
      keepEvidence(condition, observation);
      changes.push({ condition, change: 'conflict' });
      return;
    }
    condition.lastDecisiveAt = Math.max(
      condition.lastDecisiveAt ?? -Infinity,
      observation.at,
    );
    keepEvidence(condition, observation);
    if (explicit) {
      end(condition, observation.at, observation.type);
      changes.push({ condition, change: 'ended' });
      return;
    }
    condition.absentStreak += 1;
    if (condition.absentStreak >= endAfterAbsent) {
      end(condition, observation.at, 'absent on fresh readings');
      changes.push({ condition, change: 'ended' });
    } else {
      changes.push({ condition, change: 'absent' });
    }
  }

  return {
    /**
     * Apply the observations of one reading.
     * @param {object[]} observations - From readingObservations.
     * @returns {{condition:object, change:string}[]}
     */
    apply(observations) {
      const changes = [];
      const presentHere = new Set(
        observations
          .filter((item) => item.result === 'present')
          .map((item) => keyOf(item.cameraId, item.type)),
      );
      for (const observation of observations) {
        const spec = events.observations.get(observation.type);
        if (!spec) continue;
        if (observation.result === 'present' && spec.ends.length)
          for (const endedType of spec.ends) {
            const key = keyOf(observation.cameraId, endedType);
            // A reading that lists both sides contradicts itself.
            if (presentHere.has(key)) continue;
            const condition = open.get(key);
            if (condition)
              onContrary(condition, observation, { explicit: true }, changes);
          }
        if (!spec.condition) continue;
        if (observation.result === 'present') onPresent(observation, changes);
        else if (observation.result === 'unclear')
          onUnclear(observation, changes);
        else {
          const key = keyOf(observation.cameraId, observation.type);
          suspicions.delete(key);
          const condition = open.get(key);
          if (condition)
            onContrary(condition, observation, { explicit: false }, changes);
        }
      }
      return changes;
    },

    /**
     * Mark conditions with nothing decisive for a while. Never ends them.
     * @param {number} at
     * @param {(cameraId: string) => string} [reasonFor] - Why a camera has no fresh reading.
     */
    tick(at, reasonFor = () => 'not yet revisited') {
      const changes = [];
      for (const condition of open.values()) {
        if (condition.state !== 'ongoing') continue;
        const decisive = condition.lastDecisiveAt ?? condition.firstSeenAt;
        if (at - decisive <= quietAfterMs) continue;
        condition.state = 'no_recent_evidence';
        const unclear =
          condition.lastUnclear && condition.lastUnclear.at > decisive
            ? condition.lastUnclear
            : null;
        condition.stateReason = !unclear
          ? reasonFor(condition.cameraId)
          : unclear.visibility === 'good'
            ? 'recent readings could not tell'
            : `${unclear.visibility} visibility`;
        changes.push({ condition, change: 'quiet' });
      }
      for (const [key, suspicion] of suspicions)
        if (at - suspicion.at > suspicionMs) suspicions.delete(key);
      return changes;
    },

    /** Focus on a camera ended: conditions with nothing decisive since it began. */
    focusEnded(cameraId, startedAt) {
      const changes = [];
      for (const condition of open.values()) {
        if (condition.cameraId !== cameraId) continue;
        if ((condition.lastDecisiveAt ?? -Infinity) >= startedAt) continue;
        condition.state = 'monitoring_ended';
        condition.stateReason =
          'focused monitoring ended without a decisive reading';
        changes.push({ condition, change: 'monitoring_ended' });
      }
      return changes;
    },

    /** Drop ended conditions that ended before a cutoff. */
    forget(before) {
      for (const [id, condition] of all)
        if (condition.state === 'ended' && condition.endedAt < before) {
          all.delete(id);
          const key = keyOf(condition.cameraId, condition.type);
          if (lastEnded.get(key) === condition) lastEnded.delete(key);
        }
    },

    get: (id) => all.get(id) ?? null,
    openAt: (cameraId) =>
      [...open.values()].filter((condition) => condition.cameraId === cameraId),
    hasOpen: (cameraId) =>
      [...open.values()].some((condition) => condition.cameraId === cameraId),
    all: () => [...all.values()],
  };
}
