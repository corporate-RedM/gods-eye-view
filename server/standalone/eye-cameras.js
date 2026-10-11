/** Additional public operators from OSIRIS; overlapping Child's Eye packs stay native. */
const providers = [
  [
    'asfinag',
    'fetchAsfinagCameras',
    () => import('../../integrations/osiris/app/api/cctv/asfinag.js'),
  ],
  [
    'netherlands',
    'fetchNetherlandsCameras',
    () => import('../../integrations/osiris/app/api/cctv/netherlands.js'),
  ],
  [
    'japan',
    'fetchJapanCameras',
    () => import('../../integrations/osiris/app/api/cctv/japan.js'),
  ],
  [
    'hongkong',
    'fetchHongKongCameras',
    () => import('../../integrations/osiris/app/api/cctv/hongkong.js'),
  ],
  [
    'sweden',
    'fetchSwedenCameras',
    () => import('../../integrations/osiris/app/api/cctv/sweden.js'),
  ],
  [
    'oregon',
    'fetchOregonCameras',
    () => import('../../integrations/osiris/app/api/cctv/oregon.js'),
  ],
  [
    'edmonton',
    'fetchEdmontonCameras',
    () => import('../../integrations/osiris/app/api/cctv/edmonton.js'),
  ],
  [
    'florida',
    'fetchFloridaCameras',
    () => import('../../integrations/osiris/app/api/cctv/florida.js'),
  ],
  [
    'taiwan',
    'fetchTaiwanCameras',
    () => import('../../integrations/osiris/app/api/cctv/taiwan.js'),
  ],
  [
    'newzealand',
    'fetchNewZealandCameras',
    () => import('../../integrations/osiris/app/api/cctv/newzealand.js'),
  ],
  [
    'france',
    'fetchFranceCameras',
    () => import('../../integrations/osiris/app/api/cctv/france.js'),
  ],
  [
    'spain',
    'fetchSpainCameras',
    () => import('../../integrations/osiris/app/api/cctv/spain.js'),
  ],
];

export function cameraToNative(raw, pack) {
  const lat = Number(raw.lat),
    lon = Number(raw.lng);
  if (
    !raw.id ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    (!lat && !lon)
  )
    return null;
  const type = raw.stream_type || 'jpg';
  // Web embeds are not direct camera feeds. Never label them as live video.
  if (!['jpg', 'hls', 'mp4', 'mjpeg'].includes(type)) return null;
  let url = type === 'hls' ? raw.stream_url || raw.feed_url : raw.feed_url;
  if (url?.startsWith('/api/eye/cctv/proxy?'))
    url = new URLSearchParams(url.split('?')[1]).get('url');
  if (!/^https?:\/\//i.test(url || '')) return null;
  return {
    id: `osiris-${pack}-${raw.id}`,
    name: raw.name || String(raw.id),
    lat,
    lon,
    city: raw.city || raw.country || '',
    provider: raw.source || pack,
    feedType: type === 'jpg' ? 'image' : type,
    url,
    snapshotUrl: type === 'jpg' ? url : '',
    sourceKind: 'configured',
    credit: raw.source || pack,
    headingConfidence: 'unknown',
  };
}

export function eyeCameraPacks() {
  return providers.map(([pack, fn, loadModule]) => ({
    name: `osiris-${pack}`,
    enabled: () => process.env.EYE_EXTRA_CAMERAS !== '0',
    async load() {
      const module = await loadModule();
      let deadline;
      const raw = await Promise.race([
        module[fn](),
        new Promise((resolve) => {
          deadline = setTimeout(() => resolve([]), 8000);
        }),
      ]).finally(() => clearTimeout(deadline));
      const seen = new Set();
      const normalized = raw
        .map((c) => cameraToNative(c, pack))
        .filter((c) => {
          if (!c || seen.has(c.id) || seen.has(c.url)) return false;
          seen.add(c.id);
          seen.add(c.url);
          return true;
        });
      const cap = Math.max(
        1,
        Math.min(2000, Number(process.env.EYE_CAMERA_PACK_CAP) || 400),
      );
      const kept = normalized.slice(0, cap);
      Object.defineProperty(kept, 'available', { value: normalized.length });
      return kept;
    },
  }));
}
