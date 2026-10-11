import fs from 'node:fs';
import path from 'node:path';

/** Full inventories: bounded concurrent downloads, never bounded camera counts. */
export function createFullCatalog({
  sourceRoot,
  packs,
  normalize,
  decorate,
  ttl,
  concurrency = 8,
}) {
  const file = path.join(sourceRoot, '.cache', 'cctv-full-catalog.json');
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
      for (const camera of states.get(pack.name).sources) {
        const urls = [
          camera.url,
          camera.snapshotUrl,
          camera.externalUrl,
        ].filter(Boolean);
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
  try {
    if (fs.statSync(file).size < 200_000_000) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [name, entry] of Object.entries(saved.packs || {})) {
        if (states.has(name) && Array.isArray(entry.sources))
          states.set(name, { ...entry, pack: name, state: 'stale' });
      }
      rebuild();
      snapshotReady = merged.length > 0;
    }
  } catch {
    /* First launch has no persisted inventories. */
  }
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
          if (normalized.sources.length) {
            state.sources = rows.inventory?.partial
              ? [
                  ...new Map(
                    [...state.sources, ...normalized.sources].map((camera) => [
                      camera.id,
                      camera,
                    ]),
                  ).values(),
                ]
              : normalized.sources;
            state.state = rows.inventory?.partial ? 'partial' : 'ready';
            state.updatedAt = new Date().toISOString();
            delete state.error;
          } else {
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
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = file + '.tmp';
          fs.writeFileSync(
            tmp,
            JSON.stringify({ packs: Object.fromEntries(states) }),
            { mode: 0o600 },
          );
          fs.renameSync(tmp, file);
        } catch (error) {
          console.warn(
            '[CCTV] Could not persist full catalogue:',
            error.message,
          );
        }
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
