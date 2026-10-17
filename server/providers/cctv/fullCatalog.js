/** Keep video candidates unless an existing health verdict records them as dead.
 * Unverified feeds and embeds stay available; no new verification probe is added.
 */
export function createLiveCameraFilter({
  getDeadStreams = async () => new Set(),
  retainUnavailable = false,
  checkStreams = async () => {},
} = {}) {
  let dead = new Set();
  let deadFeeds = new Set();
  const include = (camera) =>
    (['hls', 'mjpeg', 'mp4', 'webm'].includes(camera.feedType) ||
      (camera.feedType === 'iframe' && !!camera.embedUrl)) &&
    !isSnapshotEndpoint(camera) &&
    (retainUnavailable ||
      (!dead.has(camera.feedType === 'iframe' ? camera.embedUrl : camera.url) &&
        !deadFeeds.has(cameraFeedKey(camera))));
  const filter = async (sources) => {
    dead = await getDeadStreams();
    deadFeeds = new Set(
      [...dead]
        .flatMap((url) => [
          cameraFeedKey({ feedType: 'hls', url }),
          cameraFeedKey({ feedType: 'iframe', embedUrl: url }),
        ])
        .filter(Boolean),
    );
    const retained = sources.filter(include);
    await checkStreams(retained);
    return retained;
  };
  filter.include = include;
  filter.liveOnly = true;
  return filter;
}

// A provider's video label must not turn a direct image into a live feed.
// Multipart MJPEG endpoints can have image-like paths: keep those unless the
// URL is a known static thumbnail service confirmed by its HTTP content type.
export function isSnapshotEndpoint(camera) {
  const value = camera.feedType === 'iframe' ? camera.embedUrl : camera.url;
  try {
    const url = new URL(value);
    if (camera.feedType === 'mjpeg')
      return (
        url.hostname === 'images.opentopia.com' &&
        /\.jpe?g$/i.test(url.pathname)
      );
    return (
      /\.(?:jpe?g|png|gif|webp)$/i.test(url.pathname) ||
      /\/(?:snapshot|thumbnail)(?:\/|$)/i.test(url.pathname) ||
      ['action', 'mode', 'type'].some(
        (key) => url.searchParams.get(key) === 'snapshot',
      )
    );
  } catch {
    return false;
  }
}

/** Stable playback identity, independent of provider coordinates and labels.
 * Keep camera-selecting query parameters. Only known player presentation flags
 * and DriveTexas's expiring signature are ignored; playback URLs stay intact.
 */
export function cameraFeedKey(camera) {
  const value = camera.feedType === 'iframe' ? camera.embedUrl : camera.url;
  if (!value) return '';
  try {
    const url = new URL(value);
    if (camera.feedType !== 'iframe') url.hash = '';
    // DelDOT publishes the same named stream through its old HTTP:1935 and
    // current HTTPS frontends. These are one camera, not separate directions.
    if (
      url.hostname === 'video.deldot.gov' &&
      /^\/live\/[^/]+\.stream\//.test(url.pathname)
    ) {
      url.protocol = 'https:';
      url.port = '';
    }
    if (url.hostname.endsWith('.skyvdn.com')) {
      url.searchParams.delete('token');
      // South Carolina publishes TS and fMP4 playlists for the same camera.
      url.pathname = url.pathname.replace(
        /^(\/rtplive\/[^/]+\/)playlist_sfm4s\.m3u8$/,
        '$1playlist.m3u8',
      );
    }
    if (
      camera.feedType === 'iframe' &&
      /^(www\.)?(youtube\.com|youtube-nocookie\.com)$/.test(url.hostname)
    ) {
      url.hostname = 'www.youtube.com';
      for (const flag of [
        'autoplay',
        'mute',
        'controls',
        'rel',
        'playsinline',
        'enablejsapi',
        'origin',
        'modestbranding',
        'iv_load_policy',
        'si',
      ])
        url.searchParams.delete(flag);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    return String(value);
  }
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
    // First pack wins: preserve native IDs and publisher playback resolvers.
    // A shared playback endpoint is one feed even if coordinates disagree.
    // Different endpoints at the same position remain separate views.
    const feeds = new Map();
    for (const pack of packs) {
      const state = states.get(pack.name);
      // Failed/partial packs may retain old records, but not known-dead feeds.
      if (filterSources.include)
        state.sources = state.sources.filter(filterSources.include);
      for (const camera of state.sources) {
        const key = cameraFeedKey(camera);
        const winner = ids.get(camera.id) || (key && feeds.get(key));
        if (winner) {
          if (winner.id !== camera.id && !winner.aliases.includes(camera.id))
            winner.aliases.push(camera.id);
          continue;
        }
        const entry = { ...camera, aliases: [] };
        ids.set(camera.id, entry);
        if (key) feeds.set(key, entry);
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
