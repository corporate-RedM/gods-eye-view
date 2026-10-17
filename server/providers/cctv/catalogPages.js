import { randomUUID } from 'node:crypto';

/** Bounded responses pinned to an in-memory snapshot across catalogue refreshes. */
export function createCatalogPages({ now = Date.now } = {}) {
  const snapshots = new Map();
  const ttl = 15 * 60 * 1000;
  return (sources, params) => {
    for (const [id, entry] of snapshots)
      if (now() - entry.touched > ttl) snapshots.delete(id);
    let id = params.get('snapshot');
    let entry = snapshots.get(id);
    if (id && !entry) return { expired: true };
    if (!entry) {
      entry = [...snapshots.values()].find((item) => item.sources === sources);
      if (entry) id = entry.id;
      else {
        id = randomUUID();
        entry = { id, sources, touched: now() };
        snapshots.set(id, entry);
        // References only: at most four previous catalogues survive refreshes.
        while (snapshots.size > 4)
          snapshots.delete(snapshots.keys().next().value);
      }
    }
    entry.touched = now();
    const requested = Number(params.get('limit') || 256);
    const limit = Number.isSafeInteger(requested)
      ? Math.max(1, Math.min(256, requested))
      : 256;
    const rawOffset = Number(params.get('offset') || 0);
    const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, rawOffset) : 0;
    const end = Math.min(offset + limit, entry.sources.length);
    return {
      sources: entry.sources.slice(offset, end),
      page: {
        snapshot: id,
        offset,
        total: entry.sources.length,
        next: end < entry.sources.length ? end : null,
      },
    };
  };
}
