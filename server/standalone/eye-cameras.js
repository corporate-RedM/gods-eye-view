import { osirisCameraRegions } from '../../integrations/osiris/app/api/cctv/route.js';

function publicUrl(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('/api/eye/cctv/proxy?'))
    value = new URLSearchParams(value.split('?')[1]).get('url') || '';
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

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
  const externalUrl = publicUrl(raw.external_url);
  const stream = publicUrl(raw.stream_url);
  const snapshotUrl = publicUrl(raw.feed_url);
  const embedUrl = type === 'iframe' ? stream : '';
  const url = type === 'iframe' ? snapshotUrl : stream || snapshotUrl;
  if (!url && !embedUrl && !externalUrl) return null;
  return {
    id: `osiris-${pack}-${raw.id}`,
    name: raw.name || String(raw.id),
    lat,
    lon,
    city: raw.city || raw.country || '',
    provider: raw.source || pack,
    feedType:
      type === 'iframe'
        ? 'iframe'
        : !url
          ? 'external'
          : type === 'jpg'
            ? 'image'
            : type,
    url,
    snapshotUrl,
    externalUrl,
    embedUrl,
    sourceKind: 'configured',
    credit: raw.source || pack,
    headingConfidence: 'unknown',
  };
}

/** Every region registered by the pinned Osiris version, without camera caps. */
export function eyeCameraPacks() {
  return Object.entries(osirisCameraRegions).map(([region, fetcher]) => ({
    name: `osiris-${region}`,
    enabled: () => process.env.EYE_EXTRA_CAMERAS !== '0',
    async load() {
      const raw = await fetcher();
      // Distinct provider IDs/views survive even when their URL is shared.
      const cameras = [
        ...new Map(
          raw
            .map((camera) => cameraToNative(camera, region))
            .filter(Boolean)
            .map((camera) => [camera.id, camera]),
        ).values(),
      ];
      if (raw.inventory)
        Object.defineProperty(cameras, 'inventory', { value: raw.inventory });
      return cameras;
    },
  }));
}
