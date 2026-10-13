/** Keep video candidates unless an existing health verdict records them as dead.
 * Unverified feeds and embeds stay available; no new verification probe is added.
 */
export function createLiveCameraFilter({
  getDeadStreams = async () => new Set(),
} = {}) {
  let dead = new Set();
  const include = (camera) =>
    (['hls', 'mjpeg', 'mp4', 'webm'].includes(camera.feedType) ||
      (camera.feedType === 'iframe' && !!camera.embedUrl)) &&
    !dead.has(camera.feedType === 'iframe' ? camera.embedUrl : camera.url);
  const filter = async (sources) => {
    dead = await getDeadStreams();
    return sources.filter(include);
  };
  filter.include = include;
  filter.liveOnly = true;
  return filter;
}

/** Full inventories: bounded concurrent downloads, never bounded camera counts. */
export function createFullCatalog({
  sourceRoot,
  packs,
  normalize,
  decorate,
  ttl,
  concurrency = 8,
  filterSources = async (sources) => sources,
}) {
  const states = new Map(
    packs.map((pack) => [
      pack.name,
      { pack: pack.name, sources: [], state: 'pending' },
    ]),
  );
  let snapshotReady = false;
  let rebuildTimer;
  const scheduleRebuild = () => {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuild();
    }, 1000);
  };
  let inflight,
    refreshed = 0,
    merged = [],
    revision = 0;
  const rebuild = () => {
    const ids = new Map();
    // Keep native stable IDs. Collapse exact shared feed URLs only at the same
    // coordinates; nearby cameras and different viewing directions remain separate.
    const feeds = new Map();
    for (const pack of packs) {
      const state = states.get(pack.name);
      // Failed/partial packs may retain old records, but not known-dead feeds.
      if (filterSources.include)
        state.sources = state.sources.filter(filterSources.include);
      for (const camera of state.sources) {
        const urls = (
          filterSources.liveOnly
            ? [camera.feedType === 'iframe' ? camera.embedUrl : camera.url]
            : [camera.url, camera.snapshotUrl, camera.externalUrl]
        ).filter(Boolean);
        const keys = urls.map(
          (url) =>
            `${Number(camera.lat).toFixed(4)},${Number(camera.lon).toFixed(4)}:${url}`,
        );
        const duplicate = keys.map((key) => feeds.get(key)).find(Boolean);
        if (
          duplicate &&
          pack.name.startsWith('osiris-') &&
          duplicate !== camera.id
        ) {
          const winner = ids.get(duplicate);
          if (winner) {
            winner.aliases.push(camera.id);
            continue;
          }
        }
        ids.set(camera.id, { ...camera, aliases: [] });
        for (const key of keys) feeds.set(key, camera.id);
      }
    }
    merged = decorate([...ids.values()]);
    revision++;
  };
  const refresh = () => {
    if (inflight) return inflight;
    let next = 0;
    for (const state of states.values()) state.state = 'pending';
    const worker = async () => {
      while (next < packs.length) {
        const pack = packs[next++],
          state = states.get(pack.name);
        if (!pack.enabled()) {
          state.state = 'disabled';
          state.sources = [];
          continue;
        }
        state.state = 'loading';
        let deadline;
        try {
          const rows = await Promise.race([
            Promise.resolve().then(() =>
              pack.load({ sourceRoot, fullCatalog: true }),
            ),
            new Promise((_, reject) => {
              deadline = setTimeout(
                () =>
                  reject(new Error('Inventory request timed out after 300 s')),
                300_000,
              );
            }),
          ]);
          const normalized = normalize(pack.name, rows);
          state.offered = rows.length;
          state.inventory = rows.inventory || null;
          const offered = normalized.sources;
          normalized.sources = await filterSources(offered);
          state.excluded = offered.length - normalized.sources.length;
          state.excludedByType = {};
          const acceptedIds = new Set(
            normalized.sources.map((camera) => camera.id),
          );
          const excludedIds = new Set();
          for (const camera of offered)
            if (!acceptedIds.has(camera.id)) {
              excludedIds.add(camera.id);
              const type = camera.feedType || 'image';
              state.excludedByType[type] =
                (state.excludedByType[type] || 0) + 1;
            }
          if (normalized.sources.length) {
            state.sources = rows.inventory?.partial
              ? [
                  ...new Map(
                    [
                      ...state.sources.filter(
                        (camera) => !excludedIds.has(camera.id),
                      ),
                      ...normalized.sources,
                    ].map((camera) => [camera.id, camera]),
                  ).values(),
                ]
              : normalized.sources;
            state.state = rows.inventory?.partial ? 'partial' : 'ready';
            state.updatedAt = new Date().toISOString();
            delete state.error;
          } else {
            if (offered.length && filterSources.liveOnly) {
              state.sources = rows.inventory?.partial
                ? state.sources.filter((camera) => !excludedIds.has(camera.id))
                : [];
              state.state = 'filtered';
              delete state.error;
              scheduleRebuild();
              continue;
            }
            state.state = state.sources.length
              ? 'stale'
              : ['file', 'env'].includes(pack.name)
                ? 'empty'
                : 'unavailable';
            state.error = 'Provider returned no usable camera records';
          }
        } catch (error) {
          state.state = state.sources.length ? 'stale' : 'unavailable';
          state.error = String(error.message || error);
        } finally {
          clearTimeout(deadline);
        }
        scheduleRebuild();
      }
    };
    inflight = Promise.all(Array.from({ length: concurrency }, worker))
      .then(() => {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
        rebuild();
        refreshed = Date.now();
        snapshotReady = true;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  const get = async () => {
    if (!refreshed || Date.now() - refreshed > ttl) refresh();
    return merged;
  };
  get.trimmedPacks = () => [];
  get.coverage = () => ({
    mode: 'full',
    liveOnly: filterSources.liveOnly === true,
    snapshotReady,
    loading: !!inflight,
    revision,
    total: merged.length,
    packs: [...states.values()].map(({ sources, ...state }) => ({
      ...state,
      retained: sources.length,
    })),
    deduplicated:
      [...states.values()].reduce((n, s) => n + s.sources.length, 0) -
      merged.length,
  });
  get.ready = async () => {
    await refresh();
    return merged;
  };
  return get;
}
