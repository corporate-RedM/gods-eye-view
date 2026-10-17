import {
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
} from './sourcePolicy.js';
function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const cadenceMs = Math.max(
    1000,
    safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
  );
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}
function mediaUrlFor(camera) {
  return `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}
/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(path, key, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Camera source HTTP ' + response.status);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (key && !Array.isArray(payload?.[key]))
      throw new Error('Malformed camera ' + key + ' snapshot');
    return payload;
  }
  return {
    async getCatalog(options = {}) {
      do {
        const status = await read('/api/cctv/sources?status=1', null, options);
        if (!Number.isSafeInteger(status.count) || status.count < 0)
          throw new Error('Malformed camera collection status');
        options.onProgress?.({
          discovered: status.count,
          collecting:
            !!status.coverage?.loading && !status.coverage.snapshotReady,
        });
        options.signal?.throwIfAborted();
        if (!status.coverage?.loading || status.coverage.snapshotReady) break;
        await new Promise((resolve, reject) => {
          const signal = options.signal;
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
          }, 2000);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      } while (true);
      const sources = [];
      let path = '/api/cctv/sources';
      let result;
      let metadata;
      do {
        result = await read(path, 'sources', options);
        metadata ||= {
          coverage: result.coverage,
          trimmedPacks: result.trimmedPacks,
        };
        sources.push(...result.sources);
        if (result.page) {
          options.onProgress?.({
            discovered: result.page.total,
            collecting: false,
            downloaded: sources.length,
          });
          // A consumer may finish processing a batch before requesting more.
          await options.onBatch?.(result.sources, result.page);
          if (result.page.next !== null) {
            if (
              !Number.isSafeInteger(result.page.next) ||
              result.page.next <= result.page.offset
            )
              throw new Error('Malformed camera page cursor');
            path = `/api/cctv/sources?snapshot=${encodeURIComponent(result.page.snapshot)}&offset=${result.page.next}`;
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
        }
        options.signal?.throwIfAborted();
      } while (result.page && result.page.next !== null);
      return { ...result, ...metadata, sources };
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', options);
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: mediaUrlFor,
    /** Read one current frame through the registered frame endpoint. */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(frameUrlFor(camera), {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Camera frame HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      return { contentType: type.split(';')[0].trim().toLowerCase(), bytes };
    },
  };
}
