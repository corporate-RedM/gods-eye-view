/** DriveTexas's public map API. Signed playback URLs are refreshed on demand. */
const API = 'https://dtx-e-cdn.maplarge.com/Api/ProcessDirect?request=';
const HEADERS = Object.freeze({
  Origin: 'https://drivetexas.org',
  Referer: 'https://drivetexas.org/',
  'User-Agent': 'Mozilla/5.0',
});

async function queryCameras(query, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(
    API +
      encodeURIComponent(
        JSON.stringify({
          action: 'table/query',
          query: { table: 'appgeo/cameraPoint', ...query },
        }),
      ),
    {
      headers: HEADERS,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`DriveTexas HTTP ${response.status}`);
  }
  const result = await response.json();
  if (
    !result.success ||
    !result.data?.data ||
    !Array.isArray(result.data.data.name)
  )
    throw new Error('Invalid DriveTexas inventory');
  const { data, totals } = result.data;
  return {
    total: Number(totals?.Records),
    rows: data.name.map((_, i) =>
      Object.fromEntries(
        Object.entries(data).map(([key, values]) => [key, values[i]]),
      ),
    ),
  };
}

function streamUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.hostname.endsWith('.skyvdn.com') ||
      !/\.m3u8$/i.test(url.pathname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function mapDriveTexasVideo(row) {
  const point = /^POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(
    row.XY || '',
  );
  const url = streamUrl(row.httpsurl);
  if (
    !point ||
    !url ||
    !/^[\w-]+$/.test(row.name || '') ||
    ![1, true, '1'].includes(row.active)
  )
    return null;
  const lon = Number(point[1]),
    lat = Number(point[2]);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (!lat && !lon)
  )
    return null;
  // Keep the stable feed identity in the catalogue; never retain an expiring token.
  url.search = '';
  return {
    id: `osiris-drivetexas-video-${row.name}`,
    name: row.description || row.name,
    city: 'Texas',
    provider: 'TxDOT / DriveTexas',
    lat,
    lon,
    feedType: 'hls',
    url: url.href,
    sourceKind: 'drivetexas-public-video',
    headingConfidence: 'unknown',
    credit: 'Texas Department of Transportation',
  };
}

export async function loadDriveTexasVideo(options = {}) {
  const sqlselect = ['name', 'description', 'httpsurl', 'active', 'XY'];
  const first = await queryCameras(
    { sqlselect, start: 0, take: 1000 },
    options,
  );
  if (!Number.isSafeInteger(first.total) || first.total < 0)
    throw new Error('Invalid DriveTexas inventory total');
  const rows = [...first.rows];
  let next = 1000,
    failedBatches = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < first.total) {
        const start = next;
        next += 1000;
        try {
          rows.push(
            ...(await queryCameras({ sqlselect, start, take: 1000 }, options))
              .rows,
          );
        } catch {
          failedBatches++;
        }
      }
    }),
  );
  const cameras = [
    ...new Map(
      rows
        .map(mapDriveTexasVideo)
        .filter(Boolean)
        .map((c) => [c.id, c]),
    ).values(),
  ];
  Object.defineProperty(cameras, 'inventory', {
    value: {
      candidates: first.total,
      batches: Math.ceil(first.total / 1000),
      failedBatches,
      partial: failedBatches > 0,
    },
  });
  return cameras;
}

export async function resolveDriveTexasStream(source, options = {}) {
  const name = String(source.id || '').replace(/^osiris-drivetexas-video-/, '');
  if (
    !source.id?.startsWith('osiris-drivetexas-video-') ||
    !/^[\w-]+$/.test(name)
  )
    throw new Error('Invalid DriveTexas identity');
  const { rows } = await queryCameras(
    {
      sqlselect: ['name', 'httpsurl'],
      take: 1,
      where: [[{ col: 'name', test: 'Equal', value: name }]],
    },
    options,
  );
  const url = streamUrl(rows.find((row) => row.name === name)?.httpsurl);
  if (
    !url ||
    url.origin !== new URL(source.url).origin ||
    url.pathname !== new URL(source.url).pathname
  )
    throw new Error('DriveTexas returned an unexpected stream');
  return { url: url.href, headers: HEADERS };
}

export function driveTexasVideoPack() {
  return {
    name: 'osiris-drivetexas-video',
    enabled: () => process.env.CCTV_PUBLIC_VIDEO_ENABLED !== '0',
    load: () => loadDriveTexasVideo(),
  };
}
