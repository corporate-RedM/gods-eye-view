/**
 * The shared GPU budget for CCTV Watch: every model call (screening,
 * readings, verification, people counts) waits for budget before it is sent
 * and is charged the GPU time the detector reports for it. Over a sliding
 * window, Watch uses at most `share` of wall time (BK, 2026-10-08: 20%), so
 * once the window's allowance is spent the GPU sits idle until older work
 * leaves the window. Limiting how many jobs run at once would not do that.
 */

/** Starting GPU time per call, until real figures come back. */
const ESTIMATE_MS = { screen: 450, describe: 1600, verify: 1500, count: 300 };
/** How fast a call kind's estimate follows its measured cost. */
const ESTIMATE_LEARNING = 0.3;

/**
 * @param {object} options
 * @param {number} options.share - Fraction of wall time (0-1].
 * @param {number} [options.windowMs] - Sliding window.
 */
export function createGpuBudget({
  share,
  windowMs = 60_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!(share > 0 && share <= 1))
    throw new Error('GPU budget must be in (0, 1]');
  const limitMs = share * windowMs;
  /** [endedAt, ms] of finished calls, oldest first. */
  const charges = [];
  /** Calls waiting for budget, first come first served. */
  const waiting = [];
  let reservedMs = 0;
  let timer = null;
  let closed = false;
  const totals = { calls: 0, chargedMs: 0, waitedMs: 0, waits: 0 };

  function usedMs(at) {
    while (charges.length && charges[0][0] <= at - windowMs) charges.shift();
    return charges.reduce((sum, [, ms]) => sum + ms, 0);
  }

  function pump() {
    clearTimer(timer);
    timer = null;
    const at = now();
    while (waiting.length) {
      const next = waiting[0];
      const committed = usedMs(at) + reservedMs;
      // An idle GPU always admits one call, so nothing can wait forever.
      if (committed > 0 && committed + next.estimateMs > limitMs) break;
      waiting.shift();
      reservedMs += next.estimateMs;
      next.admit();
    }
    if (waiting.length && charges.length) {
      // Try again when the oldest charge leaves the window.
      timer = setTimer(pump, Math.max(50, charges[0][0] + windowMs - at));
      timer?.unref?.();
    }
  }

  return {
    /**
     * Run one model call within the budget.
     * @param {number} estimateMs - Expected GPU time, held until the real one is known.
     * @param {() => Promise<object>} call
     * @param {(result: object) => number} measure - GPU ms the result reports.
     */
    async run(estimateMs, call, measure) {
      if (closed) throw new Error('Watch stopped');
      const queuedAt = now();
      await new Promise((admit, reject) => {
        waiting.push({ estimateMs, admit, reject });
        pump();
      });
      const waited = now() - queuedAt;
      if (waited > 0) {
        totals.waits += 1;
        totals.waitedMs += waited;
      }
      let spent = 0;
      try {
        const result = await call();
        spent = Math.max(0, Number(measure(result)) || 0);
        return result;
      } finally {
        reservedMs -= estimateMs;
        totals.calls += 1;
        totals.chargedMs += spent;
        if (spent > 0) charges.push([now(), spent]);
        pump();
      }
    },

    /** Refuse new calls and fail the waiting ones: Watch is stopping. */
    close() {
      closed = true;
      clearTimer(timer);
      timer = null;
      for (const entry of waiting.splice(0))
        entry.reject(new Error('Watch stopped'));
    },

    status() {
      const at = now();
      return {
        share,
        windowMs,
        usedMs: Math.round(usedMs(at)),
        limitMs: Math.round(limitMs),
        usedShare: Number((usedMs(at) / windowMs).toFixed(3)),
        waiting: waiting.length,
        ...totals,
        chargedMs: Math.round(totals.chargedMs),
        waitedMs: Math.round(totals.waitedMs),
      };
    },
  };
}

/** GPU time one detector response reports: its share of the batch it ran in. */
export function gpuMsOf(response) {
  const runMs = Number(response?.runMs);
  if (!Number.isFinite(runMs) || runMs <= 0) return 0;
  return runMs / Math.max(1, Number(response?.batchSize) || 1);
}

/**
 * A detector client whose model calls go through the budget; lifecycle and
 * status calls pass straight through. Each call kind's reservation follows
 * its measured cost, so a run of calls cannot be admitted on a guess that is
 * well below what they really take (measured live: fixed guesses let the
 * window run to twice its share).
 */
export function budgetedDetector(detector, budget) {
  // Readings are learned per mode: a clip costs more than a still.
  const estimates = {};
  const wrap = (name) => (request) => {
    const key = name === 'describe' ? `describe:${request?.mode}` : name;
    estimates[key] ??= ESTIMATE_MS[name];
    return budget.run(
      estimates[key],
      () => detector[name](request),
      (response) => {
        const spent = gpuMsOf(response);
        if (spent > 0)
          estimates[key] += (spent - estimates[key]) * ESTIMATE_LEARNING;
        return spent;
      },
    );
  };
  return {
    ...detector,
    screen: wrap('screen'),
    describe: wrap('describe'),
    verify: wrap('verify'),
    count: wrap('count'),
    /** Current per-call reservations, for the status page. */
    estimates: () => ({ ...estimates }),
  };
}
