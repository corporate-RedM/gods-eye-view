/** The public 511 player negotiates video tokens only when a camera is opened. */
export const PUBLIC_IBI_SITES = Object.freeze({
  fl: {
    origin: 'https://fl511.com',
    provider: 'FDOT',
    state: 'Florida',
    gateway:
      'https://divas.cloud/VDS-API/SecureTokenUri/GetSecureTokenUriBySourceId',
  },
  ga: { origin: 'https://511ga.org', provider: 'GDOT', state: 'Georgia' },
  nc: {
    origin: 'https://www.drivenc.gov',
    provider: 'NCDOT',
    state: 'North Carolina',
    gateway:
      'https://vds.nc.insight-atms.com/api/SecureTokenUri/GetSecureTokenUriBySourceId',
  },
  pa: {
    origin: 'https://511pa.com',
    provider: 'PennDOT',
    state: 'Pennsylvania',
    gateway:
      'https://pa.arcadis-ivds.com/api/SecureTokenUri/GetSecureTokenUriBySourceId',
  },
});
const USER_AGENT = 'Mozilla/5.0';

function headers(site) {
  return {
    Accept: 'application/json',
    Referer: `${site.origin}/`,
    Origin: site.origin,
    'User-Agent': USER_AGENT,
  };
}

async function readJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`511 provider HTTP ${response.status}`);
  }
  return response.json();
}

export function mapIbiVideoRows(key, rows) {
  const site = PUBLIC_IBI_SITES[key];
  if (!site) throw new Error('Unknown 511 video provider');
  const cameras = [];
  for (const row of rows) {
    const point = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(
      row?.latLng?.geography?.wellKnownText || '',
    );
    if (!point) continue;
    const lon = Number(point[1]),
      lat = Number(point[2]);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (!lat && !lon)
    )
      continue;
    for (const image of row.images || []) {
      if (image.disabled || image.blocked || image.videoDisabled) continue;
      if (
        !/^[\w-]+$/.test(String(image.id ?? '')) ||
        !/^[\w-]+$/.test(String(row.id ?? ''))
      )
        continue;
      let url;
      try {
        url = new URL(image.videoUrl);
      } catch {
        continue;
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !/\.m3u8$/i.test(url.pathname)
      )
        continue;
      cameras.push({
        id: `osiris-ibi-video-${key}:${row.id}:${image.id}`,
        name: [
          row.location || row.roadway || `${site.state} ${row.id}`,
          image.description,
        ]
          .filter(Boolean)
          .join(' — '),
        city: site.state,
        provider: site.provider,
        lat,
        lon,
        feedType: 'hls',
        url: url.href,
        sourceKind: image.isVideoAuthRequired
          ? 'ibi-public-video'
          : 'configured',
        headingConfidence: 'unknown',
        credit: site.provider,
      });
    }
  }
  return cameras;
}

export async function loadIbiPublicVideo(key, { fetchImpl = fetch } = {}) {
  const site = PUBLIC_IBI_SITES[key];
  if (!site) throw new Error('Unknown 511 video provider');
  const page = async (start) => {
    const query = {
      columns: [
        { data: null, name: '' },
        { name: 'sortOrder', s: true },
        { name: 'roadway', s: true },
        { data: 3, name: '' },
      ],
      order: [{ column: 1, dir: 'asc' }],
      start,
      length: 100,
      search: { value: '' },
    };
    const data = await readJson(
      fetchImpl,
      `${site.origin}/List/GetData/Cameras?${new URLSearchParams({ query: JSON.stringify(query), lang: 'en' })}`,
      { headers: { ...headers(site), 'X-Requested-With': 'XMLHttpRequest' } },
    );
    if (
      !Array.isArray(data.data) ||
      !Number.isSafeInteger(Number(data.recordsTotal)) ||
      Number(data.recordsTotal) < 0
    )
      throw new Error('Invalid 511 camera inventory');
    return data;
  };
  const first = await page(0),
    all = [...first.data];
  let next = 100,
    failedBatches = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < Number(first.recordsTotal)) {
        const start = next;
        next += 100;
        try {
          all.push(...(await page(start)).data);
        } catch {
          failedBatches++;
        }
      }
    }),
  );
  const cameras = [
    ...new Map(mapIbiVideoRows(key, all).map((c) => [c.id, c])).values(),
  ];
  Object.defineProperty(cameras, 'inventory', {
    value: {
      candidates: Number(first.recordsTotal),
      batches: Math.ceil(Number(first.recordsTotal) / 100),
      failedBatches,
      partial: failedBatches > 0,
    },
  });
  return cameras;
}

/** No persistent token cache: the puller owns tokens for its active sessions. */
export async function resolveIbiPublicStream(
  source,
  { fetchImpl = fetch, signal } = {},
) {
  if (source?.sourceKind !== 'ibi-public-video') return { url: source?.url };
  const match = /^osiris-ibi-video-(fl|ga|nc|pa):([\w-]+):([\w-]+)$/.exec(
    source.id,
  );
  if (!match) throw new Error('Invalid 511 video identity');
  const site = PUBLIC_IBI_SITES[match[1]];
  const requestHeaders = headers(site);
  const auth = await readJson(
    fetchImpl,
    `${site.origin}/Camera/GetVideoUrl?imageId=${encodeURIComponent(match[3])}`,
    { headers: requestHeaders, signal },
  );
  let value;
  if (typeof auth === 'string') value = auth;
  else {
    if (!auth || typeof auth.token !== 'string' || !site.gateway)
      throw new Error('511 video authorization unavailable');
    const suffix = await readJson(fetchImpl, site.gateway, {
      method: 'POST',
      headers: { ...requestHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(auth),
      signal,
    });
    if (typeof suffix !== 'string' || !suffix.startsWith('?'))
      throw new Error('Invalid 511 video token response');
    value = source.url + suffix;
  }
  const url = new URL(value);
  // A token endpoint cannot redirect playback to a different origin.
  if (
    url.origin !== new URL(source.url).origin ||
    !/\.m3u8$/i.test(url.pathname)
  )
    throw new Error('511 video returned an unexpected stream origin');
  return { url: url.href, headers: { ...requestHeaders, Accept: '*/*' } };
}

export function ibiPublicVideoPacks() {
  return Object.keys(PUBLIC_IBI_SITES).map((key) => ({
    name: `osiris-ibi-video-${key}`,
    enabled: () => process.env.CCTV_PUBLIC_VIDEO_ENABLED !== '0',
    load: () => loadIbiPublicVideo(key),
  }));
}
