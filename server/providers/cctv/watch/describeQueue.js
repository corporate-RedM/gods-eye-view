/**
 * Describer work queue for CCTV Watch.
 *
 * The detector has one GPU, so this queue decides what it reads next. Each
 * class gets a target share of recent describer time, not of dispatches (a
 * clip costs more than a still): focus 50%, sweep confirmations 30%, screener
 * audits 10%, profiles 10%. When classes compete the one furthest below its
 * share goes next, and a class with nothing to do leaves its share to the
 * others. A dispatch is charged the running estimate for its kind (still,
 * clip, verify, profile) and, once it finishes, the GPU time the detector
 * measured for it. Focus work never takes the last slots the other classes
 * need, and they never take the slots kept for focus, so a busy focus pool
 * cannot starve sweep confirmations or the screener checks.
 *
 * Several requests stay in flight so the detector can batch them.
 */

export const DESCRIBE_CLASSES = Object.freeze([
  'focus',
  'sweep',
  'audit',
  'profile',
]);

const DEFAULT_SHARES = Object.freeze({
  focus: 0.5,
  sweep: 0.3,
  audit: 0.1,
  profile: 0.1,
});
const DEFAULT_MAX_QUEUED = Object.freeze({
  focus: 64,
  sweep: 200,
  audit: 16,
  profile: 16,
});
const DEFAULT_MAX_AGE_MS = Object.freeze({
  focus: 60_000,
  sweep: 5 * 60_000,
  audit: 5 * 60_000,
  profile: 30 * 60_000,
});
/**
 * Starting describer-time estimates per kind of job, in ms per job at the
 * detector's usual batch size; replaced by measurements as jobs finish.
 */
const DEFAULT_COST_MS = Object.freeze({ default: 1000 });
/** Weight of each new measurement in a kind's running estimate. */
const COST_LEARNING = 0.2;

/**
 * @param {object} options
 * @param {(job: object) => Promise<*>} options.run - Sends one job to the detector.
 * @param {number} [options.inFlight=10] - Requests in flight at once.
 * @param {number} [options.focusReserve=2] - In-flight slots only focus work may use.
 * @param {number} [options.otherReserve=2] - In-flight slots focus work may not use.
 * @param {object} [options.shares] - Target share of recent describer time per class.
 * @param {number} [options.window=60] - Dispatches the shares are measured over.
 * @param {object} [options.costMs] - Starting time estimates per job kind ({default, still, clip, ...}).
 */
export function createDescribeQueue({
  run,
  inFlight = 10,
  focusReserve = 2,
  otherReserve = 2,
  shares = DEFAULT_SHARES,
  maxQueued = DEFAULT_MAX_QUEUED,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  window = 60,
  costMs = DEFAULT_COST_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, object[]>} */
  const queues = new Map(DESCRIBE_CLASSES.map((name) => [name, []]));
  const runningByClass = new Map(DESCRIBE_CLASSES.map((name) => [name, 0]));
  /** The last `window` dispatches: {name, cost}, cost measured once done. */
  const recent = [];
  const estimates = new Map(Object.entries({ ...DEFAULT_COST_MS, ...costMs }));
  const measuredKinds = new Map();
  const estimateFor = (kind) =>
    estimates.get(kind) ?? estimates.get('default') ?? 1000;
  let running = 0;
  let sequence = 0;
  const stats = Object.fromEntries(
    DESCRIBE_CLASSES.map((name) => [
      name,
      {
        queued: 0,
        dispatched: 0,
        completed: 0,
        failed: 0,
        expired: 0,
        replaced: 0,
        overflow: 0,
        waitMs: 0,
        totalMs: 0,
        describerMs: 0,
      },
    ]),
  );

  const shareOf = (name) => {
    const total = recent.reduce((sum, entry) => sum + entry.cost, 0);
    if (!total) return 0;
    return (
      recent
        .filter((entry) => entry.name === name)
        .reduce((sum, entry) => sum + entry.cost, 0) / total
    );
  };

  /** GPU time one job took: the detector's batch time over its batch size. */
  const measuredCost = (result) => {
    const runMs = Number(result?.runMs);
    if (!Number.isFinite(runMs) || runMs <= 0) return null;
    return runMs / Math.max(1, Number(result?.batchSize) || 1);
  };

  const dropExpired = (at) => {
    for (const [name, queue] of queues) {
      const limit = maxAgeMs[name] ?? Infinity;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (at - queue[i].enqueuedAt > limit) {
          const [job] = queue.splice(i, 1);
          stats[name].expired += 1;
          job.onDrop?.('expired');
        }
      }
    }
  };

  const hasRoom = (name) => {
    if (running >= inFlight) return false;
    const focusRunning = runningByClass.get('focus');
    if (name === 'focus') return focusRunning < inFlight - otherReserve;
    return running - focusRunning < inFlight - focusReserve;
  };

  const nextClass = () => {
    let best = null;
    let bestRatio = Infinity;
    for (const name of DESCRIBE_CLASSES) {
      if (!queues.get(name).length || !hasRoom(name)) continue;
      const target = shares[name] ?? 0;
      if (target <= 0) continue;
      // Furthest below its share goes next; ties keep the listed order.
      const ratio = shareOf(name) / target;
      if (ratio < bestRatio) {
        best = name;
        bestRatio = ratio;
      }
    }
    return best;
  };

  const take = (name) => {
    const queue = queues.get(name);
    let best = 0;
    for (let i = 1; i < queue.length; i += 1) {
      const a = queue[i];
      const b = queue[best];
      if (
        a.priority < b.priority ||
        (a.priority === b.priority && a.seq < b.seq)
      )
        best = i;
    }
    return queue.splice(best, 1)[0];
  };

  const pump = () => {
    dropExpired(now());
    for (;;) {
      const name = nextClass();
      if (!name) return;
      const job = take(name);
      running += 1;
      runningByClass.set(name, runningByClass.get(name) + 1);
      // Charged the estimate now, corrected to the measured time once done.
      const charge = { name, cost: estimateFor(job.kind) };
      recent.push(charge);
      if (recent.length > window) recent.shift();
      const record = stats[name];
      record.dispatched += 1;
      const dispatchedAt = now();
      record.waitMs += dispatchedAt - job.enqueuedAt;
      Promise.resolve()
        .then(() => run(job))
        .then(
          (result) => {
            record.completed += 1;
            record.totalMs += now() - job.enqueuedAt;
            const cost = measuredCost(result);
            if (cost !== null) {
              charge.cost = cost;
              record.describerMs += cost;
              const kind = job.kind ?? 'default';
              const previous = estimates.get(kind);
              estimates.set(
                kind,
                previous === undefined || !measuredKinds.has(kind)
                  ? cost
                  : previous + (cost - previous) * COST_LEARNING,
              );
              measuredKinds.set(kind, (measuredKinds.get(kind) || 0) + 1);
            }
            job.onResult?.(result, { waitMs: dispatchedAt - job.enqueuedAt });
          },
          (error) => {
            record.failed += 1;
            job.onError?.(error);
          },
        )
        .finally(() => {
          running -= 1;
          runningByClass.set(name, runningByClass.get(name) - 1);
          pump();
        });
    }
  };

  return {
    /**
     * Queue a describer job. A pending job with the same key is replaced, so
     * a camera never waits with an older frame than the one it just sent.
     * @param {object} job - {class, key, priority?, payload, onResult?, onError?, onDrop?}
     */
    push(job) {
      const name = job.class;
      const queue = queues.get(name);
      if (!queue) throw new Error(`unknown describe class ${name}`);
      const entry = {
        ...job,
        priority: job.priority ?? 5,
        enqueuedAt: job.enqueuedAt ?? now(),
        seq: sequence++,
      };
      if (job.key) {
        const index = queue.findIndex((pending) => pending.key === job.key);
        if (index !== -1) {
          const [old] = queue.splice(index, 1);
          stats[name].replaced += 1;
          old.onDrop?.('replaced');
        }
      }
      if (queue.length >= (maxQueued[name] ?? Infinity)) {
        // Full: drop the oldest lowest-priority job rather than the new one.
        let worst = 0;
        for (let i = 1; i < queue.length; i += 1)
          if (
            queue[i].priority > queue[worst].priority ||
            (queue[i].priority === queue[worst].priority &&
              queue[i].seq < queue[worst].seq)
          )
            worst = i;
        const [dropped] = queue.splice(worst, 1);
        stats[name].overflow += 1;
        dropped.onDrop?.('overflow');
      }
      queue.push(entry);
      stats[name].queued += 1;
      pump();
    },

    /** Queue depth, flow, drops and describer time per class. */
    stats() {
      return {
        running,
        recentShares: Object.fromEntries(
          DESCRIBE_CLASSES.map((name) => [
            name,
            Number(shareOf(name).toFixed(2)),
          ]),
        ),
        /** Running describer-time estimate per job kind, and how many measured it. */
        costMs: Object.fromEntries(
          [...estimates].map(([kind, ms]) => [
            kind,
            { ms: Math.round(ms), measured: measuredKinds.get(kind) || 0 },
          ]),
        ),
        classes: Object.fromEntries(
          DESCRIBE_CLASSES.map((name) => {
            const record = stats[name];
            return [
              name,
              {
                pending: queues.get(name).length,
                running: runningByClass.get(name),
                queued: record.queued,
                dispatched: record.dispatched,
                completed: record.completed,
                failed: record.failed,
                expired: record.expired,
                replaced: record.replaced,
                overflow: record.overflow,
                avgWaitMs: record.dispatched
                  ? Math.round(record.waitMs / record.dispatched)
                  : null,
                avgTotalMs: record.completed
                  ? Math.round(record.totalMs / record.completed)
                  : null,
                describerMs: Math.round(record.describerMs),
              },
            ];
          }),
        ),
      };
    },

    /** Drop everything pending (watching stopped). */
    clear() {
      for (const queue of queues.values())
        for (const job of queue.splice(0)) job.onDrop?.('stopped');
    },
  };
}
