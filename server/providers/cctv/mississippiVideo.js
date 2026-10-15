/** MDOT's public map publishes sites; each site can contain several video views. */
const ORIGIN = 'https://www.mdottraffic.com';
const HEADERS = { Referer: ORIGIN + '/', 'User-Agent': 'Mozilla/5.0' };
async function request(url, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...HEADERS, ...init.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`MDOT HTTP ${response.status}`);
  }
  return response;
}

export function mapMississippiViews(site, html) {
  const lat = Number(site.lat),
    lon = Number(site.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (!lat && !lon)
  )
    return [];
  const cameras = [];
  for (const match of html.matchAll(
    /switchImage\('([^']+)',\s*'(\d+)',\s*'([^']*)'/g,
  )) {
    let thumbnail;
    try {
      thumbnail = new URL(match[1].replaceAll('&amp;', '&'));
    } catch {
      continue;
    }
    const stream = thumbnail.searchParams.get('streamname');
    if (
      !thumbnail.hostname.endsWith('.mdottraffic.com') ||
      thumbnail.pathname !== '/thumbnail' ||
      thumbnail.searchParams.get('application') !== 'rtplive' ||
      stream !== `${match[2]}.stream`
    )
      continue;
    // This is the HLS path used by MDOT's /mapbubbles/streamcam.aspx player.
    const url = new URL(`/rtplive/${stream}/playlist.m3u8`, thumbnail.origin);
    url.protocol = 'https:';
    cameras.push({
      id: `osiris-mississippi-video-${match[2]}`,
      name: match[3] || site.tooltip,
      lat,
      lon,
      city: 'Mississippi',
      provider: 'Mississippi DOT',
      feedType: 'hls',
      url: url.href,
      headingConfidence: 'unknown',
      credit: 'Mississippi Department of Transportation',
    });
  }
  return cameras;
}

export async function loadMississippiVideo({ fetchImpl = fetch } = {}) {
  const response = await request(
    ORIGIN + '/default.aspx/LoadCameraData',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    fetchImpl,
  );
  const json = await response.json(),
    sites = typeof json.d === 'string' ? JSON.parse(json.d) : json.d;
  if (!Array.isArray(sites)) throw new Error('Invalid MDOT camera inventory');
  let next = 0,
    failedBatches = 0;
  const cameras = new Map();
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < sites.length) {
        const site = sites[next++],
          id = /^camsite_(\d+)$/.exec(site.markerid || '')?.[1];
        if (!id) continue;
        try {
          const page = await request(
            ORIGIN + `/mapbubbles/camerasite.aspx?site=${id}`,
            {},
            fetchImpl,
          );
          for (const camera of mapMississippiViews(site, await page.text()))
            cameras.set(camera.id, camera);
        } catch {
          failedBatches++;
        }
      }
    }),
  );
  if (sites.length && failedBatches === sites.length)
    throw new Error('Every MDOT camera site failed');
  const result = [...cameras.values()];
  Object.defineProperty(result, 'inventory', {
    value: {
      candidates: sites.length,
      batches: sites.length,
      failedBatches,
      partial: failedBatches > 0,
    },
  });
  return result;
}

export function mississippiVideoPack() {
  return {
    name: 'osiris-mississippi-video',
    enabled: () => process.env.CCTV_PUBLIC_VIDEO_ENABLED !== '0',
    load: () => loadMississippiVideo(),
  };
}
