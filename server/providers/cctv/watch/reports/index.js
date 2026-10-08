/**
 * Outside reports for CCTV Watch, polled from their sources and reduced to
 * changes: a report that is new, one whose upstream update time changed, and
 * one that is no longer listed (cleared).
 *
 * Polling the same unchanged report again produces nothing, so a report can
 * never keep renewing an incident's evidence or a focus session by repetition.
 */

/**
 * @param {object} options
 * @param {Array<() => Promise<{reports: object[], errors: object}>>} options.sources
 * @param {(change: {type:'new'|'updated'|'cleared', report:object, at:number}) => void} options.onChange
 */
export function createReportWatcher({
  sources,
  onChange,
  pollMs = 120_000,
  clearAfterMissedPolls = 2,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console,
} = {}) {
  /** @type {Map<string, object>} */
  const known = new Map();
  let timer = null;
  let running = false;
  let polling = false;
  let lastPollAt = null;
  let errors = {};
  const totals = { polls: 0, new: 0, updated: 0, cleared: 0, unchanged: 0 };

  async function poll() {
    if (polling) return;
    polling = true;
    const at = now();
    try {
      const results = await Promise.allSettled(
        sources.map((source) => source()),
      );
      const listed = new Map();
      const failedSources = new Set();
      errors = {};
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          errors[`source-${index}`] =
            result.reason?.message || String(result.reason);
          failedSources.add(index);
          return;
        }
        Object.assign(errors, result.value.errors || {});
        for (const report of result.value.reports || [])
          listed.set(report.id, { report, source: index });
      });
      // A site that failed this poll lists nothing; its reports are not
      // "cleared" just because the site was unreachable.
      const failedSites = new Set(Object.keys(errors));
      for (const [id, { report }] of listed) {
        const entry = known.get(id);
        if (!entry) {
          known.set(id, { report, firstSeenAt: at, changedAt: at, missed: 0 });
          totals.new += 1;
          onChange({ type: 'new', report, at, firstSeenAt: at });
        } else if (entry.report.updatedKey !== report.updatedKey) {
          entry.report = report;
          entry.changedAt = at;
          entry.missed = 0;
          totals.updated += 1;
          onChange({
            type: 'updated',
            report,
            at,
            firstSeenAt: entry.firstSeenAt,
          });
        } else {
          entry.missed = 0;
          totals.unchanged += 1;
        }
      }
      for (const [id, entry] of known) {
        if (listed.has(id)) continue;
        const siteId = id.split(':')[0];
        if (failedSites.has(siteId) || failedSources.size) continue;
        entry.missed += 1;
        if (entry.missed >= clearAfterMissedPolls) {
          known.delete(id);
          totals.cleared += 1;
          onChange({
            type: 'cleared',
            report: entry.report,
            at,
            firstSeenAt: entry.firstSeenAt,
          });
        }
      }
      totals.polls += 1;
      lastPollAt = at;
    } catch (error) {
      log.warn?.(`[CCTV Watch] report poll failed: ${error.message}`);
    } finally {
      polling = false;
    }
  }

  function loop() {
    if (!running) return;
    poll().finally(() => {
      if (!running) return;
      timer = setTimer(loop, pollMs);
      timer?.unref?.();
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      clearTimer(timer);
      timer = null;
    },
    poll,
    /** Currently listed reports, with when each was first seen and last changed. */
    current: () =>
      [...known.values()].map((entry) => ({
        ...entry.report,
        firstSeenAt: entry.firstSeenAt,
        changedAt: entry.changedAt,
      })),
    stats: () => ({
      ...totals,
      listed: known.size,
      lastPollAt,
      errors,
    }),
  };
}
