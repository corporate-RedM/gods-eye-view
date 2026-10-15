/** Join RIDOT's published live players to OpenCCTV's geolocated image identities. */
const PAGE = 'https://www.dot.ri.gov/travel/cameras_metro.php';
const ROOT = 'https://opencctv.org/api/cameras/';
const HEADERS = {
  Referer: 'https://opencctv.org/',
  'Content-Type': 'application/json',
};
async function request(url, init = {}, fetchImpl = fetch) {
  const r = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`RIDOT inventory HTTP ${r.status}`);
  }
  return r;
}
function imageIdentity(value, base = PAGE) {
  try {
    const u = new URL(value.replaceAll('&amp;', '&'), base);
    return decodeURIComponent(u.pathname);
  } catch {
    return '';
  }
}

export function parseRidotPlayers(html, page = PAGE) {
  const images = new Map(),
    players = new Map();
  for (const m of html.matchAll(
    /<a\b[^>]*\bid=["']([^"']+)["'][^>]*>\s*<img\b[^>]*\bsrc=["']([^"']+)["']/gi,
  ))
    images.set(m[1], imageIdentity(m[2], page));
  for (const m of html.matchAll(
    /document\.getElementById\(["']([^"']+)["']\)[\s\S]{0,200}?openVideoPopup2\(["'](https:\/\/[^"']+\.m3u8)["']/g,
  )) {
    const image = images.get(m[1]);
    if (!image) continue;
    const url = new URL(m[2]);
    if (!url.hostname.endsWith('.wowza.com')) continue;
    players.set(image, url.href);
  }
  return players;
}

export async function loadRhodeIslandVideo({ fetchImpl = fetch } = {}) {
  const first = await (await request(PAGE, {}, fetchImpl)).text();
  const pages = [
    ...new Set(
      [...first.matchAll(/["'](\/travel\/cameras_[a-z]+\.php)["']/g)].map(
        (m) => new URL(m[1], PAGE).href,
      ),
    ),
  ].filter((url) => url !== PAGE);
  const players = parseRidotPlayers(first);
  let failedBatches = 0;
  for (const url of pages) {
    try {
      const html = await (await request(url, {}, fetchImpl)).text();
      for (const [key, value] of parseRidotPlayers(html, url))
        players.set(key, value);
    } catch {
      failedBatches++;
    }
  }
  const index = await (
    await request(ROOT + 'markers', { headers: HEADERS }, fetchImpl)
  ).json();
  if (!Array.isArray(index.ids))
    throw new Error('Invalid RIDOT location index');
  const ids = index.ids.filter(
      (id) => typeof id === 'string' && id.startsWith('ridot-'),
    ),
    cameras = [];
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    try {
      const records = await (
        await request(
          ROOT + 'batch',
          {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ ids: batch }),
          },
          fetchImpl,
        )
      ).json();
      if (!Array.isArray(records))
        throw new Error('Invalid RIDOT location batch');
      for (const record of records) {
        const url = players.get(imageIdentity(record.feed_url || ''));
        if (
          !batch.includes(record.id) ||
          !url ||
          record.active === 0 ||
          !Number.isFinite(record.lat) ||
          !Number.isFinite(record.lng) ||
          Math.abs(record.lat) > 90 ||
          Math.abs(record.lng) > 180
        )
          continue;
        cameras.push({
          id: `osiris-ridot-video-${record.id}`,
          name: record.name,
          lat: record.lat,
          lon: record.lng,
          city: record.city || 'Rhode Island',
          provider: 'Rhode Island DOT',
          feedType: 'hls',
          url,
          headingConfidence: 'unknown',
          credit: 'Rhode Island Department of Transportation',
        });
      }
    } catch {
      failedBatches++;
    }
  }
  Object.defineProperty(cameras, 'inventory', {
    value: {
      candidates: ids.length,
      livePlayers: players.size,
      batches: pages.length + 1 + Math.ceil(ids.length / 50),
      failedBatches,
      partial: failedBatches > 0,
    },
  });
  return cameras;
}
export function rhodeIslandVideoPack() {
  return {
    name: 'osiris-ridot-video',
    enabled: () => process.env.CCTV_PUBLIC_VIDEO_ENABLED !== '0',
    load: () => loadRhodeIslandVideo(),
  };
}
