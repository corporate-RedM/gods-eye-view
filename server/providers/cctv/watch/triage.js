/**
 * CCTV Watch triage: from fresh frames to describer readings.
 *
 * Every fresh frame is screened. A frame that clears a screening threshold
 * for a type its camera can show goes to the describer. A share of frames the
 * screener passed as normal is audited by the describer anyway, ignoring
 * gating, so screener misses get measured instead of assumed away. Profile
 * samples and people counts ride along.
 *
 * Readings come back with three times: capture (or unknown), fetch, and
 * analysis. A motion type can never be "present" from a single still; the
 * describer is told so, and this module enforces it.
 */
import {
  applicableObservations,
  needsMotion,
  readingVocabulary,
  screenCandidates,
  screeningNeutral,
  screeningPrompts,
} from './events.js';
import { dayPart } from './profiles.js';

/** Detector priority for every describer reading; screening runs at 0, ahead. */
const DESCRIBE_PRIORITY = 5;
/** A camera gets at most one profile request in this long. */
const PROFILE_REQUEST_EVERY_MS = 10 * 60_000;
/** Novelty above this on consecutive frames means the view itself changed. */
const VIEW_CHANGE_NOVELTY = 0.5;
const VIEW_CHANGE_FRAMES = 3;
/** People are counted only where profiles say they are large enough. */
const COUNT_MIN_PEOPLE_USABLE = 0.3;

/**
 * Enforce evidence rules on one describer reading.
 * A single still cannot establish motion: such answers become "unclear" and
 * are flagged, which is what sends a camera to video.
 * @param {object} reading - Detector clean_reading result.
 * @param {string} mode - still | pair | clip.
 * @param {Map<string, object>} observations - Event specs.
 * @returns {object} Reading with enforced observations.
 */
export function enforceEvidenceRules(reading, mode, observations) {
  if (!reading?.ok) return reading;
  const enforced = reading.observations.map((item) => {
    const spec = observations.get(item.type);
    if (!spec) return item;
    const singleFrame = mode === 'still';
    const clipOnly = spec.evidence === 'clip';
    const tooLittle =
      (singleFrame && needsMotion(spec)) || (clipOnly && mode !== 'clip');
    if (tooLittle && item.result === 'present')
      return { ...item, result: 'unclear', enforced: 'needs-motion' };
    return item;
  });
  return { ...reading, observations: enforced };
}

/** Types in a reading that ask for live video: motion suspected, or clip-only. */
export function motionSuspects(reading, observations) {
  if (!reading?.ok) return [];
  return reading.observations
    .filter((item) => needsMotion(observations.get(item.type)))
    .filter((item) => item.result === 'unclear' || item.enforced)
    .map((item) => item.type);
}

/**
 * @param {object} options
 * @param {object} options.events - loadWatchEvents result.
 * @param {object} options.thresholds - loadWatchThresholds result.
 * @param {object} options.detector - Detector client (screen, describe, count, baseline).
 * @param {object} options.queue - createDescribeQueue instance.
 * @param {object} options.profiles - createProfileStore instance.
 * @param {(reading: object) => void} [options.onReading]
 * @param {(event: object) => void} [options.onScreened]
 */
export function createTriage({
  events,
  thresholds,
  detector,
  queue,
  profiles,
  onReading = () => {},
  onScreened = () => {},
  auditRate = 0.02,
  followUp = () => false,
  followUpEveryMs = 2 * 60_000,
  onVerification = () => {},
  sequenceFrames = 2,
  sequenceWaitMs = 5 * 60_000,
  screenBatch = 32,
  screenFlushMs = 1000,
  screenInFlight = 4,
  countBatch = 16,
  now = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console,
} = {}) {
  const prompts = screeningPrompts(events);
  const neutral = screeningNeutral(events);
  const pending = [];
  const countPending = [];
  let screening = 0;
  let flushTimer = null;
  // Requests still in flight when watching stops fail by design; stay quiet.
  let stopped = false;
  const noveltyRuns = new Map();
  /** cameraId -> when its last profile request was made. */
  const profileRequestedAt = new Map();
  /** cameraId -> when a frame was last read to follow an open condition. */
  const followedUpAt = new Map();
  let readingSequence = 0;
  /** cameraId -> claims waiting for the camera's next fresh frames. */
  const awaitingFrames = new Map();

  /**
   * Claims in a reading that the measured policy checks with a narrow
   * question: present ones, and unclear ones a sequence can settle.
   */
  function claimsToVerify(reading) {
    if (!reading?.ok) return [];
    const claims = [];
    for (const item of reading.observations) {
      const arm = thresholds.verification?.(item.type) ?? null;
      const spec = events.verify?.get(item.type);
      if (!arm || !spec) continue;
      const usesSequence = arm === 'closer' && spec.sequence;
      if (
        item.result === 'present' ||
        (item.result === 'unclear' && usesSequence)
      )
        claims.push({ item, arm, spec, usesSequence });
    }
    return claims;
  }

  function dispatchVerification(pending) {
    const { record, claim, frames } = pending;
    const { item, arm, spec } = claim;
    totals.verifications += 1;
    queue.push({
      class: record.class,
      kind: 'verify',
      // One pending check per camera and type: a newer claim replaces it.
      key: `verify:${record.cameraId}:${item.type}`,
      priority: record.class === 'focus' ? 2 : 4,
      payload: { mode: 'verify', cameraId: record.cameraId },
      run: () =>
        detector.verify({
          frames,
          box: item.box ?? null,
          spec,
          closer: arm === 'closer',
          context: contextFor(record.camera),
          priority: DESCRIBE_PRIORITY,
        }),
      onResult: (response, { waitMs } = {}) =>
        onVerification({
          record,
          type: item.type,
          arm,
          verdict: response.result,
          analyzedAt: now(),
          // Describer time and queue wait, for the operating-load figures.
          runMs: response.runMs ?? null,
          waitMs: waitMs ?? null,
        }),
      onError: (error) => {
        if (stopped) return;
        totals.describeErrors += 1;
        onVerification({
          record,
          type: item.type,
          arm,
          verdict: null,
          error: error.message,
        });
      },
      onDrop: (reason) =>
        onVerification({
          record,
          type: item.type,
          arm,
          verdict: null,
          dropped: reason,
        }),
    });
  }

  function scheduleVerifications(record, claims) {
    const time = (meta) => meta?.captureTime ?? record.fetchedAt;
    for (const claim of claims) {
      if (record.mode === 'clip') {
        // The clip is its own sequence: its last frame is where the box is.
        const order = record.jpegs.map((_, index) => index).reverse();
        const anchor = time(record.frames[order[0]]);
        dispatchVerification({
          record,
          claim,
          frames: order.slice(0, 1 + sequenceFrames).map((index) => ({
            jpeg: record.jpegs[index],
            offsetSec: ((time(record.frames[index]) ?? anchor) - anchor) / 1000,
          })),
        });
        continue;
      }
      const pending = {
        record,
        claim,
        frames: [{ jpeg: record.jpegs[0], offsetSec: 0 }],
        anchorAt: time(record.frames?.[0]),
        deadline: now() + sequenceWaitMs,
      };
      if (!claim.usesSequence) {
        dispatchVerification(pending);
        continue;
      }
      // A still suspects; the camera's next fresh frames decide.
      const list = awaitingFrames.get(record.cameraId) || [];
      list.push(pending);
      awaitingFrames.set(record.cameraId, list);
    }
  }

  /** Give waiting claims the camera's newer frames; send them when complete or due. */
  function feedAwaiting(frame) {
    const at = now();
    for (const [cameraId, list] of awaitingFrames) {
      const remaining = [];
      for (const pending of list) {
        if (cameraId === frame?.cameraId)
          pending.frames.push({
            jpeg: frame.jpeg,
            offsetSec:
              ((frame.captureTime ?? frame.fetchedAt) - pending.anchorAt) /
              1000,
          });
        if (pending.frames.length > sequenceFrames || at >= pending.deadline)
          dispatchVerification(pending);
        else remaining.push(pending);
      }
      if (remaining.length) awaitingFrames.set(cameraId, remaining);
      else awaitingFrames.delete(cameraId);
    }
  }
  const totals = {
    screened: 0,
    candidates: 0,
    audits: 0,
    followUps: 0,
    verifications: 0,
    profiles: 0,
    counted: 0,
    readings: 0,
    unreadable: 0,
    enforced: 0,
    screenErrors: 0,
    describeErrors: 0,
    droppedFrames: 0,
  };

  const contextFor = (camera) => ({
    cameraName: camera?.name || camera?.id || '',
    place: [camera?.city, camera?.provider].filter(Boolean).join(', '),
  });

  function describe(job, frames, frameMeta) {
    const { mode, cameraId, camera, origin } = job;
    const specs = job.specs;
    queue.push({
      class: job.class,
      // Clips, stills and profiles cost different describer time; the queue
      // learns each kind's cost and shares by time.
      kind: mode,
      key: `${job.class}:${cameraId}:${mode}`,
      priority: job.priority,
      payload: { mode, cameraId },
      run: () =>
        detector.describe({
          mode,
          frames,
          vocabulary: mode === 'profile' ? [] : readingVocabulary(specs),
          context: contextFor(camera),
          // One priority for every reading: the describe queue has already
          // chosen what runs and in which order, and the detector must not
          // re-sort it (it starved profiles when it did).
          priority: DESCRIBE_PRIORITY,
          // Where each listed type is, so a narrow question can look closer.
          boxes: mode !== 'profile',
        }),
      onResult: (response, { waitMs }) => {
        const analyzedAt = now();
        if (mode === 'profile') {
          profiles.addSample(cameraId, response.result, {
            at: frameMeta.fetchedAt,
            part: dayPart(frameMeta.fetchedAt, camera?.lon),
          });
          return;
        }
        const enforcedReading = enforceEvidenceRules(
          response.result,
          mode,
          events.observations,
        );
        const enforcedCount = enforcedReading.ok
          ? enforcedReading.observations.filter((item) => item.enforced).length
          : 0;
        totals.readings += 1;
        totals.enforced += enforcedCount;
        if (!enforcedReading.ok) totals.unreadable += 1;
        const claims = claimsToVerify(enforcedReading);
        const record = {
          readingId: `${cameraId}-${frameMeta.fetchedAt}-${mode}-${++readingSequence}`,
          cameraId,
          camera,
          origin,
          class: job.class,
          mode,
          frames: frameMeta.frames,
          captureTime: frameMeta.captureTime,
          captureSource: frameMeta.captureSource,
          fetchedAt: frameMeta.fetchedAt,
          analyzedAt,
          queueWaitMs: waitMs,
          detector: {
            queuedMs: response.queuedMs,
            runMs: response.runMs,
            batchSize: response.batchSize,
            outputTokens: response.outputTokens,
          },
          screen: job.screen || null,
          reading: enforcedReading,
          checkedTypes: specs.map((spec) => spec.id),
          motionSuspects: motionSuspects(enforcedReading, events.observations),
          raw: enforcedReading.ok ? undefined : response.raw,
          // Frames stay in memory; the log saves them only under evaluation
          // capture, the evidence store only for incidents.
          jpegs: frames.map((frame) => frame.jpeg),
          // A clip's untouched source segments, kept for motion evidence.
          segments: frameMeta.segments ?? [],
          // Claims held until their narrow question is answered.
          pendingVerification: claims.map((claim) => claim.item.type),
        };
        onReading(record);
        scheduleVerifications(record, claims);
      },
      onError: (error) => {
        if (stopped) return;
        totals.describeErrors += 1;
        log.warn?.(
          `[CCTV Watch] describe ${mode} failed for ${cameraId}: ${error.message}`,
        );
      },
    });
  }

  function afterScreen(frame, result) {
    const { cameraId, camera } = frame;
    const profile = profiles.summary(cameraId);
    const specs = applicableObservations(events, profile);
    const candidates = screenCandidates(result.scores, specs, thresholds);
    totals.screened += 1;

    // A sustained jump in novelty means the camera now looks somewhere else:
    // re-profile it and start its baseline over, rather than reading the new
    // view as an anomaly forever.
    const run =
      result.novelty !== null && result.novelty >= VIEW_CHANGE_NOVELTY
        ? (noveltyRuns.get(cameraId) || 0) + 1
        : 0;
    noveltyRuns.set(cameraId, run);
    if (run >= VIEW_CHANGE_FRAMES) {
      noveltyRuns.set(cameraId, 0);
      profiles.flagViewChange(cameraId);
      detector
        .baseline({ key: frame.baselineKey, action: 'reset' })
        .catch(() => {});
    }

    const meta = {
      frames: [
        {
          captureTime: frame.captureTime,
          captureSource: frame.captureSource,
          fetchedAt: frame.fetchedAt,
          hash: frame.hash,
        },
      ],
      captureTime: frame.captureTime,
      captureSource: frame.captureSource,
      fetchedAt: frame.fetchedAt,
    };
    const screen = {
      top: Object.entries(result.scores || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      scores: result.scores || {},
      candidates,
      novelty: result.novelty,
      baselineSamples: result.baselineSamples,
    };
    onScreened({ frame, screen });

    const origin = frame.origin;
    const describeClass = origin === 'sweep' ? 'sweep' : 'focus';
    const stillFrame = [
      { jpeg: frame.jpeg, captureTime: frame.captureTime ?? undefined },
    ];
    if (candidates.length) {
      totals.candidates += 1;
      describe(
        {
          class: describeClass,
          mode: 'still',
          cameraId,
          camera,
          origin,
          specs,
          screen,
          priority: frame.priority ?? (origin === 'sweep' ? 5 : 2),
        },
        stillFrame,
        meta,
      );
    } else if (
      followUp(cameraId) &&
      frame.fetchedAt - (followedUpAt.get(cameraId) ?? -Infinity) >=
        followUpEveryMs
    ) {
      // An open condition needs fresh readings: without them it could only
      // go quiet, never be seen to persist or end.
      followedUpAt.set(cameraId, frame.fetchedAt);
      totals.followUps += 1;
      describe(
        {
          class: describeClass,
          mode: 'still',
          cameraId,
          camera,
          origin,
          specs,
          screen,
          priority: origin === 'sweep' ? 4 : 2,
        },
        stillFrame,
        meta,
      );
    } else if (random() < auditRate) {
      totals.audits += 1;
      describe(
        {
          class: 'audit',
          mode: 'still',
          cameraId,
          camera,
          origin,
          // Audits ignore gating: they are how an unsuitable-looking camera
          // keeps a way back in, and how screener misses get counted.
          specs: applicableObservations(events, profile, { ungated: true }),
          screen,
          priority: 6,
        },
        stillFrame,
        meta,
      );
    }

    const part = dayPart(frame.fetchedAt, camera?.lon);
    const lastAsked = profileRequestedAt.get(cameraId) ?? -Infinity;
    if (
      profiles.needsSample(cameraId, part, frame.fetchedAt) &&
      frame.fetchedAt - lastAsked >= PROFILE_REQUEST_EVERY_MS
    ) {
      // One request per camera per interval: every frame of an unprofiled
      // camera used to queue another one.
      profileRequestedAt.set(cameraId, frame.fetchedAt);
      totals.profiles += 1;
      describe(
        {
          class: 'profile',
          mode: 'profile',
          cameraId,
          camera,
          origin,
          specs: [],
          priority: 8,
        },
        [{ jpeg: frame.jpeg }],
        meta,
      );
    }

    if (
      profile &&
      profile.peopleUsable >= COUNT_MIN_PEOPLE_USABLE &&
      countPending.length < countBatch * 4
    ) {
      countPending.push(frame);
      if (countPending.length >= countBatch) flushCounts();
    }
  }

  function flushCounts() {
    const batch = countPending.splice(0, countBatch);
    if (!batch.length) return;
    detector
      .count({
        frames: batch.map((frame, index) => ({
          id: String(index),
          jpeg: frame.jpeg,
        })),
        priority: 6,
      })
      .then((response) => {
        for (const [index, result] of response.results.entries()) {
          totals.counted += 1;
          const frame = batch[index];
          onReading({
            cameraId: frame.cameraId,
            camera: frame.camera,
            origin: frame.origin,
            class: 'count',
            mode: 'count',
            captureTime: frame.captureTime,
            captureSource: frame.captureSource,
            fetchedAt: frame.fetchedAt,
            analyzedAt: now(),
            people: {
              count: result.count,
              medianHeightPx: result.medianHeightPx,
              imageHeight: result.imageHeight,
            },
          });
        }
      })
      .catch((error) => {
        if (stopped) return;
        log.warn?.(`[CCTV Watch] people count failed: ${error.message}`);
      });
  }

  function flushScreen() {
    clearTimer(flushTimer);
    flushTimer = null;
    while (pending.length && screening < screenInFlight) {
      const batch = pending.splice(0, screenBatch);
      screening += 1;
      const priority = Math.min(
        ...batch.map((frame) => frame.screenPriority ?? 5),
      );
      detector
        .screen({
          frames: batch.map((frame, index) => ({
            id: String(index),
            jpeg: frame.jpeg,
            baselineKey: frame.baselineKey,
          })),
          prompts,
          neutral,
          priority,
          learnMax: thresholds.novelty.learnMax,
          warmupSamples: thresholds.novelty.warmupSamples,
        })
        .then((response) => {
          for (const [index, result] of response.results.entries())
            afterScreen(batch[index], result);
        })
        .catch((error) => {
          if (stopped) return;
          totals.screenErrors += 1;
          log.warn?.(`[CCTV Watch] screening failed: ${error.message}`);
        })
        .finally(() => {
          screening -= 1;
          if (pending.length) scheduleFlush(0);
        });
    }
  }

  function scheduleFlush(delay) {
    if (flushTimer) return;
    flushTimer = setTimer(flushScreen, delay);
    flushTimer?.unref?.();
  }

  return {
    /**
     * Accept one fresh frame from the sweep or from focus.
     * @param {object} frame - {cameraId, camera, origin, jpeg, fetchedAt, captureTime, captureSource, hash, priority?}
     */
    submit(frame) {
      // A fresh frame may complete a sequence a waiting claim needs.
      if (awaitingFrames.size) feedAwaiting(frame);
      const part = dayPart(frame.fetchedAt, frame.camera?.lon);
      // Keep memory bounded if the detector falls behind: drop the oldest.
      if (pending.length >= screenBatch * 8) {
        pending.shift();
        totals.droppedFrames += 1;
      }
      pending.push({
        ...frame,
        baselineKey: `${frame.cameraId}:${part}`,
        // Screening runs ahead of every describer reading on the GPU: it is
        // the baseline, and a full focus pool must never starve it.
        screenPriority: 0,
      });
      if (pending.length >= screenBatch) flushScreen();
      else scheduleFlush(screenFlushMs);
    },

    /**
     * Describe a short clip from focus or patrol. Clips read every type the
     * camera can show, plus the clip-only types, from the same frames.
     * @param {object} clip - {cameraId, camera, origin, frames:[{jpeg, offsetSec, captureTime}], fetchedAt, priority}
     */
    describeClip(clip) {
      const profile = profiles.summary(clip.cameraId);
      const ungated = clip.origin === 'patrol';
      const specs = applicableObservations(events, profile, { ungated });
      describe(
        {
          class: 'focus',
          mode: 'clip',
          cameraId: clip.cameraId,
          camera: clip.camera,
          origin: clip.origin,
          specs,
          priority: clip.priority ?? 2,
        },
        clip.frames.map((frame) => ({
          jpeg: frame.jpeg,
          offsetSec: frame.offsetSec,
          captureTime: frame.captureTime ?? undefined,
        })),
        {
          frames: clip.frames.map((frame) => ({
            captureTime: frame.captureTime,
            captureSource: frame.captureSource,
            offsetSec: frame.offsetSec,
            seq: frame.seq,
          })),
          captureTime: clip.frames[0]?.captureTime ?? null,
          captureSource: clip.frames[0]?.captureSource ?? 'unknown',
          fetchedAt: clip.fetchedAt,
          segments: clip.segments ?? [],
        },
      );
    },

    stats: () => ({
      ...totals,
      pendingFrames: pending.length,
      screening,
      claimsAwaitingFrames: [...awaitingFrames.values()].reduce(
        (sum, list) => sum + list.length,
        0,
      ),
    }),

    clear() {
      stopped = true;
      pending.length = 0;
      countPending.length = 0;
      awaitingFrames.clear();
      clearTimer(flushTimer);
      flushTimer = null;
    },
  };
}
