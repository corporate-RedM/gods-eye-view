// Public publisher feeds also indexed by WorldCam. Inventories stay in memory.
const INDEX = 'https://opencctv.org/api/cameras/markers';
const BATCH = 'https://opencctv.org/api/cameras/batch';
const THB = 'https://thbapp.thb.gov.tw/services/cctv/thb';
const VIDEO_TYPES = new Map([
  ['m3u8', 'hls'],
  ['hls', 'hls'],
  ['mjpeg', 'mjpeg'],
  ['iframe', 'iframe'],
  ['mp4', 'mp4'],
  ['webm', 'webm'],
]);

function publicUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function position(lat, lon) {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    (lat !== 0 || lon !== 0)
  );
}

export function mapPublicVideo(record) {
  const feedType = VIDEO_TYPES.get(String(record?.feed_type).toLowerCase());
  const url = publicUrl(record?.feed_url);
  if (
    !record?.id ||
    record.active === 0 ||
    !feedType ||
    !url ||
    !position(record.lat, record.lng)
  )
    return null;
  return {
    id: `osiris-global-video-occ-${record.id}`,
    name: record.name || String(record.id),
    lat: record.lat,
    lon: record.lng,
    city: record.city || record.country || '',
    provider: record.source ? `OpenCCTV / ${record.source}` : 'OpenCCTV',
    feedType,
    url: feedType === 'iframe' ? '' : url,
    embedUrl: feedType === 'iframe' ? url : '',
    headingConfidence: 'unknown',
    credit: record.source || 'OpenCCTV',
  };
}

async function json(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Camera provider HTTP ${response.status}`);
  }
  return response.json();
}

/** Hydrate every video candidate, in the provider's documented 50-record batches. */
export async function loadGlobalPublicVideo({ fetchImpl = fetch } = {}) {
  const headers = {
    Accept: 'application/json',
    Referer: 'https://opencctv.org/',
  };
  const index = await json(fetchImpl, INDEX, { headers });
  if (!Array.isArray(index.ids) || index.fts?.length !== index.ids.length)
    throw new Error('OpenCCTV returned an invalid feed-type index');
  // 0 is a snapshot. Unknown nonzero codes are hydrated, then checked by type.
  const ids = [...new Set(index.ids.filter((_, i) => index.fts[i] !== 0))];
  const cameras = new Map();
  let next = 0;
  let failedBatches = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < ids.length) {
        const batch = ids.slice(next, (next += 50));
        try {
          const rows = await json(fetchImpl, BATCH, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: batch }),
          });
          if (!Array.isArray(rows)) throw new Error('Invalid camera batch');
          const requested = new Set(batch);
          for (const record of rows) {
            if (!requested.has(record?.id)) continue;
            const camera = mapPublicVideo(record);
            if (camera) cameras.set(camera.id, camera);
          }
        } catch {
          failedBatches++;
        }
      }
    }),
  );
  if (ids.length && failedBatches === Math.ceil(ids.length / 50))
    throw new Error('Every OpenCCTV video batch failed');
  const result = [...cameras.values()];
  Object.defineProperty(result, 'inventory', {
    value: {
      candidates: ids.length,
      batches: Math.ceil(ids.length / 50),
      failedBatches,
      partial: failedBatches > 0,
    },
  });
  return result;
}

export function mapTaiwanVideo(record) {
  const url = publicUrl(record?.html);
  if (!record?.id || !url || !position(record.gisy, record.gisx)) return null;
  // The publisher's base camera URL is multipart MJPEG; /snapshot is a still.
  const host = new URL(url).hostname;
  if (!/^cctv-ss\d+\.thb\.gov\.tw$/.test(host)) return null;
  return {
    id: `osiris-taiwan-video-${record.id}`,
    name: record.stakenumber || record.id,
    lat: record.gisy,
    lon: record.gisx,
    city: 'Taiwan',
    provider: 'THB Highway Bureau',
    feedType: 'mjpeg',
    url,
    headingConfidence: 'unknown',
    credit: 'Taiwan Highway Bureau',
  };
}

export async function loadTaiwanPublicVideo({ fetchImpl = fetch } = {}) {
  const rows = await json(fetchImpl, THB);
  if (!Array.isArray(rows)) throw new Error('Invalid Taiwan camera inventory');
  return rows.map(mapTaiwanVideo).filter(Boolean);
}

export function mapTaiwanFreewayVideo(record) {
  const url = publicUrl(record?.VideoStreamURL);
  if (
    !record?.CCTVID ||
    !url ||
    !position(record.PositionLat, record.PositionLon)
  )
    return null;
  const endpoint = new URL(url);
  if (
    !endpoint.hostname.endsWith('.freeway.gov.tw') ||
    !['/abs2mjpg/bmjpg', '/live-view/mjpg/video.cgi'].includes(
      endpoint.pathname,
    )
  )
    return null;
  return {
    id: `osiris-taiwan-freeway-video-${record.CCTVID}`,
    name:
      [record.RoadName, record.RoadDirection, record.LocationMile]
        .filter(Boolean)
        .join(' ') || record.CCTVID,
    lat: record.PositionLat,
    lon: record.PositionLon,
    city: 'Taiwan',
    provider: 'Taiwan Freeway Bureau',
    feedType: 'mjpeg',
    url,
    headingConfidence: 'unknown',
    credit: 'Freeway Bureau, MOTC',
    license: 'Taiwan Government Open Data License v1.0',
  };
}

export async function loadTaiwanFreewayVideo({ fetchImpl = fetch } = {}) {
  const data = await json(
    fetchImpl,
    'https://traffic.transportdata.tw/MOTC/v2/Road/Traffic/CCTV/Freeway?$format=JSON',
  );
  if (!Array.isArray(data.CCTVs))
    throw new Error('Invalid Taiwan freeway inventory');
  return data.CCTVs.map(mapTaiwanFreewayVideo).filter(Boolean);
}

export function publicVideoPacks() {
  return [
    { name: 'osiris-global-video', load: loadGlobalPublicVideo },
    { name: 'osiris-taiwan-video', load: loadTaiwanPublicVideo },
    { name: 'osiris-taiwan-freeway-video', load: loadTaiwanFreewayVideo },
  ].map((pack) => ({
    ...pack,
    enabled: () => process.env.CCTV_PUBLIC_VIDEO_ENABLED !== '0',
  }));
}
