/**
 * Focused monitoring for CCTV Watch: temporary, high-cadence watching of a
 * few cameras from their live video, on top of the baseline sweep.
 *
 * Sessions come from manual watches, outside reports, camera observations,
 * scheduled events and patrol. The pool is separate from the sweep, so
 * baseline coverage keeps running while every slot is busy. Manual watches
 * come first; scheduled events get a capped share; two slots patrol suitable
 * cameras with no trigger at all, to find what the screener misses.
 *
 * A session lasts a fixed time from its trigger. Re-sending the same trigger
 * (an unchanged report polled again) does not extend it; only a new trigger
 * reference, such as a report's real update, does.
 */

export const FOCUS_TRIGGERS = Object.freeze([
  'manual',
  'report',
  'observation',
  'schedule',
  'patrol',
]);

/** Lower runs first when slots are contested. */
const TRIGGER_RANK = Object.freeze({
  manual: 0,
  report: 1,
  observation: 1,
  schedule: 2,
  patrol: 3,
});

export const FOCUS_DURATIONS_MS = Object.freeze({
  manual: 15 * 60_000,
  report: 20 * 60_000,
  observation: 10 * 60_000,
  earthquake: 15 * 60_000,
  patrol: 15_000,
});

/**
 * Decide which requested sessions hold slots. Pure: same inputs, same answer.
 *
 * @param {object[]} sessions - Active, unexpired sessions with {id, cameraId, trigger, priority, startedAt}.
 * @param {object} limits
 * @param {number} limits.slots - Total cameras in focus at once.
 * @param {number} limits.patrolSlots - Slots reserved for patrol.
 * @param {number} limits.scheduleShare - Most slots scheduled events may hold.
 * @returns {Set<string>} Session ids that get a slot.
 */
export function allocateFocusSlots(
  sessions,
  { slots, patrolSlots, scheduleShare },
) {
  const triggered = sessions.filter((session) => session.trigger !== 'patrol');
  const patrol = sessions.filter((session) => session.trigger === 'patrol');
  const ordered = [...triggered].sort(
    (a, b) =>
      TRIGGER_RANK[a.trigger] - TRIGGER_RANK[b.trigger] ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.startedAt - b.startedAt,
  );
  const triggeredSlots = Math.max(0, slots - patrolSlots);
  const scheduleCap = Math.floor(slots * scheduleShare);
  const granted = new Set();
  const cameras = new Set();
  let scheduled = 0;
  for (const session of ordered) {
    if (cameras.has(session.cameraId)) {
      // One slot per camera: a second trigger on a watched camera rides along.
      granted.add(session.id);
      continue;
    }
    if (cameras.size >= triggeredSlots) continue;
    if (session.trigger === 'schedule') {
      if (scheduled >= scheduleCap) continue;
      scheduled += 1;
    }
    granted.add(session.id);
    cameras.add(session.cameraId);
  }
  let patrolling = 0;
  for (const session of patrol) {
    if (patrolling >= patrolSlots) break;
    if (cameras.has(session.cameraId)) continue;
    granted.add(session.id);
    cameras.add(session.cameraId);
    patrolling += 1;
  }
  return granted;
}

/**
 * @param {object} options
 * @param {(cameraId: string) => object|null} options.cameraById - Catalog source lookup.
 * @param {(source: object, opts: object) => Promise<object>} options.fetchSegments - fetchNewestSegments.
 * @param {(fetched: object, opts: object) => Promise<object[]>} options.decode - framesFromSegments.
 * @param {(frame: object) => void} options.onFrame - Screening input.
 * @param {(clip: object) => void} options.onClip - Clip reading input.
 * @param {() => string[]} [options.patrolCandidates] - Cameras suitable for patrol, in order.
 */
export function createFocus({
  cameraById,
  fetchSegments,
  decode,
  onFrame,
  onClip,
  onSessionEnd = () => {},
  patrolCandidates = () => [],
  slots = 16,
  patrolSlots = 2,
  scheduleShare = 0.25,
  clipEveryMs = 45_000,
  spikeMinGapMs = 30_000,
  clipFrames = 8,
  clipSpanSec = 6,
  screenEveryMs = 2000,
  pollMs = 2500,
  patrolSampleMs = FOCUS_DURATIONS_MS.patrol,
  tickMs = 1000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console,
} = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** @type {Map<string, object>} cameraId -> live watcher state */
  const watchers = new Map();
  let running = false;
  let timer = null;
  let sequence = 0;
  let patrolCursor = 0;
  const totals = { opened: 0, frames: 0, clips: 0, errors: 0, refused: 0 };

  const sessionKey = (trigger, cameraId, ref) =>
    `${trigger}:${cameraId}:${ref ?? ''}`;

  function openWatcher(cameraId) {
    if (watchers.has(cameraId)) return;
    const source = cameraById(cameraId);
    if (!source?.url) return;
    watchers.set(cameraId, {
      cameraId,
      source,
      sinceSeq: -1,
      initCache: new Map(),
      recentFrames: [],
      recentSegments: [],
      lastClipAt: 0,
      lastScreenOffset: -Infinity,
      nextPollAt: 0,
      busy: false,
      errors: 0,
      spike: false,
    });
  }

  function closeWatcher(cameraId) {
    watchers.delete(cameraId);
  }

  async function pollWatcher(watcher, session) {
    watcher.busy = true;
    try {
      const fetched = await fetchSegments(watcher.source, {
        sinceSeq: watcher.sinceSeq,
        maxSegments: 2,
        initCache: watcher.initCache,
      });
      watcher.sinceSeq = Math.max(watcher.sinceSeq, fetched.newestSeq ?? -1);
      if (!fetched.segments.length) return;
      const frames = await decode(fetched, { fps: 1, maxFrames: 12 });
      watcher.errors = 0;
      const keepSince = now() - (clipSpanSec + 4) * 1000;
      for (const segment of fetched.segments)
        watcher.recentSegments.push({
          ...segment,
          at: fetched.fetchedAt,
          init: fetched.init,
        });
      watcher.recentSegments = watcher.recentSegments.filter(
        (s) => s.at >= keepSince,
      );
      for (const frame of frames) {
        totals.frames += 1;
        const dated = { ...frame, fetchedAt: fetched.fetchedAt };
        watcher.recentFrames.push(dated);
        // Every decoded frame feeds the clips; only one every screenEveryMs
        // is screened, so focus cannot crowd out the sweep's screening.
        const position =
          frame.captureTime ?? fetched.fetchedAt + frame.offsetSec * 1000;
        if (position - watcher.lastScreenOffset < screenEveryMs) continue;
        watcher.lastScreenOffset = position;
        onFrame({
          cameraId: watcher.cameraId,
          camera: watcher.source,
          origin: session.trigger === 'patrol' ? 'patrol' : 'focus',
          kind: 'video',
          jpeg: frame.jpeg,
          contentType: 'image/jpeg',
          hash: `${frame.seq}:${frame.offsetSec}`,
          fetchedAt: fetched.fetchedAt,
          captureTime: frame.captureTime,
          captureSource: frame.captureSource,
          sessionId: session.id,
          priority: TRIGGER_RANK[session.trigger],
        });
      }
      watcher.recentFrames = watcher.recentFrames.filter(
        (frame) => frame.fetchedAt >= keepSince,
      );
      maybeClip(watcher, session, fetched.fetchedAt);
    } catch (error) {
      watcher.errors += 1;
      totals.errors += 1;
      if (watcher.errors === 1 || watcher.errors % 10 === 0)
        log.warn?.(`[CCTV Watch] focus ${watcher.cameraId}: ${error.message}`);
    } finally {
      watcher.busy = false;
      watcher.nextPollAt = now() + pollMs * Math.min(watcher.errors + 1, 8);
    }
  }

  function maybeClip(watcher, session, fetchedAt) {
    const sinceLast = fetchedAt - watcher.lastClipAt;
    // A screening spike asks for a clip now, but never more often than
    // spikeMinGapMs: back-to-back spikes only repeat the same frames.
    // A patrol sample is read once, as soon as it has enough frames.
    const due =
      (watcher.spike && sinceLast >= spikeMinGapMs) ||
      (session.trigger === 'patrol' &&
        watcher.lastClipAt < session.startedAt) ||
      sinceLast >= clipEveryMs;
    if (!due) return;
    const frames = watcher.recentFrames.slice(-clipFrames);
    if (frames.length < Math.min(4, clipFrames)) return;
    watcher.spike = false;
    watcher.lastClipAt = fetchedAt;
    totals.clips += 1;
    const start = frames[0];
    onClip({
      cameraId: watcher.cameraId,
      camera: watcher.source,
      origin: session.trigger === 'patrol' ? 'patrol' : 'focus',
      sessionId: session.id,
      fetchedAt,
      priority: TRIGGER_RANK[session.trigger],
      frames: frames.map((frame) => ({
        ...frame,
        offsetSec:
          frame.captureTime !== null && start.captureTime !== null
            ? (frame.captureTime - start.captureTime) / 1000
            : frame.offsetSec + (frame.fetchedAt - start.fetchedAt) / 1000,
      })),
      segments: watcher.recentSegments.slice(),
    });
  }

  function topUpPatrol(at) {
    const active = [...sessions.values()].filter((s) => s.trigger === 'patrol');
    if (active.length >= patrolSlots) return;
    const candidates = patrolCandidates();
    if (!candidates.length) return;
    for (
      let tries = 0;
      tries < candidates.length && active.length < patrolSlots;
      tries += 1
    ) {
      const cameraId = candidates[patrolCursor % candidates.length];
      patrolCursor += 1;
      if (watchers.has(cameraId)) continue;
      const session = {
        id: `focus-${++sequence}`,
        key: sessionKey('patrol', cameraId, patrolCursor),
        cameraId,
        trigger: 'patrol',
        label: 'Patrol sample',
        ref: null,
        priority: 0,
        startedAt: at,
        endsAt: at + patrolSampleMs,
      };
      sessions.set(session.id, session);
      active.push(session);
    }
  }

  function tick() {
    if (!running) return;
    const at = now();
    for (const session of sessions.values())
      if (session.endsAt <= at) {
        sessions.delete(session.id);
        onSessionEnd(session, 'expired');
      }
    topUpPatrol(at);
    const granted = allocateFocusSlots([...sessions.values()], {
      slots,
      patrolSlots,
      scheduleShare,
    });
    const focusedCameras = new Map();
    for (const session of sessions.values()) {
      session.active = granted.has(session.id);
      if (session.active && !focusedCameras.has(session.cameraId))
        focusedCameras.set(session.cameraId, session);
    }
    for (const cameraId of [...watchers.keys()])
      if (!focusedCameras.has(cameraId)) closeWatcher(cameraId);
    for (const [cameraId, session] of focusedCameras) {
      openWatcher(cameraId);
      const watcher = watchers.get(cameraId);
      if (watcher && !watcher.busy && watcher.nextPollAt <= at)
        pollWatcher(watcher, session);
    }
    timer = setTimer(tick, tickMs);
    timer?.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      clearTimer(timer);
      timer = null;
      watchers.clear();
      sessions.clear();
    },

    /**
     * Ask for focus on one camera. The same trigger reference again is a
     * no-op: re-polling an unchanged report never extends monitoring.
     * @param {object} request - {cameraId, trigger, ref?, label?, durationMs?, priority?}
     * @returns {object|null} The session, or null when the camera has no live video.
     */
    request({
      cameraId,
      trigger,
      ref = null,
      label = '',
      durationMs,
      priority = 0,
    }) {
      if (!FOCUS_TRIGGERS.includes(trigger))
        throw new Error(`unknown focus trigger ${trigger}`);
      const source = cameraById(cameraId);
      if (!source?.url) {
        totals.refused += 1;
        return null;
      }
      const key = sessionKey(trigger, cameraId, ref);
      for (const session of sessions.values())
        if (session.key === key) return session;
      const at = now();
      const session = {
        id: `focus-${++sequence}`,
        key,
        cameraId,
        trigger,
        label,
        ref,
        priority,
        startedAt: at,
        endsAt:
          at +
          (durationMs ??
            FOCUS_DURATIONS_MS[trigger] ??
            FOCUS_DURATIONS_MS.observation),
      };
      sessions.set(session.id, session);
      totals.opened += 1;
      return session;
    },

    /** End a session early (manual stop). */
    cancel(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      sessions.delete(sessionId);
      onSessionEnd(session, 'cancelled');
      return true;
    },

    /** A screening spike on a focused camera asks for a clip now. */
    spike(cameraId) {
      const watcher = watchers.get(cameraId);
      if (watcher) watcher.spike = true;
    },

    /** Whether the sweep should skip this camera. */
    isFocused: (cameraId) => watchers.has(cameraId),

    sessions: () =>
      [...sessions.values()].map((session) => ({
        id: session.id,
        cameraId: session.cameraId,
        trigger: session.trigger,
        label: session.label,
        ref: session.ref,
        startedAt: session.startedAt,
        endsAt: session.endsAt,
        active: Boolean(session.active),
      })),

    stats: () => ({
      ...totals,
      sessions: sessions.size,
      watching: watchers.size,
      slots,
      patrolSlots,
    }),
  };
}
