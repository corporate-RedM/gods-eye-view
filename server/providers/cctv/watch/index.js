/**
 * CCTV Watch: the server side of watching one area's live cameras for events.
 *
 * Off until BK presses Start (BK, 2026-10-08): polls, opened cameras,
 * reports and restarts never start it, and nothing restores an earlier run.
 * Start names one area (a region, city or municipality); the detector loads,
 * then the sweep, focused monitoring and report polling run on that area's
 * cameras only, with every model call inside the shared GPU budget. Stop
 * ends all of it: queued work is dropped, the detector process exits and
 * the GPU is released; Watch reads "stopping" until the process has gone.
 * Five minutes without a keepalive from an open app also stops it.
 * Incidents and their evidence outlive a run.
 */
import path from 'node:path';
import { isVideoFeedType, normalizeFeedType } from '../normalize.js';
import { buildAreas, isAreaId, loadAreaCities } from './areas.js';
import { chooseCameras } from './cameraChoice.js';
import { readWatchConfig } from './config.js';
import { createDescribeQueue } from './describeQueue.js';
import { createDetectorClient, DETECTOR_STATES } from './detectorClient.js';
import { readWatchDefinitions } from './events.js';
import { createEvidenceModel } from './evidenceModel.js';
import { createEvidenceStore } from './evidenceStore.js';
import { createFocus } from './focus.js';
import { createFreshnessTracker } from './freshness.js';
import { budgetedDetector, createGpuBudget } from './gpuBudget.js';
import { fetchNewestSegments, framesFromSegments } from './keyframes.js';
import { notificationsFrom } from './notifications.js';
import { createProfileStore } from './profiles.js';
import { createReadingsLog } from './readingsLog.js';
import { fetchCastleRockReports } from './reports/castleRock511.js';
import { createReportWatcher } from './reports/index.js';
import { createSweep } from './sweep.js';
import { createTriage } from './triage.js';

/** Report kinds that start focused monitoring on nearby cameras. */
const FOCUS_REPORT_KINDS = new Set([
  'crash',
  'incident',
  'hazard',
  'fire',
  'flood',
]);
const OBSERVATION_FOCUS_BUCKET_MS = 30 * 60_000;
/**
 * A report last updated longer ago than this does not start focus: the sweep
 * already covers its cameras, and old news should not fill the pool.
 */
const REPORT_FOCUS_MAX_AGE_MS = 60 * 60_000;
/** Evaluation capture saves one screened frame in this many for labelling. */
const EVAL_SCREEN_SAMPLE = 1 / 40;
/**
 * A sampled sweep frame is followed by this many more fresh frames from the
 * same camera, so evaluation has short sequences (motion, persistence).
 */
const EVAL_SEQUENCE_FRAMES = 2;
/** Under evaluation capture, sweep keyframes keep their native resolution. */
const EVAL_KEYFRAME_EDGE = 4096;

/** A camera with a live stream the watch can read. */
export function isLiveCamera(source) {
  return (
    Boolean(source?.url) && isVideoFeedType(normalizeFeedType(source.feedType))
  );
}

function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}

/**
 * @param {object} options
 * @param {string} options.root - Repo root.
 * @param {() => Promise<object[]>} options.getSources - The CCTV proxy's catalog (shared instance).
 * @param {(source: object) => Promise<object|null>} options.fetchStill - Agency still fetch.
 * @param {Function} [options.createDetector] - Detector client factory (tests pass a fake).
 */
export function createCctvWatch({
  root,
  getSources,
  fetchStill,
  env = process.env,
  log = console,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  createDetector = createDetectorClient,
} = {}) {
  let parts = null;
  /** off | starting | running | stopping | failed | disabled */
  let state = 'off';
  let lastError = null;
  let lastPollAt = 0;
  let startedAt = null;
  let idleTimer = null;
  let readyTimer = null;
  let pruneTimer = null;
  let stoppingTimer = null;
  let config = null;
  /** The area this run reads: {id, label, cameras}. */
  let area = null;
  /** Incidents and evidence, built once and kept across runs. */
  let evidence = null;
  /** Every live camera seen, so incidents keep their names after a run. */
  const cameraIndex = new Map();
  let areasCache = null;
  const screenedAt = new Map();

  function ensureEvidence() {
    if (evidence) return evidence;
    config = config ?? readWatchConfig(env, root);
    const { events, thresholds } = readWatchDefinitions(root);
    const store = createEvidenceStore({ dir: config.evidenceDir, log });
    store.loadArchive().catch(() => {});
    const model = createEvidenceModel({
      events,
      thresholds,
      store,
      cameraById: (cameraId) => cameraIndex.get(cameraId) || null,
      profileOf: (cameraId) => parts?.profiles.summary(cameraId) ?? null,
      now,
    });
    evidence = { events, thresholds, store, model };
    return evidence;
  }

  /** Coverage areas over the live cameras, rebuilt when the catalog changes. */
  function areasOf(liveSources) {
    if (areasCache?.sources !== liveSources)
      areasCache = {
        sources: liveSources,
        areas: buildAreas(liveSources, loadAreaCities(root)),
      };
    return areasCache.areas;
  }

  async function liveSources() {
    const sources = await getSources();
    if (areasCache?.all === sources) return areasCache.sources;
    const live = sources.filter(isLiveCamera);
    for (const camera of live) cameraIndex.set(camera.id, camera);
    areasOf(live);
    areasCache.all = sources;
    return live;
  }
  /** Evaluation capture: cameras whose next fresh frames complete a sequence. */
  const sequenceFollow = new Map();

  function build(chosen) {
    config = readWatchConfig(env, root);
    const { events, thresholds, store, model } = ensureEvidence();
    const detector = createDetector({
      root,
      python: config.python,
      script: config.detectorScript,
      port: config.detectorPort,
      maxBatch: config.describeBatch,
      log,
    });
    const freshness = createFreshnessTracker();
    const profiles = createProfileStore({
      file: path.join(config.cacheDir, 'profiles.json'),
      log,
    });
    const readings = createReadingsLog({
      dir: config.logDir,
      evalDir: config.evalCapture ? config.evalDir : null,
      log,
    });
    const queue = createDescribeQueue({
      run: (job) => job.run(),
      inFlight: config.describeBatch + 2,
    });
    const ffmpegLimit = createLimiter(config.ffmpegConcurrency);
    const decode = (fetched, options) =>
      ffmpegLimit(() =>
        framesFromSegments(fetched, { ...options, ffmpeg: config.ffmpeg }),
      );
    // Every model call waits for the shared GPU budget.
    const budget = createGpuBudget({
      share: config.gpuBudget,
      now,
      setTimer,
      clearTimer,
    });
    const gpu = budgetedDetector(detector, budget);
    // Only the chosen area's cameras are fetched, screened and read.
    let liveCameras = [];
    const listCameras = async () => {
      const live = await liveSources();
      const members = areasOf(live).members(chosen.id);
      liveCameras = live.filter((camera) => members?.has(camera.id));
      return liveCameras;
    };
    const keyframeInits = new Map();

    let focus = null;
    const triage = createTriage({
      events,
      thresholds,
      detector: gpu,
      queue,
      profiles,
      auditRate: config.auditRate,
      followUp: (cameraId) => model.needsFollowUp(cameraId),
      onVerification: (result) => {
        readings.write({
          kind: 'verification',
          readingId: result.record.readingId,
          cameraId: result.record.cameraId,
          type: result.type,
          arm: result.arm,
          verdict: result.verdict,
          dropped: result.dropped ?? null,
          error: result.error ?? null,
          claimedAt: result.record.analyzedAt ?? null,
          runMs: result.runMs ?? null,
          waitMs: result.waitMs ?? null,
        });
        model.onVerification(result);
      },
      log,
      onScreened: ({ frame, screen }) => {
        screenedAt.set(frame.cameraId, frame.fetchedAt);
        // A screening hit on a camera already in focus asks for a clip now.
        if (frame.origin !== 'sweep' && screen.candidates.length)
          focus?.spike(frame.cameraId);
        if (config.evalCapture) {
          const follow =
            frame.origin === 'sweep'
              ? sequenceFollow.get(frame.cameraId)
              : null;
          const sampled =
            !follow &&
            frame.origin === 'sweep' &&
            Math.random() < EVAL_SCREEN_SAMPLE;
          if (sampled)
            sequenceFollow.set(frame.cameraId, {
              of: `${frame.cameraId}@${frame.fetchedAt}`,
              index: 0,
            });
          else if (follow && ++follow.index >= EVAL_SEQUENCE_FRAMES)
            sequenceFollow.delete(frame.cameraId);
          readings.writeScreen(
            {
              cameraId: frame.cameraId,
              origin: frame.origin,
              kind: frame.kind,
              fetchedAt: frame.fetchedAt,
              captureTime: frame.captureTime,
              captureSource: frame.captureSource,
              scores: screen.scores,
              candidates: screen.candidates.map((c) => c.type),
              novelty: screen.novelty,
              profile: profiles.summary(frame.cameraId),
              sequence: sampled
                ? { of: `${frame.cameraId}@${frame.fetchedAt}`, index: 0 }
                : follow
                  ? { of: follow.of, index: follow.index }
                  : null,
            },
            sampled || follow ? frame.jpeg : null,
          );
        }
      },
      onReading: (reading) => {
        readings.write({ kind: 'reading', ...reading });
        if (!reading.reading?.ok || reading.class === 'count') return;
        model.onReading(reading);
        const present = reading.reading.observations.filter(
          (item) =>
            item.result === 'present' &&
            events.observations.get(item.type)?.condition,
        );
        const triggers = [
          ...new Set([
            ...reading.motionSuspects,
            ...present.map((item) => item.type),
          ]),
        ];
        if (!triggers.length || reading.origin !== 'sweep') return;
        const bucket = Math.floor(now() / OBSERVATION_FOCUS_BUCKET_MS);
        const session = focus.request({
          cameraId: reading.cameraId,
          trigger: 'observation',
          ref: `${triggers.sort().join('+')}:${bucket}`,
          label: triggers.join(', '),
        });
        if (session)
          readings.write({ kind: 'focus', reason: 'observation', session });
      },
    });

    focus = createFocus({
      cameraById: (cameraId) => cameraIndex.get(cameraId) || null,
      fetchSegments: (source, options) => fetchNewestSegments(source, options),
      decode,
      onFrame: (frame) => triage.submit(frame),
      onClip: (clip) => triage.describeClip(clip),
      onSessionEnd: (session, reason) => {
        model.onFocusEnd(session);
        readings.write({
          kind: 'focus-end',
          reason,
          session: {
            id: session.id,
            cameraId: session.cameraId,
            trigger: session.trigger,
          },
        });
      },
      patrolCandidates: () => {
        const suitable = [];
        const rest = [];
        for (const camera of liveCameras) {
          const profile = profiles.summary(camera.id);
          const people =
            profile &&
            Math.max(
              profile.peopleUsable ?? 0,
              profile.pedestrianAreaVisible ?? 0,
            ) >= 0.3;
          (people ? suitable : rest).push(camera.id);
        }
        return [...suitable, ...rest];
      },
      slots: config.focusSlots,
      patrolSlots: config.patrolSlots,
      scheduleShare: config.scheduleShare,
      clipEveryMs: config.clipEveryMs,
      spikeMinGapMs: config.spikeMinGapMs,
      log,
    });

    const sweep = createSweep({
      listCameras,
      fetchStill,
      grabKeyframe: async (source) => {
        let initCache = keyframeInits.get(source.id);
        if (!initCache) keyframeInits.set(source.id, (initCache = new Map()));
        const fetched = await fetchNewestSegments(source, {
          maxSegments: 1,
          initCache,
        });
        const segment = fetched.segments[0];
        if (!segment) return null;
        // Timed inside the ffmpeg limiter: decoding cost, not queueing.
        const { frame, decodeMs } = await ffmpegLimit(async () => {
          const start = performance.now();
          const [first] = await framesFromSegments(fetched, {
            fps: null,
            ffmpeg: config.ffmpeg,
            ...(config.evalCapture ? { maxEdge: EVAL_KEYFRAME_EDGE } : {}),
          });
          return {
            frame: first,
            decodeMs: Math.round(performance.now() - start),
          };
        });
        if (!frame) return { jpeg: null, decodeMs };
        return {
          jpeg: frame.jpeg,
          segmentId: `${segment.seq}:${segment.uri}`,
          captureTime: frame.captureTime,
          captureSource: frame.captureSource,
          bytes: segment.bytes.length,
          decodeMs,
        };
      },
      freshness,
      isFocused: (cameraId) => focus.isFocused(cameraId),
      onFrame: (frame) => triage.submit(frame),
      concurrency: config.sweepConcurrency,
      hostConcurrency: config.hostConcurrency,
      staleStillVideo: config.staleStillVideo,
      log,
    });

    const reports = createReportWatcher({
      sources: config.reports ? [() => fetchCastleRockReports()] : [],
      pollMs: config.reportPollMs,
      log,
      onChange: (change) => {
        readings.write({
          kind: 'report',
          change: change.type,
          report: change.report,
          firstSeenAt: change.firstSeenAt,
        });
        model.onReport(change);
        const { report } = change;
        if (change.type === 'cleared' || !FOCUS_REPORT_KINDS.has(report.kind))
          return;
        const reportTime = report.updatedAt ?? change.firstSeenAt;
        if (now() - reportTime > REPORT_FOCUS_MAX_AGE_MS) return;
        const chosen = chooseCameras(report, liveCameras, {
          linkedUrls: report.cameraUrls,
          prefer: 'traffic',
          profileOf: (cameraId) => profiles.summary(cameraId),
        });
        for (const choice of chosen) {
          const session = focus.request({
            cameraId: choice.cameraId,
            trigger: 'report',
            // A real update is a new reference; the same report polled
            // again matches this one and does not extend monitoring.
            ref: `${report.id}@${report.updatedKey}`,
            label: report.title,
          });
          if (session)
            readings.write({
              kind: 'focus',
              reason: 'report',
              reportId: report.id,
              choice,
              session,
            });
        }
      },
    });

    return {
      config,
      events,
      thresholds,
      detector,
      budget,
      freshness,
      profiles,
      readings,
      queue,
      triage,
      focus,
      sweep,
      reports,
      store,
      model,
    };
  }

  /** Why a camera has had no fresh reading, for conditions gone quiet. */
  function quietReason(cameraId) {
    const stats = parts?.sweep.cameraState?.(cameraId);
    if (stats?.stale) return 'camera stale or offline';
    if (stats?.failing) return 'camera not answering';
    return 'not yet revisited';
  }

  function startPipelines() {
    if (!parts || state !== 'starting') return;
    if (parts.detector.status().state === DETECTOR_STATES.FAILED) {
      state = 'failed';
      lastError = parts.detector.status().lastError;
      return;
    }
    if (!parts.detector.isReady()) {
      readyTimer = setTimer(startPipelines, 1000);
      readyTimer?.unref?.();
      return;
    }
    parts.sweep.start();
    parts.focus.start();
    parts.reports.start();
    state = 'running';
    log.info?.('[CCTV Watch] running');
  }

  function checkIdle() {
    if (!parts) return;
    if (now() - lastPollAt > config.idleStopMs) {
      log.info?.(
        '[CCTV Watch] no app has kept Watch alive for a while; stopping',
      );
      stop();
      return;
    }
    idleTimer = setTimer(checkIdle, 30_000);
    idleTimer?.unref?.();
  }

  /**
   * Start watching one area, only ever on BK's request.
   * @param {{area: string}} request - An area id from areas().
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function start({ area: areaId } = {}) {
    if (state === 'stopping')
      return { ok: false, error: 'Watch is still stopping' };
    if (parts) return { ok: true };
    const probe = readWatchConfig(env, root);
    if (!probe.enabled) {
      state = 'disabled';
      return { ok: false, error: 'CCTV Watch is turned off in this setup' };
    }
    if (!isAreaId(areaId))
      return { ok: false, error: 'Choose an area to watch' };
    let chosen;
    try {
      const areas = areasOf(await liveSources());
      const members = areas.members(areaId);
      if (!members?.size)
        return { ok: false, error: 'That area has no live cameras' };
      chosen = {
        id: areaId,
        label: areas.label(areaId),
        cameras: members.size,
      };
    } catch (error) {
      return { ok: false, error: `Camera list unavailable: ${error.message}` };
    }
    if (parts || state === 'stopping') return { ok: true };
    try {
      parts = build(chosen);
    } catch (error) {
      state = 'failed';
      lastError = error.message;
      log.warn?.(`[CCTV Watch] could not start: ${error.message}`);
      parts = null;
      return { ok: false, error: error.message };
    }
    area = chosen;
    lastPollAt = now();
    state = 'starting';
    lastError = null;
    startedAt = now();
    parts.readings.prune().catch(() => {});
    let ticks = 0;
    // Every minute: mark quiet conditions, save profiles and incident
    // metadata; every hour: prune logs and evidence past seven days.
    pruneTimer = setInterval(() => {
      ticks += 1;
      try {
        parts?.profiles.save();
      } catch (error) {
        log.warn?.(`[CCTV Watch] could not save profiles: ${error.message}`);
      }
      parts?.model.tick(quietReason);
      parts?.model.maintain({ prune: ticks % 60 === 0 });
      if (ticks % 60 === 0) parts?.readings.prune().catch(() => {});
    }, 60_000);
    pruneTimer.unref?.();
    log.info?.(
      `[CCTV Watch] starting on ${chosen.label} (${chosen.cameras} cameras)`,
    );
    parts.detector.start();
    startPipelines();
    clearTimer(idleTimer);
    idleTimer = setTimer(checkIdle, 30_000);
    idleTimer?.unref?.();
    return { ok: true };
  }

  /**
   * Stop everything this run started: no more fetches, screening, readings
   * or verification; queued work is dropped and the detector process ends,
   * releasing the GPU. "stopping" until the process has actually exited.
   */
  function stop() {
    clearTimer(idleTimer);
    clearTimer(readyTimer);
    clearInterval(pruneTimer);
    idleTimer = readyTimer = pruneTimer = null;
    if (!parts) {
      if (state !== 'disabled' && state !== 'stopping') state = 'off';
      return;
    }
    const current = parts;
    parts = null;
    state = 'stopping';
    current.sweep.stop();
    current.focus.stop();
    current.reports.stop();
    current.budget.close();
    current.triage.clear();
    current.queue.clear();
    current.detector.stop();
    sequenceFollow.clear();
    try {
      current.profiles.save();
    } catch (error) {
      log.warn?.(`[CCTV Watch] could not save profiles: ${error.message}`);
    }
    evidence?.model.maintain({ prune: false })?.catch?.(() => {});
    const settle = () => {
      if (current.detector.status().state !== DETECTOR_STATES.STOPPED) {
        stoppingTimer = setTimer(settle, 200);
        stoppingTimer?.unref?.();
        return;
      }
      stoppingTimer = null;
      if (state === 'stopping') state = 'off';
      area = null;
      log.info?.('[CCTV Watch] stopped; detector exited');
    };
    settle();
  }

  function coverage(at) {
    const ids = parts?.sweep.cameraIds() ?? [];
    let checked5 = 0;
    let checked10 = 0;
    for (const id of ids) {
      const last = screenedAt.get(id);
      if (!last) continue;
      if (at - last <= 5 * 60_000) checked5 += 1;
      if (at - last <= 10 * 60_000) checked10 += 1;
    }
    return { cameras: ids.length, checked5, checked10 };
  }

  return {
    /** An open app keeping a running Watch alive. Never starts it. */
    touch() {
      lastPollAt = now();
    },
    start,
    stop,
    dispose: stop,
    state: () => state,

    /** Regions, cities and municipalities with their live-camera counts. */
    async areas() {
      return { regions: areasOf(await liveSources()).regions };
    },

    status() {
      const at = now();
      const base = {
        state,
        lastError,
        startedAt,
        lastPollAt,
        area,
        idleStopMs: config?.idleStopMs ?? null,
      };
      if (!parts) return base;
      return {
        ...base,
        gpuBudget: parts.budget.status(),
        thresholds: parts.thresholds.status,
        detector: parts.detector.status(),
        coverage: {
          // Cameras screened from a fresh capture, the honest "checked" figure.
          analysed: coverage(at),
          // Fresh captures fetched, analysed or not.
          fetched: parts.sweep.stats().coverage,
        },
        sweep: parts.sweep.stats(),
        triage: parts.triage.stats(),
        describe: parts.queue.stats(),
        focus: { ...parts.focus.stats(), sessions: parts.focus.sessions() },
        reports: parts.reports.stats(),
        log: parts.readings.stats(),
        profiles: parts.profiles.size(),
        incidents: parts.model.stats(),
      };
    },

    /**
     * Incidents changed after a revision, each with its saved evidence.
     * Earlier runs' incidents come back read-only (archived). Available
     * whether or not Watch is running.
     */
    incidents({ since = 0 } = {}) {
      const { model, store } = ensureEvidence();
      const listed = model.list({ since });
      return {
        ...listed,
        incidents: listed.incidents.map((incident) => ({
          ...incident,
          evidence: model.evidenceFor(incident.id),
        })),
        archived: since ? [] : store.archived(),
      };
    },

    /**
     * The notification feed: one entry per camera incident, updated in
     * place as it is seen again. Notifying never moves the view.
     */
    notifications({ since = 0 } = {}) {
      const { model } = ensureEvidence();
      // Nothing is being read while Watch is off: say so rather than leave
      // its conditions looking current.
      if (!parts) model.tick(() => 'Watch is off');
      const listed = model.list({ since });
      return {
        revision: listed.revision,
        notifications: notificationsFrom(listed.incidents, (cameraId) =>
          cameraIndex.get(cameraId),
        ),
        removed: listed.removed ?? [],
      };
    },

    /** Resolve an evidence file request, or null for any name the store does not write. */
    evidenceFile(day, incidentId, readingId, name) {
      return ensureEvidence().store.resolve(day, incidentId, readingId, name);
    },

    /** BK's verdict on an incident: real, false_alarm or null. */
    setVerdict(incidentId, value) {
      return ensureEvidence().model.setVerdict(incidentId, value);
    },

    linkIncidents: (a, b) => Boolean(ensureEvidence().model.link(a, b)),
    unlinkIncidents: (a, b) => Boolean(ensureEvidence().model.unlink(a, b)),
    mergeIncidents: (into, from) =>
      Boolean(ensureEvidence().model.merge(into, from)),

    /** Manual watch of one camera. */
    watchCamera({ cameraId, minutes = 15 }) {
      if (!parts) return { ok: false, error: 'CCTV Watch is not running' };
      const session = parts.focus.request({
        cameraId,
        trigger: 'manual',
        ref: `manual:${now()}`,
        label: 'Manual watch',
        durationMs: Math.max(1, Math.min(240, Number(minutes) || 15)) * 60_000,
      });
      if (!session)
        return { ok: false, error: 'That camera has no live video to watch' };
      parts.readings.write({ kind: 'focus', reason: 'manual', session });
      return { ok: true, session };
    },

    stopWatching(sessionId) {
      return Boolean(parts?.focus.cancel(sessionId));
    },

    recentReadings(limit) {
      return parts?.readings.recent(limit) ?? [];
    },

    currentReports() {
      return parts?.reports.current() ?? [];
    },
  };
}
